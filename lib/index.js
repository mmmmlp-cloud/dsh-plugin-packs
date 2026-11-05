/**
 * Host half of dsh-plugin-packs（插件包管理器）。
 *
 * 这一半做浏览器做不到的三件事，全部经同源路由暴露：
 *   1. 读内核的插件清单（`ctx.pluginManager` 的 listBundles / listPlugins）；
 *   2. 整包启停（`setBundleEnabled`，把官方 ChangeResult 原样交回界面）；
 *   3. 把标签数据落成用户能看见、能备份、能手改的文件。
 *
 *   GET  /plugin-packs/api/health           -> { build, route, dir, file }
 *   GET  /plugin-packs/api/bundles          -> { bundles, plugins }
 *   POST /plugin-packs/api/bundles/enabled  -> 官方 ChangeResult
 *   GET  /plugin-packs/api/state            -> 标签文档
 *   PUT  /plugin-packs/api/state            -> 落盘后的标签文档
 *
 * 为什么是「同源路由」而不是让浏览器自己调远程命名空间：`webServer.register` 是
 * 公开 seam，同源意味着端口、CORS、token 全都不用操心；而且每条路由都能用 curl
 * 单独验证，不受客户端远程装配顺序影响（那一层失败时是静默的，最难查）。
 *
 * 安全：写操作必须带 `x-plugin-packs` 这个自定义头。跨源页面要设自定义头就会
 * 触发预检，而这条路由不回答预检，于是「别的本地页面顺手改你的插件状态」这条路
 * 被堵住。路由本身只在本机 loopback 上，并由宿主的 renderer-token 闸门把关。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const name = "dsh-plugin-packs";
/**
 * 需要 web server 挂路由，需要 pluginManager 读包清单与整包启停。
 * `pluginManager` 是 dsh-base 的核心行，永远在；声明它等于「本插件依赖内核的插件管理能力」，
 * 而不是去赌浏览器端有没有把 `remote.pluginManager` 命名空间挂出来。
 */
export const inject = ["webServer", "pluginManager"];

/** 健康检查里回报的构建标记：用来判断宿主 half 是否已换成新代码（改完不用猜）。 */
const BUILD = "host-route/1";

/** 路由前缀，必须与 lib/client.js 里的 STATE_URL 保持一致。 */
const ROUTE = "/plugin-packs/api";
/** PUT 的防跨源门槛头，同样与浏览器 half 保持一致。 */
const GATE_HEADER = "x-plugin-packs";
/** 数据目录名（相对 $DSH_HOME）。 */
const STORAGE_DIR_NAME = "plugin-packs";
const STATE_FILE = "packs.json";
const STATE_VERSION = 1;
const MAX_BODY_BYTES = 512 * 1024;

/**
 * 出厂标签表。只在首次生成 packs.json 时写入一次；之后文件即事实来源，
 * 用户在界面里改名/删标签不会再被这里覆盖。
 */
const DEFAULT_TAGS = [
  { id: "novel", label: "小说 · 阅读", color: "#7B68EE" },
  { id: "search", label: "联网搜索", color: "#4C9AFF" },
  { id: "ui", label: "界面美化", color: "#E8A33D" },
  { id: "sec", label: "安全 · 渗透", color: "#D9534F" },
  { id: "model", label: "模型渠道", color: "#3AA76D" },
  { id: "mem", label: "记忆 · 知识", color: "#17A2B8" },
  { id: "tools", label: "工具 · 其它", color: "#8E8E93" },
];

/**
 * 首次生成时的预分类（键 = 包名，不是 entryId：重装/升级都不丢）。
 *
 * **出厂为空是有意的**：
 *   1. 谁在用哪些插件是使用者的私人信息，装一个管理插件的工具不该顺手把
 *      "作者用过什么" 印进代码里；
 *   2. 陌生人机器上根本没有这些包，预填只会变成一堆对不上号的噪音。
 * 所以只预置上面那套「通用分类词表」，具体哪个包属于哪类，由使用者自己打标签
 * （打过的会写进 packs.json，之后一直跟着走）。
 */
const DEFAULT_PACKS = {};

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

/**
 * 把任意来源的文档收敛成可信形状。宽容读取、严格写出：
 * 坏字段丢掉而不是整份作废，用户手改错了也不会丢光标签。
 *
 * @param {unknown} raw
 * @returns {{ version: number, tags: Array<object>, packs: Record<string, object> }}
 */
