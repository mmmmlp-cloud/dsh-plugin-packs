/**
 * 离线结构/行为自检（无浏览器，绝非视觉验证）：执行 lib/client.js 组件与事件。
 *
 * 做法：用假 `window.__ModuleLoader__` 捕获 factory，再用一个只替换 hook 的
 * mock React 驱动组件函数 —— `useState` 按调用序号喂种子，`useMemo` / `useCallback`
 * 直接求值，`useEffect` 不跑。任何一个分支里的 ReferenceError 或 undefined 访问
 * 都会在这里炸出来，比「装上去让人点一眼」早一步。
 *
 * 用法：
 *   node scripts/render-check.mjs
 *   node scripts/render-check.mjs --profile "C:/Users/你/.dsh/profiles/desktop"
 *
 * 依赖：react / react-dom 从目标 profile 的 node_modules 取（不额外装包）。
 */
import { createRequire } from "node:module";
import { analyzeHealth, preflightHealth } from "../lib/health.js";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "..");

const profileArgIndex = process.argv.indexOf("--profile");
const profileDir =
	profileArgIndex >= 0 && process.argv[profileArgIndex + 1]
		? process.argv[profileArgIndex + 1]
		: path.join(homedir(), ".dsh", "profiles", "desktop");

const requireProfile = createRequire(path.join(profileDir, "package.json"));
const React = requireProfile("react");
const { renderToStaticMarkup } = requireProfile("react-dom/server");

// ---- 捕获 client.js 的 factory -------------------------------------------------
let captured = null;
globalThis.window = {
	__ModuleLoader__: {
		load(definition) {
			captured = definition;
		},
	},
};

await import(pathToFileURL(path.join(packageDir, "lib", "client.js")).href);
if (captured === null) throw new Error("client.js 没有调用 window.__ModuleLoader__.load");
if (captured.id !== "dsh-plugin-packs") throw new Error(`模块 id 不对：${captured.id}`);

// ---- mock React（只换 hook）----------------------------------------------------
let hookIndex = 0;
let seeds = {};
let hookWrites = {};
const mockReact = {
	createElement: React.createElement,
	Fragment: React.Fragment,
	useState(init) {
		const index = hookIndex++;
		const value = Object.prototype.hasOwnProperty.call(seeds, index) ? seeds[index] : init;
		return [value, (next) => { hookWrites[index] = typeof next === "function" ? next(hookWrites[index] ?? value) : next; }];
	},
	useEffect() {
		// Seeds address useState calls only; effects do not consume a state index.
	},
	useCallback(fn) {
		return fn;
	},
	useMemo(fn) {
		return fn();
	},
	useRef(init) {
		return { current: init };
	},
};

const moduleExports = captured.factory((id) => {
	if (id === "react") return mockReact;
	throw new Error(`意外 require：${id}`);
});
const PacksTab = moduleExports.PacksTab;
if (typeof PacksTab !== "function") throw new Error("PacksTab 未导出");

const t = (key) => moduleExports.dictionaries.zh[key] ?? key;

// ---- 假数据（形状照真实 BundleInfo）--------------------------------------------
const bundle = (name, over) => ({
	name,
	official: false,
	availability: "profile",
	version: "1.0.0",
	description: `${name} 的用途说明。`,
	enabled: true,
	installed: true,
	optional: false,
	removable: true,
	rows: [{ rowId: "main", moduleName: name, entryId: `include:${name}` }],
	overrides: [],
	...over,
});

const BUNDLES = [
	bundle("demo-pack-a"),
	bundle("demo-pack-b"),
	bundle("@demo/aggregate-pack", {
		rows: Array.from({ length: 21 }, (_, i) => ({ rowId: `row-${i}`, moduleName: `pkg-${i}`, entryId: `include:row-${i}` })),
	}),
	bundle("@demo/disabled-pack", { enabled: false, version: "0.1.0-rc.34" }),
	bundle("demo-pack-c", { enabled: false }),
	bundle("@deepseek-ai/dsh-experimental-demo-bundle", {
		official: true,
		availability: "installation",
		installed: false,
		removable: false,
	}),
	bundle("@deepseek-ai/dsh-base", {
		availability: "installation",
		installed: false,
		removable: false,
		readOnlyReason: "management-required",
		description: "dsh 核心",
	}),
	bundle("@deepseek-ai/dsh-headless", { availability: "installation", installed: false, enabled: false, removable: false }),
	bundle("@deepseek-ai/dsh-subagent-missing-demo", {
		availability: "missing",
		installed: false,
		enabled: false,
		removable: false,
		rows: [],
	}),
];

