import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzeHealth, preflightHealth } from "../lib/health.js";
import { apply } from "../lib/index.js";

const stamp = "2026-01-01T00:00:00.000Z";
const bundle = (name = "fixture-pack", extra = {}) => ({ name, enabled: true, installed: true,
  availability: "profile", version: "1.0.0", rows: [{ rowId: `${name}-row`, moduleName: "fixture-module", entryId: `${name}-entry` }], overrides: [], ...extra });
const plugin = (name = "fixture-pack", extra = {}) => ({ entryId: `${name}-entry`, moduleName: "fixture-module", enabled: true, fiberPhase: "active", ...extra });
const analyze = (b = [bundle()], p = [plugin()]) => analyzeHealth(b, p, stamp);

function deepFreeze(value) {
  if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
}

test("pure analysis is deterministic and does not mutate inputs; timestamp is caller-owned", () => {
  const b = deepFreeze([bundle()]); const p = deepFreeze([plugin()]);
  assert.deepEqual(analyze(b, p), analyze(b, p));
  assert.equal(analyze(b, p).checkedAt, stamp);
  assert.equal(analyzeHealth(b, p).checkedAt, null);
  assert.equal(analyze(b, p).packs["fixture-pack"].status, "normal");
  assert.deepEqual(analyze(b, p).summary, { total: 1, problem: 0, risk: 0, unknown: 0, disabled: 0, normal: 1 });
});

test("enabled never implies active; transition/null phases stay unknown, not broken", () => {
  for (const phase of ["pending", "loading", "unloading", null]) {
    const pack = analyze([bundle()], [plugin(undefined, { fiberPhase: phase })]).packs["fixture-pack"];
    assert.equal(pack.status, "unknown");
    assert.ok(pack.issues.every((i) => i.severity === "info"));
  }
});

test("explicit failed runtime row produces an evidenced error", () => {
  const pack = analyze([bundle()], [plugin(undefined, { fiberPhase: "failed", diagnostic: "synthetic activation failure" })]).packs["fixture-pack"];
  assert.equal(pack.status, "problem");
  assert.match(pack.issues[0].evidence, /synthetic activation failure/);
  assert.ok(pack.issues[0].related.includes("fixture-pack-entry"));
});

test("disabled package never reports stale runtime errors or auto-enables", () => {
  const b = bundle(undefined, { enabled: false, error: { code: "incompatible-version" }, overrides: ["example-target"] });
  const pack = analyze([b], [plugin(undefined, { fiberPhase: "failed" })]).packs[b.name];
  assert.equal(pack.status, "disabled"); assert.equal(b.enabled, false);
  assert.ok(pack.issues.some((i) => i.code === "incompatible-version"));
  assert.ok(pack.issues.every((i) => i.code !== "row-failed"));
});

test("individual disabled rows do not mark the bundle broken", () => {
  const b = bundle(); b.rows.push({ rowId: "off", moduleName: "fixture-other", entryId: "off-entry" });
  const pack = analyze([b], [plugin(), plugin("off", { entryId: "off-entry", enabled: false, fiberPhase: "failed" })]).packs[b.name];
  assert.equal(pack.status, "normal"); assert.equal(pack.issues[0].code, "row-disabled");
});

test("all disabled rows cannot establish loading health", () => {
  const pack = analyze([bundle()], [plugin(undefined, { enabled: false, fiberPhase: null })]).packs["fixture-pack"];
  assert.equal(pack.status, "unknown"); assert.ok(pack.issues.some((i) => i.code === "no-active-rows"));
  const disabled = analyze([bundle(undefined, { enabled: false, availability: "missing" })], []).packs["fixture-pack"];
  assert.equal(disabled.status, "disabled"); assert.ok(disabled.issues.some((i) => i.code === "missing"));
});

test("same module is not a conflict and is never used to guess entry identity", () => {
  const r = analyze([bundle("a"), bundle("b")], [plugin("a"), plugin("b")]);
  assert.equal(r.summary.normal, 2);
  const missing = analyze([bundle("a")], [plugin("b")]).packs.a;
  assert.equal(missing.status, "unknown"); assert.equal(missing.rows[0].enabled, null);
  assert.equal(analyze([bundle()], [plugin(), plugin()]).packs["fixture-pack"].status, "unknown");
});

