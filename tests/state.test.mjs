import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeState, seedState, classifyState, inferAutoTags, mergeState, applyStateAction, readState, writeState } from "../lib/state.js";
import { apply } from "../lib/index.js";
const bundle = (name, extra = {}) => ({ name, availability: "profile", installed: true, rows: [], ...extra });
const inventory = () => [bundle("novel-reader"), bundle("search-web"), bundle("unknown-xyz")];
const gate = { "x-plugin-packs": "1" };
const temporary = async (fn) => { const dir = await mkdtemp(path.join(tmpdir(), "packs-state-")); try { await fn(dir); } finally { await rm(dir, { force: true, recursive: true }); } };

async function harness(run, bundles = inventory()) {
  return temporary(async (dir) => {
    let handler; let tool; let mutations = 0;
    const webCtx = { effect: (fn) => fn(), webServer: { register: (route) => { handler = route.handler; return () => {}; } },
      inject: (_keys, fn) => fn({ effect: (fn) => fn(), tools: { register: (definition) => { tool = definition; return () => {}; } } }) };
    const ctx = { pluginManager: { listBundles: async () => structuredClone(bundles), listPlugins: async () => [],
      setBundleEnabled: async () => { mutations++; return { changed: true }; } }, inject: (_keys, fn) => fn(webCtx) };
    apply(ctx, { storageDir: dir });
    const request = async (suffix, { method = "GET", body, headers = {} } = {}) => {
      const req = new PassThrough(); req.url = `/plugin-packs/api${suffix}`; req.method = method; req.headers = headers;
      let status; let payload; let responseHeaders;
      const res = { headersSent: false, writeHead: (s, h) => { status = s; responseHeaders = h; res.headersSent = true; }, end: (s) => { payload = s; } };
      const done = handler(req, res); req.end(typeof body === "string" ? body : JSON.stringify(body ?? {})); await done;
      const raw = payload?.toString() ?? "";
      return { status, headers: responseHeaders, body: raw.startsWith("{") ? JSON.parse(raw) : raw };
    };
    const post = (body) => request("/state/actions", { method: "POST", headers: gate, body });
    const put = (body) => request("/state", { method: "PUT", headers: gate, body });
    await run({ dir, request, post, put, bundles, tool, mutations: () => mutations });
  });
}

test("v2 defaults, normalization, proto keys and single group membership are safe", () => {
  const state = normalizeState(JSON.parse('{"version":2,"tags":[],"packs":{"__proto__":{"tags":["novel"]},"constructor":{"autoClassified":true}},"groups":[{"id":"1","name":"one","members":["__proto__","a"]},{"id":"2","name":"two","members":["a","gone"]}]}'));
  assert.equal(state.version, 2); assert.equal(state.revision, 0);
  assert.ok(Object.hasOwn(state.packs, "__proto__")); assert.deepEqual(state.packs.__proto__.tags, ["novel"]);
  assert.deepEqual(state.groups[1].members, ["gone"]); assert.equal({}.autoClassified, undefined);
  assert.equal(seedState().tags.length, 7); assert.deepEqual(seedState().groups, []);
});

test("local classifier uses all localized metadata and row metadata; unknown has no tools fallback", () => {
  const ids = new Set(seedState().tags.map((t) => t.id));
  const b = bundle("opaque", { meta: { title: { en: "opaque", zh: "小说" }, description: { fr: "security auditing" } }, rows: [{ meta: { description: { ja: "跨会话记忆" } } }] });
  assert.deepEqual(inferAutoTags(b, ids), ["novel", "sec", "mem"]);
  assert.deepEqual(inferAutoTags(bundle("opaque", { description: "unrecognized" }), ids), []);
  assert.deepEqual(inferAutoTags(bundle("shell-utility"), ids), ["tools"]);
  assert.deepEqual(inferAutoTags(bundle("local-imagegen"), ids), ["tools"]);
  assert.deepEqual(inferAutoTags(bundle("opaque", { description: "Local image generation utility" }), ids), ["tools"]);
  assert.deepEqual(inferAutoTags(bundle("novel-reader"), new Set()), []);
});