/**
 * 自检用的状态文档。
 *
 * 默认用内置的**示例数据**：断言必须可复现，也不该让这个脚本去读别人机器上的
 * 真实标签文件。即使传入 --live 也只使用 fixtures；这不是浏览器或视觉验证。
 */
const DEMO_DOC = {
	version: 2,
	revision: 1,
	groups: [],
	tags: [
		{ id: "novel", label: "小说 · 阅读", color: "#7B68EE" },
		{ id: "sec", label: "安全 · 渗透", color: "#D9534F" },
	],
	packs: {
		"demo-pack-a": { name: "示例包 A", tags: ["novel"] },
		"@demo/disabled-pack": { name: "示例包 B", tags: ["sec"] },
		"demo-pack-c": { name: "示例包 C", tags: ["sec"] },
	},
};

const DOC = DEMO_DOC;

const PLUGINS = BUNDLES.flatMap((b) =>
	b.rows.map((row) => ({
		entryId: row.entryId,
		moduleName: row.moduleName,
		enabled: b.enabled,
		fiberPhase: b.enabled ? "active" : null,
	})),
);

const api = {
	loadPacks: async () => ({ bundles: BUNDLES, plugins: PLUGINS }),
	loadState: async () => DOC,
	saveState: async (next) => next,
	resolveText: (value) => (typeof value === "string" ? value : value?.zh ?? value?.en),
};

function render(seedByIndex) {
	hookIndex = 0;
	seeds = seedByIndex ?? {};
	return renderToStaticMarkup(React.createElement(PacksTab, { api, t }));
}

let failures = 0;
function check(label, condition, extra) {
	if (condition) console.log(`  ok   ${label}`);
	else {
		failures += 1;
		console.log(`  FAIL ${label}${extra === undefined ? "" : ` -> ${extra}`}`);
	}
}

// 主页面 useState 序号：0 bundles 1 plugins 2 doc 3 error 4 loading 5 busyPack
// 6 toast 7 query 8 tagFilter 9 scope 10 showSystem 11 selected
// 12 diagnostics 13 onlyProblems 14 review 15 groupName 16 targetGroup 17 metadataBusy
// 子组件单独测试，不靠全树 hook 序号定位；hookWrites 只记录现有 mock hook setter。
const base = {
	0: BUNDLES,
	1: PLUGINS,
	2: DOC,
	3: null,
	4: false,
	5: null,
	6: null,
	7: "",
	8: "*",
	9: "mine",
	10: false,
	11: {},
	12: analyzeHealth(BUNDLES, PLUGINS, "2026-01-01T00:00:00.000Z"),
	13: false,
	14: null,
	15: "",
	16: "",
	17: false,
};

console.log("[1] 默认视图（范围=我安装的，未筛选）");
const html1 = render(base);
check("两栏都在", (html1.match(/class="ppk-col"/g) ?? []).length === 2);
check("已启用栏标题", html1.includes(t("colEnabled")));
check("未启用栏标题", html1.includes(t("colDisabled")));
check("系统核心默认不出现", !html1.includes("dsh-base"));
check("missing 的包不出现", !html1.includes("subagent-missing-demo"));
check("标签 chip 出现", html1.includes("ppk-chip"));
check("没有 undefined 字样", !/undefined/.test(html1));

console.log("[2] 搜索");
const html2 = render({ ...base, 7: "demo-pack-a" });
check("只剩匹配项", html2.includes("demo-pack-a") && !html2.includes("demo-pack-b"));

console.log("[3] 标签筛选");
const html3 = render({ ...base, 8: "sec" });
check("安全标签命中", html3.includes("demo-pack-c") || html3.includes("示例包 B"));
if (DOC.packs["demo-pack-a"]?.tags?.includes("novel")) {
	check("小说包被筛掉", !html3.includes("示例包 A"));
}

console.log("[4] 显示系统核心");
const html4 = render({ ...base, 10: true });
check("系统区出现", html4.includes("ppk-sys"));
check("dsh-base 出现", html4.includes("dsh-base"));
check("headless 归入系统区", html4.includes("dsh-headless"));

console.log("[5] 范围切到官方可选");
const html5 = render({ ...base, 9: "official" });
check("只剩官方包", html5.includes("experimental-demo-bundle") && !html5.includes("demo-pack-a"));

console.log("[6] 错误态");
const html6 = render({ ...base, 0: null, 3: "pluginManager.listBundles failed: 404: unavailable", 4: false });
check("错误块出现", html6.includes("ppk-error"));
check("显示错误原文", html6.includes("listBundles failed"));

