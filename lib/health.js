/** Read-only inventory analysis. No filesystem, environment, network or runtime mutation.
 * checkedAt is supplied by the caller (ISO string); null means no clock was supplied.
 * Runtime rows are joined ONLY by entryId, never by moduleName or category.
 */
const PHASES = new Set(["pending", "loading", "active", "failed", "unloading"]);
const BLOCKING = new Set(["incompatible-version", "unsupported-platform", "not-bundle", "missing"]);
const COVERAGE = [
  "已检查：包清单错误、精确 entryId 行状态、配置覆盖声明及跨包配置目标精确交集。",
  "未覆盖：外部程序可用性、密钥有效性、业务功能与客户端实际显示。",
  "未覆盖：完整依赖图与跨包冲突；同类或同 moduleName 不构成冲突证据。",
  "未覆盖：没有明确兼容性错误时，不能据版本号证明版本兼容。",
];

function issue(code, severity, title, evidence, impact, suggestion, related = []) {
  return { code, severity, title, evidence, impact, suggestion, related: [...related] };
}

/** Only exact declared configuration targets count, with at least one override.
 * Does not infer runtime ordering, config values, dependencies or module identities.
 */
function configurationOverlaps(bundles) {
  const seen = new Set();
  const enabled = [];
  for (const bundle of bundles) {
    if (bundle?.enabled !== true || typeof bundle.name !== "string" || seen.has(bundle.name)) continue;
    seen.add(bundle.name);
    const strings = (values) => new Set(values.filter((value) => typeof value === "string" && value.length > 0));
    enabled.push({
      name: bundle.name,
      overrides: strings(Array.isArray(bundle.overrides) ? bundle.overrides : []),
      rows: strings((Array.isArray(bundle.rows) ? bundle.rows : []).map((row) => row.rowId)),
    });
  }
  const overlaps = [];
  for (let i = 0; i < enabled.length; i++) {
    const left = enabled[i];
    for (let j = i + 1; j < enabled.length; j++) {
      const right = enabled[j];
      const targets = new Set([
        ...[...left.overrides].filter((target) => right.overrides.has(target) || right.rows.has(target)),
        ...[...right.overrides].filter((target) => left.rows.has(target)),
      ]);
      for (const target of targets) {
        const source = (pack) => [pack.overrides.has(target) ? "overrides" : null, pack.rows.has(target) ? "rows.rowId" : null].filter(Boolean).join("+");
        overlaps.push(issue("configuration-overlap", "warning", "跨包配置目标共触达",
          `${left.name} (${source(left)}) 与 ${right.name} (${source(right)}) 精确共触达目标 ${JSON.stringify(target)}。`,
          "这是配置覆盖风险，不是确定冲突；不能据此判断最终配置或执行顺序，也不证明依赖关系。",
          "变更前人工核对双方对该目标的配置与用途。", [left.name, right.name, target]));
      }
    }
  }
  return overlaps;
}