test("incidental search/filter, UI and tool wording does not turn management or memory into those categories", () => {
  const ids = new Set(seedState().tags.map((t) => t.id));
  const manager = bundle("pack-manager", { meta: { title: { zh: "插件包管理器", en: "Pack manager" },
    description: { zh: "管理插件包，支持搜索与范围筛选，提供界面提示和工具入口", en: "Manage packages with search and range filters, UI hints and tools." } } });
  assert.deepEqual(inferAutoTags(manager, ids), []);
  const memory = bundle("persistent-memory", { description: "跨会话记忆，提供检索工具和界面提示，支持模型读取、章节上下文。UI tools for search and filtering.",
    rows: [{ meta: { title: "记录", description: "搜索工具及UI提示；tools, chapters and model integrations" } }] });
  assert.deepEqual(inferAutoTags(memory, ids), ["mem"]);
  for (const description of ["搜索 检索 UI 工具 章节 模型", "search retrieval UI tools chapters model", "Supports browsing and searching settings", "主题字段与模型字段可检索"]) {
    assert.deepEqual(inferAutoTags(bundle("opaque", { description }), ids), []);
  }
});

test("strong package/title identity remains usable; description purposes and row titles remain useful", () => {
  const ids = new Set(seedState().tags.map((t) => t.id));
  const cases = [
    ["novel", "novel", "小说创作和章节续写"], ["search", "search", "联网搜索与网页抓取"],
    ["ui", "theme", "界面美化和壁纸切换"], ["sec", "security", "漏洞扫描与安全审计"],
    ["model", "llm", "模型渠道接入与推理网关"], ["mem", "memory", "跨会话记忆与知识库"],
    ["tools", "utility", "终端命令执行和自动化"],
  ];
  for (const [id, identity, description] of cases) {
    assert.deepEqual(inferAutoTags(bundle(`pack-${identity}`), ids), [id]);
    assert.deepEqual(inferAutoTags(bundle("opaque", { meta: { title: { en: identity } } }), ids), [id]);
    assert.deepEqual(inferAutoTags(bundle("opaque", { rows: [{ meta: { title: { en: identity } } }] }), ids), [id]);
    assert.deepEqual(inferAutoTags(bundle("opaque", { description }), ids), [id]);
    assert.deepEqual(inferAutoTags(bundle("opaque", { rows: [{ meta: { description: { zh: description } } }] }), ids), [id]);
  }
  for (const description of ["web search across search engines", "internet search", "web crawler"]) {
    assert.deepEqual(inferAutoTags(bundle("opaque", { description }), ids), ["search"]);
  }
});

test("force reclassification removes obsolete noisy automatic tags but preserves manual/suppression state", () => {
  const state = seedState(); state.packs["memory-store"] = { tags: ["model"], autoTags: ["mem", "search", "ui", "tools"], suppressedTags: ["novel"], autoClassified: true };
  const next = classifyState(state, [bundle("memory-store", { description: "记忆存储，提供搜索筛选、UI和工具入口" })], { force: true });
  assert.deepEqual(next.packs["memory-store"], { tags: ["model"], autoTags: ["mem"], suppressedTags: ["novel"], autoClassified: true });
  assert.deepEqual(state.packs["memory-store"].autoTags, ["mem", "search", "ui", "tools"]);
});

test("classification is pure, respects manual/suppressed IDs and does not prune absent package data", () => {
  const state = seedState(); state.packs.old = { tags: ["mem"] }; state.groups = [{ id: "g", name: "g", members: ["gone"] }];
  state.packs["novel-reader"] = { tags: ["novel"], suppressedTags: ["search"] };
  const before = JSON.stringify(state);
  const next = classifyState(state, [bundle("novel-reader", { description: "web search" })], { force: true });
  assert.equal(JSON.stringify(state), before); assert.deepEqual(next.packs["novel-reader"].autoTags, undefined);
  assert.equal(next.packs["novel-reader"].autoClassified, true); assert.deepEqual(next.packs.old.tags, ["mem"]);
  assert.deepEqual(next.groups, state.groups);
});

test("migration backs up original once, keeps manual tags and marks current installed packages processed", async () => temporary(async (dir) => {
  const raw = '{"version":1,"tags":[{"id":"novel","label":"mine"}],"packs":{"novel-reader":{"tags":["novel"]},"gone":{"tags":["novel"]}}}';
  await writeFile(path.join(dir, "packs.json"), raw);
  const migrated = await readState(dir, inventory());
  assert.equal(await readFile(path.join(dir, "packs.json.v1.bak"), "utf8"), raw);
  assert.equal(migrated.version, 2); assert.deepEqual(migrated.packs["novel-reader"].tags, ["novel"]);
  assert.equal(migrated.packs["search-web"].autoClassified, true); assert.equal(migrated.packs.gone.autoClassified, true);
  assert.equal(migrated.packs["search-web"].autoTags, undefined);
  await readState(dir, inventory());
  assert.deepEqual((await readdir(dir)).sort(), ["packs.json", "packs.json.v1.bak"]);
}));