console.log("[7] 第一张卡展开详情");
function renderCard(health = base[12].packs["demo-pack-a"]) {
	hookIndex = 0;
	seeds = { 0: true };
	return renderToStaticMarkup(React.createElement(moduleExports.PackCard, {
		t, pack: { ...BUNDLES[0], displayName: "Demo", defaultName: "Demo", rowActive: { "include:demo-pack-a": true }, rowEnabled: {}, health, tags: [], allTags: [], tagIds: [] },
	}));
}
const html7 = renderCard();
check("详情块出现", html7.includes("ppk-detail"));
check("出现包内行列表", html7.includes("ppk-row"));
check("出现改名输入框", html7.includes("ppk-field"));

console.log("[8] 加载中");
const html8 = render({ ...base, 0: null, 4: true });
check("loading 文案", html8.includes(t("loading")));

console.log("[9] 体检、筛选与预检确认");
check("检查入口与时间", html1.includes(t("healthCheck")) && html1.includes(t("healthTime")));
check("加载状态并非启用状态", html1.includes(t("healthNormal")) && html1.includes(t("healthDisabled")));
check("检查边界明确", html7.includes(t("healthScope")) && html7.includes(t("healthCoverage")));
const broken = analyzeHealth(BUNDLES, PLUGINS.map((row) => row.moduleName === "demo-pack-a" ? { ...row, fiberPhase: "failed", diagnostic: "<script>fixture</script>" } : row), "2026-01-01T00:00:00.000Z");
const html9 = render({ ...base, 12: broken, 13: true });
check("仅看问题保留异常包", html9.includes('data-pack="demo-pack-a"') && !html9.includes('data-pack="demo-pack-b"'));
const finding = broken.packs["demo-pack-a"].issues[0];
const pending = { changes: [{ name: "demo-pack-a", enabled: true }], findings: [finding], blocked: false, fingerprint: "fixture" };
const html10 = render({ ...base, 14: pending });
check("风险确认与取消", html10.includes(t("healthContinue")) && html10.includes(t("healthCancel")));
check("证据不执行HTML", html10.includes("&lt;script&gt;fixture&lt;/script&gt;") && !html10.includes("<script>fixture"));
const html11 = render({ ...base, 14: { ...pending, blocked: true } });
check("阻断不能继续", html11.includes(t("healthBlocked")) && !html11.includes(t("healthContinue")));
const html12 = renderCard(broken.packs["demo-pack-a"]);
check("详情显示问题依据与建议", html12.includes(t("healthEvidence")) && html12.includes(t("healthSuggestion")));

console.log("[10] 操作链路（只用示例 api，不改变真实插件）");
const calls = [];
api.loadPacks = async () => ({ bundles: BUNDLES, plugins: PLUGINS, diagnostics: base[12] });
api.preflight = async (changes) => { calls.push(["preflight", changes]); return preflightHealth(BUNDLES, PLUGINS, changes); };
api.setBundleEnabled = async (name, enabled) => { calls.push(["apply", name, enabled]); return { changed: true, application: "applied" }; };
function treeNodes(tree) {
	const out = [];
	const walk = (node) => { if (Array.isArray(node)) return node.forEach(walk); if (!node?.props) return; out.push(node); walk(node.props.children); };
	walk(tree);
	return out;
}
function componentNodes(component, props, seed = {}) {
	hookIndex = 0;
	seeds = seed;
	hookWrites = {};
	return treeNodes(component(props));
}
function actionNodes(seed = base) {
	return componentNodes(PacksTab, { api, t }, seed);
}
let nodes = actionNodes();
const cardActions = nodes.find((node) => node.props.cardProps).props.cardProps;
await cardActions.onToggle({ name: "demo-pack-c", displayName: "Demo", scope: "mine" }, true);
check("安全启用先预检再执行", calls[0]?.[0] === "preflight" && calls[1]?.[0] === "apply");
calls.length = 0;
await cardActions.onToggle({ name: "demo-pack-a", displayName: "Demo", scope: "mine" }, false);
check("停用风险等待确认、不先改状态", calls.length === 1 && calls[0][0] === "preflight");
calls.length = 0;
const disableChanges = [{ name: "demo-pack-a", enabled: false }];
const disableResult = preflightHealth(BUNDLES, PLUGINS, disableChanges);
const disableFindings = disableResult.findings.filter((item) => item.severity !== "info");
nodes = actionNodes({ ...base, 14: { changes: disableChanges, findings: disableFindings, blocked: false, fingerprint: JSON.stringify(disableFindings) } });
await nodes.find((node) => node.type === "button" && node.props.children === t("healthContinue")).props.onClick();
check("确认后重新预检再执行", calls[0]?.[0] === "preflight" && calls[1]?.[0] === "apply");
calls.length = 0;
nodes = actionNodes({ ...base, 11: { "demo-pack-a": true, "demo-pack-b": true } });
await nodes.find((node) => node.type === "button" && node.props.children === t("batchDisable")).props.onClick();
check("批量预警汇总一次、不逐个先执行", calls.length === 1 && calls[0][1].length === 2);
calls.length = 0;
api.setBundleEnabled = async (name, enabled) => { calls.push(["apply", name, enabled]); return { changed: false, application: "failed", error: { code: "operation-error" } }; };
nodes = actionNodes({ ...base, 11: { "demo-pack-c": true, "@demo/disabled-pack": true } });
await nodes.find((node) => node.type === "button" && node.props.children === t("batchEnable")).props.onClick();
check("批量失败不继续后续目标", calls.filter((item) => item[0] === "apply").length === 1);
calls.length = 0;
api.loadPacks = async () => ({ bundles: BUNDLES.map((item) => item.name === "demo-pack-c" ? { ...item, readOnlyReason: "management-required" } : item), plugins: PLUGINS, diagnostics: base[12] });
await cardActions.onToggle({ name: "demo-pack-c", scope: "mine" }, true);
check("最新清单只读保护阻止变更", calls.length === 0);