export function analyzeHealth(bundles, plugins, checkedAt = null) {
  const inventory = Array.isArray(plugins) ? plugins : [];
  const byEntry = new Map();
  for (const plugin of inventory) {
    if (typeof plugin?.entryId !== "string") continue;
    const entries = byEntry.get(plugin.entryId) ?? [];
    entries.push(plugin);
    byEntry.set(plugin.entryId, entries);
  }
  // Define own properties below so legal package names such as __proto__ stay data.
  const packs = {};
  const overlaps = configurationOverlaps(Array.isArray(bundles) ? bundles : []);
  const summary = { total: 0, problem: 0, risk: 0, unknown: 0, disabled: 0, normal: 0 };
  for (const bundle of Array.isArray(bundles) ? bundles : []) {
    if (typeof bundle?.name !== "string" || Object.hasOwn(packs, bundle.name)) continue;
    const issues = overlaps.filter((entry) => entry.related[0] === bundle.name || entry.related[1] === bundle.name)
      .map((entry) => ({ ...entry, related: [...entry.related] }));
    const add = (code, severity, title, evidence, impact, suggestion, related = []) =>
      issues.push(issue(code, severity, title, evidence, impact, suggestion, [bundle.name, ...related]));
    const rows = (Array.isArray(bundle.rows) ? bundle.rows : []).map((row) => {
      const matches = typeof row.entryId === "string" ? byEntry.get(row.entryId) ?? [] : [];
      const plugin = matches.length === 1 ? matches[0] : null;
      return {
        rowId: row.rowId ?? null,
        moduleName: row.moduleName ?? null,
        entryId: row.entryId ?? null,
        enabled: typeof plugin?.enabled === "boolean" ? plugin.enabled : null,
        phase: PHASES.has(plugin?.fiberPhase) ? plugin.fiberPhase : null,
        diagnostic: typeof plugin?.diagnostic === "string" ? plugin.diagnostic : null,
      };
    });
    const coverage = [...COVERAGE];
    if (!Array.isArray(plugins)) coverage.push("未覆盖：运行行清单不可用。");
    let unknown = false;
    // Static package evidence remains useful even while disabled; no runtime health is inferred.
    if (bundle.availability === "missing") {
      add("missing", "error", "包不可用", "availability=missing", "清单未找到可用包；若已禁用，不代表当前运行故障。", "启用前确认安装来源与路径；不要自动启用或安装。");
    }
    if (bundle.error) {
      const code = bundle.error.code || "bundle-error";
      const readonly = code === "management-required" || code === "unaddressable";
      add(code, readonly ? "warning" : "error", readonly ? "包管理受限" : "包清单报告错误",
        JSON.stringify({ code, diagnostic: bundle.error.diagnostic ?? null, incompatible: bundle.error.incompatible ?? [] }),
        readonly ? "常规管理操作可能不可用；不代表运行损坏。" : "包的静态清单存在异常；若已禁用，不代表当前运行故障。",
        "查看宿主诊断并人工处理，不自动修改配置。");
    }
    if (bundle.enabled !== false) {
      if (bundle.enabled !== true) {
        unknown = true;
        add("enablement-unknown", "info", "包启用状态未知", "清单未提供明确 enabled 布尔值。", "不能证明包正在运行。", "刷新清单并检查宿主状态。");
      }
      if (Array.isArray(bundle.overrides) && bundle.overrides.length > 0) {
        add("configuration-overrides", "warning", "包含配置覆盖", `overrides=${JSON.stringify(bundle.overrides)}`,
          "启停可能改变这些配置目标；仅凭声明无法确定关联包或冲突。", "核对覆盖目标与配置后再变更。", bundle.overrides);
      }
      if (rows.length === 0) {
        unknown = true;
        add("no-runtime-rows", "info", "没有可检查的运行行", "包 rows 为空。", "可能是纯配置包，无法证明运行健康或损坏。", "核对包用途；必要时检查其实际功能。");
      }
      if (rows.length > 0 && rows.every((row) => row.enabled === false)) {
        unknown = true;
        add("no-active-rows", "info", "没有活动运行行", "所有已知行均 enabled=false。", "包已选择，但没有可确认加载正常的活动行；不视为损坏。", "核对包用途，不自动启用行。");
      }
      for (const row of rows) {
        const related = [row.entryId ?? row.rowId].filter(Boolean);
        if (row.enabled === false) {
          add("row-disabled", "info", "行已停用", `${row.rowId}: enabled=false`, "该行未参与运行；不视为包损坏。", "仅在确认需要时由用户手动启用。", related);
        } else if (row.enabled === true && row.phase === "failed") {
          add("row-failed", "error", "运行行失败", `${row.rowId}: phase=failed; ${row.diagnostic ?? "未提供详细诊断"}`,
            "该行功能可能不可用。", "检查宿主诊断与该行配置。", related);
        } else if (row.enabled === null || row.phase !== "active") {
          unknown = true;
          add("row-not-active", "info", "尚未确认行已激活", `${row.rowId}: enabled=${row.enabled}, phase=${row.phase}; ${row.diagnostic ?? "无详细诊断"}`,
            "启用选择不等于 active；可能正在过渡或等待依赖，原因尚不确定。", "稍后刷新并查看宿主诊断，不据此判定损坏。", related);
        } else if (row.diagnostic) {
          add("row-diagnostic", "warning", "运行行带有诊断", `${row.rowId}: ${row.diagnostic}`,
            "行已 active，但宿主同时报告诊断；影响需要核实。", "阅读诊断并验证实际功能。", related);
        }
      }
    } else {
      coverage.push("未检查：包已禁用，忽略残留运行错误；不自动启用。");
    }
    const status = bundle.enabled === false ? "disabled"
      : issues.some((entry) => entry.severity === "error") ? "problem"
      : issues.some((entry) => entry.severity === "warning") ? "risk"
      : unknown ? "unknown" : "normal";
    Object.defineProperty(packs, bundle.name, { value: { status, issues, rows, coverage }, enumerable: true });
    summary.total += 1;
    summary[status] += 1;
  }
  return { checkedAt, packs, summary };
}

