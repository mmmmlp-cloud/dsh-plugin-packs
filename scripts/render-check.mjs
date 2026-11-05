/**
 * 离线渲染自检（无浏览器）：把 lib/client.js 真的渲染一遍。
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
import { readFileSync, existsSync } from "node:fs";
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
const mockReact = {
	createElement: React.createElement,
	Fragment: React.Fragment,
	useState(init) {
		const index = hookIndex++;
		const value = Object.prototype.hasOwnProperty.call(seeds, index) ? seeds[index] : init;
		return [value, () => undefined];
	},
	useEffect() {
		hookIndex++;
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
 * 真实标签文件。想看真实数据下的渲染，加 `--live`（只读本地 packs.json，不写）。
 */
const DEMO_DOC = {
	version: 1,
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

const liveStateFile = path.join(homedir(), ".dsh", "plugin-packs", "packs.json");
const DOC =
	process.argv.includes("--live") && existsSync(liveStateFile)
		? JSON.parse(readFileSync(liveStateFile, "utf8"))
		: DEMO_DOC;

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

// 12 个 useState 的序号：0 bundles 1 plugins 2 doc 3 error 4 loading 5 busyPack
// 6 toast 7 query 8 tagFilter 9 scope 10 showSystem 11 selected
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
const html7 = render({ ...base, 12: true });
check("详情块出现", html7.includes("ppk-detail"));
check("出现包内行列表", html7.includes("ppk-row"));
check("出现改名输入框", html7.includes("ppk-field"));

console.log("[8] 加载中");
const html8 = render({ ...base, 0: null, 4: true });
check("loading 文案", html8.includes(t("loading")));

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
if (failures > 0) process.exitCode = 1;