console.log("[11] v2 自动/手工标签（fixtures；非视觉验证）");
const clone = (value) => JSON.parse(JSON.stringify(value));
const GROUP = { id: "fixture-group", name: "写作工作台", members: ["demo-pack-a", "demo-pack-c"] };
const V2_DOC = { ...clone(DOC), revision: 20, groups: [GROUP], packs: {
	...clone(DOC.packs),
	"demo-pack-a": { name: "示例包 A", tags: ["novel"], autoTags: ["novel", "sec", "unknown"], suppressedTags: ["sec"], autoClassified: true },
	"demo-pack-b": { tags: ["novel"], autoTags: ["sec"], suppressedTags: ["novel"], autoClassified: true },
} };
const v2base = { ...base, 2: V2_DOC };
const columns = (list) => list.filter((node) => node.type === moduleExports.PackColumn);
// Execute the exported existing column component, not a replacement renderer. Keep the
// parent hook observations intact: the column has its own useState numbering.
function columnNodes(column) {
	const previous = { hookIndex, seeds, hookWrites };
	try { return componentNodes(moduleExports.PackColumn, column.props); }
	finally { ({ hookIndex, seeds, hookWrites } = previous); }
}
const groupNodes = (list) => columns(list).flatMap(columnNodes).filter((node) => node.type === moduleExports.GroupCard);
const groupNode = (list) => groupNodes(list)[0];
const allPacks = (list) => [...columns(list).flatMap((node) => node.props.packs), ...groupNodes(list).flatMap((node) => node.props.members)];
nodes = actionNodes(v2base);
const derivedA = allPacks(nodes).find((pack) => pack.name === "demo-pack-a");
const derivedB = allPacks(nodes).find((pack) => pack.name === "demo-pack-b");
check("自动标签与手工标签去重，suppression 阻止自动标签，未知标签忽略", JSON.stringify(derivedA.tagIds) === '["novel"]');
check("suppression 不抹掉手工标签，自动标签并入有效标签", derivedB.tagIds.includes("novel") && derivedB.tagIds.includes("sec") && derivedB.tags.find((tag) => tag.id === "sec").annotation === t("autoTagMark"));
const secNodes = actionNodes({ ...v2base, 8: "sec" });
const secVisible = [...columns(secNodes).flatMap((node) => node.props.packs), ...groupNodes(secNodes).flatMap((node) => node.props.visibleMembers)];
check("有效标签用于筛选", !secVisible.some((pack) => pack.name === "demo-pack-a") && secVisible.some((pack) => pack.name === "demo-pack-b"));