test("future version is refused intact; invalid JSON is backed up before rebuilding", async () => temporary(async (dir) => {
  const file = path.join(dir, "packs.json"); await writeFile(file, '{"version":99}');
  await assert.rejects(readState(dir), (e) => e.status === 409); assert.equal(await readFile(file, "utf8"), '{"version":99}');
  assert.deepEqual(await readdir(dir), ["packs.json"]);
  await writeFile(file, "{broken"); await readState(dir);
  const backup = (await readdir(dir)).find((n) => n.startsWith("packs.json.broken-"));
  assert.equal(await readFile(path.join(dir, backup), "utf8"), "{broken"); assert.equal(JSON.parse(await readFile(file)).version, 2);
}));

test("failed migration backup cannot replace state", async () => temporary(async (dir) => {
  const file = path.join(dir, "packs.json"); const raw = '{"version":1,"packs":{}}';
  await writeFile(file, raw); await mkdir(path.join(dir, "packs.json.v1.bak"));
  // An existing directory is not a valid original backup.
  await assert.rejects(readState(dir, inventory())); assert.equal(await readFile(file, "utf8"), raw);
}));

test("bad JSON cannot be rebuilt when backup fails (fault injection)", async () => temporary(async (dir) => {
  const file = path.join(dir, "packs.json"); await writeFile(file, "{broken");
  await assert.rejects(readState(dir, [], { backup: async () => { throw Object.assign(new Error("backup denied"), { code: "EACCES" }); } }), /backup denied/);
  assert.equal(await readFile(file, "utf8"), "{broken"); assert.deepEqual(await readdir(dir), ["packs.json"]);
}));

test("GET classifies only new user-install packages, records unmatched as seen and does not reclassify", async () => harness(async ({ request, bundles, dir }) => {
  const first = (await request("/state")).body.value;
  assert.deepEqual(first.packs["novel-reader"].autoTags, ["novel"]); assert.equal(first.packs["unknown-xyz"].autoClassified, true);
  bundles[2].description = "security";
  const second = (await request("/state")).body.value; assert.deepEqual(second, first);
  assert.equal(JSON.parse(await readFile(path.join(dir, "packs.json"))).revision, first.revision);
}));

test("readonly, installation and otherMode packages are excluded from automatic tags and new groups", async () => harness(async ({ request, post, mutations }) => {
  const doc = (await request("/state")).body.value; assert.deepEqual(Object.keys(doc.packs), ["novel-reader"]);
  for (const name of ["search-system", "mem-readonly", "@deepseek-ai/dsh-sdk-app", "missing"]) {
    assert.equal((await post({ action: "group-create", name: "g", members: [name] })).status, 400);
    assert.equal((await request("/bundles/enabled", { method: "POST", headers: gate, body: { name, enabled: true } })).status, 400);
  }
  assert.equal(mutations(), 0);
}, [bundle("novel-reader"), bundle("search-system", { availability: "installation" }), bundle("mem-readonly", { readOnlyReason: "management-required" }), bundle("@deepseek-ai/dsh-sdk-app", { otherMode: true })]));

test("official optional bundles can be grouped/toggled but never auto-classified; runtime modes are always excluded", async () => harness(async ({ request, post, mutations }) => {
  const state = (await request("/state")).body.value; assert.deepEqual(state.packs, {});
  const created = await post({ action: "group-create", name: "official", members: ["official-optional"] }); assert.equal(created.status, 200);
  assert.equal((await request("/bundles/enabled", { method: "POST", headers: gate, body: { name: "official-optional", enabled: true } })).status, 200);
  for (const name of ["@deepseek-ai/dsh-acp-app", "@deepseek-ai/dsh-headless", "@deepseek-ai/dsh-sdk-app", "@deepseek-ai/dsh-sdk-minimal"]) {
    assert.equal((await post({ action: "group-add", id: created.body.value.groups[0].id, members: [name] })).status, 400);
    assert.equal((await request("/bundles/enabled", { method: "POST", headers: gate, body: { name, enabled: true } })).status, 400);
  }
  assert.equal(mutations(), 1);
}, [bundle("official-optional", { availability: "installation", optional: true, installed: false }), ...["@deepseek-ai/dsh-acp-app", "@deepseek-ai/dsh-headless", "@deepseek-ai/dsh-sdk-app", "@deepseek-ai/dsh-sdk-minimal"].map((name) => bundle(name))]));

