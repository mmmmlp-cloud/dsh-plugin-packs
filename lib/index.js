/**
 * Host half of dsh-plugin-packs（插件包管理器）。
 *
 * 这一半做浏览器做不到的三件事，全部经同源路由暴露：
 *   1. 读内核的插件清单（`ctx.pluginManager` 的 listBundles / listPlugins）；
 *   2. 整包启停（`setBundleEnabled`，把官方 ChangeResult 原样交回界面）；
 *   3. 把标签数据落成用户能看见、能备份、能手改的文件。
 *
 *   GET  /plugin-packs/api/health           -> { build, route, dir, file }
 *   GET  /plugin-packs/api/bundles          -> { bundles, plugins, diagnostics }
 *   GET  /plugin-packs/api/diagnostics      -> 只读体检报告（不触碰标签文件）
 *   POST /plugin-packs/api/preflight        -> { report, findings, blocked }（只读）
 *   POST /plugin-packs/api/bundles/enabled  -> 官方 ChangeResult
 *   GET  /plugin-packs/api/state            -> 标签文档
 *   PUT  /plugin-packs/api/state            -> revision 乐观锁更新 v2 标签文档
 *   POST /plugin-packs/api/state/actions    -> auto-tag / group-*（仅状态，不启停插件）
 *
 * 为什么是「同源路由」而不是让浏览器自己调远程命名空间：`webServer.register` 是
 * 公开 seam，同源意味着端口、CORS、token 全都不用操心；而且每条路由都能用 curl
 * 单独验证，不受客户端远程装配顺序影响（那一层失败时是静默的，最难查）。
 *
 * 安全：写操作必须带 `x-plugin-packs` 这个自定义头。跨源页面要设自定义头就会
 * 触发预检，而这条路由不回答预检，于是「别的本地页面顺手改你的插件状态」这条路
 * 被堵住。路由本身只在本机 loopback 上，并由宿主的 renderer-token 闸门把关。
 */
import { randomUUID } from "node:crypto";
import { STATE_FILE, readState, writeState, classifyState, mergeState, applyStateAction, manageableBundle, stateError } from "./state.js";
import { homedir } from "node:os";
import path from "node:path";
import { analyzeHealth, preflightHealth } from "./health.js";
import { createPacksTool } from "./tools.js";

export const name = "dsh-plugin-packs";
/**
 * 需要 web server 挂路由，需要 pluginManager 读包清单与整包启停。
 * `pluginManager` 是 dsh-base 的核心行，永远在；声明它等于「本插件依赖内核的插件管理能力」，
 * 而不是去赌浏览器端有没有把 `remote.pluginManager` 命名空间挂出来。
 */
export const inject = ["webServer", "pluginManager"];

/** 健康检查里回报的构建标记：用来判断宿主 half 是否已换成新代码（改完不用猜）。 */
const BUILD = "host-route/3-groups";

/** 路由前缀，必须与 lib/client.js 里的 STATE_URL 保持一致。 */
const ROUTE = "/plugin-packs/api";
/** PUT 的防跨源门槛头，同样与浏览器 half 保持一致。 */
const GATE_HEADER = "x-plugin-packs";
/** 数据目录名（相对 $DSH_HOME）。 */
const STORAGE_DIR_NAME = "plugin-packs";
const MAX_BODY_BYTES = 512 * 1024;

/**
 * 解析数据目录：显式配置 > 宿主 dshHomePath() > $DSH_HOME > ~/.dsh。
 * 走 dshHomePath 是为了跟随用户的 DSH_HOME / profile 搬家，而不是自己拼路径。
 *
 * @param {object} ctx 宿主上下文
 * @param {object|undefined} config 行配置
 * @returns {string} 绝对路径
 */
function resolveStorageDir(ctx, config) {
  const configured = typeof config?.storageDir === "string" ? config.storageDir.trim() : "";
  if (configured.length > 0) return configured;
  try {
    const dshHomePath = ctx.get("dshHomePath");
    if (typeof dshHomePath === "function") return dshHomePath(STORAGE_DIR_NAME);
  } catch {
    /* 落到下面的兜底 */
  }
  const home = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
  return path.join(home.length > 0 ? home : path.join(homedir(), ".dsh"), STORAGE_DIR_NAME);
}