console.log("[12] 分组派生与搜索");
nodes = actionNodes(v2base);
check("组成员从独立启停两栏收起", groupNode(nodes)?.props.members.length === 2 && columns(nodes).every((node) => node.props.packs.every((pack) => !GROUP.members.includes(pack.name))));
check("搜索组名命中组及组内成员", groupNode(actionNodes({ ...v2base, 7: GROUP.name }))?.props.visibleMembers.length === 2);
check("搜索成员命中所属组但只显示命中成员", groupNode(actionNodes({ ...v2base, 7: "demo-pack-c" }))?.props.visibleMembers.map((pack) => pack.name).join() === "demo-pack-c");
check("不匹配搜索隐藏组", !groupNode(actionNodes({ ...v2base, 7: "never-match-fixture" })));
const groupProps = groupNode(nodes).props;
check("主树不再有独立分组区，组合真实嵌在插件列的ppk-list内", !nodes.some((node) => node.type === moduleExports.GroupCard) && columns(nodes).some((column) => columnNodes(column).some((node) => node.props.className === "ppk-list" && treeNodes(node.props.children).some((child) => child.type === moduleExports.GroupCard))));
const placements = [
	{ id: "all-on", name: "全部启用", members: ["demo-pack-a", "demo-pack-b"] },
	{ id: "partial", name: "部分启用", members: ["@demo/aggregate-pack", "demo-pack-c"] },
	{ id: "all-off", name: "全部停用", members: ["@demo/disabled-pack"] },
	{ id: "empty", name: "空组合", members: [] },
];
const placedColumns = columns(actionNodes({ ...v2base, 2: { ...clone(V2_DOC), groups: placements } }));
const columnGroupIds = (enabled) => placedColumns.filter((node) => node.props.enabledColumn === enabled).flatMap(columnNodes).filter((node) => node.type === moduleExports.GroupCard).map((node) => node.props.group.id);
check("全部启用和部分启用组合归左栏", JSON.stringify(columnGroupIds(true).sort()) === JSON.stringify(["all-on", "partial"]));
check("全停用和空组合归右栏", JSON.stringify(columnGroupIds(false).sort()) === JSON.stringify(["all-off", "empty"]));
hookIndex = 0; seeds = {};
const groupHtml = renderToStaticMarkup(React.createElement(moduleExports.GroupCard, groupProps));
check("组计数明确部分启用状态", groupHtml.includes(t("groupPartial").replace("{on}", "1").replace("{total}", "2")));