test("explicit empty suppression clears intent without resurrecting it on later PUTs", () => {
  const current = seedState(); current.packs.a = { suppressedTags: ["novel"], autoClassified: true };
  const input = structuredClone(current); input.packs.a.suppressedTags = [];
  const saved = mergeState(current, input); assert.equal(saved.packs.a.suppressedTags, undefined);
  const again = mergeState(saved, { ...saved, packs: {} }); assert.equal(again.packs.a.suppressedTags, undefined);
});

test("PUT automatic removal intent persists over force reclassification, deleted tags never regenerate", async () => harness(async ({ request, put, post }) => {
  const doc = (await request("/state")).body.value;
  doc.packs["novel-reader"].autoTags = []; doc.packs["novel-reader"].suppressedTags = ["novel"];
  doc.tags = doc.tags.filter((t) => t.id !== "search");
  assert.equal((await put(doc)).status, 200);
  const result = await post({ action: "auto-tag" }); assert.equal(result.status, 200);
  assert.deepEqual(result.body.value.packs["novel-reader"].suppressedTags, ["novel"]);
  assert.equal(result.body.value.packs["novel-reader"].autoTags, undefined);
  assert.equal(result.body.value.packs["search-web"].autoTags, undefined);
  assert.ok(!result.body.value.tags.some((t) => t.id === "search"));
}));

test("PUT keeps missing auto metadata/groups and rejects stale revisions and v1 writes", async () => harness(async ({ request, post, put }) => {
  const initial = (await request("/state")).body.value;
  const created = (await post({ action: "group-create", name: "g", members: ["novel-reader"] })).body.value;
  assert.equal((await put(initial)).status, 409); assert.equal((await put({ version: 1, tags: [], packs: {} })).status, 409);
  const next = await put({ version: 2, revision: created.revision, tags: created.tags, packs: {} });
  assert.deepEqual(next.body.value.groups, created.groups); assert.equal(next.body.value.packs["novel-reader"].autoClassified, true);
  assert.deepEqual(next.body.value.packs["novel-reader"].autoTags, ["novel"]);
}));

test("group create/move/remove/rename/dissolve are state-only, empty groups remain", async () => harness(async ({ post, mutations }) => {
  let doc = (await post({ action: "group-create", name: "one", members: ["novel-reader"] })).body.value;
  const first = doc.groups[0].id; assert.match(first, /^[a-f\d-]{36}$/);
  doc = (await post({ action: "group-create", name: "two", members: ["novel-reader", "search-web"] })).body.value;
  const second = doc.groups[1].id; assert.deepEqual(doc.groups[0].members, []);
  doc = (await post({ action: "group-add", id: first, members: ["novel-reader"] })).body.value;
  assert.deepEqual(doc.groups[1].members, ["search-web"]);
  doc = (await post({ action: "group-remove", id: first, members: ["novel-reader"] })).body.value;
  assert.deepEqual(doc.groups[0].members, []);
  doc = (await post({ action: "group-rename", id: first, name: "renamed" })).body.value; assert.equal(doc.groups[0].name, "renamed");
  doc = (await post({ action: "group-dissolve", id: second })).body.value; assert.equal(doc.groups.length, 1); assert.equal(mutations(), 0);
}));

test("uninstalled group members and tag data persist but cannot trigger enable; removal remains allowed", async () => harness(async ({ request, post, bundles, mutations }) => {
  const doc = (await post({ action: "group-create", name: "g", members: ["novel-reader"] })).body.value;
  bundles.splice(0, 1);
  const state = (await request("/state")).body.value; assert.deepEqual(state.groups[0].members, ["novel-reader"]);
  assert.equal((await request("/bundles/enabled", { method: "POST", headers: gate, body: { name: "novel-reader", enabled: false } })).status, 400);
  const removed = await post({ action: "group-remove", id: doc.groups[0].id, members: ["novel-reader"] });
  assert.deepEqual(removed.body.value.groups[0].members, []); assert.equal(mutations(), 0);
}));

test("concurrent group modifications serialize latest-state read-modify-write without lost changes", async () => harness(async ({ post, request }) => {
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => post({ action: "group-create", name: `g${i}`, members: ["novel-reader"] })));
  assert.ok(responses.every((r) => r.status === 200));
  const doc = (await request("/state")).body.value;
  assert.equal(doc.groups.length, 12); assert.equal(doc.groups.flatMap((g) => g.members).length, 1);
  assert.ok(doc.revision >= 12);
}));