test("override warning describes configuration only, not guessed related packages", () => {
  const pack = analyze([bundle(undefined, { overrides: ["example-target"] })]).packs["fixture-pack"];
  assert.equal(pack.status, "risk"); assert.equal(pack.issues[0].code, "configuration-overrides");
  assert.deepEqual(pack.issues[0].related, ["fixture-pack", "example-target"]);
});

test("no rows is unknown, version/program/credential gaps stay explicitly uncovered", () => {
  const pack = analyze([bundle(undefined, { rows: [] })]).packs["fixture-pack"];
  assert.equal(pack.status, "unknown"); assert.ok(pack.coverage.some((s) => s.includes("密钥")));
  assert.ok(pack.coverage.some((s) => s.includes("版本")));
  assert.equal(analyze([bundle(undefined, { installed: false, availability: "installation" })]).summary.normal, 1);
});

test("bundle errors and availability missing are problems; readonly is not runtime failure", () => {
  assert.equal(analyze([bundle(undefined, { error: { code: "unsupported-platform", diagnostic: "fixture platform" } })]).summary.problem, 1);
  assert.equal(analyze([bundle(undefined, { availability: "missing" })]).summary.problem, 1);
  assert.equal(analyze([bundle(undefined, { error: { code: "management-required" } })]).summary.risk, 1);
});

test("summary partitions all pack statuses and special keys remain ordinary data", () => {
  const b = [bundle("normal"), bundle("problem", { availability: "missing" }), bundle("risk", { overrides: ["x"] }),
    bundle("unknown", { rows: [] }), bundle("disabled", { enabled: false }), bundle("__proto__")];
  const report = analyze(b, b.map((v) => plugin(v.name)));
  assert.deepEqual(report.summary, { total: 6, normal: 2, problem: 1, risk: 1, unknown: 1, disabled: 1 });
  assert.ok(Object.hasOwn(report.packs, "__proto__"));
});

test("enable preflight blocks only explicit blocking errors/missing, even for disabled packages", () => {
  for (const code of ["incompatible-version", "unsupported-platform", "not-bundle"]) {
    const b = bundle(undefined, { enabled: false, error: { code, diagnostic: `fixture ${code}` } });
    const r = preflightHealth([b], [], [{ name: b.name, enabled: true }], stamp);
    assert.equal(r.blocked, true); assert.equal(r.report.packs[b.name].status, "disabled");
    assert.equal(r.findings[0].code, code);
  }
  assert.equal(preflightHealth([], [], [{ name: "absent", enabled: true }]).blocked, true);
  for (const code of ["operation-error", "management-required", "unaddressable"]) {
    const r = preflightHealth([bundle(undefined, { enabled: false, error: { code } })], [], [{ name: "fixture-pack", enabled: true }]);
    assert.equal(r.blocked, false); assert.ok(r.findings.some((i) => i.code === code && i.severity === "warning"));
  }
});

test("read-only metadata warns without bypassing or inventing extra blockers", () => {
  const r = preflightHealth([bundle(undefined, { readOnlyReason: "management-required" })], [plugin()],
    [{ name: "fixture-pack", enabled: false }], stamp);
  assert.equal(r.blocked, false);
  assert.ok(r.findings.some((i) => i.code === "management-restricted" && i.severity === "warning"));
});

test("disable preflight never blocks and does not invent dependent packages", () => {
  const r = preflightHealth([bundle(undefined, { error: { code: "not-bundle" } })], [plugin()],
    [{ name: "fixture-pack", enabled: false }, { name: "absent", enabled: false }], stamp);
  assert.equal(r.blocked, false); assert.equal(r.findings[0].severity, "warning");
  assert.ok(r.findings.some((i) => i.code === "not-bundle" && i.severity === "warning"));
  assert.ok(r.findings.every((i) => i.related.length === 1));
  assert.ok(r.findings.some((i) => i.related.includes("absent") && i.severity === "info"));
});