/** 集中写 JSON 响应，省得每条分支重复编码与头。 */
function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.byteLength),
    "cache-control": "no-store",
  });
  res.end(payload);
}

/** 读请求体，超过上限直接掐断（这是一份标签表，不需要无限大）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * 组装路由处理器。
 *
 * @param {{ dir: string, ctx: object, enqueue: (task: () => Promise<any>) => Promise<any> }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
function makeHandler({ dir, ctx, enqueue, operations }) {
  const file = path.join(dir, STATE_FILE);

  return async (req, res) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      sendJson(res, 400, { ok: false, error: { message: "请求 URL 无法解析" } });
      return;
    }
    const suffix = pathname.startsWith(ROUTE) ? pathname.slice(ROUTE.length) || "/" : pathname;
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && suffix === "/health") {
        sendJson(res, 200, { ok: true, value: { build: BUILD, route: ROUTE, dir, file } });
        return;
      }

      // 包清单：浏览器不用去碰远端命名空间，直接读这里。listBundles + listPlugins 一次给全。
      if (method === "GET" && (suffix === "/bundles" || suffix === "/diagnostics")) {
        const [bundles, plugins] = await Promise.all([
          ctx.pluginManager.listBundles(),
          ctx.pluginManager.listPlugins(),
        ]);
        const diagnostics = analyzeHealth(bundles, plugins, new Date().toISOString());
        sendJson(res, 200, { ok: true, value: suffix === "/diagnostics" ? diagnostics : { bundles, plugins, diagnostics } });
        return;
      }

      // Read-only preflight: shares the inventory snapshot, never reads/writes tag state.
      if (method === "POST" && suffix === "/preflight") {
        if (req.headers[GATE_HEADER] === undefined) {
          sendJson(res, 400, { ok: false, error: { message: `缺少 ${GATE_HEADER} 请求头` } });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(await readBody(req));
        } catch (error) {
          sendJson(res, 400, { ok: false, error: { message: `请求体不是合法 JSON：${error?.message ?? error}` } });
          return;
        }
        if (!Array.isArray(parsed?.changes) || parsed.changes.length === 0 || parsed.changes.some((change) =>
          !change || typeof change.name !== "string" || !change.name.trim() || typeof change.enabled !== "boolean")) {
          sendJson(res, 400, { ok: false, error: { message: "changes 必须是非空的 {name, enabled:boolean} 数组" } });
          return;
        }
        const changes = parsed.changes.map(({ name, enabled }) => ({ name: name.trim(), enabled }));
        if (new Set(changes.map((change) => change.name)).size !== changes.length) {
          sendJson(res, 400, { ok: false, error: { message: "changes 不能包含重复目标" } });
          return;
        }
        const [bundles, plugins] = await Promise.all([
          ctx.pluginManager.listBundles(),
          ctx.pluginManager.listPlugins(),
        ]);
        sendJson(res, 200, { ok: true, value: preflightHealth(bundles, plugins, changes, new Date().toISOString()) });
        return;
      }

      // 整包启停：返回官方的 ChangeResult，原样交给界面去解释 applied/restart-required/...。
      if (method === "POST" && suffix === "/bundles/enabled") {
        if (req.headers[GATE_HEADER] === undefined) {
          sendJson(res, 400, { ok: false, error: { message: `缺少 ${GATE_HEADER} 请求头` } });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(await readBody(req));
        } catch (error) {
          sendJson(res, 400, { ok: false, error: { message: `请求体不是合法 JSON：${error?.message ?? error}` } });
          return;
        }
        const target = typeof parsed?.name === "string" ? parsed.name.trim() : "";
        if (target.length === 0) {
          sendJson(res, 400, { ok: false, error: { message: "缺少 name" } });
          return;
        }
        if (typeof parsed?.enabled !== "boolean") throw stateError("enabled 必须是 boolean");
        const bundles = await ctx.pluginManager.listBundles();
        if (!bundles.some((b) => b.name === target && manageableBundle(b))) {
          throw stateError("目标必须是现有可管理的用户包或官方可选包");
        }
        const result = await ctx.pluginManager.setBundleEnabled(target, parsed.enabled);
        sendJson(res, 200, { ok: true, value: result });
        return;
      }

      if (suffix === "/state/actions") {
        if (method !== "POST") {
          res.writeHead(405, { allow: "POST" }); res.end("method not allowed"); return;
        }
        if (req.headers[GATE_HEADER] === undefined) throw stateError(`缺少 ${GATE_HEADER} 请求头`);
        let parsed;
        try { parsed = JSON.parse(await readBody(req)); }
        catch (error) { throw stateError(`请求体不是合法 JSON：${error?.message ?? error}`); }
        sendJson(res, 200, await operations.act(parsed)); return;
      }

      if (suffix !== "/state") {
        sendJson(res, 404, { ok: false, error: { message: `未知路径 ${suffix}` } });
        return;
      }

      if (method === "GET") {
        sendJson(res, 200, await operations.list());
        return;
      }

      if (method === "PUT") {
        if (req.headers[GATE_HEADER] === undefined) {
          sendJson(res, 400, { ok: false, error: { message: `缺少 ${GATE_HEADER} 请求头` } });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(await readBody(req));
        } catch (error) {
          sendJson(res, 400, { ok: false, error: { message: `请求体不是合法 JSON：${error?.message ?? error}` } });
          return;
        }
        const next = await enqueue(async () => {
          const bundles = await ctx.pluginManager.listBundles();
          const current = await readState(dir, bundles);
          const value = mergeState(current, parsed);
          await writeState(dir, value); return value;
        });
        sendJson(res, 200, { ok: true, value: next, paths: { dir, file } });
        return;
      }

      res.writeHead(405, { allow: "GET, PUT", "content-type": "text/plain; charset=utf-8" });
      res.end("method not allowed");
    } catch (error) {
      ctx.logger?.warn?.(`plugin-packs: ${method} ${suffix} failed: ${error?.stack ?? error}`);
      if (!res.headersSent) {
        sendJson(res, error?.status ?? 500, { ok: false, error: { message: String(error?.message ?? error) } });
      } else {
        res.end();
      }
    }
  };
}

/**
 * 挂上数据路由。所有文件写入串行化：界面连续点标签时不会互相吞掉更新。
 *
 * @param {object} ctx 宿主根上下文
 * @param {object|undefined} config 行配置
 */