test("HTTP validates gate/JSON/method/action/members/name; read-only inventory never creates state", async () => harness(async ({ request, post, dir }) => {
  for (const suffix of ["/bundles", "/diagnostics"]) assert.equal((await request(suffix)).status, 200);
  assert.deepEqual(await readdir(dir), []);
  assert.equal((await request("/state/actions", { method: "POST", body: { action: "auto-tag" } })).status, 400);
  assert.equal((await request("/state", { method: "PUT", body: {} })).status, 400);
  assert.equal((await request("/state/actions", { method: "POST", headers: gate, body: "{" })).status, 400);
  assert.equal((await request("/state/actions", { method: "OPTIONS" })).status, 405);
  assert.equal((await request("/no-such-route")).status, 404);
  for (const body of [{}, { action: "unknown" }, { action: "group-create", name: "g", members: [] },
    { action: "group-create", name: "g", members: ["novel-reader", " novel-reader "] },
    { action: "group-create", name: "x".repeat(121), members: ["novel-reader"] },
    { action: "group-create", name: "g", members: [42] }]) assert.equal((await post(body)).status, 400);
}));

test("concurrent PUT with same revision accepts one writer and reports the other as stale", async () => harness(async ({ request, put }) => {
  const doc = (await request("/state")).body.value;
  const replies = await Promise.all([put({ ...doc, tags: [...doc.tags, { id: "a", label: "A" }] }), put({ ...doc, tags: [...doc.tags, { id: "b", label: "B" }] })]);
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
}));

test("v1 GET does not classify existing packages; explicit auto-tag does, later new installs classify automatically", async () => harness(async ({ dir, request, post, bundles }) => {
  await writeFile(path.join(dir, "packs.json"), JSON.stringify({ version: 1, tags: seedState().tags, packs: {} }));
  let doc = (await request("/state")).body.value;
  assert.equal(doc.packs["novel-reader"].autoTags, undefined); assert.equal(doc.packs["novel-reader"].autoClassified, true);
  doc = (await post({ action: "auto-tag" })).body.value; assert.deepEqual(doc.packs["novel-reader"].autoTags, ["novel"]);
  bundles.push(bundle("memory-new")); doc = (await request("/state")).body.value;
  assert.deepEqual(doc.packs["memory-new"].autoTags, ["mem"]);
}));

test("HTTP rejects oversized state body and leaves state untouched", async () => harness(async ({ request, dir }) => {
  const reply = await request("/state/actions", { method: "POST", headers: gate, body: "x".repeat(512 * 1024 + 1) });
  assert.equal(reply.status, 400); assert.deepEqual(await readdir(dir), []);
}));

test("agent tool and HTTP share state operations, queue, validation errors and no enablement", async () => harness(async ({ tool, request, post, mutations }) => {
  assert.equal(tool.name, "plugin_packs");
  assert.ok(!tool.parameters.properties.action.enum.some((a) => /enabled|approve|confirm/.test(a)));
  const listed = await tool.execute({ action: "list" }); assert.deepEqual(listed, (await request("/state")).body);
  const created = await tool.execute({ action: "group-create", name: "tool-folder", members: ["novel-reader"] });
  assert.deepEqual(created.value, (await request("/state")).body.value);
  const id = created.value.groups[0].id;
  const httpRenamed = await post({ action: "group-rename", id, name: "http-folder" });
  assert.deepEqual(httpRenamed.body, await tool.execute({ action: "list" }));
  for (const action of [{ action: "group-add", id, members: ["absent"] }, { action: "group-remove", id, members: [] },
    { action: "group-rename", id: "absent", name: "g" }, { action: "enable", enabled: true }]) {
    const response = await post(action);
    await assert.rejects(tool.execute(action), (error) => error.status === response.status && error.message === response.body.error.message);
  }
  await tool.execute({ action: "group-add", id, members: ["search-web"] });
  await tool.execute({ action: "group-remove", id, members: ["novel-reader"] });
  await tool.execute({ action: "auto-tag" });
  const dissolved = await tool.execute({ action: "group-dissolve", id }); assert.deepEqual(dissolved.value.groups, []);
  assert.equal(mutations(), 0); assert.deepEqual(tool.output.render({}, listed), [{ type: "text", text: JSON.stringify(listed) }]);
}));

test("pure group actions and PUT do not mutate caller documents", () => {
  const doc = classifyState(seedState(), inventory()); const old = JSON.stringify(doc);
  const grouped = applyStateAction(doc, { action: "group-create", name: "g", members: ["novel-reader"] }, inventory(), "id");
  assert.equal(JSON.stringify(doc), old); const saved = mergeState(grouped, structuredClone(grouped));
  assert.equal(saved.revision, grouped.revision + 1); assert.equal(grouped.revision, doc.revision + 1);
});