console.log("[13] 分组元数据动作与拖放，不启停");
let fixtureDoc = clone(V2_DOC);
// API fixture owns only in-memory documents; server validation is covered by state tests.
api.loadState = async () => clone(fixtureDoc);
api.stateAction = async (action) => {
	calls.push(["stateAction", clone(action)]);
	const next = clone(fixtureDoc);
	const group = next.groups.find((item) => item.id === action.id);
	if (action.action === "group-create") next.groups.push({ id: "created-fixture", name: action.name, members: [...action.members] });
	else if (action.action === "group-add") group.members = [...new Set([...group.members, ...action.members])];
	else if (action.action === "group-remove") group.members = group.members.filter((name) => !action.members.includes(name));
	else if (action.action === "group-rename") group.name = action.name;
	else if (action.action === "group-dissolve") next.groups = next.groups.filter((item) => item.id !== action.id);
	else if (action.action === "auto-tag") next.packs["demo-pack-a"].autoClassified = true;
	else throw new Error(`Unsupported fixture action: ${action.action}`);
	next.revision++;
	fixtureDoc = next;
	return clone(next);
};
api.loadPacks = async () => ({ bundles: BUNDLES, plugins: PLUGINS, diagnostics: base[12] });
api.setBundleEnabled = async (name, enabled) => { calls.push(["apply", name, enabled]); return { changed: true, application: "applied" }; };
const button = (list, key) => list.find((node) => node.type === "button" && node.props.children === t(key));
const resetFixture = () => { fixtureDoc = clone(V2_DOC); calls.length = 0; };
resetFixture();
nodes = actionNodes({ ...v2base, 11: { "demo-pack-b": true, "@demo/disabled-pack": true }, 15: "选中组合" });
await button(nodes, "groupCreate").props.onClick();
check("选中创建组仅 stateAction，返回 v2 revision 更新", calls.length === 1 && calls[0][1].action === "group-create" && calls[0][1].name === "选中组合" && calls[0][1].members.length === 2 && hookWrites[2]?.revision === 21);
resetFixture();
nodes = actionNodes({ ...v2base, 11: { "demo-pack-b": true }, 16: GROUP.id });
await button(nodes, "groupAdd").props.onClick();
check("选中加入组仅 stateAction", calls.length === 1 && calls[0][1].action === "group-add" && calls[0][1].id === GROUP.id);
resetFixture();
await button(actionNodes(v2base), "autoTag").props.onClick();
check("自动分类入口使用 stateAction", calls.length === 1 && calls[0][1].action === "auto-tag");
resetFixture();
let parentGroup = groupNode(actionNodes(v2base));
let stopped = 0, prevented = 0, accidentalToggle = 0;
const drop = (source) => ({ preventDefault() { prevented++; }, stopPropagation() { stopped++; }, dataTransfer: { types: ["application/x-dsh-plugin-pack"], getData(type) { if (type !== "application/x-dsh-plugin-pack") throw new Error(type); return source; } } });
let childNodes = componentNodes(moduleExports.PackCard, { ...parentGroup.props.cardProps, pack: derivedB, t, busy: false, locked: false, onToggle: () => accidentalToggle++ });
await childNodes.find((node) => typeof node.props.onDrop === "function").props.onDrop(drop("@demo/disabled-pack"));
// Drop handlers intentionally fire-and-forget their serialized metadata operation.
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
check("卡片 combine drop stopPropagation，不触发启停", stopped === 1 && prevented === 1 && accidentalToggle === 0 && calls.length === 1 && calls[0][0] === "stateAction" && calls[0][1].action === "group-create");
resetFixture();
parentGroup = groupNode(actionNodes(v2base));
childNodes = componentNodes(moduleExports.GroupCard, parentGroup.props, { 0: true, 1: "重命名组合", 2: true });
await childNodes.find((node) => node.props["data-group"]).props.onDrop(drop("demo-pack-b"));
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
check("拖入组仅追加成员并阻止冒泡", stopped === 2 && calls.length === 1 && calls[0][1].action === "group-add" && calls[0][1].id === GROUP.id);
resetFixture();
childNodes = componentNodes(moduleExports.GroupCard, groupNode(actionNodes(v2base)).props, { 0: false, 1: "重命名组合", 2: true });
check("折叠组合仍显示可编辑名称和保存按钮", childNodes.some((node) => node.type === "input" && node.props["aria-label"] === t("groupName")) && !!button(childNodes, "nameSave"));
await button(childNodes, "nameSave").props.onClick();
check("折叠组合重命名仅 stateAction", calls.length === 1 && calls[0][1].action === "group-rename" && calls[0][1].name === "重命名组合");
resetFixture();
childNodes = componentNodes(moduleExports.GroupCard, groupNode(actionNodes(v2base)).props, { 0: false, 1: "  回车命名  " });
const nameInput = childNodes.find((node) => node.type === "input" && node.props["aria-label"] === t("groupName"));
await nameInput.props.onKeyDown({ key: "Enter", isComposing: true, preventDefault() {}, stopPropagation() {} });
await nameInput.props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: true }, preventDefault() {}, stopPropagation() {} });
check("中文输入法候选Enter不会提前保存名称", calls.length === 0);
await nameInput.props.onKeyDown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
check("折叠组合Enter保存trim后名称，不启停", calls.length === 1 && calls[0][0] === "stateAction" && calls[0][1].action === "group-rename" && calls[0][1].name === "回车命名");
let inputStops = 0, inputPrevents = 0;
nameInput.props.onPointerDown({ stopPropagation() { inputStops++; } });
nameInput.props.onDragStart({ stopPropagation() { inputStops++; }, preventDefault() { inputPrevents++; } });
nameInput.props.onChange({ target: { value: "输入新名称" } });
check("名称输入支持编辑，阻止冒泡和误拖", hookWrites[1] === "输入新名称" && nameInput.props.draggable === false && inputStops === 2 && inputPrevents === 1);
resetFixture();
childNodes = componentNodes(moduleExports.GroupCard, groupNode(actionNodes(v2base)).props, { 0: true, 2: true });
await childNodes.find((node) => node.type === moduleExports.PackCard).props.onRemoveFromGroup("demo-pack-a");
check("移出成员只改元数据，不停用包", calls.length === 1 && calls[0][0] === "stateAction" && calls[0][1].action === "group-remove");
resetFixture();
childNodes = componentNodes(moduleExports.GroupCard, groupNode(actionNodes(v2base)).props, { 0: true });
button(childNodes, "groupDissolve").props.onClick();
check("解散第一次只进入确认", calls.length === 0 && hookWrites[2] === true);
childNodes = componentNodes(moduleExports.GroupCard, groupNode(actionNodes(v2base)).props, { 0: true, 2: true });
await button(childNodes, "groupDissolveConfirm").props.onClick();
check("确认解散只 stateAction，无 setBundleEnabled", calls.length === 1 && calls[0][0] === "stateAction" && calls[0][1].action === "group-dissolve");