/** Analyze proposed selections without applying them or pretending their future rows are active. */
export function preflightHealth(bundles, plugins, changes, checkedAt = null) {
  const report = analyzeHealth(bundles, plugins, checkedAt);
  const findings = [];
  const byName = new Map(bundles.map((bundle) => [bundle.name, bundle]));
  let blocked = false;
  for (const change of changes) {
    const bundle = byName.get(change.name);
    const related = [change.name];
    if (bundle?.readOnlyReason) {
      findings.push(issue("management-restricted", "warning", "包管理操作受限",
        `目标 ${change.name}；readOnlyReason=${bundle.readOnlyReason}`,
        "宿主可能拒绝变更；这不构成运行错误，也不能绕过宿主管理保护。", "保留界面只读限制，按宿主要求管理。", related));
    }
    if (!change.enabled) {
      for (const entry of report.packs[change.name]?.issues ?? []) {
        if (entry.code === "missing" || entry.code === "configuration-overlap" || entry.code === bundle?.error?.code) {
          findings.push({ ...entry, severity: "warning", related: [...entry.related],
            evidence: entry.code === "configuration-overlap" ? `当前快照：${entry.evidence}` : entry.evidence });
        }
      }
      const active = report.packs[change.name]?.rows.filter((row) => row.enabled && row.phase === "active") ?? [];
      findings.push(issue("disable-scope", active.length ? "warning" : "info", "停用影响与检查范围",
        `目标 ${change.name}；当前确认 active 的行：${active.map((row) => row.entryId).join(", ") || "无"}。`,
        active.length ? "停用将移除包层；当前活动行功能可能停止，完整依赖影响未覆盖。" : "未确认活动行；完整依赖图与配置影响未覆盖，不代表没有影响。",
        "核对用途与配置；不能从当前清单推断其他包依赖。", related));
      if (bundle?.overrides?.length) findings.push(issue("configuration-overrides", "warning", "停用包含配置覆盖的包",
        `overrides=${JSON.stringify(bundle.overrides)}`, "移除包层可能改变这些配置目标，关联包未知。", "人工核对覆盖目标。", related));
      continue;
    }
    const code = !bundle || bundle.availability === "missing" ? "missing" : bundle.error?.code;
    if (BLOCKING.has(code)) {
      blocked = true;
      findings.push(issue(code, "error", "当前证据不允许启用", `${change.name}: ${code}; ${bundle?.error?.diagnostic ?? ""}`,
        "清单明确报告包缺失、非 bundle、平台或版本不兼容。", "先处理宿主报告的问题，再重新预检。", related));
    }
    for (const entry of report.packs[change.name]?.issues ?? []) {
      // Current overlaps may disappear when another batch target is disabled.
      if (entry.severity === "info" || entry.code === "configuration-overlap" || entry.code === code && BLOCKING.has(code)) continue;
      findings.push({ ...entry, severity: "warning", related: [...entry.related] });
    }
    // Disabled packages have no runtime findings; configuration metadata is still relevant.
    if (bundle?.enabled === false && bundle.overrides?.length) {
      findings.push(issue("configuration-overrides", "warning", "启用将加入配置覆盖",
        `overrides=${JSON.stringify(bundle.overrides)}`, "配置目标可能改变，不能据此推断关联包或冲突。", "人工核对覆盖目标。", related));
    }
    findings.push(issue("preflight-coverage", "info", "启用预检范围有限", `目标 ${change.name}；本预检未执行启用。`,
      "未检查外部程序、密钥、完整依赖图及没有明确错误的版本兼容性；不保证启用后 active。", "启用后刷新体检并验证实际功能。", related));
  }
  const desired = new Map(changes.map((change) => [change.name, change.enabled]));
  const enabling = new Set(changes.filter((change) => change.enabled).map((change) => change.name));
  const prospective = bundles.map((bundle) => desired.has(bundle.name) ? { ...bundle, enabled: desired.get(bundle.name) } : bundle);
  for (const entry of configurationOverlaps(prospective)) {
    if (enabling.has(entry.related[0]) || enabling.has(entry.related[1])) {
      findings.push({ ...entry, evidence: `按整批请求计算的预期启用集合（未执行变更）：${entry.evidence}` });
    }
  }
  return { report, findings, blocked };
}
