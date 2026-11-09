/**
 * Browser half of dsh-plugin-packs（插件包管理器）。
 *
 * 左侧栏「插件」页里的一个标签（官方页声明 `plugins.tab` 槽），把已安装的插件包排成两栏：
 * 左边是正在一起用的，右边是装好了但停用的。点卡片上的箭头就在两栏之间搬，
 * 也可以直接把卡片拖到对面那一栏。每张卡片可以挂标签，标签栏用来快速收窄范围。
 *
 * 数据全部走本包宿主 half 的同源路由 `/plugin-packs/api`，浏览器端不碰远程命名空间：
 *   - GET  /bundles          包清单 + 行状态（宿主侧读内核 pluginManager 服务）
 *   - POST /bundles/enabled  整包启停，返回官方 ChangeResult
 *   - GET/PUT /state         标签与中文名，落成用户能看能改的 packs.json
 *
 * 为什么绕开 `ctx.remote.pluginManager`：那一层踩过两次坑——不声明 inject 就抛
 * `without inject`，声明了又可能整条 fiber 卡 pending（标签页静默消失）。宿主路由
 * 既能用 curl 单独验证，也不受客户端远程装配顺序影响。
 *
 * 这里只管到「包」这一层；包内单个 loader 行的开关留给插件管家那一页。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-packs",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// 基线 React 是平台静态模块：扁平导出与 default 互操作命名空间都接住。
		const ReactModule = require("react");
		const React =
			ReactModule && typeof ReactModule.createElement === "function"
				? ReactModule
				: ReactModule && ReactModule.default && typeof ReactModule.default.createElement === "function"
					? ReactModule.default
					: ReactModule;
		const h = React.createElement;

		/** 本页字典命名空间。 */
		const NS = "pluginPacks";
		/** 标签页 key；不要复用官方已有的 "all" / "manager"。 */
		const TAB_ID = "packs";
		/** 排在「插件」页自带的「已安装」之后。 */
		const TAB_ORDER = 10;
		/** 宿主 half 的接口根，必须与 lib/index.js 的 ROUTE 一致。 */
		const API_ROOT = "/plugin-packs/api";
		/** PUT 的防跨源门槛头，必须与 lib/index.js 的 GATE_HEADER 一致。 */
		const GATE_HEADER = "x-plugin-packs";
		const DRAG_PACK = "application/x-dsh-plugin-pack";
		const DRAG_GROUP = "application/x-dsh-plugin-group";
		/** 标签颜色盘（用户从这里挑，不给他填任意字符串）。 */
		const PALETTE = ["#7B68EE", "#4C9AFF", "#E8A33D", "#D9534F", "#3AA76D", "#17A2B8", "#8E8E93", "#C2478F"];

		/**
		 * 这些包属于**别的运行模式**（SDK / headless / ACP），桌面档里既不该出现，
		 * 切一下还可能把 profile 弄坏。一律归到「系统 · 只读」，默认不显示。
		 */
		const OTHER_MODE_PACKS = new Set([
			"@deepseek-ai/dsh-acp-app",
			"@deepseek-ai/dsh-headless",
			"@deepseek-ai/dsh-sdk-app",
			"@deepseek-ai/dsh-sdk-minimal",
		]);

		const zh = {
			tab: "插件包",
			subtitle: "已安装插件包 · 左栏一起用，右栏未启用",
			search: "搜索 中文名 / 包名 / 描述 / 标签",
			scopeMine: "我安装的",
			scopeOfficial: "官方可选",
			scopeAll: "全部",
			showSystem: "显示系统核心（只读）",
			colEnabled: "已启用 · 一起用",
			colDisabled: "未启用",
			tagAll: "全部",
			tagUntagged: "未标记",
			tagManage: "管理标签",
			tagNew: "新标签名",
			tagAdd: "添加标签",
			tagDelete: "删除",
			tagColor: "颜色",
			emptyColEnabled: "这一栏还没有启用的包",
			emptyColDisabled: "这一栏没有停用的包",
			emptyFiltered: "没有匹配的包 —— 清掉搜索或标签筛选试试",
			loading: "正在读取插件包…",
			retry: "重试",
			errorHead: "读取插件包失败",
			rows: "{n} 个插件行",
			rowsLive: "{on}/{total} 行运行中",
			detail: "详情",
			collapse: "收起",
			enable: "启用",
			disable: "停用",
			batchEnable: "批量启用",
			batchDisable: "批量停用",
			batchClear: "取消选择",
			batchPicked: "已选 {n}",
			locked: "系统核心 · 只读",
			lockedHint: "由 dsh 安装本身提供，不能在这里启停",
			rename: "中文名",
			namePlaceholder: "给这个包起个中文名（留空则用默认名）",
			nameSave: "保存",
			nameClear: "恢复默认名",
			tagOfPack: "所属标签",
			source: "来源",
			version: "版本",
			ok1: "已启用「{name}」",
			ok0: "已停用「{name}」",
			refreshHint: "客户端插件需刷新页面（Ctrl+F5）才完全卸载",
			restart: "已写入「{name}」，但需重启 DSH 才生效",
			overridden: "「{name}」被更高优先级的层覆盖，未生效",
			failed: "「{name}」切换失败：{code}",
			cancelled: "「{name}」切换已取消",
			undo: "撤销",
			saveFailed: "标签保存失败：{msg}",
			paths: "标签数据文件：{file}",
			healthCheck: "检查全部",
			healthChecking: "正在检查…",
			healthOnly: "仅看问题 / 风险",
			healthNormal: "加载正常",
			healthProblem: "有问题",
			healthRisk: "有风险",
			healthUnknown: "未验证",
			healthDisabled: "未启用",
			healthTitle: "体检结果",
			healthScope: "只读检查加载状态与已知覆盖；不调用插件功能。版本、外部程序、密钥及完整依赖关系未必可验证；加载正常不等于功能实测通过。",
			healthTime: "检查时间",
			healthEvidence: "依据",
			healthImpact: "影响",
			healthSuggestion: "建议",
			healthCoverage: "检查范围 / 限制",
			healthEmpty: "当前证据未发现加载问题，不代表绝对无冲突。",
			healthPreflight: "操作前检查",
			healthContinue: "了解风险，继续",
			healthCancel: "取消操作",
			healthBlocked: "无法执行：存在明确阻断问题",
			healthCount: "个包有问题或风险（全部范围）",
			healthNoReport: "尚未检查",
			healthBatchStopped: "批量已停止，剩余 {n} 项未执行",
			noTags: "还没有标签，先在上面加一个",
			readOnly: "只读",
			autoTag: "自动分类",
			autoTagHint: "按本地规则补充标签；保留手工标签和你移除自动标签的选择。新安装插件在读取时自动分类。",
			autoTagDone: "自动分类已完成",
			autoTagMark: "自动",
			groupsTitle: "组合管理",
			groupsHint: "组合与插件放在同一栏；部分启用在左，全停用在右。直接输入组合名保存；拖组合图标到另一栏可整组切换。",
			groupPartial: "部分启用 {on}/{total}",
			groupAllScope: "整组开关作用于全部成员，不受筛选影响。",
			groupDrag: "拖动组合到另一栏，整组切换启停",
			groupName: "组合名称",
			groupDefault: "新组合",
			groupCreate: "将已选插件建为组合",
			groupAdd: "将已选插件加入",
			groupChoose: "选择已有组合",
			groupDrop: "拖到这里组成文件夹",
			groupDropInto: "拖入插件加入组合",
			groupEnabled: "已启用 {on}/{total}",
			groupVisible: "当前显示 {n} 个成员；整组开关仍作用于全部成员",
			groupEnable: "全部启用",
			groupDisable: "全部停用",
			groupRemove: "移出组合",
			groupDissolve: "解散组合",
			groupDissolveConfirm: "确认解散（不会停用或卸载插件）",
			groupMissing: "缺失或不可管理的成员：{names}。请先移出这些成员再整组切换。",
			groupEmpty: "组合为空，可拖入插件",
			groupSaved: "组合已保存；插件启停未改变",
			groupFailed: "保存失败：{msg}",
		};

		const en = {
			tab: "Packs",
			subtitle: "Installed plugin packs · left column in use, right column disabled",
			search: "Search name / package / description / tag",
			scopeMine: "Mine",
			scopeOfficial: "Official",
			scopeAll: "All",
			showSystem: "Show system core (read-only)",
			colEnabled: "Enabled · in use",
			colDisabled: "Disabled",
			tagAll: "All",
			tagUntagged: "Untagged",
			tagManage: "Manage tags",
			tagNew: "New tag name",
			tagAdd: "Add tag",
			tagDelete: "Delete",
			tagColor: "Color",
			emptyColEnabled: "Nothing enabled here yet",
			emptyColDisabled: "Nothing disabled here",
			emptyFiltered: "No matching pack — clear the search or tag filter",
			loading: "Reading plugin packs…",
			retry: "Retry",
			errorHead: "Could not read plugin packs",
			rows: "{n} plugin rows",
			rowsLive: "{on}/{total} rows running",
			detail: "Details",
			collapse: "Collapse",
			enable: "Enable",
			disable: "Disable",
			batchEnable: "Enable selected",
			batchDisable: "Disable selected",
			batchClear: "Clear selection",
			batchPicked: "{n} selected",
			locked: "System core · read-only",
			lockedHint: "Provided by the dsh installation itself and not toggleable here",
			rename: "Display name",
			namePlaceholder: "Give this pack a name (empty = default)",
			nameSave: "Save",
			nameClear: "Restore default",
			tagOfPack: "Tags",
			source: "Source",
			version: "Version",
			ok1: "Enabled {name}",
			ok0: "Disabled {name}",
			refreshHint: "Client plugins fully unload only after a page refresh (Ctrl+F5)",
			restart: "Saved {name}, but DSH must restart to apply it",
			overridden: "{name} is overridden by a higher-priority layer",
			failed: "Could not toggle {name}: {code}",
			cancelled: "Toggling {name} was cancelled",
			undo: "Undo",
			saveFailed: "Could not save tags: {msg}",
			paths: "Tag data file: {file}",
			healthCheck: "Check all",
			healthChecking: "Checking…",
			healthOnly: "Problems / risks only",
			healthNormal: "Loaded",
			healthProblem: "Problem",
			healthRisk: "Risk",
			healthUnknown: "Unverified",
			healthDisabled: "Disabled",
			healthTitle: "Health check",
			healthScope: "Read-only loading and known override checks; no plugin functions are called. Versions, external programs, secrets and full dependencies may remain unverified. Loaded does not mean functionally tested.",
			healthTime: "Checked at",
			healthEvidence: "Evidence",
			healthImpact: "Impact",
			healthSuggestion: "Suggestion",
			healthCoverage: "Coverage / limitations",
			healthEmpty: "No loading problem found in the available evidence; this does not guarantee no conflicts.",
			healthPreflight: "Before applying changes",
			healthContinue: "Continue with risks",
			healthCancel: "Cancel changes",
			healthBlocked: "Cannot proceed: a blocking problem was found",
			healthCount: "packs with problems or risks (all scopes)",
			healthNoReport: "Not checked yet",
			healthBatchStopped: "Batch stopped; {n} remaining changes were not applied",
			noTags: "No tags yet — add one above",
			readOnly: "Read-only",
			autoTag: "Auto-classify",
			autoTagHint: "Local rules only. Manual labels and dismissed automatic labels are preserved; new installations are classified when read.",
			autoTagDone: "Classification complete",
			autoTagMark: "Auto",
			groupsTitle: "Group controls",
			groupsHint: "Groups share the plugin columns: partially enabled on the left, fully disabled on the right. Edit names directly; drag a group icon across columns to switch it.",
			groupPartial: "Partially enabled {on}/{total}",
			groupAllScope: "Group switches affect all members, regardless of filters.",
			groupDrag: "Drag the group to the other column to switch all members",
			groupName: "Group name",
			groupDefault: "New group",
			groupCreate: "Group selected packs",
			groupAdd: "Add selected packs",
			groupChoose: "Choose an existing group",
			groupDrop: "Drop here to create a group",
			groupDropInto: "Drop a pack to add it",
			groupEnabled: "Enabled {on}/{total}",
			groupVisible: "Showing {n} members; group switches still affect all members",
			groupEnable: "Enable all",
			groupDisable: "Disable all",
			groupRemove: "Remove from group",
			groupDissolve: "Dissolve group",
			groupDissolveConfirm: "Confirm dissolve (does not disable or uninstall plugins)",
			groupMissing: "Missing or unmanageable members: {names}. Remove them before toggling the group.",
			groupEmpty: "Empty group — drop a pack here",
			groupSaved: "Group saved; enablement unchanged",
			groupFailed: "Could not save: {msg}",
		};

		//#region helpers

		/** 极简插值：字典里写 `{name}`，这里替换。 */
		function fmt(template, vars) {
			if (typeof template !== "string") return "";
			return template.replace(/\{(\w+)\}/g, (whole, key) =>
				vars && Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole,
			);
		}

		/** 深拷贝（只用在这份小 JSON 上）。 */
		function clone(value) {
			return JSON.parse(JSON.stringify(value));
		}

		/**
		 * 包名兜底短名：`@scope/dsh-web-all` -> `dsh-web-all`，
		 * `@deepseek-ai/dsh-plugin-manager/tools` 这类子路径也只剩主名。
		 */
		function shortName(packName) {
			const last = String(packName).split("/").filter((part) => part.length > 0).pop() ?? String(packName);
			return last;
		}

		/** 把 LocalizedText（string 或 {en, zh, ...}）解析成当前语言的一段文字。 */
		function resolveText(resolve, value) {
			if (value === undefined || value === null) return "";
			if (typeof value === "string") return value;
			if (typeof resolve === "function") {
				try {
					const resolved = resolve(value);
					if (typeof resolved === "string" && resolved.length > 0) return resolved;
				} catch {
					/* 落到手写兜底 */
				}
			}
			if (typeof value === "object") {
				for (const key of ["zh", "en"]) {
					if (typeof value[key] === "string" && value[key].length > 0) return value[key];
				}
				for (const candidate of Object.values(value)) {
					if (typeof candidate === "string" && candidate.length > 0) return candidate;
				}
			}
			return "";
		}

		/**
		 * 给一个包定性。四类：
		 *   mine     用户自己装的（availability === 'profile'）
		 *   official 随安装附带的官方可选包
		 *   system   只读：系统核心，或别的运行模式的包
		 *   hidden   未安装（availability === 'missing'），不显示
		 */
		function classify(bundle) {
			if (bundle.readOnlyReason) return "system";
			if (OTHER_MODE_PACKS.has(bundle.name)) return "system";
			if (bundle.availability === "missing") return bundle.enabled === true || bundle.installed === true || bundle.source ? "mine" : "hidden";
			if (bundle.availability === "profile") return "mine";
			return "official";
		}

		/** 把 ChangeResult 翻成一句人话 + 可撤销动作。 */
		function describeChange(t, bundle, targetEnabled, result) {
			const name = bundle.displayName;
			const application = result?.application ?? "failed";
			if (application === "failed") {
				const code = result?.error?.code ?? result?.error?.message ?? "unknown";
				return { kind: "error", text: fmt(t("failed"), { name, code }) };
			}
			if (application === "cancelled") return { kind: "warn", text: fmt(t("cancelled"), { name }) };
			if (application === "overridden") return { kind: "warn", text: fmt(t("overridden"), { name }) };
			if (application === "restart-required") return { kind: "warn", text: fmt(t("restart"), { name }) };
			return {
				kind: targetEnabled ? "ok" : "ok",
				text: `${targetEnabled ? fmt(t("ok1"), { name }) : fmt(t("ok0"), { name })} · ${t("refreshHint")}`,
			};
		}

		//#endregion

		//#region styles

		const CSS = `
.ppk-root{display:flex;flex-direction:column;gap:12px;width:100%;max-width:1080px;color:var(--dsw-alias-label-primary,#262626);font-size:13px;line-height:20px;container:ppk/inline-size}
.ppk-head{display:flex;flex-direction:column;gap:2px}
.ppk-title{font-size:15px;font-weight:500;line-height:22px;margin:0}
.ppk-sub{color:var(--dsw-alias-label-secondary,#666);font-size:12px;line-height:18px;margin:0}
.ppk-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ppk-search{position:relative;flex:1 1 220px;min-width:180px}
.ppk-search input{box-sizing:border-box;width:100%;height:32px;border:.5px solid var(--dsw-alias-border-l2,#dcdcdc);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#262626);font:inherit;outline:none;padding:0 10px}
.ppk-search input:focus-visible{border-color:var(--dsw-alias-brand-primary,#4d6bfe);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 18%,transparent)}
.ppk-seg{display:inline-flex;border:.5px solid var(--dsw-alias-border-l2,#dcdcdc);border-radius:8px;overflow:hidden}
.ppk-seg button{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#666);font:inherit;font-size:12px;padding:6px 10px;cursor:pointer}
.ppk-seg button[data-on="true"]{background:var(--dsw-alias-bg-layer-2,#f2f2f2);color:var(--dsw-alias-label-primary,#262626);font-weight:500}
.ppk-check{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,#666);font-size:12px;cursor:pointer;user-select:none}
.ppk-tagbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.ppk-chip{display:inline-flex;align-items:center;gap:5px;border:.5px solid var(--dsw-alias-border-l2,#dcdcdc);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#666);font:inherit;font-size:12px;line-height:18px;padding:2px 9px;cursor:pointer;white-space:nowrap}
.ppk-chip[data-on="true"]{color:var(--dsw-alias-label-primary,#262626);border-color:var(--dsw-alias-brand-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 10%,transparent)}
.ppk-chip .ppk-swatch{width:8px;height:8px;border-radius:999px;flex:none}
.ppk-chip .ppk-count{color:var(--dsw-alias-label-secondary,#666);font-variant-numeric:tabular-nums}
.ppk-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;align-items:start}
.ppk-col{display:flex;flex-direction:column;gap:8px;min-width:0}
.ppk-colhead{display:flex;align-items:baseline;gap:8px;padding:2px 2px 0}
.ppk-colhead h4{margin:0;font-size:13px;font-weight:500;line-height:20px}
.ppk-colhead span{color:var(--dsw-alias-label-secondary,#666);font-size:12px;font-variant-numeric:tabular-nums}
.ppk-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-content:start;overflow:auto;max-height:min(68vh,720px);min-height:120px;padding:2px;margin:-2px;border-radius:10px}
.ppk-list[data-dropping="true"]{outline:1.5px dashed var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-2px}
.ppk-sys{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-content:start}
.ppk-empty{grid-column:1/-1;color:var(--dsw-alias-label-secondary,#666);font-size:12px;border:.5px dashed var(--dsw-alias-border-l2,#dcdcdc);border-radius:10px;padding:14px;text-align:center;margin:0}
.ppk-card{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2,#dcdcdc);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);display:flex;flex-direction:column;gap:3px;padding:9px 10px;min-width:0;aspect-ratio:1/1;overflow:hidden}
.ppk-card[data-open="true"]{grid-column:1/-1;aspect-ratio:auto;overflow:visible;gap:6px}
.ppk-pkg{display:block;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#666);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ppk-cardfoot{margin-top:auto;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-top:2px}
.ppk-card[data-busy="true"]{opacity:.6}
.ppk-card[data-locked="true"]{background:var(--dsw-alias-bg-layer-2,#f7f7f7)}
.ppk-cardhead{display:flex;align-items:center;gap:8px;min-width:0}
.ppk-dot{width:8px;height:8px;border-radius:999px;flex:none;background:var(--dsw-alias-state-idle-primary,#bdbdbd)}
.ppk-dot[data-on="true"]{background:var(--dsw-alias-state-success-primary,#2ba471)}
.ppk-name{flex:1;min-width:0;font-weight:500;font-size:13px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ppk-icon-btn{appearance:none;border:.5px solid var(--dsw-alias-border-l2,#dcdcdc);background:var(--dsw-alias-bg-layer-2,#f2f2f2);color:var(--dsw-alias-label-primary,#262626);width:26px;height:26px;border-radius:8px;font:inherit;font-size:13px;line-height:1;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none}
.ppk-icon-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1,#fff)}
.ppk-icon-btn:disabled{cursor:not-allowed;opacity:.45}
.ppk-meta{display:flex;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary,#666);font-size:12px;line-height:18px;min-width:0}
.ppk-meta code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;background:var(--dsw-alias-bg-layer-2,#f2f2f2);border-radius:5px;padding:1px 5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.ppk-cardtags{display:flex;gap:4px;flex-wrap:wrap;align-items:flex-start;max-height:40px;overflow:hidden}
.ppk-card[data-open="true"] .ppk-cardtags{max-height:none}
.ppk-cardtags .ppk-chip{cursor:default;font-size:11px;padding:1px 8px}
.ppk-inline-btn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-brand-primary,#4d6bfe);font:inherit;font-size:12px;cursor:pointer;padding:0 2px}
.ppk-detail{display:flex;flex-direction:column;gap:8px;border-top:.5px solid var(--dsw-alias-border-l2,#dcdcdc);margin-top:2px;padding-top:8px}
.ppk-detail p{margin:0;color:var(--dsw-alias-label-secondary,#666);font-size:12px;line-height:18px;white-space:pre-wrap}
.ppk-field{display:flex;flex-direction:column;gap:4px}
.ppk-field > label{color:var(--dsw-alias-label-secondary,#666);font-size:11px;line-height:16px}
.ppk-field input{box-sizing:border-box;height:28px;border:.5px solid var(--dsw-alias-border-l2,#dcdcdc);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#262626);font:inherit;font-size:12px;outline:none;padding:0 8px;max-width:320px}
.ppk-field input:focus-visible{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.ppk-rowlist{display:flex;flex-direction:column;gap:3px;max-height:180px;overflow:auto}
.ppk-row{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,#666);font-size:11px;line-height:16px;min-width:0}
.ppk-row code{font-family:var(--ds-font-family-code,ui-monospace,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ppk-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ppk-btn{appearance:none;border:.5px solid var(--dsw-alias-border-l2,#dcdcdc);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f2f2f2);color:var(--dsw-alias-label-primary,#262626);font:inherit;font-size:12px;line-height:18px;padding:5px 11px;cursor:pointer}
.ppk-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1,#fff)}
.ppk-btn:disabled{opacity:.45;cursor:not-allowed}
.ppk-btn[data-tone="primary"]{border-color:transparent;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}
.ppk-btn[data-tone="danger"]{color:var(--dsw-alias-state-error-primary,#d9534f)}
.ppk-batch{position:sticky;top:0;z-index:2;display:flex;gap:8px;align-items:center;flex-wrap:wrap;border:.5px solid var(--dsw-alias-brand-primary,#4d6bfe);border-radius:10px;background:var(--dsw-alias-bg-overlay,#fff);padding:6px 10px}
.ppk-toast{display:flex;gap:10px;align-items:center;flex-wrap:wrap;border:.5px solid var(--dsw-alias-border-l2,#dcdcdc);border-radius:10px;background:var(--dsw-alias-bg-overlay,#fff);padding:7px 11px;font-size:12px;line-height:18px}
.ppk-toast[data-kind="ok"]{border-color:var(--dsw-alias-state-success-primary,#2ba471)}
.ppk-toast[data-kind="warn"]{border-color:var(--dsw-alias-state-warn-primary,#e8a33d)}
.ppk-toast[data-kind="error"]{border-color:var(--dsw-alias-state-error-primary,#d9534f);color:var(--dsw-alias-state-error-primary,#d9534f)}
.ppk-details{border:.5px solid var(--dsw-alias-border-l2,#dcdcdc);border-radius:10px;padding:8px 11px}
.ppk-details > summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#666);font-size:12px;line-height:18px;user-select:none}
.ppk-tagrows{display:flex;flex-direction:column;gap:6px;margin-top:8px}
.ppk-tagrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ppk-tagrow input[type="text"]{box-sizing:border-box;height:26px;border:.5px solid var(--dsw-alias-border-l2,#dcdcdc);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#262626);font:inherit;font-size:12px;outline:none;padding:0 7px;width:130px}
.ppk-colors{display:inline-flex;gap:4px;flex-wrap:wrap}
.ppk-color{width:16px;height:16px;border-radius:999px;border:1.5px solid transparent;cursor:pointer;padding:0}
.ppk-color[data-on="true"]{border-color:var(--dsw-alias-label-primary,#262626)}
.ppk-sys{display:flex;flex-direction:column;gap:8px}
.ppk-syshead{grid-column:1/-1;display:flex;align-items:baseline;gap:8px;color:var(--dsw-alias-label-secondary,#666);font-size:12px}
.ppk-hint{color:var(--dsw-alias-label-secondary,#666);font-size:11px;line-height:16px;margin:0}
.ppk-error{border:.5px solid var(--dsw-alias-state-error-primary,#d9534f);border-radius:10px;color:var(--dsw-alias-state-error-primary,#d9534f);padding:10px 12px;font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.ppk-group-card{box-sizing:border-box;aspect-ratio:1/1;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:9px 10px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:4px;min-width:0;overflow-wrap:anywhere}
.ppk-group-card[data-open="true"]{grid-column:1/-1;aspect-ratio:auto;overflow:visible}
.ppk-group-card[data-partial="true"]{border-style:dashed}
.ppk-group-name input{flex:1;min-width:0;width:100%}
.ppk-group-name .ppk-actions{flex-wrap:nowrap}
.ppk-group-card > .ppk-hint{margin-top:auto}
.ppk-group-members{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.ppk-group-drop{font:inherit;font-size:10px;line-height:14px;border:1px dashed var(--dsw-alias-border-l2);border-radius:6px;padding:2px 4px;color:var(--dsw-alias-label-secondary);background:transparent;max-width:65%;white-space:normal}
.ppk-group-drop:hover{border-color:var(--dsw-alias-brand-primary)}
.ppk-cardfoot{flex-wrap:wrap}
.ppk-group-builder{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ppk-group-builder input,.ppk-group-builder select{font:inherit;min-width:120px;max-width:100%;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
@container ppk (width<=620px){.ppk-group-members{grid-template-columns:minmax(0,1fr)}}
.ppk-health-issues{display:flex;flex-direction:column;gap:8px;max-height:360px;overflow:auto}
.ppk-health-issue{border-left:2px solid var(--dsw-alias-border-l2);padding:4px 9px;overflow-wrap:anywhere}
.ppk-health-issue[data-severity="error"]{border-color:var(--dsw-alias-state-error-primary)}
.ppk-health-issue[data-severity="warning"]{border-color:var(--dsw-alias-state-warn-primary)}
.ppk-health-issue p{margin:3px 0;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.ppk-health-badge{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ppk-health-badge[data-status="problem"]{color:var(--dsw-alias-state-error-primary)}
.ppk-health-badge[data-status="risk"]{color:var(--dsw-alias-state-warn-primary)}
.ppk-health-review{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px}
.ppk-sr{position:absolute;width:1px;height:1px;clip:rect(0 0 0 0);clip-path:inset(50%);overflow:hidden;white-space:nowrap}
@container ppk (width<=720px){.ppk-cols{grid-template-columns:minmax(0,1fr)}.ppk-list{max-height:none}}
@container ppk (width<=620px){.ppk-list,.ppk-sys{grid-template-columns:minmax(0,1fr)}}
`;

		//#endregion

		//#region components

		/**
		 * 标签 chip。
		 * @param {object} props tag / active / count / onClick / onRemove
		 */
		function TagChip(props) {
			const { tag, active } = props;
			const style = props.tone === undefined ? undefined : { borderColor: tag.color, color: tag.color };
			return h(
				"button",
				{
					type: "button",
					className: "ppk-chip",
					"data-on": active ? "true" : "false",
					style: props.solid ? { ...style, background: "transparent" } : style,
					onClick: props.onClick,
					title: tag.label,
				},
				h("span", { className: "ppk-swatch", style: { background: tag.color } }),
				h("span", null, tag.label),
				tag.annotation ? h("small", null, tag.annotation) : null,
				props.count === undefined ? null : h("span", { className: "ppk-count" }, String(props.count)),
			);
		}

		function healthLabel(t, status) {
			return t(({ normal: "healthNormal", problem: "healthProblem", risk: "healthRisk", disabled: "healthDisabled" })[status] || "healthUnknown");
		}

		function HealthIssues({ issues, t }) {
			return h("div", { className: "ppk-health-issues" }, (issues || []).map((issue, index) =>
				h("div", { className: "ppk-health-issue", key: `${issue.code}-${index}`, "data-severity": issue.severity },
					h("strong", null, issue.title),
					...[["healthEvidence", issue.evidence], ["healthImpact", issue.impact], ["healthSuggestion", issue.suggestion]].map(([key, value]) =>
						value ? h("p", { key }, `${t(key)}：${value}`) : null),
					issue.related?.length ? h("p", null, issue.related.join(" · ")) : null)));
		}

		/**
		 * 包卡片。箭头是主操作，拖拽是加分项（拖不动也不影响箭头）。
		 */
		function PackCard(props) {
			const { pack, t, enabledColumn, busy, locked } = props;
			const [open, setOpen] = React.useState(false);
			const [draftName, setDraftName] = React.useState(pack.displayName);

			React.useEffect(() => {
				setDraftName(pack.displayName);
			}, [pack.displayName, pack.name]);

			const toggle = () => props.onToggle(pack, !pack.enabled);
			const rowTotal = pack.rows.length;
			const rowLive = pack.rows.filter((row) => pack.rowActive[row.entryId] === true).length;

			return h(
				"article",
				{
					className: "ppk-card",
					"data-busy": busy ? "true" : "false",
					"data-locked": locked ? "true" : "false",
					"data-open": open ? "true" : "false",
					draggable: !locked && !busy,
					onDragStart: (event) => {
						if (locked || busy) { event.preventDefault(); return; }
						event.stopPropagation();
						event.dataTransfer.setData("text/plain", pack.name);
						event.dataTransfer.setData(DRAG_PACK, pack.name);
						event.dataTransfer.effectAllowed = "move";
						if (props.onDragStart) props.onDragStart(pack.name);
					},
					onDragEnd: () => {
						if (props.onDragEnd) props.onDragEnd();
					},
					"data-pack": pack.name,
				},
				h(
					"div",
					{ className: "ppk-cardhead" },
					locked
						? null
						: h("input", {
								type: "checkbox",
								"aria-label": pack.displayName,
								checked: props.selected === true,
								onChange: (event) => props.onSelect(pack.name, event.target.checked),
							}),
					h("span", { className: "ppk-dot", "data-on": pack.enabled ? "true" : "false" }),
					h("span", { className: "ppk-name", title: pack.name }, pack.displayName),
					locked
						? h("span", { className: "ppk-chip", "data-on": "false" }, t("readOnly"))
						: h(
								"button",
								{
									type: "button",
									className: "ppk-icon-btn",
									disabled: busy,
									title: pack.enabled ? t("disable") : t("enable"),
									"aria-label": pack.enabled ? t("disable") : t("enable"),
									onClick: toggle,
								},
								enabledColumn ? "→" : "←",
							),
				),
				h("code", { className: "ppk-pkg", title: pack.name }, pack.name),
				h("span", { className: "ppk-health-badge", "data-status": pack.health?.status, title: t("healthScope") }, healthLabel(t, pack.health?.status), pack.health?.status === "disabled" && pack.health.issues?.some((issue) => issue.severity === "error") ? ` · ${t("healthProblem")}` : ""),
				h(
					"div",
					{ className: "ppk-meta" },
					pack.version ? h("span", null, `v${pack.version}`) : null,
					h(
						"span",
						null,
						rowTotal === 0
							? null
							: rowLive === rowTotal
								? fmt(t("rows"), { n: rowTotal })
								: `${fmt(t("rows"), { n: rowTotal })} · ${fmt(t("rowsLive"), { on: rowLive, total: rowTotal })}`,
					),
					pack.readonlyReasonNote ? h("span", null, pack.readonlyReasonNote) : null,
				),
				h(
					"div",
					{ className: "ppk-cardtags" },
					pack.tags.length === 0
						? null
						: pack.tags.map((tag) => h(TagChip, { key: tag.id, tag, tone: true, active: false })),
				),
				h(
					"div",
					{ className: "ppk-cardfoot" },
					!locked && props.onCombine ? h("button", {
						type: "button", className: "ppk-group-drop", disabled: busy, title: t("groupDrop"),
						onDragOver: (event) => { if (!busy && Array.from(event.dataTransfer.types || []).includes(DRAG_PACK)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; } },
						onDrop: (event) => { event.preventDefault(); event.stopPropagation(); const source = event.dataTransfer.getData(DRAG_PACK); if (source && !busy && source !== pack.name) props.onCombine(pack.name, source); },
					}, t("groupDrop")) : null,
					props.onRemoveFromGroup ? h("button", { type: "button", className: "ppk-inline-btn", disabled: busy, onClick: () => props.onRemoveFromGroup(pack.name) }, t("groupRemove")) : null,
					h(
						"button",
						{ type: "button", className: "ppk-inline-btn", onClick: () => setOpen((prev) => !prev) },
						open ? t("collapse") : t("detail"),
					),
				),
				open
					? h(
							"div",
							{ className: "ppk-detail" },
							h("strong", null, t("healthTitle")),
							pack.health?.issues?.length ? h(HealthIssues, { issues: pack.health.issues, t }) : h("p", null, pack.health ? t("healthEmpty") : t("healthNoReport")),
							h("p", { className: "ppk-hint" }, t("healthScope")),
							pack.health?.coverage?.length ? h("details", null, h("summary", null, t("healthCoverage")), pack.health.coverage.map((line, index) => h("p", { key: index }, line))) : null,
							pack.description ? h("p", null, pack.description) : null,
							h(
								"div",
								{ className: "ppk-meta" },
								pack.source ? h("span", null, `${t("source")}：${pack.source}`) : null,
								pack.official ? h("span", null, "官方") : null,
								pack.installTarget ? h("span", null, `安装源：${pack.installTarget.spec}`) : null,
							),
							locked
								? h("p", { className: "ppk-hint" }, t("lockedHint"))
								: h(
										"div",
										{ className: "ppk-field" },
										h("label", null, t("rename")),
										h(
											"div",
											{ className: "ppk-actions" },
											h("input", {
												type: "text",
												value: draftName,
												placeholder: t("namePlaceholder"),
												onChange: (event) => setDraftName(event.target.value),
												onKeyDown: (event) => {
													if (event.key === "Enter") props.onRename(pack.name, draftName.trim());
												},
											}),
											h(
												"button",
												{
													type: "button",
													className: "ppk-btn",
													onClick: () => props.onRename(pack.name, draftName.trim()),
												},
												t("nameSave"),
											),
											h(
												"button",
												{
													type: "button",
													className: "ppk-btn",
													onClick: () => {
														setDraftName(pack.defaultName);
														props.onRename(pack.name, "");
													},
												},
												t("nameClear"),
											),
										),
									),
							locked
								? null
								: h(
										"div",
										{ className: "ppk-field" },
										h("label", null, t("tagOfPack")),
										h(
											"div",
											{ className: "ppk-cardtags" },
											pack.allTags.map((tag) =>
												h(TagChip, {
													key: tag.id,
													tag,
													active: pack.tagIds.includes(tag.id),
													onClick: () => props.onToggleTag(pack.name, tag.id),
												}),
											),
											pack.allTags.length === 0 ? h("span", { className: "ppk-hint" }, t("noTags")) : null,
										),
									),
							rowTotal === 0
								? null
								: h(
										"div",
										{ className: "ppk-field" },
										h("label", null, fmt(t("rows"), { n: rowTotal })),
										h(
											"div",
											{ className: "ppk-rowlist" },
											pack.rows.map((row, index) =>
												h(
													"div",
													{ className: "ppk-row", key: `${row.entryId ?? row.rowId}-${index}` },
													h("span", {
														className: "ppk-dot",
														"data-on": pack.rowActive[row.entryId] === true ? "true" : "false",
													}),
													h("code", { title: row.moduleName }, `${row.rowId} · ${shortName(row.moduleName)}`),
													h("span", null, pack.health?.rows?.find((item) => item.entryId === row.entryId && item.rowId === row.rowId)?.phase ?? "—"),
												),
											),
										),
									),
						)
					: null,
			);
		}

		/** A group is metadata only; switches delegate to the shared preflight path. */
		function GroupCard(props) {
			const { group, members, visibleMembers, missing, t, busy, cardProps } = props;
			const [open, setOpen] = React.useState(false);
			const [name, setName] = React.useState(group.name);
			const [confirmDissolve, setConfirmDissolve] = React.useState(false);
			React.useEffect(() => { setName(group.name); }, [group.name]);
			const onDrop = (event) => { const member = event.dataTransfer.getData(DRAG_PACK); if (!member) return; event.preventDefault(); event.stopPropagation(); if (!busy) props.onAction({ action: "group-add", id: group.id, members: [member] }); };
			const saveName = () => { if (!busy && name.trim() && name.trim() !== group.name) return props.onAction({ action: "group-rename", id: group.id, name: name.trim() }); };
			const enabledCount = members.filter((pack) => pack.enabled).length;
			const partial = enabledCount > 0 && enabledCount < group.members.length;
			return h("article", { className: "ppk-group-card", "data-group": group.id, "data-open": open ? "true" : "false", "data-enabled": enabledCount > 0 ? "true" : "false", "data-partial": partial ? "true" : "false",
				onDragOver: (event) => { if (!busy && Array.from(event.dataTransfer.types || []).includes(DRAG_PACK)) { event.preventDefault(); event.stopPropagation(); } }, onDrop },
				h("div", { className: "ppk-actions" },
					h("button", { type: "button", className: "ppk-icon-btn", title: t("groupDrag"), "aria-label": t("groupDrag"), draggable: !busy, disabled: busy,
						onDragStart: (event) => { if (busy) { event.preventDefault(); return; } event.stopPropagation(); event.dataTransfer.setData(DRAG_GROUP, group.id); event.dataTransfer.effectAllowed = "move"; } }, "▣"),
					h("span", { className: "ppk-hint" }, fmt(t(partial ? "groupPartial" : "groupEnabled"), { on: enabledCount, total: group.members.length })),
					h("button", { type: "button", className: "ppk-inline-btn", onClick: () => { setOpen(!open); setConfirmDissolve(false); } }, open ? t("collapse") : t("detail"))),
				h("div", { className: "ppk-field ppk-group-name" }, h("label", { className: "ppk-sr" }, t("groupName")), h("div", { className: "ppk-actions" },
					h("input", { value: name, maxLength: 120, disabled: busy, draggable: false, "aria-label": t("groupName"),
						onPointerDown: (event) => event.stopPropagation(), onDragStart: (event) => { event.preventDefault(); event.stopPropagation(); },
						onChange: (event) => setName(event.target.value), onKeyDown: (event) => { event.stopPropagation(); if (event.isComposing || event.nativeEvent?.isComposing) return; if (event.key === "Enter") { event.preventDefault(); return saveName(); } } }),
					h("button", { type: "button", className: "ppk-btn", disabled: busy || !name.trim() || name.trim() === group.name, onClick: saveName }, t("nameSave")))),
				h("div", { className: "ppk-actions" },
					h("button", { type: "button", className: "ppk-btn", disabled: busy || !group.members.length, onClick: () => props.onToggle(group, true) }, t("groupEnable")),
					h("button", { type: "button", className: "ppk-btn", disabled: busy || !group.members.length, onClick: () => props.onToggle(group, false) }, t("groupDisable"))),
				h("p", { className: "ppk-hint" }, t("groupDropInto")),
				open ? h("div", { className: "ppk-detail" },
					h("p", { className: "ppk-hint" }, fmt(t("groupVisible"), { n: visibleMembers.length })),
					missing.length ? h("div", { className: "ppk-health-issues" }, missing.map((member) => h("div", { key: member, className: "ppk-actions" }, h("code", null, member), h("button", { type: "button", className: "ppk-btn", disabled: busy, onClick: () => props.onAction({ action: "group-remove", id: group.id, members: [member] }) }, t("groupRemove"))))) : null,
					h("div", { className: "ppk-group-members" }, visibleMembers.map((pack) => h(PackCard, { ...cardProps, key: pack.name, pack, t, locked: pack.scope === "system", busy, selected: cardProps.selectedPack(pack.name), enabledColumn: pack.enabled,
						onRemoveFromGroup: (member) => props.onAction({ action: "group-remove", id: group.id, members: [member] }) }))),
					!group.members.length ? h("p", { className: "ppk-hint" }, t("groupEmpty")) : null,
					h("button", { type: "button", className: "ppk-btn", "data-tone": "danger", disabled: busy, onClick: () => { if (!confirmDissolve) setConfirmDissolve(true); else props.onAction({ action: "group-dissolve", id: group.id }); } }, confirmDissolve ? t("groupDissolveConfirm") : t("groupDissolve"))) : null);
		}

		/** 一栏（已启用 / 未启用）。整栏都是拖放目标。 */
		function PackColumn(props) {
			const { title, count, packs, emptyText, enabledColumn, t, dropTarget, groups = [] } = props;
			const [hover, setHover] = React.useState(false);
			return h(
				"section",
				{ className: "ppk-col" },
				h(
					"div",
					{ className: "ppk-colhead" },
					h("h4", null, title),
					h("span", null, String(count)),
				),
				h(
					"div",
					{
						className: "ppk-list",
						"data-dropping": hover ? "true" : "false",
						onDragOver: (event) => {
							event.preventDefault();
							setHover(true);
						},
						onDragLeave: () => setHover(false),
						onDrop: (event) => {
							event.preventDefault();
							setHover(false);
							event.stopPropagation();
							const groupId = event.dataTransfer.getData(DRAG_GROUP);
							if (groupId) return props.dropGroup?.(groupId, enabledColumn);
							const name = event.dataTransfer.getData(DRAG_PACK);
							if (name && name.length > 0) dropTarget(name, enabledColumn);
						},
					},
					groups.map((item) => h(GroupCard, { ...item, key: `group:${item.group.id}`, t, busy: props.cardProps.busyPack !== null, cardProps: props.cardProps, onAction: props.onGroupAction, onToggle: props.onGroupToggle })),
					packs.length === 0 && groups.length === 0
						? h("p", { className: "ppk-empty" }, emptyText)
						: packs.map((pack) =>
								h(PackCard, {
									...props.cardProps,
									key: pack.name,
									pack,
									enabledColumn,
									t,
									busy: props.cardProps.busyPack !== null,
									locked: false,
									selected: props.cardProps.selectedPack === undefined ? false : props.cardProps.selectedPack(pack.name),
									onToggle: props.cardProps.onToggle,
									onSelect: props.cardProps.onSelect,
									onRename: props.cardProps.onRename,
									onToggleTag: props.cardProps.onToggleTag,
									onDragStart: props.cardProps.onDragStart,
									onDragEnd: props.cardProps.onDragEnd,
								}),
							),
				),
			);
		}

		/** 主页面。 */
		function PacksTab(props) {
			const t = props.t;
			// 插槽的 `inject` 每次投影都可能给出新的 props 对象；把 api 收进 ref，
			// 否则依赖 [api] 的 useCallback 每帧都变，effect 会自己把自己转成死循环。
			const apiRef = React.useRef(props.api);
			apiRef.current = props.api;

			const [bundles, setBundles] = React.useState(null);
			const [plugins, setPlugins] = React.useState([]);
			const [doc, setDoc] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [loading, setLoading] = React.useState(true);
			const [busyPack, setBusyPack] = React.useState(null);
			const [toast, setToast] = React.useState(null);
			const [query, setQuery] = React.useState("");
			const [tagFilter, setTagFilter] = React.useState("*");
			const [scope, setScope] = React.useState("mine");
			const [showSystem, setShowSystem] = React.useState(false);
			const [selected, setSelected] = React.useState({});
			const [diagnostics, setDiagnostics] = React.useState(null);
			const [onlyProblems, setOnlyProblems] = React.useState(false);
			const [review, setReview] = React.useState(null);
			const [groupName, setGroupName] = React.useState("");
			const [targetGroup, setTargetGroup] = React.useState("");
			const [metadataBusy, setMetadataBusy] = React.useState(false);
			const metadataQueue = React.useRef(Promise.resolve());
			const operationRef = React.useRef(false);
			const toastTimer = React.useRef(0);

			const showToast = React.useCallback((next) => {
				setToast(next);
				if (toastTimer.current) clearTimeout(toastTimer.current);
				toastTimer.current = setTimeout(() => setToast(null), next.kind === "error" ? 12000 : 8000);
			}, []);

			React.useEffect(
				() => () => {
					if (toastTimer.current) clearTimeout(toastTimer.current);
				},
				[],
			);

			const refresh = React.useCallback(async () => {
				const api = apiRef.current;
				setLoading(true);
				setError(null);
				try {
					const [snapshot, nextDoc] = await Promise.all([api.loadPacks(), api.loadState()]);
					setBundles(Array.isArray(snapshot.bundles) ? snapshot.bundles : []);
					setPlugins(Array.isArray(snapshot.plugins) ? snapshot.plugins : []);
					setDiagnostics(snapshot.diagnostics ?? null);
					setDoc((previous) => !previous || (nextDoc.revision ?? 0) >= (previous.revision ?? 0) ? nextDoc : previous);
				} catch (caught) {
					setError(String(caught?.message ?? caught));
				} finally {
					setLoading(false);
				}
			}, []);

			React.useEffect(() => {
				refresh();
			}, [refresh]);

			// Metadata mutations are serialized and use the latest server revision, never a stale render snapshot.
			const enqueueMetadata = React.useCallback((operation, success) => {
				const run = metadataQueue.current.then(async () => {
					setMetadataBusy(true);
					try {
						const saved = await operation(apiRef.current);
						setDoc((previous) => !previous || (saved.revision ?? 0) >= (previous.revision ?? 0) ? { ...saved, paths: saved.paths ?? previous?.paths } : previous);
						if (success) showToast({ kind: "ok", text: success });
						return saved;
					} catch (caught) {
						showToast({ kind: "error", text: fmt(t("groupFailed"), { msg: String(caught?.message ?? caught) }) });
						return null;
					} finally { setMetadataBusy(false); }
				});
				metadataQueue.current = run.then(() => undefined, () => undefined);
				return run;
			}, [showToast, t]);

			const saveDoc = React.useCallback((mutator) => enqueueMetadata(async (api) => {
				const next = clone(await api.loadState());
				mutator(next);
				return api.saveState(next);
			}), [enqueueMetadata]);

			const stateAction = React.useCallback((action) => enqueueMetadata((api) => api.stateAction(action), t(action.action === "auto-tag" ? "autoTagDone" : "groupSaved")), [enqueueMetadata, t]);

			// All entry points (arrow, drop, batch and undo) share one preflight path.
			const requestChanges = React.useCallback(async (changes, acceptedFingerprint, groupIntent) => {
				if (operationRef.current || !changes.length) return;
				operationRef.current = true;
				setBusyPack("*");
				try {
					await metadataQueue.current;
					// Revalidate against a fresh inventory, including after a confirmation or undo.
					const latest = await apiRef.current.loadPacks();
					setBundles(latest.bundles);
					setPlugins(latest.plugins);
					setDiagnostics(latest.diagnostics ?? null);
					const current = new Map(latest.bundles.map((bundle) => [bundle.name, bundle]));
					let currentGroup = null;
					if (groupIntent) {
						const latestDoc = await apiRef.current.loadState();
						setDoc((previous) => !previous || (latestDoc.revision ?? 0) >= (previous.revision ?? 0) ? latestDoc : previous);
						currentGroup = latestDoc.groups?.find((group) => group.id === groupIntent.id);
						if (!currentGroup) throw new Error(t("groupChoose"));
						const unavailable = currentGroup.members.filter((name) => !current.has(name) || classify(current.get(name)) === "system" || current.get(name).availability === "missing");
						if (unavailable.length) throw new Error(fmt(t("groupMissing"), { names: unavailable.join(", ") }));
						changes = currentGroup.members.map((name) => ({ name, enabled: groupIntent.enabled, displayName: name }));
					}
					for (const change of changes) {
						const bundle = current.get(change.name);
						if (!bundle || classify(bundle) === "system") throw new Error(`${change.name}: ${t("readOnly")} / unavailable`);
					}
					changes = changes.filter((change) => current.get(change.name).enabled !== change.enabled)
						.sort((left, right) => Number(left.name === "dsh-plugin-packs" && !left.enabled) - Number(right.name === "dsh-plugin-packs" && !right.enabled));
					if (!changes.length) { setReview(null); return; }
					const result = await apiRef.current.preflight(changes.map(({ name, enabled }) => ({ name, enabled })));
					setDiagnostics(result.report);
					const findings = (result.findings || []).filter((issue) => issue.severity !== "info");
					if (currentGroup) findings.unshift({ code: "whole-group", severity: "warning", title: `${currentGroup.name} · ${t(groupIntent.enabled ? "groupEnable" : "groupDisable")}`, evidence: currentGroup.members.join(" · "), impact: t("groupAllScope"), suggestion: t("groupVisible").replace("{n}", String(currentGroup.members.length)), related: changes.map((change) => change.name) });
					const fingerprint = JSON.stringify(findings);
					if (result.blocked || (findings.length && fingerprint !== acceptedFingerprint)) {
						setReview({ changes, findings, blocked: result.blocked, fingerprint, groupIntent });
						return;
					}
					setReview(null);
					setSelected({});
					const messages = [];
					const applied = [];
					for (const change of changes) {
						const outcome = await apiRef.current.setBundleEnabled(change.name, change.enabled);
						const described = describeChange(t, { displayName: change.displayName || change.name }, change.enabled, outcome);
						messages.push(described);
						if (outcome.application !== "applied") break;
						if (outcome.changed) applied.push(change);
					}
					const last = messages.at(-1);
					if (last) showToast({ kind: last.kind, text: messages.map((item) => item.text).join("\n") + (messages.length < changes.length ? `\n${fmt(t("healthBatchStopped"), { n: changes.length - messages.length })}` : ""),
						undo: applied.length ? () => requestChanges(applied.slice().reverse().map((item) => ({ ...item, enabled: !item.enabled }))) : undefined });
					await refresh();
				} catch (caught) {
					showToast({ kind: "error", text: String(caught?.message ?? caught) });
					await refresh();
				} finally {
					operationRef.current = false;
					setBusyPack(null);
				}
			}, [refresh, showToast, t]);

			const togglePack = (pack, enabled) => {
				if (pack.scope === "system") return;
				return requestChanges([{ name: pack.name, enabled, displayName: pack.displayName }]);
			};

			// ---- 派生数据
			const rowEnabled = React.useMemo(() => {
				const map = {};
				for (const plugin of plugins) {
					if (plugin && typeof plugin.entryId === "string") map[plugin.entryId] = plugin.enabled === true;
				}
				return map;
			}, [plugins]);

			const rowActive = React.useMemo(() => Object.fromEntries(plugins.map((plugin) => [plugin.entryId, plugin.fiberPhase === "active"])), [plugins]);
			const tags = Array.isArray(doc?.tags) ? doc.tags : [];
			const tagById = React.useMemo(() => {
				const map = new Map();
				for (const tag of tags) map.set(tag.id, tag);
				return map;
			}, [tags]);

			const packs = React.useMemo(() => {
				if (bundles === null) return [];
				const overrides = doc?.packs ?? {};
				const resolveFn = typeof apiRef.current?.resolveText === "function" ? apiRef.current.resolveText : undefined;
				return bundles.map((bundle) => {
					const override = overrides[bundle.name] ?? {};
					const defaultName =
						resolveText(resolveFn, bundle.meta?.title) || resolveText(resolveFn, bundle.name) || shortName(bundle.name);
					const manualTags = Array.isArray(override.tags) ? override.tags : [];
					const autoTags = (Array.isArray(override.autoTags) ? override.autoTags : []).filter((id) => !(override.suppressedTags || []).includes(id));
					const tagIds = [...new Set([...manualTags, ...autoTags])].filter((id) => tagById.has(id));
					return {
						name: bundle.name,
						version: bundle.version ?? "",
						description: resolveText(resolveFn, bundle.meta?.description) || (typeof bundle.description === "string" ? bundle.description : ""),
						source: typeof bundle.source === "string" ? bundle.source : "",
						official: bundle.official === true,
						availability: bundle.availability,
						installTarget: bundle.installTarget,
						enabled: bundle.enabled === true,
						removable: bundle.removable === true,
						rows: Array.isArray(bundle.rows) ? bundle.rows : [],
						rowEnabled,
						rowActive,
						health: diagnostics?.packs?.[bundle.name],
						readonlyReasonNote: bundle.readOnlyReason === "management-required" ? "management-required" : "",
						scope: classify(bundle),
						defaultName,
						displayName: typeof override.name === "string" && override.name.length > 0 ? override.name : defaultName,
						tagIds,
						tags: tagIds.map((id) => ({ ...tagById.get(id), annotation: autoTags.includes(id) && !manualTags.includes(id) ? t("autoTagMark") : undefined })),
						allTags: tags,
					};
				});
			}, [bundles, doc, rowEnabled, rowActive, diagnostics, tagById, tags, t]);

			const systemPacks = React.useMemo(() => packs.filter((pack) => pack.scope === "system"), [packs]);

			const matchesQuery = React.useCallback(
				(pack) => {
					const needle = query.trim().toLowerCase();
					if (needle.length === 0) return true;
					const haystack = [pack.displayName, pack.name, pack.description, pack.source, pack.version, ...pack.tags.map((tag) => tag.label)]
						.join(" ")
						.toLowerCase();
					return haystack.includes(needle);
				},
				[query],
			);

			const matchesTag = React.useCallback(
				(pack) => {
					if (tagFilter === "*") return true;
					if (tagFilter === "-") return pack.tagIds.length === 0;
					return pack.tagIds.includes(tagFilter);
				},
				[tagFilter],
			);

			const inScope = React.useCallback(
				(pack) => pack.scope !== "hidden" && pack.scope !== "system" && (scope === "all" || pack.scope === scope),
				[scope],
			);

			const visible = React.useMemo(
				() =>
					packs
						.filter((pack) => inScope(pack) && matchesQuery(pack) && matchesTag(pack) && (!onlyProblems || pack.health?.issues?.some((issue) => ["error", "warning"].includes(issue.severity))))
						.sort((left, right) => left.displayName.localeCompare(right.displayName, "zh")),
				[inScope, matchesQuery, matchesTag, packs, onlyProblems],
			);

			const groups = Array.isArray(doc?.groups) ? doc.groups : [];
			const packByName = new Map(packs.map((pack) => [pack.name, pack]));
			const memberGroup = new Map(groups.flatMap((group) => group.members.map((name) => [name, group.id])));
			const enabledPacks = visible.filter((pack) => pack.enabled && !memberGroup.has(pack.name));
			const disabledPacks = visible.filter((pack) => !pack.enabled && !memberGroup.has(pack.name));
			const visibleGroups = groups.map((group) => {
				const groupMatch = query.trim() && group.name.toLowerCase().includes(query.trim().toLowerCase());
				const members = group.members.map((name) => packByName.get(name)).filter(Boolean);
				const visibleMembers = members.filter((pack) => inScope(pack) && matchesTag(pack) && (groupMatch || matchesQuery(pack)) && (!onlyProblems || pack.health?.issues?.some((issue) => ["error", "warning"].includes(issue.severity))));
				const missing = group.members.filter((name) => !packByName.has(name) || ["system", "hidden"].includes(packByName.get(name).scope) || packByName.get(name).availability === "missing");
				return { group, members, visibleMembers, missing };
			}).filter(({ group, members, visibleMembers }) => visibleMembers.length || (!members.length && !onlyProblems && tagFilter === "*" && (!query.trim() || group.name.toLowerCase().includes(query.trim().toLowerCase()))));

			const enabledGroups = visibleGroups.filter((item) => item.members.some((pack) => pack.enabled));
			const disabledGroups = visibleGroups.filter((item) => !item.members.some((pack) => pack.enabled));
			const toggleGroup = (group, enabled) => requestChanges(group.members.map((name) => ({ name, enabled })), undefined, { id: group.id, enabled });
			const dropGroup = (id, enabled) => {
				const group = groups.find((item) => item.id === id);
				if (!group || group.members.some((name) => packByName.get(name)?.enabled) === enabled) return;
				return toggleGroup(group, enabled);
			};
			const combinePacks = (target, source) => {
				if (target === source || !packByName.has(source) || packByName.get(source).scope === "system") return;
				const id = memberGroup.get(target);
				return stateAction(id ? { action: "group-add", id, members: [source] } : { action: "group-create", name: t("groupDefault"), members: [target, source] });
			};

			const tagCounts = React.useMemo(() => {
				const counts = new Map();
				for (const pack of packs) {
					if (!inScope(pack)) continue;
					for (const id of pack.tagIds) counts.set(id, (counts.get(id) ?? 0) + 1);
				}
				return counts;
			}, [inScope, packs]);

			const scopedTotal = packs.filter((pack) => inScope(pack)).length;
			const untaggedCount = packs.filter((pack) => inScope(pack) && pack.tagIds.length === 0).length;
			const selectedNames = Object.keys(selected).filter((name) => selected[name]);

			const runBatch = async (target) => {
				const targets = [...new Map([...visible, ...visibleGroups.flatMap((item) => item.visibleMembers)].map((pack) => [pack.name, pack])).values()].filter((pack) => selected[pack.name] === true && pack.enabled !== target && pack.scope !== "system");
				await requestChanges(targets.map((pack) => ({ name: pack.name, enabled: target, displayName: pack.displayName })));
			};

			const dropTarget = (name, targetEnabledColumn) => {
				const pack = packs.find((candidate) => candidate.name === name);
				if (!pack || pack.scope === "system") return;
				if (pack.enabled === targetEnabledColumn) return;
				togglePack(pack, targetEnabledColumn);
			};

			const cardProps = {
				t,
				busyPack: metadataBusy ? "*" : busyPack,
				onCombine: combinePacks,
				selectedPack: (name) => selected[name] === true,
				onToggle: (pack, target) => togglePack(pack, target),
				onSelect: (name, on) =>
					setSelected((prev) => {
						const next = { ...prev };
						if (on) next[name] = true;
						else delete next[name];
						return next;
					}),
				onRename: (name, text) =>
					saveDoc((next) => {
						const record = next.packs[name] ?? {};
						if (text.length === 0) delete record.name;
						else record.name = text;
						if (Object.keys(record).length === 0) delete next.packs[name];
						else next.packs[name] = record;
					}),
				onToggleTag: (name, tagId) =>
					saveDoc((next) => {
						const record = next.packs[name] ?? {};
						const manual = new Set(record.tags || []);
						const automatic = new Set(record.autoTags || []);
						const suppressed = new Set(record.suppressedTags || []);
						if (manual.has(tagId) || (automatic.has(tagId) && !suppressed.has(tagId))) {
							manual.delete(tagId);
							if (automatic.has(tagId)) { automatic.delete(tagId); suppressed.add(tagId); }
						} else { manual.add(tagId); suppressed.delete(tagId); }
						record.tags = [...manual];
						record.autoTags = [...automatic];
						record.suppressedTags = [...suppressed];
						if (Object.keys(record).length === 0) delete next.packs[name];
						else next.packs[name] = record;
					}),
				onDragStart: () => undefined,
				onDragEnd: () => undefined,
			};

			const scopeButtons = [
				["mine", t("scopeMine"), packs.filter((pack) => pack.scope === "mine").length],
				["official", t("scopeOfficial"), packs.filter((pack) => pack.scope === "official").length],
				["all", t("scopeAll"), packs.filter((pack) => pack.scope === "mine" || pack.scope === "official").length],
			];

			// 标签栏已经写着「插件包」，这里不再重复一个大标题，只留一句说明。
			const head = h("div", { className: "ppk-head" }, h("p", { className: "ppk-sub" }, t("subtitle")));

			if (loading && bundles === null) {
				return h("div", { className: "ppk-root" }, h("style", null, CSS), head, h("p", { className: "ppk-hint" }, t("loading")));
			}

			if (error !== null) {
				return h(
					"div",
					{ className: "ppk-root" },
					h("style", null, CSS),
					head,
					h("div", { className: "ppk-error" }, `${t("errorHead")}\n${error}`),
					h(
						"div",
						{ className: "ppk-actions" },
						h("button", { type: "button", className: "ppk-btn", onClick: refresh }, t("retry")),
					),
				);
			}

			const tagBar = h(
				"div",
				{ className: "ppk-tagbar" },
				h(TagChip, {
					tag: { id: "*", label: t("tagAll"), color: "#8E8E93" },
					active: tagFilter === "*",
					count: scopedTotal,
					onClick: () => setTagFilter("*"),
				}),
				tags.map((tag) =>
					h(TagChip, {
						key: tag.id,
						tag,
						active: tagFilter === tag.id,
						count: tagCounts.get(tag.id) ?? 0,
						onClick: () => setTagFilter(tagFilter === tag.id ? "*" : tag.id),
					}),
				),
				h(TagChip, {
					tag: { id: "-", label: t("tagUntagged"), color: "#8E8E93" },
					active: tagFilter === "-",
					count: untaggedCount,
					onClick: () => setTagFilter(tagFilter === "-" ? "*" : "-"),
				}),
			);

			const tagManager = h(
				"details",
				{ className: "ppk-details" },
				h("summary", null, t("tagManage")),
				h(
					"div",
					{ className: "ppk-tagrows" },
					tags.map((tag) =>
						h(
							"div",
							{ className: "ppk-tagrow", key: tag.id },
							h("span", { className: "ppk-swatch", style: { width: 10, height: 10, borderRadius: 999, background: tag.color } }),
							h("input", {
								type: "text",
								defaultValue: tag.label,
								onBlur: (event) => {
									const label = event.target.value.trim();
									if (label.length === 0 || label === tag.label) return;
									saveDoc((next) => {
										const target = next.tags.find((item) => item.id === tag.id);
										if (target) target.label = label;
									});
								},
							}),
							h(
								"span",
								{ className: "ppk-colors" },
								PALETTE.map((color) =>
									h("button", {
										key: color,
										type: "button",
										className: "ppk-color",
										style: { background: color },
										"data-on": color === tag.color ? "true" : "false",
										title: color,
										onClick: () =>
											saveDoc((next) => {
												const target = next.tags.find((item) => item.id === tag.id);
												if (target) target.color = color;
											}),
									}),
								),
							),
							h(
								"button",
								{
									type: "button",
									className: "ppk-btn",
									"data-tone": "danger",
									onClick: () =>
										saveDoc((next) => {
											next.tags = next.tags.filter((item) => item.id !== tag.id);
											for (const [packName, record] of Object.entries(next.packs)) {
												record.tags = (record.tags || []).filter((id) => id !== tag.id);
												if ((record.autoTags || []).includes(tag.id)) record.suppressedTags = [...new Set([...(record.suppressedTags || []), tag.id])];
												record.autoTags = (record.autoTags || []).filter((id) => id !== tag.id);
												if (record.tags.length === 0) delete record.tags;
												if (Object.keys(record).length === 0) delete next.packs[packName];
											}
										}),
								},
								t("tagDelete"),
							),
						),
					),
					h(NewTagRow, { t, onAdd: (label, color) => saveDoc((next) => {
						const base = label.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "");
						let id = base.length > 0 ? base : `tag-${Date.now()}`;
						let attempt = 2;
						while (next.tags.some((item) => item.id === id)) id = `${base || "tag"}-${attempt++}`;
						next.tags.push({ id, label, color });
					}) }),
				),
			);

			return h(
				"div",
				{ className: "ppk-root" },
				h("style", null, CSS),
				head,
				h(
					"div",
					{ className: "ppk-toolbar" },
					h(
						"div",
						{ className: "ppk-search" },
						h("input", {
							type: "search",
							value: query,
							placeholder: t("search"),
							"aria-label": t("search"),
							onChange: (event) => setQuery(event.target.value),
						}),
					),
					h(
						"div",
						{ className: "ppk-seg", role: "group" },
						scopeButtons.map(([value, label, count]) =>
							h(
								"button",
								{
									key: value,
									type: "button",
									"data-on": scope === value ? "true" : "false",
									onClick: () => setScope(value),
								},
								`${label} ${count}`,
							),
						),
					),
					h(
						"label",
						{ className: "ppk-check" },
						h("input", {
							type: "checkbox",
							checked: showSystem,
							onChange: (event) => setShowSystem(event.target.checked),
						}),
						t("showSystem"),
					),
				),
				h("div", { className: "ppk-actions" },
					h("button", { type: "button", className: "ppk-btn", disabled: loading || busyPack !== null, onClick: refresh }, loading ? t("healthChecking") : t("healthCheck")),
					h("label", { className: "ppk-check" }, h("input", { type: "checkbox", checked: onlyProblems, onChange: (event) => setOnlyProblems(event.target.checked) }), t("healthOnly")),
					h("span", { className: "ppk-hint", role: "status" }, diagnostics ? `${packs.filter((pack) => pack.scope !== "hidden" && pack.health?.issues?.some((issue) => ["error", "warning"].includes(issue.severity))).length} ${t("healthCount")} · ${t("healthTime")}：${diagnostics.checkedAt ? new Date(diagnostics.checkedAt).toLocaleString() : "—"}` : t("healthNoReport"))),
				h("p", { className: "ppk-hint" }, t("healthScope")),
				review ? h("section", { className: "ppk-health-review", "aria-label": t("healthPreflight"), "aria-live": "polite" },
					h("strong", null, review.blocked ? t("healthBlocked") : t("healthPreflight")),
					h("p", { className: "ppk-hint" }, review.changes.map((item) => `${item.displayName || item.name} → ${item.enabled ? t("enable") : t("disable")}`).join(" · ")),
					h(HealthIssues, { issues: review.findings, t }),
					h("div", { className: "ppk-actions" },
						h("button", { type: "button", className: "ppk-btn", disabled: busyPack !== null, onClick: () => setReview(null) }, t("healthCancel")),
						!review.blocked ? h("button", { type: "button", className: "ppk-btn", disabled: busyPack !== null, onClick: () => requestChanges(review.changes, review.fingerprint, review.groupIntent) }, t("healthContinue")) : null)) : null,
				tagBar,
				h("div", { className: "ppk-actions" }, h("button", { type: "button", className: "ppk-btn", disabled: metadataBusy || busyPack !== null, onClick: () => stateAction({ action: "auto-tag" }) }, t("autoTag")), h("span", { className: "ppk-hint" }, t("autoTagHint"))),
				tagManager,
				h("section", { "aria-label": t("groupsTitle") },
					h("h4", { className: "ppk-title" }, t("groupsTitle")),
					h("p", { className: "ppk-hint" }, t("groupsHint")),
					h("div", { className: "ppk-group-builder" },
						h("input", { value: groupName, maxLength: 120, "aria-label": t("groupName"), placeholder: t("groupName"), onChange: (event) => setGroupName(event.target.value) }),
						h("button", { type: "button", className: "ppk-btn", disabled: !selectedNames.length || metadataBusy || busyPack !== null, onClick: async () => { const saved = await stateAction({ action: "group-create", name: groupName.trim() || t("groupDefault"), members: selectedNames }); if (saved) { setGroupName(""); setSelected({}); } } }, t("groupCreate")),
						h("select", { value: targetGroup, "aria-label": t("groupChoose"), onChange: (event) => setTargetGroup(event.target.value) }, h("option", { value: "" }, t("groupChoose")), groups.map((group) => h("option", { key: group.id, value: group.id }, group.name))),
						h("button", { type: "button", className: "ppk-btn", disabled: !selectedNames.length || !groups.some((group) => group.id === targetGroup) || metadataBusy || busyPack !== null, onClick: async () => { if (await stateAction({ action: "group-add", id: targetGroup, members: selectedNames })) setSelected({}); } }, t("groupAdd")))),
				selectedNames.length > 0
					? h(
							"div",
							{ className: "ppk-batch" },
							h("strong", null, fmt(t("batchPicked"), { n: selectedNames.length })),
							h(
								"button",
								{ type: "button", className: "ppk-btn", "data-tone": "primary", onClick: () => runBatch(true) },
								t("batchEnable"),
							),
							h(
								"button",
								{ type: "button", className: "ppk-btn", onClick: () => runBatch(false) },
								t("batchDisable"),
							),
							h(
								"button",
								{ type: "button", className: "ppk-btn", onClick: () => setSelected({}) },
								t("batchClear"),
							),
						)
					: null,
				visible.length === 0 && visibleGroups.length === 0 && (query.trim().length > 0 || tagFilter !== "*" || onlyProblems)
					? h("p", { className: "ppk-empty" }, t("emptyFiltered"))
					: h(
							"div",
							{ className: "ppk-cols" },
							h(PackColumn, {
								title: t("colEnabled"),
								count: enabledPacks.length + enabledGroups.length,
								packs: enabledPacks,
								groups: enabledGroups,
								onGroupAction: stateAction, onGroupToggle: toggleGroup, dropGroup,
								emptyText: t("emptyColEnabled"),
								enabledColumn: true,
								t,
								cardProps,
								dropTarget,
							}),
							h(PackColumn, {
								title: t("colDisabled"),
								count: disabledPacks.length + disabledGroups.length,
								packs: disabledPacks,
								groups: disabledGroups,
								onGroupAction: stateAction, onGroupToggle: toggleGroup, dropGroup,
								emptyText: t("emptyColDisabled"),
								enabledColumn: false,
								t,
								cardProps,
								dropTarget,
							}),
						),
				showSystem && systemPacks.length > 0
					? h(
							"div",
							{ className: "ppk-sys" },
							h(
								"div",
								{ className: "ppk-syshead" },
								h("strong", null, t("locked")),
								h("span", null, t("lockedHint")),
							),
							systemPacks.map((pack) =>
								h(PackCard, { key: pack.name, pack, t, enabledColumn: pack.enabled, busy: false, locked: true }),
							),
						)
					: null,
				toast
					? h(
							"div",
							{ className: "ppk-toast", "data-kind": toast.kind, role: "status" },
							h("span", null, toast.text),
							toast.undo
								? h(
										"button",
										{
											type: "button",
											className: "ppk-btn",
											onClick: () => {
												const undo = toast.undo;
												setToast(null);
												undo();
											},
										},
										t("undo"),
									)
								: null,
						)
					: null,
				doc?.paths?.file
					? h("p", { className: "ppk-hint" }, fmt(t("paths"), { file: doc.paths.file }))
					: null,
			);
		}

		/** 新增标签的一行（受控草稿，提交才写盘）。 */
		function NewTagRow(props) {
			const t = props.t;
			const [label, setLabel] = React.useState("");
			const [color, setColor] = React.useState(PALETTE[0]);
			const submit = () => {
				const text = label.trim();
				if (text.length === 0) return;
				props.onAdd(text, color);
				setLabel("");
			};
			return h(
				"div",
				{ className: "ppk-tagrow" },
				h("input", {
					type: "text",
					value: label,
					placeholder: t("tagNew"),
					onChange: (event) => setLabel(event.target.value),
					onKeyDown: (event) => {
						if (event.key === "Enter") submit();
					},
				}),
				h(
					"span",
					{ className: "ppk-colors" },
					PALETTE.map((swatch) =>
						h("button", {
							key: swatch,
							type: "button",
							className: "ppk-color",
							style: { background: swatch },
							"data-on": swatch === color ? "true" : "false",
							title: swatch,
							onClick: () => setColor(swatch),
						}),
					),
				),
				h("button", { type: "button", className: "ppk-btn", "data-tone": "primary", onClick: submit }, t("tagAdd")),
			);
		}

		//#endregion

		//#region registration

		/**
		 * 只需要插槽表与字典。
		 *
		 * 包清单与整包启停**不走浏览器端的远程命名空间**：宿主 half 已经用内核的
		 * `pluginManager` 服务把它们转发成同源路由（`/plugin-packs/api/bundles`）。
		 * 这样客户端少一层依赖，出问题也能用 curl 单独验证——上一版去点
		 * `ctx.remote.pluginManager` 就是在这层反复翻车的（未声明就抛 without inject，
		 * 声明了又可能整条 fiber 卡 pending）。
		 */
		const inject = ["slots", "locale"];

		/** 统一读一条同源路由：非 2xx 或 ok!==true 一律抛人话错误。 */
		async function callJson(method, path, body) {
			const init = { method, cache: "no-store", headers: { accept: "application/json" } };
			if (body !== undefined) {
				init.headers["content-type"] = "application/json";
				init.headers[GATE_HEADER] = "1";
				init.body = JSON.stringify(body);
			}
			const url = `${API_ROOT}${path}`;
			const response = await fetch(url, init);
			let parsed;
			try {
				parsed = await response.json();
			} catch {
				throw new Error(`${method} ${url} -> HTTP ${response.status}（响应不是 JSON，宿主 half 可能没挂上）`);
			}
			if (!response.ok || parsed?.ok !== true) {
				throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`);
			}
			return parsed;
		}

		/** 挂上标签页。 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "plugin-packs: dictionaries");
			const t = ctx.locale.bind(NS);

			/** 一次取齐包清单与行状态（宿主侧 listBundles + listPlugins）。 */
			const loadPacks = async () => {
				const body = await callJson("GET", "/bundles");
				return {
					bundles: Array.isArray(body.value?.bundles) ? body.value.bundles : [],
					plugins: Array.isArray(body.value?.plugins) ? body.value.plugins : [],
					diagnostics: body.value?.diagnostics ?? null,
				};
			};

			/** 整包启停，返回官方的 ChangeResult 原样。 */
			const setBundleEnabled = async (name, enabled) => {
				const body = await callJson("POST", "/bundles/enabled", { name, enabled });
				return body.value;
			};

			const loadState = async () => {
				const body = await callJson("GET", "/state");
				return { ...body.value, paths: body.paths };
			};

			const saveState = async (next) => {
				const body = await callJson("PUT", "/state", next);
				return { ...body.value, paths: body.paths };
			};

			const resolveTextFn = (value) => {
				try {
					return ctx.locale.resolveText(value);
				} catch {
					return undefined;
				}
			};

			const injected = () => ({
				t,
				api: { loadPacks, setBundleEnabled, loadState, saveState, resolveText: resolveTextFn,
					preflight: async (changes) => (await callJson("POST", "/preflight", { changes })).value,
					stateAction: async (action) => { const body = await callJson("POST", "/state/actions", action); return { ...body.value, paths: body.paths }; } },
			});

			// 挂在左侧栏「插件」整页面里，而不是「设置 → 插件」：那是两个不同的面。
			// 该页由官方 @deepseek-ai/dsh-client-ui-plugin-manager 注册（main key = 'plugins'），
			// 它声明了 `plugins.tab` 作为「已安装」之后的新标签位（当前无人占用）。
			// 这样既不新起左侧入口，也不另造一个设置页，标签就长在用户说的那个页面上。
			ctx.slots.inject("plugins.tab", () =>
				ctx.slots.register(
					{
						name: "plugins.tab",
						id: TAB_ID,
						order: TAB_ORDER,
						label: () => t("tab"),
						locale: NS,
						inject: injected,
					},
					PacksTab,
				),
			);
		}

		//#endregion

		exports.NS = NS;
		exports.TAB_ID = TAB_ID;
		exports.PacksTab = PacksTab;
		exports.PackCard = PackCard;
		exports.GroupCard = GroupCard;
		exports.PackColumn = PackColumn;
		/** 字典也导出：离线渲染自检要按真实文案断言，不必另抄一份。 */
		exports.dictionaries = { zh, en };
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