test("batch preflight aggregates every target without upgrading other errors to blockers", () => {
  const r = preflightHealth([bundle("a", { enabled: false, overrides: ["x"] }), bundle("b")], [plugin("b", { fiberPhase: "failed" })],
    [{ name: "a", enabled: true }, { name: "b", enabled: true }, { name: "missing", enabled: true }], stamp);
  assert.equal(r.blocked, true);
  for (const name of ["a", "b", "missing"]) assert.ok(r.findings.some((i) => i.related.includes(name)));
  assert.ok(r.findings.some((i) => i.code === "row-failed" && i.severity === "warning"));
});

test("exact override-to-row target overlap warns on both enabled packs", () => {
  const b = deepFreeze([bundle("a", { overrides: ["b-row", "b-row"] }), bundle("b")]);
  const r = analyze(b, [plugin("a"), plugin("b")]);
  assert.equal(r.summary.risk, 2);
  for (const name of ["a", "b"]) {
    const overlaps = r.packs[name].issues.filter((i) => i.code === "configuration-overlap");
    assert.equal(overlaps.length, 1); assert.equal(overlaps[0].severity, "warning");
    assert.deepEqual(overlaps[0].related, ["a", "b", "b-row"]);
    assert.match(overlaps[0].evidence, /overrides/); assert.match(overlaps[0].evidence, /rows.rowId/);
    assert.match(overlaps[0].impact, /不是确定冲突/); assert.match(overlaps[0].impact, /执行顺序/);
  }
});

test("exact override-to-override overlap is configuration risk, not a blocker", () => {
  const b = [bundle("a", { overrides: ["shared"] }), bundle("b", { overrides: ["shared"] })];
  assert.ok(analyze(b).packs.a.issues.some((i) => i.code === "configuration-overlap"));
  const r = preflightHealth(b, [], [{ name: "a", enabled: true }], stamp);
  assert.equal(r.blocked, false);
  assert.equal(r.findings.filter((i) => i.code === "configuration-overlap").length, 1);
});

test("row-row same names without overrides do not create configuration overlap", () => {
  const b = [bundle("a"), bundle("b", { rows: [{ rowId: "a-row", moduleName: "fixture-module", entryId: "b-entry" }] })];
  const r = analyze(b, [plugin("a"), plugin("b")]);
  assert.equal(r.summary.normal, 2);
  assert.ok(Object.values(r.packs).every((p) => !p.issues.some((i) => i.code === "configuration-overlap")));
});

test("different exact targets, whitespace, prefixes and module names never imply overlap", () => {
  for (const target of ["different", " b-row", "b-row ", "b", "fixture-module"]) {
    const r = analyze([bundle("a", { overrides: [target] }), bundle("b")]);
    assert.ok(Object.values(r.packs).every((p) => !p.issues.some((i) => i.code === "configuration-overlap")));
  }
});

test("disabled or unknown-enable bundles do not produce current configuration overlap", () => {
  for (const enabled of [false, undefined]) {
    const r = analyze([bundle("a", { overrides: ["shared"] }), bundle("b", { enabled, overrides: ["shared"] })]);
    assert.ok(Object.values(r.packs).every((p) => !p.issues.some((i) => i.code === "configuration-overlap")));
  }
});

test("batch enabling two disabled packs checks prospective overlap without predicting active", () => {
  const b = deepFreeze([bundle("a", { enabled: false, overrides: ["shared"] }), bundle("b", { enabled: false, overrides: ["shared"] })]);
  const r = preflightHealth(b, [], [{ name: "a", enabled: true }, { name: "b", enabled: true }], stamp);
  const overlaps = r.findings.filter((i) => i.code === "configuration-overlap");
  assert.equal(overlaps.length, 1); assert.deepEqual(overlaps[0].related, ["a", "b", "shared"]);
  assert.equal(overlaps[0].severity, "warning"); assert.equal(r.blocked, false);
  assert.equal(r.report.summary.disabled, 2); assert.equal(r.report.packs.a.rows[0].phase, null);
  assert.equal(b[0].enabled, false);
  assert.equal(preflightHealth(b, [], [{ name: "a", enabled: true }]).findings.some((i) => i.code === "configuration-overlap"), false);
});