console.log("[14] 整组启停新鲜度、确认与失败中止");
api.preflight = async (changes) => { calls.push(["preflight", clone(changes)]); return { blocked: false, findings: [], report: base[12] }; };
resetFixture();
await button(actionNodes({ ...v2base, 7: GROUP.name, 11: { "demo-pack-c": true } }), "batchEnable").props.onClick();
check("搜索组名后对可见成员勾选，普通批量按钮仍执行", calls[0]?.[0] === "preflight" && calls.filter((call) => call[0] === "apply").map((call) => call[1]).join() === "demo-pack-c");
resetFixture();
const filteredGroup = groupNode(actionNodes({ ...v2base, 7: "demo-pack-a" }));
await filteredGroup.props.onToggle(GROUP, false);
let groupReview = hookWrites[14];
check("整组停用先 preflight 后 whole-group 确认，未先执行", calls.length === 1 && calls[0][0] === "preflight" && groupReview?.findings[0]?.code === "whole-group" && groupReview?.groupIntent?.id === GROUP.id);
calls.length = 0;
await button(actionNodes({ ...v2base, 7: "demo-pack-a", 14: groupReview }), "healthContinue").props.onClick();
check("确认后重新 preflight 并执行整组停用", calls[0]?.[0] === "preflight" && calls.filter((call) => call[0] === "apply").map((call) => call[1]).join() === "demo-pack-a");
resetFixture();
fixtureDoc.groups[0].members.push("demo-pack-b");
await groupNode(actionNodes({ ...v2base, 7: "demo-pack-a" })).props.onToggle(GROUP, false);
groupReview = hookWrites[14];
check("整组停用也包含筛选隐藏的启用成员", calls[0]?.[1]?.length === 2 && calls[0][1].some((change) => change.name === "demo-pack-b") && !calls.some((call) => call[0] === "apply"));
calls.length = 0;
await button(actionNodes({ ...v2base, 14: groupReview }), "healthContinue").props.onClick();
check("确认整组停用执行全部待切换成员", calls.filter((call) => call[0] === "apply").length === 2);
resetFixture();
await groupNode(actionNodes({ ...v2base, 7: "demo-pack-a" })).props.onToggle(GROUP, true);
groupReview = hookWrites[14];
check("整组启用包括被搜索隐藏的停用成员", calls[0]?.[1]?.some((change) => change.name === "demo-pack-c") && !calls.some((call) => call[0] === "apply"));
calls.length = 0;
await button(actionNodes({ ...v2base, 14: groupReview }), "healthContinue").props.onClick();
check("确认后启用隐藏成员", calls.filter((call) => call[0] === "apply").map((call) => call[1]).join() === "demo-pack-c");
resetFixture();
await groupNode(actionNodes(v2base)).props.onToggle(GROUP, true);
groupReview = hookWrites[14];
fixtureDoc.groups[0].members.push("@demo/disabled-pack"); fixtureDoc.revision++;
calls.length = 0;
await button(actionNodes({ ...v2base, 14: groupReview }), "healthContinue").props.onClick();
const changedReview = hookWrites[14];
check("确认时读取最新组成员，变化要求重新确认", !calls.some((call) => call[0] === "apply") && calls[0]?.[1]?.length === 2 && changedReview?.fingerprint !== groupReview.fingerprint && changedReview?.findings[0]?.evidence.includes("@demo/disabled-pack"));
calls.length = 0;
await button(actionNodes({ ...v2base, 14: changedReview }), "healthContinue").props.onClick();
check("再次确认执行新成员清单", calls.filter((call) => call[0] === "apply").length === 2);
resetFixture();
fixtureDoc.groups[0].members.push("@demo/disabled-pack");
await groupNode(actionNodes(v2base)).props.onToggle(GROUP, true);
groupReview = hookWrites[14]; calls.length = 0;
api.setBundleEnabled = async (name, enabled) => { calls.push(["apply", name, enabled]); return { changed: false, application: "failed" }; };
await button(actionNodes({ ...v2base, 14: groupReview }), "healthContinue").props.onClick();
check("整组启停遇失败停止后续成员", calls.filter((call) => call[0] === "apply").length === 1);
for (const unavailable of ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-subagent-missing-demo", "fixture-absent-pack"]) {
	resetFixture(); fixtureDoc.groups[0].members.push(unavailable);
	await groupNode(actionNodes(v2base)).props.onToggle(GROUP, true);
	check(`系统/缺失成员阻止整组切换：${unavailable}`, !calls.some((call) => ["apply", "preflight"].includes(call[0])));
}
resetFixture(); fixtureDoc.groups = [];
await groupNode(actionNodes(v2base)).props.onToggle(GROUP, true);
check("最新状态已解散的组不能切换", !calls.some((call) => ["apply", "preflight"].includes(call[0])));