export function apply(ctx, config) {
  ctx.inject(["webServer"], (webCtx) => {
    const dir = resolveStorageDir(ctx, config);
    const file = path.join(dir, STATE_FILE);
    let tail = Promise.resolve();
    const enqueue = (task) => {
      const run = tail.then(task, task);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };

    const wrap = (value) => ({ ok: true, value, paths: { dir, file } });
    // Both callers share this operation and queue; no HTTP loopback or duplicate state logic.
    const operations = {
      list: () => enqueue(async () => {
        const bundles = await ctx.pluginManager.listBundles();
        const current = await readState(dir, bundles);
        const next = classifyState(current, bundles);
        if (JSON.stringify(next) !== JSON.stringify(current)) {
          next.revision = current.revision + 1;
          await writeState(dir, next);
        }
        return wrap(next);
      }),
      act: (action) => enqueue(async () => {
        const bundles = await ctx.pluginManager.listBundles();
        const current = await readState(dir, bundles);
        const next = applyStateAction(current, action, bundles, randomUUID());
        await writeState(dir, next); return wrap(next);
      }),
    };
    webCtx.inject?.(["tools"], (toolCtx) => {
      if (!toolCtx.tools) return;
      toolCtx.effect(() => toolCtx.tools.register(createPacksTool(operations)), "plugin-packs: organization tool");
    });
    ctx.logger?.info?.(`plugin-packs: 标签数据 ${file}`);
    webCtx.effect(
      () => webCtx.webServer.register({ kind: "prefix", path: ROUTE, handler: makeHandler({ dir, ctx, enqueue, operations }) }),
      "plugin-packs: state route",
    );
  });
}
