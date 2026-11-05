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
			noTags: "还没有标签，先在上面加一个",
			readOnly: "只读",
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
			noTags: "No tags yet — add one above",
			readOnly: "Read-only",
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
			if (bundle.availability === "missing") return "hidden";
			if (bundle.readOnlyReason) return "system";
			if (OTHER_MODE_PACKS.has(bundle.name)) return "system";
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
				props.count === undefined ? null : h("span", { className: "ppk-count" }, String(props.count)),
			);
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
			const rowLive = pack.rows.filter((row) => pack.rowEnabled[row.entryId] === true).length;

			return h(
				"article",
				{
					className: "ppk-card",
					"data-busy": busy ? "true" : "false",
					"data-locked": locked ? "true" : "false",
					"data-open": open ? "true" : "false",
					draggable: locked ? false : true,
					onDragStart: (event) => {
						if (locked) return;
						event.dataTransfer.setData("text/plain", pack.name);
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
														"data-on": pack.rowEnabled[row.entryId] === true ? "true" : "false",
													}),
													h("code", { title: row.moduleName }, `${row.rowId} · ${shortName(row.moduleName)}`),
												),
											),
										),
									),
						)
					: null,
			);
		}

		/** 一栏（已启用 / 未启用）。整栏都是拖放目标。 */
		function PackColumn(props) {
			const { title, count, packs, emptyText, enabledColumn, t, dropTarget } = props;
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
							const name = event.dataTransfer.getData("text/plain");
							if (name && name.length > 0) dropTarget(name, enabledColumn);
						},
					},
					packs.length === 0
						? h("p", { className: "ppk-empty" }, emptyText)
						: packs.map((pack) =>
								h(PackCard, {
									...props.cardProps,
									key: pack.name,
									pack,
									enabledColumn,
									t,
									busy: props.cardProps.busyPack === pack.name,
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
					setDoc(nextDoc);
				} catch (caught) {
					setError(String(caught?.message ?? caught));
				} finally {
					setLoading(false);
				}
			}, []);

			React.useEffect(() => {
				refresh();
			}, [refresh]);

			const saveDoc = React.useCallback(
				async (mutator) => {
					if (doc === null) return;
					const next = clone(doc);
					mutator(next);
					try {
						const saved = await apiRef.current.saveState(next);
						setDoc({ ...saved, paths: saved?.paths ?? doc.paths });
					} catch (caught) {
						showToast({ kind: "error", text: fmt(t("saveFailed"), { msg: String(caught?.message ?? caught) }) });
					}
				},
				[doc, showToast, t],
			);

			const togglePack = React.useCallback(
				async (pack, target) => {
					setBusyPack(pack.name);
					try {
						const result = await apiRef.current.setBundleEnabled(pack.name, target);
						const described = describeChange(t, pack, target, result);
						showToast({
							kind: described.kind,
							text: described.text,
							undo:
								described.kind === "error"
									? undefined
									: () => {
											togglePack(pack, !target);
										},
						});
						await refresh();
					} catch (caught) {
						showToast({ kind: "error", text: fmt(t("failed"), { name: pack.displayName, code: String(caught?.message ?? caught) }) });
					} finally {
						setBusyPack(null);
					}
				},
				[refresh, showToast, t],
			);

			// ---- 派生数据
			const rowEnabled = React.useMemo(() => {
				const map = {};
				for (const plugin of plugins) {
					if (plugin && typeof plugin.entryId === "string") map[plugin.entryId] = plugin.enabled === true;
				}
				return map;
			}, [plugins]);

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
					const tagIds = Array.isArray(override.tags) ? override.tags.filter((id) => tagById.has(id)) : [];
					return {
						name: bundle.name,
						version: bundle.version ?? "",
						description: resolveText(resolveFn, bundle.meta?.description) || (typeof bundle.description === "string" ? bundle.description : ""),
						source: typeof bundle.source === "string" ? bundle.source : "",
						official: bundle.official === true,
						installTarget: bundle.installTarget,
						enabled: bundle.enabled === true,
						removable: bundle.removable === true,
						rows: Array.isArray(bundle.rows) ? bundle.rows : [],
						rowEnabled,
						readonlyReasonNote: bundle.readOnlyReason === "management-required" ? "management-required" : "",
						scope: classify(bundle),
						defaultName,
						displayName: typeof override.name === "string" && override.name.length > 0 ? override.name : defaultName,
						tagIds,
						tags: tagIds.map((id) => tagById.get(id)).filter(Boolean),
						allTags: tags,
					};
				});
			}, [bundles, doc, rowEnabled, tagById, tags]);

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
						.filter((pack) => inScope(pack) && matchesQuery(pack) && matchesTag(pack))
						.sort((left, right) => left.displayName.localeCompare(right.displayName, "zh")),
				[inScope, matchesQuery, matchesTag, packs],
			);

			const enabledPacks = visible.filter((pack) => pack.enabled);
			const disabledPacks = visible.filter((pack) => !pack.enabled);

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
				const targets = visible.filter((pack) => selected[pack.name] === true && pack.enabled !== target && pack.scope !== "system");
				setSelected({});
				for (const pack of targets) {
					await togglePack(pack, target);
				}
			};

			const dropTarget = (name, targetEnabledColumn) => {
				const pack = packs.find((candidate) => candidate.name === name);
				if (!pack || pack.scope === "system") return;
				if (pack.enabled === targetEnabledColumn) return;
				togglePack(pack, targetEnabledColumn);
			};

			const cardProps = {
				t,
				busyPack,
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
						const current = Array.isArray(record.tags) ? record.tags.slice() : [];
						const at = current.indexOf(tagId);
						if (at >= 0) current.splice(at, 1);
						else current.push(tagId);
						if (current.length === 0) delete record.tags;
						else record.tags = current;
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
												if (!Array.isArray(record.tags)) continue;
												record.tags = record.tags.filter((id) => id !== tag.id);
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
				tagBar,
				tagManager,
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
				visible.length === 0 && (query.trim().length > 0 || tagFilter !== "*")
					? h("p", { className: "ppk-empty" }, t("emptyFiltered"))
					: h(
							"div",
							{ className: "ppk-cols" },
							h(PackColumn, {
								title: t("colEnabled"),
								count: enabledPacks.length,
								packs: enabledPacks,
								emptyText: t("emptyColEnabled"),
								enabledColumn: true,
								t,
								cardProps,
								dropTarget,
							}),
							h(PackColumn, {
								title: t("colDisabled"),
								count: disabledPacks.length,
								packs: disabledPacks,
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
				api: { loadPacks, setBundleEnabled, loadState, saveState, resolveText: resolveTextFn },
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
		/** 字典也导出：离线渲染自检要按真实文案断言，不必另抄一份。 */
		exports.dictionaries = { zh, en };
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