console.log("[15] 整组停用管理器自身最后执行（仅 fixture）");
resetFixture();
const selfBundle = bundle("dsh-plugin-packs");
const selfBundles = [...BUNDLES, selfBundle];
const selfGroup = { ...GROUP, members: [selfBundle.name, "demo-pack-a", "demo-pack-b"] };
fixtureDoc.groups = [selfGroup];
const selfDoc = clone(fixtureDoc);
api.loadPacks = async () => ({ bundles: selfBundles, plugins: PLUGINS, diagnostics: base[12] });
api.setBundleEnabled = async (name, enabled) => { calls.push(["apply", name, enabled]); return { changed: true, application: "applied" }; };
const selfSeed = { ...v2base, 0: selfBundles, 2: selfDoc };
await groupNode(actionNodes(selfSeed)).props.onToggle(selfGroup, false);
groupReview = hookWrites[14];
check("自身在组成员首位时仍先预检并等待整组确认", calls.length === 1 && calls[0][0] === "preflight" && groupReview?.findings[0]?.code === "whole-group" && groupReview?.findings[0]?.evidence.startsWith(selfBundle.name));
calls.length = 0;
await button(actionNodes({ ...selfSeed, 14: groupReview }), "healthContinue").props.onClick();
check("整组确认停用按其他包→自身执行，避免提前卸载管理路由", calls[0]?.[0] === "preflight" && JSON.stringify(calls.filter((call) => call[0] === "apply").map((call) => [call[1], call[2]])) === JSON.stringify([["demo-pack-a", false], ["demo-pack-b", false], [selfBundle.name, false]]));

console.log("[16] 组合专用拖柄与跨栏预检（仅 fixture）");
resetFixture();
api.loadPacks = async () => ({ bundles: BUNDLES, plugins: PLUGINS, diagnostics: base[12] });
const dragData = new Map();
let dragStopped = 0;
const dragTransfer = { types: ["application/x-dsh-plugin-group"], setData(type, value) { dragData.set(type, value); }, getData(type) { return dragData.get(type) ?? ""; } };
const dragGroupNodes = componentNodes(moduleExports.GroupCard, groupNode(actionNodes(v2base)).props);
const dragHandles = dragGroupNodes.filter((node) => node.props.draggable === true);
check("折叠组合仅专用拖柄可拖，整张article不抢输入事件", dragHandles.length === 1 && dragHandles[0].props["aria-label"] === t("groupDrag") && !dragGroupNodes.find((node) => node.props["data-group"]).props.draggable);
dragHandles[0].props.onDragStart({ dataTransfer: dragTransfer, stopPropagation() { dragStopped++; }, preventDefault() {} });
check("组拖柄写入专用group MIME，非pack MIME", dragData.get("application/x-dsh-plugin-group") === GROUP.id && !dragData.has("application/x-dsh-plugin-pack") && dragTransfer.effectAllowed === "move" && dragStopped === 1);
let droppedOperation;
const disabledColumn = columns(actionNodes(v2base)).find((node) => !node.props.enabledColumn);
const realDropGroup = disabledColumn.props.dropGroup;
const dropColumnNodes = componentNodes(moduleExports.PackColumn, { ...disabledColumn.props, dropGroup: (...args) => { droppedOperation = realDropGroup(...args); return droppedOperation; } });
let columnStops = 0;
// Even a transfer carrying both MIME types must choose the group before the pack.
dragData.set("application/x-dsh-plugin-pack", "demo-pack-b");
dropColumnNodes.find((node) => node.props.className === "ppk-list").props.onDrop({ dataTransfer: dragTransfer, preventDefault() {}, stopPropagation() { columnStops++; } });
await droppedOperation;
const dragReview = hookWrites[14];
check("组合跨栏拖放走整组preflight/whole-group确认，优先group MIME", columnStops === 1 && calls.length === 1 && calls[0][0] === "preflight" && calls[0][1].length === 1 && calls[0][1][0].name === "demo-pack-a" && dragReview?.groupIntent?.id === GROUP.id && dragReview?.findings[0]?.code === "whole-group");
calls.length = 0;
await button(actionNodes({ ...v2base, 14: dragReview }), "healthContinue").props.onClick();
check("拖组跨栏确认后重新预检才执行，不将pack payload误切换", calls[0]?.[0] === "preflight" && calls.filter((call) => call[0] === "apply").map((call) => call[1]).join() === "demo-pack-a");

console.log(failures === 0 ? "\n全部通过（离线结构/行为测试，非视觉验证）" : `\n${failures} 项失败`);
if (failures > 0) process.exitCode = 1;