test("whole-batch disable removes prospective overlap; disable may explain current shared target", () => {
  const b = [bundle("a", { overrides: ["shared"] }), bundle("b", { overrides: ["shared"] })];
  const r = preflightHealth(b, [], [{ name: "a", enabled: true }, { name: "b", enabled: false }], stamp);
  // One warning describes the confirmed current pair for the disabling target, not a future conflict.
  assert.equal(r.findings.filter((i) => i.code === "configuration-overlap").length, 1);
  const disableOnly = preflightHealth(b, [], [{ name: "b", enabled: false }], stamp);
  assert.equal(disableOnly.blocked, false);
  assert.ok(disableOnly.findings.some((i) => i.code === "configuration-overlap" && i.related.includes("a")));
  const mixed = [bundle("a", { enabled: false, overrides: ["shared"] }), bundle("b", { overrides: ["shared"] })];
  assert.equal(preflightHealth(mixed, [], [{ name: "a", enabled: true }, { name: "b", enabled: false }]).findings.some((i) => i.code === "configuration-overlap"), false);
});

async function harness(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "plugin-packs-health-test-"));
  let handler; let bundleCalls = 0; let pluginCalls = 0;
  const ctx = { pluginManager: {
    listBundles: async () => { bundleCalls++; return [bundle()]; },
    listPlugins: async () => { pluginCalls++; return [plugin()]; },
    setBundleEnabled: () => { throw new Error("READ-ONLY endpoint attempted mutation"); },
  }, inject: (_keys, fn) => fn({ effect: (fn) => fn(), webServer: { register: (route) => { handler = route.handler; return () => {}; } } }) };
  apply(ctx, { storageDir: dir });
  const request = async (suffix, { method = "GET", headers = {}, body } = {}) => {
    const req = new PassThrough(); req.url = `/plugin-packs/api${suffix}`; req.method = method; req.headers = headers;
    let status; let payload;
    const res = { headersSent: false, writeHead: (s) => { status = s; res.headersSent = true; }, end: (data) => { payload = data; } };
    const done = handler(req, res); req.end(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body));
    await done;
    return { status, body: JSON.parse(payload.toString()) };
  };
  try { await run({ request, calls: () => [bundleCalls, pluginCalls], dir }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test("GET diagnostics and bundles take one snapshot each and never touch state", async () => harness(async ({ request, calls, dir }) => {
  const r = await request("/diagnostics"); assert.equal(r.status, 200); assert.equal(r.body.ok, true);
  assert.equal(r.body.value.summary.normal, 1); assert.ok(Number.isFinite(Date.parse(r.body.value.checkedAt)));
  assert.deepEqual(calls(), [1, 1]);
  const b = await request("/bundles"); assert.equal(b.body.value.bundles.length, 1);
  assert.equal(b.body.value.diagnostics.summary.normal, 1); assert.deepEqual(calls(), [2, 2]);
  assert.deepEqual(await readdir(dir), []);
}));

test("preflight route validates header, JSON, boolean and duplicate targets before reading inventory", async () => harness(async ({ request, calls, dir }) => {
  const post = (body, headers = { "x-plugin-packs": "1" }) => request("/preflight", { method: "POST", headers, body });
  assert.equal((await post({ changes: [] }, {})).status, 400);
  for (const body of ["{", {}, { changes: [] }, { changes: [{ name: "a", enabled: "true" }] },
    { changes: [{ name: "a", enabled: true }, { name: " a ", enabled: false }] }]) assert.equal((await post(body)).status, 400);
  assert.deepEqual(calls(), [0, 0]);
  const r = await post({ changes: [{ name: " fixture-pack ", enabled: false }, { name: "absent", enabled: true }] });
  assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(r.body.value.blocked, true);
  assert.equal(r.body.value.report.summary.normal, 1); assert.deepEqual(calls(), [1, 1]);
  assert.deepEqual(await readdir(dir), []);
}));