function normalizeState(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const seen = new Set();
  const tags = [];
  for (const entry of Array.isArray(source.tags) ? source.tags : []) {
    if (entry === null || typeof entry !== "object") continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    tags.push({
      id,
      label: typeof entry.label === "string" && entry.label.trim().length > 0 ? entry.label.trim() : id,
      color: typeof entry.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(entry.color.trim()) ? entry.color.trim() : "#8E8E93",
    });
  }
  const packs = {};
  const rawPacks = source.packs !== null && typeof source.packs === "object" ? source.packs : {};
  for (const [packName, entry] of Object.entries(rawPacks)) {
    const key = packName.trim();
    if (key.length === 0 || entry === null || typeof entry !== "object") continue;
    const record = {};
    if (typeof entry.name === "string" && entry.name.trim().length > 0) record.name = entry.name.trim().slice(0, 120);
    if (Array.isArray(entry.tags)) {
      const kept = [];
      for (const tag of entry.tags) {
        if (typeof tag !== "string") continue;
        const id = tag.trim();
        if (id.length === 0 || kept.includes(id)) continue;
        kept.push(id);
      }
      if (kept.length > 0) record.tags = kept;
    }
    if (Object.keys(record).length > 0) packs[key] = record;
  }
  return { version: STATE_VERSION, tags, packs };
}

/** 出厂文档（首次生成 / 文件坏掉重置时用）。 */
function seedState() {
  return normalizeState({ version: STATE_VERSION, tags: DEFAULT_TAGS, packs: DEFAULT_PACKS });
}

/**
 * 读状态；文件不存在则按出厂内容建好，文件坏掉则改名留底后重建。
 *
 * @param {string} dir 数据目录
 * @param {object} ctx 宿主上下文（只为记日志）
 * @returns {Promise<object>} 归一化后的状态文档
 */
async function readState(dir, ctx) {
  const file = path.join(dir, STATE_FILE);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const fresh = seedState();
    await writeState(dir, fresh);
    ctx.logger?.info?.(`plugin-packs: seeded ${file}`);
    return fresh;
  }
  try {
    return normalizeState(JSON.parse(raw));
  } catch {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const aside = `${file}.broken-${stamp}`;
    try {
      await writeFile(aside, raw, "utf8");
      ctx.logger?.warn?.(`plugin-packs: ${file} unreadable, kept as ${aside}, reseeding`);
    } catch {
      ctx.logger?.warn?.(`plugin-packs: ${file} unreadable and could not be kept aside, reseeding`);
    }
    const fresh = seedState();
    await writeState(dir, fresh);
    return fresh;
  }
}

/**
 * 原子写：先写同目录临时文件再 rename，避免半截 JSON 卡住下次启动。
 *
 * @param {string} dir 数据目录
 * @param {object} state 已归一化的状态文档
 */
async function writeState(dir, state) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, STATE_FILE);
  const temp = path.join(dir, `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temp, file);
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
function makeHandler({ dir, ctx, enqueue }) {
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
      if (method === "GET" && suffix === "/bundles") {
        const [bundles, plugins] = await Promise.all([
          ctx.pluginManager.listBundles(),
          ctx.pluginManager.listPlugins(),
        ]);
        sendJson(res, 200, { ok: true, value: { bundles, plugins } });
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
        const result = await ctx.pluginManager.setBundleEnabled(target, parsed?.enabled === true);
        sendJson(res, 200, { ok: true, value: result });
        return;
      }

      if (suffix !== "/state") {
        sendJson(res, 404, { ok: false, error: { message: `未知路径 ${suffix}` } });
        return;
      }

      if (method === "GET") {
        const state = await enqueue(() => readState(dir, ctx));
        sendJson(res, 200, { ok: true, value: state, paths: { dir, file } });
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
        const next = normalizeState(parsed);
        await enqueue(() => writeState(dir, next));
        sendJson(res, 200, { ok: true, value: next, paths: { dir, file } });
        return;
      }

      res.writeHead(405, { allow: "GET, PUT", "content-type": "text/plain; charset=utf-8" });
      res.end("method not allowed");
    } catch (error) {
      ctx.logger?.warn?.(`plugin-packs: ${method} ${suffix} failed: ${error?.stack ?? error}`);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: { message: String(error?.message ?? error) } });
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

    ctx.logger?.info?.(`plugin-packs: 标签数据 ${file}`);
    webCtx.effect(
      () => webCtx.webServer.register({ kind: "prefix", path: ROUTE, handler: makeHandler({ dir, ctx, enqueue }) }),
      "plugin-packs: state route",
    );
  });
}
