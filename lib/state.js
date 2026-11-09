/** Plugin-owned v2 state. No manager mutations occur in this module. */
import { mkdir, readFile, rename, writeFile, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const STATE_FILE = "packs.json";
export const STATE_VERSION = 2;
export const DEFAULT_TAGS = [
  { id: "novel", label: "小说 · 阅读", color: "#7B68EE" },
  { id: "search", label: "联网搜索", color: "#4C9AFF" },
  { id: "ui", label: "界面美化", color: "#E8A33D" },
  { id: "sec", label: "安全 · 渗透", color: "#D9534F" },
  { id: "model", label: "模型渠道", color: "#3AA76D" },
  { id: "mem", label: "记忆 · 知识", color: "#17A2B8" },
  { id: "tools", label: "工具 · 其它", color: "#8E8E93" },
];
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string" ? v.trim() : "";
const strings = (v) => [...new Set((Array.isArray(v) ? v : []).map(text).filter(Boolean))];
const own = (v, k) => Object.hasOwn(v, k);
const put = (v, k, x) => Object.defineProperty(v, k, { value: x, enumerable: true, writable: true, configurable: true });
export function stateError(message, status = 400) { return Object.assign(new Error(message), { status }); }

export function normalizeState(raw) {
  const source = object(raw) ? raw : {};
  if (source.version !== undefined && source.version !== 1 && source.version !== 2) {
    throw stateError(`不支持状态版本 ${source.version}，请升级插件`, 409);
  }
  const seen = new Set();
  const tags = [];
  for (const entry of Array.isArray(source.tags) ? source.tags : []) {
    if (!object(entry)) continue;
    const id = text(entry.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    tags.push({ id, label: text(entry.label) || id,
      color: /^#[0-9a-fA-F]{3,8}$/.test(text(entry.color)) ? text(entry.color) : "#8E8E93" });
  }
  const packs = {};
  for (const [key, entry] of Object.entries(object(source.packs) ? source.packs : {})) {
    const name = text(key);
    if (!name || !object(entry)) continue;
    const record = {};
    if (text(entry.name)) record.name = text(entry.name).slice(0, 120);
    for (const field of ["tags", "autoTags", "suppressedTags"]) {
      const values = strings(entry[field]);
      if (values.length) record[field] = values;
    }
    if (entry.autoClassified === true || source.version === 1) record.autoClassified = true;
    // Keep even empty records: their names are durable user data, not inventory.
    put(packs, name, record);
  }
  const groups = []; const groupIds = new Set(); const members = new Set();
  for (const entry of Array.isArray(source.groups) ? source.groups : []) {
    if (!object(entry)) continue;
    const id = text(entry.id); const name = text(entry.name).slice(0, 120);
    if (!id || !name || groupIds.has(id)) continue;
    groupIds.add(id);
    const kept = strings(entry.members).filter((m) => { if (members.has(m)) return false; members.add(m); return true; });
    groups.push({ id, name, members: kept });
  }
  return { version: 2, revision: Number.isSafeInteger(source.revision) && source.revision >= 0 ? source.revision : 0, tags, packs, groups };
}
export const seedState = () => normalizeState({ version: 2, tags: DEFAULT_TAGS });
// These public runtime-mode bundles cannot be toggled safely from this desktop profile.
export const OTHER_MODE_PACKS = new Set(["@deepseek-ai/dsh-acp-app", "@deepseek-ai/dsh-headless",
  "@deepseek-ai/dsh-sdk-app", "@deepseek-ai/dsh-sdk-minimal"]);
export const manageableBundle = (b) => object(b) && typeof b.name === "string" && !!b.name.trim()
  && !b.readOnlyReason && !OTHER_MODE_PACKS.has(b.name)
  && ((b.availability === "profile" && b.installed === true) || (b.availability === "installation" && b.optional === true));
export const autoTagCandidate = (b) => manageableBundle(b) && b.availability === "profile" && b.installed === true;

// Evidence only: package name/description and all localized display text, including rows.
function allText(v) {
  if (typeof v === "string") return v;
  if (!object(v) && !Array.isArray(v)) return "";
  return Object.values(v).map(allText).join(" ");
}
// Identity is strong evidence; descriptions frequently mention incidental UI/search/tools.
// Require an explicit purpose in descriptions rather than treating every mentioned noun as identity.
const RULES = {
  novel: { identity: /\b(novel|fiction|ebook|reader|writing)\b|小说|网文|阅读|写作/i,
    purpose: /\b(novel|fiction|ebook)\b|\b(creative writing|book reader|chapter writing)\b|小说|网文|电子书|章节(?:写作|续写|创作)|(?:写作|阅读)助手/i },
  search: { identity: /\b(search|browse|browser|crawl|crawler)\b|搜索|检索|联网|爬虫|浏览器/i,
    purpose: /\b(web search|internet search|search engine|web browsing|web crawler|web scraping|crawler)\b|(?:联网|网页|网络|全网|互联网)(?:搜索|检索|浏览)|搜索引擎|网页抓取|爬虫/i },
  ui: { identity: /\b(ui|theme|decoration|wallpaper|widget|appearance)\b|界面|美化|主题|壁纸|挂件/i,
    purpose: /\b(theming|wallpaper|widget|sidebar|ui customization|appearance customization|visual decoration)\b|(?:界面|外观)(?:美化|定制)|美化|主题(?:切换|定制|配色)|壁纸|挂件|侧边栏|外观定制/i },
  sec: { identity: /\b(security|pentest|vulnerability|exploit|cyber|ctf)\b|渗透|漏洞|网安|网络安全|安全审计/i,
    purpose: /\b(pentest|penetration testing|security auditing|security audit|vulnerability scanning|vulnerability research|cybersecurity|ctf)\b|渗透测试|漏洞(?:扫描|检测|研究|利用)|网络安全|安全审计/i },
  model: { identity: /\b(llm|model|provider|inference|openai|anthropic)\b|模型|推理渠道|供应商/i,
    purpose: /\b(llm provider|model provider|inference provider|inference gateway|model gateway|model routing)\b|模型(?:渠道|供应商|提供商|接入|路由|网关)|推理(?:渠道|服务|网关)|大语言模型接入/i },
  mem: { identity: /\b(memory|knowledge|notes|obsidian|rag)\b|记忆|知识|笔记/i,
    purpose: /\b(persistent memory|long term memory|knowledge base|note taking|obsidian|retrieval augmented generation)\b|跨会话记忆|长期记忆|持久记忆|记忆(?:存储|管理)|知识库|笔记(?:管理|记录)|语义记忆/i },
  tools: { identity: /\b(tool|tools|terminal|shell|utility|utilities|automation|workflow|file manager|imagegen|image generation)\b|工具|终端|自动化|工作流|文件管理|生图|图像生成/i,
    purpose: /\b(terminal|shell|automation|workflow automation|file manager|file management|command execution|image generation)\b|终端|命令执行|自动化|文件管理|工作流编排|(?:图片|图像)生成|本地生图/i },
};
export function inferAutoTags(bundle, tagIds) {
  const metas = [bundle.meta, ...(Array.isArray(bundle.rows) ? bundle.rows.map((r) => r?.meta) : [])];
  const clean = (v) => allText(v).replace(/[-_/]/g, " ");
  const identities = [bundle.name, ...metas.map((m) => m?.title)].map(clean);
  const descriptions = [bundle.description, ...metas.map((m) => m?.description)].map(clean);
  return Object.entries(RULES).filter(([id, rule]) => tagIds.has(id)
    && (identities.some((s) => rule.identity.test(s)) || descriptions.some((s) => rule.purpose.test(s)))).map(([id]) => id);
}
export function classifyState(state, bundles, { force = false, markOnly = false } = {}) {
  const next = normalizeState(state); const tagIds = new Set(next.tags.map((t) => t.id));
  for (const bundle of bundles.filter(autoTagCandidate)) {
    const old = own(next.packs, bundle.name) ? next.packs[bundle.name] : {};
    if (!force && old.autoClassified === true) continue;
    const blocked = new Set([...(old.tags ?? []), ...(old.suppressedTags ?? [])]);
    const autoTags = markOnly ? (old.autoTags ?? []) : inferAutoTags(bundle, tagIds).filter((id) => !blocked.has(id));
    put(next.packs, bundle.name, { ...old, autoTags, autoClassified: true });
  }
  return normalizeState(next);
}

/** PUT preserves absent v2 metadata; the v2 UI owns explicit automatic-tag suppression intent. */
export function mergeState(current, raw) {
  if (!object(raw) || raw.version !== 2 || !Number.isSafeInteger(raw.revision) || raw.revision !== current.revision) {
    throw stateError("状态已更新或客户端版本过旧，请刷新后重试", 409);
  }
  const next = normalizeState(raw);
  // Group writes belong to actions (which validate inventory); PUT cannot bypass those checks.
  next.groups = current.groups.map((g) => ({ ...g, members: [...g.members] }));
  for (const [name, old] of Object.entries(current.packs)) {
    const candidate = object(raw.packs) && own(raw.packs, name) && object(raw.packs[name]) ? raw.packs[name] : {};
    const record = own(next.packs, name) ? next.packs[name] : {};
    for (const field of ["autoTags", "suppressedTags", "autoClassified"]) {
      if (!own(candidate, field) && own(old, field)) record[field] = old[field];
    }
    put(next.packs, name, record);
  }
  next.revision = current.revision + 1;
  return normalizeState(next);
}
function memberList(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.some((m) => typeof m !== "string" || !m.trim())
    || strings(raw).length !== raw.length) throw stateError("members 必须是非空、唯一的字符串数组");
  return strings(raw);
}
function groupName(raw) {
  const value = text(raw);
  if (!value || value.length > 120) throw stateError("组名必须是 1–120 个字符");
  return value;
}
export function applyStateAction(current, action, bundles, newId) {
  if (!object(action)) throw stateError("缺少 action");
  let next = normalizeState(current);
  if (action.action === "auto-tag") next = classifyState(next, bundles, { force: true });
  else if (["group-create", "group-add", "group-remove", "group-rename", "group-dissolve"].includes(action.action)) {
    let group;
    if (action.action !== "group-create") {
      group = next.groups.find((g) => g.id === action.id);
      if (!group) throw stateError("组不存在", 404);
    }
    if (action.action === "group-create" || action.action === "group-add") {
      const members = memberList(action.members);
      const allowed = new Set(bundles.filter(manageableBundle).map((b) => b.name));
      if (members.some((m) => !allowed.has(m))) throw stateError("新增成员必须是现有可管理的用户包或官方可选包");
      const name = action.action === "group-create" ? groupName(action.name) : group.name;
      if (action.action === "group-create") {
        if (!text(newId) || next.groups.some((g) => g.id === newId)) throw stateError("无效的新组 id");
        group = { id: newId, name, members: [] }; next.groups.push(group);
      }
      for (const other of next.groups) other.members = other.members.filter((m) => !members.includes(m));
      group.members.push(...members);
    } else if (action.action === "group-remove") {
      const members = memberList(action.members);
      group.members = group.members.filter((m) => !members.includes(m));
    } else if (action.action === "group-rename") group.name = groupName(action.name);
    else next.groups = next.groups.filter((g) => g !== group);
  } else throw stateError("未知 action");
  next.revision = current.revision + 1;
  return normalizeState(next);
}

export async function writeState(dir, state) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, STATE_FILE); const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); await rename(temp, file); }
  finally { await unlink(temp).catch((e) => { if (e.code !== "ENOENT") throw e; }); }
}
// Publish a complete backup without replacing a previous one. No partial backups on crash.
async function backupOnce(file, raw, suffix) {
  const dest = `${file}.${suffix}`; const temp = `${dest}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, raw, { encoding: "utf8", flag: "wx" });
    try { await link(temp, dest); }
    catch (e) { if (e.code !== "EEXIST") throw e; await readFile(dest, "utf8"); }
  } finally { await unlink(temp).catch((e) => { if (e.code !== "ENOENT") throw e; }); }
}
export async function readState(dir, bundles = [], { backup = backupOnce } = {}) {
  const file = path.join(dir, STATE_FILE); let raw;
  try { raw = await readFile(file, "utf8"); }
  catch (e) { if (e.code !== "ENOENT") throw e; const fresh = seedState(); await writeState(dir, fresh); return fresh; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    await backup(file, raw, `broken-${randomUUID()}`); // Failure must stop before overwriting original.
    const fresh = seedState(); await writeState(dir, fresh); return fresh;
  }
  const state = normalizeState(parsed); // Unsupported versions never enter JSON-repair handling.
  if (parsed?.version === 1) {
    await backup(file, raw, "v1.bak");
    const migrated = classifyState(state, bundles, { markOnly: true });
    await writeState(dir, migrated); return migrated;
  }
  return state;
}
