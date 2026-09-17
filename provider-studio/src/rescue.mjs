// src/rescue.mjs
// Safety net around the opencode config: snapshots, restore, validation, and
// the network probes used by "Test" and "Discover models".
//
// Three things this module deliberately does NOT do itself:
//   - decide where files live      -> paths.mjs
//   - parse JSONC                  -> jsonc-edit.mjs
//   - know the provider schema     -> formats.mjs
// Earlier versions duplicated all three, and the copies drifted: backups were
// written next to the source (read-only once packaged), and a hand-rolled
// comment stripper rejected trailing commas that opencode itself accepts.

import { readFileSync, readdirSync, existsSync, statSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  backupDir, dataDir, ensureDir, writeFileAtomic, isInside, IS_WINDOWS,
} from "./paths.mjs";
import { parseJsonc } from "./jsonc-edit.mjs";
import { proxyForUrl, proxyFetch, describeProxy } from "./proxy.mjs";
import {
  looksLikePackage, isCustomProviderBlock, decodeApiKey, isPlaintextKey,
  suggestEnvVarName, MODALITIES, MODEL_STATUSES, PROVIDER_FIELDS, MODEL_FIELDS,
} from "./formats.mjs";
import {
  resolveKeyRef, keyRefProblem, lookupEnv, setEnvCommand, SETX_MAX_LENGTH,
} from "./env.mjs";

// Re-exported so callers keep a single import site for "where does data go".
// These stay functions on purpose: a captured constant would freeze the path
// before tests (or a packaged exe) get to set PS_DATA_DIR.
export { backupDir, dataDir };

export function ensureBackupDir() {
  return ensureDir(backupDir());
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sanitize(s) {
  return String(s || "").replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/**
 * Snapshots a config file.
 * The name carries a counter as well as a timestamp: several writes inside one
 * second are routine (apply, then repoint the default model), and a
 * second-resolution name alone would silently overwrite the earlier snapshot.
 */
export function backupConfig(configPath, label = "auto") {
  if (!configPath || !existsSync(configPath)) return null;
  let raw;
  try { raw = readFileSync(configPath, "utf8"); } catch { return null; }
  ensureBackupDir();
  const base = `opencode-${stamp()}-${sanitize(label) || "auto"}`;
  let dest = join(backupDir(), `${base}.jsonc`);
  for (let n = 2; existsSync(dest) && n < 1000; n++) {
    dest = join(backupDir(), `${base}-${n}.jsonc`);
  }
  writeFileAtomic(dest, raw);
  prune();
  return dest;
}

export function listBackups() {
  const dir = backupDir();
  if (!existsSync(dir)) return [];
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of names) {
    if (!f.endsWith(".jsonc")) continue;
    try {
      const st = statSync(join(dir, f));
      if (!st.isFile()) continue;
      out.push({ file: f, size: st.size, mtime: st.mtimeMs });
    } catch { /* vanished between readdir and stat */ }
  }
  // Ties on mtime are broken by name, which embeds the counter, so the order is
  // stable rather than dependent on directory order.
  return out.sort((a, b) => b.mtime - a.mtime || b.file.localeCompare(a.file));
}

/**
 * Loads a snapshot for restoring.
 *
 * The filename is never trusted: only an exact match against a listed file is
 * accepted, and the resolved path is re-checked against the backup directory.
 * Otherwise `{ file: "../../.ssh/config" }` would let the caller read, and then
 * write over the opencode config with, an arbitrary file.
 */
export function restoreBackup(file) {
  const raw = String(file || "");
  const wanted = basename(raw);
  // A name that changes under basename() was a path, not a filename.
  if (!wanted || wanted !== raw.trim()) return { ok: false, error: "Бэкап не найден" };
  if (!listBackups().some((b) => b.file === wanted)) return { ok: false, error: "Бэкап не найден" };

  const src = join(backupDir(), wanted);
  if (!isInside(backupDir(), src) || !existsSync(src)) return { ok: false, error: "Бэкап не найден" };

  let text;
  try { text = readFileSync(src, "utf8"); } catch (e) {
    return { ok: false, error: "Бэкап не читается: " + e.message };
  }
  // Uses the real JSONC parser: a backup legitimately contains comments and
  // trailing commas, and the previous JSON.parse-based check rejected both.
  const doc = parseJsonc(text);
  if (!doc.ok) return { ok: false, error: "Бэкап повреждён: " + doc.error };
  if (!doc.value || typeof doc.value !== "object" || Array.isArray(doc.value)) {
    return { ok: false, error: "Бэкап повреждён: корень должен быть объектом" };
  }
  return { ok: true, raw: text, config: doc.value, file: wanted };
}

/** Keeps the newest N snapshots; older ones are dropped. */
function prune(max = 30) {
  for (const b of listBackups().slice(max)) {
    try { unlinkSync(join(backupDir(), b.file)); } catch { /* already gone */ }
  }
}

/** Comment stripper kept for callers that still want plain JSON text. */
export function stripJsonc(raw) {
  let out = ""; let inStr = false; let block = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]; const n = raw[i + 1];
    if (block) { if (c === "*" && n === "/") { block = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (c === "\\") { out += n || ""; i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < raw.length && raw[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { block = true; i++; continue; }
    out += c;
  }
  // Trailing commas are valid JSONC but not JSON; drop them so the result
  // survives JSON.parse.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// ------------------------------------------------------------- validation

const VALID_MODALITIES = new Set(MODALITIES);
const VALID_STATUSES = new Set(MODEL_STATUSES);
const PROVIDER_FIELD_SET = new Set([...PROVIDER_FIELDS, "type", "$schema"]);
// Misplaced fields that get their own, more actionable message.
const SPECIFIC_PROVIDER_FIELDS = new Set(["apiKey", "baseURL"]);
const MODEL_FIELD_SET = new Set(MODEL_FIELDS);

function issue(severity, id, message, extra = {}) {
  return { severity, id, message, ...extra };
}

/**
 * Reports what would stop this config from working, worst first.
 * Only reports what is actually checkable here; anything requiring the network
 * belongs in the diagnostics endpoint.
 */
export function validateConfig(config) {
  const issues = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    issues.push(issue("error", "not-object", "Конфиг не является объектом", { fixable: false }));
    return issues;
  }
  if (!config.provider || typeof config.provider !== "object" || Array.isArray(config.provider)) {
    issues.push(issue("error", "no-provider", "Нет блока provider — добавь провайдера"));
    return issues;
  }

  for (const [key, p] of Object.entries(config.provider)) {
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      issues.push(issue("error", "bad-provider", `Провайдер «${key}» не является объектом`, { provider: key }));
      continue;
    }
    if (p.type === "local") continue; // local runners follow a different shape

    const packageInName = !p.npm && !p.api && looksLikePackage(p.name);
    const isCustom = isCustomProviderBlock(p);

    // additionalProperties:false — one stray field invalidates the whole config,
    // and opencode then ignores every provider, not just this one.
    // Fields with a dedicated diagnosis below are skipped here: reporting both
    // the generic and the specific message for one field is just noise.
    for (const field of Object.keys(p)) {
      if (PROVIDER_FIELD_SET.has(field) || SPECIFIC_PROVIDER_FIELDS.has(field)) continue;
      issues.push(issue("error", "unknown-provider-field",
        `Провайдер «${key}»: поле «${field}» не входит в схему — opencode отклонит весь конфиг`,
        { provider: key, field, fixable: true }));
    }

    if (!p.options?.baseURL && isCustom) {
      issues.push(issue("warn", "no-baseURL", `Провайдер «${key}» без options.baseURL (может быть намеренно)`, { provider: key }));
    }
    if (packageInName) {
      issues.push(issue("error", "npm-as-name",
        `Провайдер «${key}»: пакет «${p.name}» указан в «name» вместо «npm» — opencode его не загрузит`,
        { provider: key, fixable: true }));
    }

    // `apiKey` belongs in `options`. At the top level it is both schema-invalid
    // and never sent, so auth fails with no hint as to why.
    if (p.apiKey !== undefined) {
      issues.push(issue("error", "apikey-top-level",
        `Провайдер «${key}»: apiKey должен лежать в options, а не на верхнем уровне — ключ не будет отправлен`,
        { provider: key, fixable: true }));
    }
    if (p.baseURL !== undefined) {
      // Either way it breaks additionalProperties:false; the consequence
      // differs, so the message does too.
      issues.push(issue("error", "baseurl-top-level",
        p.options?.baseURL
          ? `Провайдер «${key}»: baseURL на верхнем уровне дублирует options.baseURL и не входит в схему — удали его`
          : `Провайдер «${key}»: baseURL должен лежать в options — иначе запросы уйдут не туда`,
        { provider: key, fixable: true }));
    }

    validateApiKey(key, p, issues);
    validateHeaders(key, p, issues);
    validateOptions(key, p, issues);

    const models = p.models && typeof p.models === "object" && !Array.isArray(p.models)
      ? Object.entries(p.models) : [];
    if (!models.length && isCustom) {
      issues.push(issue("warn", "no-models", `Провайдер «${key}» не содержит моделей`, {
        provider: key, fixable: true,
        fixAdd: "Используй форму справа, чтобы добавить модели.",
      }));
    }
    for (const [mid, m] of models) validateModel(key, mid, m, issues);
  }

  // Два провайдера на один адрес — почти всегда копипаст из соседнего блока:
  // запросы уходят не туда, а ключ проверяется не тот. Только предупреждение:
  // зеркала одного шлюза существуют намеренно, и удалять тут нечего.
  const seenBase = new Map();
  for (const [key, p] of Object.entries(config.provider)) {
    if (!p || typeof p !== "object" || Array.isArray(p) || p.type === "local") continue;
    const raw = p.options?.baseURL;
    const base = typeof raw === "string" ? raw.trim().replace(/\/+$/, "").toLowerCase() : "";
    if (!base) continue;
    if (seenBase.has(base)) {
      issues.push(issue("warn", "duplicate-baseurl",
        `Провайдеры «${seenBase.get(base)}» и «${key}» указывают на один Base URL — обычно это копипаст`,
        { provider: key }));
    } else {
      seenBase.set(base, key);
    }
  }

  validateDefaultModel(config, issues);
  return issues;
}

// Таймаут и env-массив руками пишут редко, но когда пишут — пишут как попало:
// строкой, нулём или отрицательным. Нулевой таймаут означает «не ждать вообще»,
// и первый же запрос умирает, а чинится это удалением поля.
function validateOptions(key, p, issues) {
  const opts = p.options;
  // timeout живёт в options, а env — на верхнем уровне: проверять одно только
  // при наличии другого — значит пропускать половину битого.
  if (opts !== undefined && opts && typeof opts === "object" && !Array.isArray(opts)) {
    const t = opts.timeout;
    if (t !== undefined && !(typeof t === "number" && Number.isFinite(t) && t > 0)) {
      issues.push(issue("error", "bad-timeout",
        `Провайдер «${key}»: options.timeout должен быть положительным числом, сейчас: ${JSON.stringify(t)}`,
        { provider: key, fixable: true }));
    }
  }
  const env = p.env;
  if (env === undefined) return;
  if (!Array.isArray(env)) {
    issues.push(issue("error", "bad-env",
      `Провайдер «${key}»: env должен быть массивом имён переменных`,
      { provider: key, fixable: true }));
    return;
  }
  // Одного сообщения на провайдера достаточно: дальше всё равно правится списком.
  if (env.some((n) => typeof n !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) {
    issues.push(issue("error", "bad-env-name",
      `Провайдер «${key}»: в env есть запись, не похожая на имя переменной — opencode её не подставит`,
      { provider: key, fixable: true }));
  }
}

function validateApiKey(key, p, issues) {
  const apiKey = p.options?.apiKey;
  if (typeof apiKey !== "string" || !apiKey) return;

  // A bare $VAR or ${VAR} is sent verbatim as the credential.
  const bare = apiKey.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
  if (bare) {
    issues.push(issue("error", "bad-env-ref",
      `Провайдер «${key}»: ключ «${apiKey}» — opencode ждёт синтаксис {env:${bare[1]}}`,
      { provider: key, fixable: true, suggest: `{env:${bare[1]}}` }));
    return;
  }

  const decoded = decodeApiKey(apiKey);
  if (decoded.useEnvVar) {
    // Checked against the persistent stores too, not just process.env: a
    // variable created with setx after this process started is real but not
    // inherited, and reporting it as missing sends the user in circles.
    const info = lookupEnv(decoded.envVarName);
    if (!info.set) {
      // Severity depends on how much we can actually see.
      //
      // On Windows the lookup covers every place a variable can persist
      // (process, HKCU, machine), so "absent" is authoritative: opencode will
      // substitute "" and the provider will answer 401. That is a present-tense
      // breakage, so it is an error — as a warning it was easy to scroll past,
      // which is exactly how an empty bearer token reached production.
      //
      // Elsewhere only this process's environment is visible. The variable may
      // legitimately come from a wrapper script, direnv or a systemd unit that
      // this process never sees, so claiming a definite error would be a false
      // positive. Warn instead.
      const authoritative = IS_WINDOWS;
      issues.push(issue(authoritative ? "error" : "warn", "env-missing",
        `Провайдер «${key}»: переменная ${decoded.envVarName} не задана — opencode отправит пустой ключ и получит 401. Выполни ${setEnvCommand(decoded.envVarName)} и перезапусти терминал`,
        { provider: key, envVar: decoded.envVarName }));
    } else if (!info.scopes.includes("process")) {
      issues.push(issue("warn", "env-not-inherited",
        `Провайдер «${key}»: переменная ${decoded.envVarName} задана в системе, но не видна текущему процессу — opencode нужно запускать из нового окна терминала`,
        { provider: key, envVar: decoded.envVarName }));
    } else if (info.length > SETX_MAX_LENGTH) {
      issues.push(issue("warn", "env-truncated",
        `Провайдер «${key}»: значение ${decoded.envVarName} длиной ${info.length} симв. — setx обрезает на ${SETX_MAX_LENGTH}, ключ может быть неполным`,
        { provider: key, envVar: decoded.envVarName }));
    }
    return;
  }

  // A literal secret in a file users paste into issues and commit to git.
  if (isPlaintextKey(apiKey)) {
    issues.push(issue("warn", "plaintext-key",
      `Провайдер «${key}»: ключ записан открытым текстом — вынеси его в ${suggestEnvVarName(key)}`,
      { provider: key, fixable: true, envVar: suggestEnvVarName(key) }));
  }
  // `{env:}` with a malformed name never resolves.
  if (/^\{env:/.test(apiKey) && !/^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(apiKey)) {
    issues.push(issue("error", "malformed-env-ref",
      `Провайдер «${key}»: «${apiKey}» — некорректная ссылка на переменную окружения`,
      { provider: key }));
  }
}

// Anthropic-compatible endpoints authenticate with `x-api-key` plus a version
// header. Without them the server answers 401 even though the key is correct.
function validateHeaders(key, p, issues) {
  const npm = String(p.npm || (looksLikePackage(p.name) ? p.name : "") || "").toLowerCase();
  const api = String(p.api || "").toLowerCase();
  const isAnthropic = npm.includes("anthropic") || api.includes("anthropic");
  if (!isAnthropic) return;

  const headers = p.options?.headers;
  if (headers !== undefined && (typeof headers !== "object" || headers === null || Array.isArray(headers))) {
    issues.push(issue("error", "bad-headers", `Провайдер «${key}»: options.headers должен быть объектом`, { provider: key }));
    return;
  }
  const names = Object.keys(headers || {}).map((h) => h.toLowerCase());
  // The official @ai-sdk/anthropic package sets both itself; only a raw
  // openai-compatible block pointed at an Anthropic URL needs them spelled out.
  if (npm === "@ai-sdk/anthropic") return;
  if (!names.includes("anthropic-version")) {
    issues.push(issue("warn", "no-anthropic-version",
      `Провайдер «${key}»: Anthropic-эндпоинт обычно требует заголовок anthropic-version`,
      { provider: key, fixable: true, header: "anthropic-version" }));
  }
}

function validateModel(key, mid, m, issues) {
  if (!m || typeof m !== "object" || Array.isArray(m)) {
    issues.push(issue("error", "bad-model", `Модель «${key}/${mid}» не является объектом`, { provider: key, model: mid }));
    return;
  }
  for (const field of Object.keys(m)) {
    if (!MODEL_FIELD_SET.has(field)) {
      issues.push(issue("error", "unknown-model-field",
        `Модель «${key}/${mid}»: поле «${field}» не входит в схему — opencode отклонит конфиг`,
        { provider: key, model: mid, field, fixable: true }));
    }
  }

  const input = m.modalities?.input;
  const output = m.modalities?.output;
  for (const [label, list] of [["input", input], ["output", output]]) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      issues.push(issue("error", "bad-modalities",
        `Модель «${key}/${mid}»: modalities.${label} должен быть массивом`, { provider: key, model: mid }));
      continue;
    }
    for (const t of list) {
      if (!VALID_MODALITIES.has(t)) {
        issues.push(issue("error", "bad-modality",
          `Модель «${key}/${mid}»: «${t}» не входит в допустимые modalities (${MODALITIES.join(", ")})`,
          { provider: key, model: mid, fixable: true }));
      }
    }
  }
  if (Array.isArray(input) && !input.includes("text")) {
    issues.push(issue("warn", "no-text-input",
      `Модель «${key}/${mid}» без text-входа — chat не будет работать`, { provider: key, model: mid }));
  }

  // limit requires context+output together; a half-filled object is invalid.
  if (m.limit !== undefined) {
    if (typeof m.limit !== "object" || m.limit === null || Array.isArray(m.limit)) {
      issues.push(issue("error", "bad-limit", `Модель «${key}/${mid}»: limit должен быть объектом`, { provider: key, model: mid }));
    } else {
      const hasCtx = typeof m.limit.context === "number" && m.limit.context > 0;
      const hasOut = typeof m.limit.output === "number" && m.limit.output > 0;
      if (hasCtx !== hasOut) {
        issues.push(issue("error", "partial-limit",
          `Модель «${key}/${mid}»: в limit нужны и context, и output — иначе конфиг невалиден`,
          { provider: key, model: mid, fixable: true }));
      }
      if (hasCtx && hasOut && m.limit.output > m.limit.context) {
        issues.push(issue("warn", "output-over-context",
          `Модель «${key}/${mid}»: output (${m.limit.output}) больше context (${m.limit.context}) — проверь значения`,
          { provider: key, model: mid }));
      }
    }
  }

  // cost requires input+output together, same reason.
  if (m.cost !== undefined) {
    if (typeof m.cost !== "object" || m.cost === null || Array.isArray(m.cost)) {
      issues.push(issue("error", "bad-cost", `Модель «${key}/${mid}»: cost должен быть объектом`, { provider: key, model: mid }));
    } else {
      const hasIn = typeof m.cost.input === "number";
      const hasOut = typeof m.cost.output === "number";
      if (hasIn !== hasOut) {
        issues.push(issue("error", "partial-cost",
          `Модель «${key}/${mid}»: в cost нужны и input, и output`, { provider: key, model: mid, fixable: true }));
      }
    }
  }

  const needsAttachment = Array.isArray(input) && input.some((t) => t !== "text");
  if (needsAttachment && m.attachment !== true) {
    issues.push(issue("warn", "no-attachment",
      `Модель «${key}/${mid}» принимает ${input.filter((t) => t !== "text").join("/")}, но без attachment:true вложения не пройдут`,
      { provider: key, model: mid, fixable: true }));
  }
  if (m.status !== undefined && !VALID_STATUSES.has(m.status)) {
    issues.push(issue("error", "bad-status",
      `Модель «${key}/${mid}»: status «${m.status}» вне списка (${MODEL_STATUSES.join(", ")})`,
      { provider: key, model: mid, fixable: true }));
  }
  if (m.release_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(m.release_date))) {
    issues.push(issue("warn", "bad-release-date",
      `Модель «${key}/${mid}»: release_date ожидается в формате YYYY-MM-DD`, { provider: key, model: mid }));
  }
}

// A default model pointing at something that does not exist stops opencode from
// starting, so it is reported per field.
function validateDefaultModel(config, issues) {
  for (const field of ["model", "small_model"]) {
    const value = config[field];
    if (value === undefined) {
      if (field === "model") {
        issues.push(issue("warn", "no-default", "Не задана модель по умолчанию (model)"));
      }
      continue;
    }
    if (typeof value !== "string" || !value.includes("/")) {
      issues.push(issue("error", `bad-${field}-format`,
        `Поле ${field} должно иметь вид «провайдер/модель», сейчас: ${JSON.stringify(value)}`, { fixable: true }));
      continue;
    }
    const [prov, ...rest] = value.split("/");
    const mdl = rest.join("/");
    if (!config.provider?.[prov]?.models?.[mdl]) {
      issues.push(issue("warn", field === "model" ? "bad-default" : "bad-small-model",
        `Модель ${value} (${field}) не найдена среди провайдеров`, { fixable: true, field }));
    }
  }
}

// ------------------------------------------------------------ network probes

const PROBE_UA = "provider-studio/1.0";
// Token budget for the live-fire probe. Kept tiny so a check costs nothing,
// but above the minimum some gateways enforce (they 400 on max_tokens <= 2).
const PROBE_MAX_TOKENS = 16;

/**
 * Rejects URLs that must never be fetched on the user's behalf.
 *
 * The browser hands us an arbitrary string and the server fetches it, so this is
 * an SSRF sink. Two tiers, because the obvious "block everything internal" rule
 * would break the tool's main use case:
 *
 *   - always blocked: non-http(s) schemes, embedded credentials, and the cloud
 *     metadata range, which is never a model endpoint but does hand out
 *     credentials to anyone who asks.
 *   - allowed by default: loopback and RFC1918. ollama, LM Studio and vLLM all
 *     live on 127.0.0.1, and configuring them is precisely what this tool is
 *     for. Set PS_BLOCK_LOCAL_PROBE=1 to close that off in a shared setting.
 */
export function validateProbeUrl(raw, { blockLocal = process.env.PS_BLOCK_LOCAL_PROBE === "1" } = {}) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, error: "Пустой Base URL" };
  let u;
  try { u = new URL(text); } catch { return { ok: false, error: "Некорректный URL" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: `Схема ${u.protocol} запрещена — нужен http или https` };
  }
  if (u.username || u.password) {
    return { ok: false, error: "URL с логином/паролем не поддерживается" };
  }
  if (isMetadataHost(u.hostname)) {
    return { ok: false, error: `Адрес ${u.hostname} — служебный эндпоинт метаданных, запрос запрещён` };
  }
  if (blockLocal && isPrivateHost(u.hostname)) {
    return { ok: false, error: `Адрес ${u.hostname} во внутренней сети, а PS_BLOCK_LOCAL_PROBE=1` };
  }
  return { ok: true, url: u, blockLocal };
}

/**
 * Link-local and cloud metadata endpoints. Blocked unconditionally: no LLM
 * server is ever reached this way, while 169.254.169.254 returns IAM
 * credentials on every major cloud.
 */
export function isMetadataHost(hostname) {
  const h = normaliseHost(hostname);
  if (!h) return false;
  if (h === "metadata.google.internal" || h === "metadata") return true;
  if (isIP(h) === 4) {
    const p = h.split(".").map(Number);
    return p[0] === 169 && p[1] === 254; // includes 169.254.169.254
  }
  if (isIP(h) === 6) {
    if (h.startsWith("fe80") || h === "fd00:ec2::254") return true;
    const mapped = mappedIPv4(h);
    return mapped ? isMetadataHost(mapped) : false;
  }
  return false;
}

/** True for loopback and RFC1918 ranges. */
export function isPrivateHost(hostname) {
  const h = normaliseHost(hostname);
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (isIP(h) === 4) return isPrivateIPv4(h);
  if (isIP(h) === 6) return isPrivateIPv6(h);
  return false; // a name: resolved separately, since DNS can point anywhere
}

function normaliseHost(hostname) {
  return String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/**
 * Extracts the IPv4 address out of an IPv4-mapped IPv6 one.
 *
 * Both spellings must be handled: the URL parser rewrites
 * `::ffff:169.254.169.254` into the hex form `::ffff:a9fe:a9fe`, so matching
 * only the dotted form let the metadata address through as IPv6.
 */
function mappedIPv4(h) {
  const dotted = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8 & 255}.${hi & 255}.${lo >> 8 & 255}.${lo & 255}`;
}

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;            // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;  // carrier-grade NAT
  if (a >= 224) return true;                          // multicast / reserved
  return false;
}

function isPrivateIPv6(ip) {
  if (ip === "::1" || ip === "::") return true;
  if (ip.startsWith("fe80") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  const mapped = mappedIPv4(ip);
  return mapped ? isPrivateIPv4(mapped) : false;
}

/**
 * Resolves a hostname and re-checks the result.
 * A public name can resolve to 127.0.0.1, so validating only the text would
 * leave the SSRF hole open (DNS rebinding).
 */
async function resolvedHostRisk(hostname, blockLocal) {
  if (isIP(hostname)) return null; // the literal form was already checked
  let addrs;
  try {
    addrs = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch {
    return null; // resolution failure surfaces as a normal fetch error
  }
  for (const a of addrs) {
    if (isMetadataHost(a.address)) {
      return `${hostname} разрешается в служебный адрес метаданных (${a.address}) — запрос отклонён`;
    }
    if (blockLocal && isPrivateHost(a.address)) {
      return `${hostname} разрешается во внутренний адрес (${a.address}), а PS_BLOCK_LOCAL_PROBE=1`;
    }
  }
  return null;
}

/**
 * Auth headers for a probe. Anthropic ignores Bearer and needs x-api-key.
 *
 * An `{env:VAR}` / `$VAR` reference is resolved here rather than dropped. The
 * old behaviour — sending no auth header at all — turned a missing variable
 * into a generic 401 that read as "check your API key", sending the user to
 * re-check a key that was never the problem. Resolving means the probe sends
 * exactly what opencode would send, and `problem` names the real cause when the
 * variable does not exist.
 */
export function probeHeaders(apiKey, apiFormat) {
  const headers = { "User-Agent": PROBE_UA, Accept: "application/json" };
  const ref = resolveKeyRef(apiKey);
  if (ref.isRef && !ref.resolved) {
    return { headers, problem: keyRefProblem(apiKey) };
  }
  const key = ref.value;
  if (!key) return { headers, problem: "" }; // no key given: probe anonymously
  if (String(apiFormat || "").includes("anthropic")) {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${key}`;
  }
  return { headers, problem: "" };
}

/**
 * Did the probe actually carry a credential?
 *
 * A 401 alone cannot tell "the key was refused" from "no key was ever sent" —
 * both look identical from the outside. Only the request we built knows, so the
 * answer has to travel with the result instead of being guessed from the status.
 */
function headersCarryKey(headers) {
  return Boolean(headers.Authorization || headers["x-api-key"]);
}

/**
 * Classifies a failed probe so the UI can say who is at fault.
 *
 * The distinction that matters: `network` means the request never got an answer
 * (their server, the proxy, or DNS), `auth` means it did and the key was
 * refused. Collapsing the two is what makes a dead endpoint look like a bad
 * key and sends the user off to regenerate a token that was always fine.
 */
export function classifyProbeError(e) {
  if (e?.proxyFault) return { kind: "proxy", label: e.message, hint: "запрос не вышел наружу, проверь прокси или VPN" };
  const name = e?.name || "";
  // A dual-stack host fails once per address family, and undici wraps the set
  // in an AggregateError whose own `code` is undefined; the useful code is on
  // the members.
  const nested = e?.cause?.errors?.[0]?.code || e?.errors?.[0]?.code || "";
  const code = e?.cause?.code || e?.code || nested || "";
  const msg = String(e?.cause?.message || e?.message || "");
  if (name === "TimeoutError" || name === "AbortError") {
    return { kind: "timeout", label: "таймаут", hint: "сервер не ответил вовремя, скорее всего он лежит или закрыт файрволом" };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return { kind: "dns", label: "домен не найден", hint: "проверь адрес или DNS" };
  }
  if (code === "ECONNREFUSED") {
    return { kind: "refused", label: "соединение отклонено", hint: "на этом порту никто не слушает" };
  }
  if (code === "ECONNRESET" || code === "EPIPE" || /socket disconnected/i.test(msg)) {
    return { kind: "reset", label: "соединение разорвано", hint: "сервер оборвал связь до ответа" };
  }
  if (code === "CERT_HAS_EXPIRED" || /certificate|self-signed|CERT_/i.test(msg + code)) {
    return { kind: "tls", label: "ошибка TLS", hint: "сертификат сервера не принят" };
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return { kind: "unreachable", label: "сеть недоступна", hint: "" };
  }
  return { kind: "network", label: msg || "нет ответа", hint: "" };
}

/**
 * Does this base URL already point inside a versioned API?
 *
 * The old test only looked for a version at the very end, so
 * `https://generativelanguage.googleapis.com/v1beta/openai` — Google's
 * OpenAI-compatible root — was treated as unversioned and got another `/v1`
 * bolted on, producing `/v1beta/openai/v1/chat/completions`. The version can
 * sit anywhere in the path, and it can be `v1beta`, so match a whole segment.
 * `v2ray` and similar must not count, hence the restricted suffix.
 */
function hasVersionSegment(path) {
  return /\/v\d+(alpha|beta)?(\/|$)/.test(path);
}

/** Endpoints to try, most likely first. */
function probeCandidates(url) {
  const trimmed = url.replace(/\/+$/, "");
  const out = [trimmed + "/models"];
  if (!hasVersionSegment(trimmed)) out.push(trimmed + "/v1/models");
  return out;
}

/**
 * One probe request, with the SSRF checks applied before anything leaves.
 *
 * The proxy hop happens after `resolvedHostRisk`, not instead of it: the guard
 * decides whether this target may be contacted at all, which is independent of
 * how the bytes get there. Note that a proxied request is resolved by the proxy
 * itself, so DNS-rebinding cannot be prevented locally in that path — the guard
 * still rejects the metadata range by name and by our own resolution, which is
 * what it can honestly promise.
 */
async function guardedFetch(target, headers, timeoutMs, blockLocal) {
  const u = new URL(target);
  const risk = await resolvedHostRisk(u.hostname, blockLocal);
  if (risk) throw new Error(risk);

  const proxy = proxyForUrl(target);
  if (proxy) {
    try {
      return await proxyFetch(target, { headers, timeoutMs, proxy });
    } catch (e) {
      // Name the proxy explicitly. Otherwise a broken proxy reads as a dead
      // provider, and the user goes looking for the fault in the wrong place.
      if (e.proxyStage) {
        throw Object.assign(new Error(`${describeProxy(proxy)}: ${e.message}`), { proxyFault: true });
      }
      throw e;
    }
  }

  return fetch(target, {
    method: "GET",
    headers,
    redirect: "manual", // a redirect to 127.0.0.1 would bypass every check above
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Reachability probe: is there an API server behind this URL? */
export async function testConnection({ baseURL, apiFormat, apiKey } = {}) {
  const guard = validateProbeUrl(baseURL);
  if (!guard.ok) return { ok: false, message: guard.error };

  const auth = probeHeaders(apiKey, apiFormat);
  // A reference to a variable that does not exist can only ever produce an
  // empty bearer token, so say that instead of probing and blaming the key.
  if (auth.problem) return { ok: false, message: auth.problem };
  const headers = auth.headers;
  const candidates = [...probeCandidates(guard.url.toString()), guard.url.toString().replace(/\/+$/, "")];
  let lastErr = "";
  let lastClass = null;

  for (const c of candidates) {
    let r;
    try {
      r = await guardedFetch(c, headers, 8000, guard.blockLocal);
    } catch (e) {
      lastClass = classifyProbeError(e);
      lastErr = lastClass.label;
      continue;
    }
    if (r.ok) {
      const via = r.viaProxy ? " (через прокси)" : "";
      return { ok: true, status: r.status, url: c, reach: "up", viaProxy: Boolean(r.viaProxy), message: `✓ Ответ ${r.status} — эндпоинт доступен${via}` };
    }
    // Reachable but unauthorised still proves the endpoint exists.
    if (r.status === 401 || r.status === 403) {
      // Distinguish "no key was sent" from "the key was rejected": otherwise a
      // probe run with an empty field reads as a bad key. These need different
      // faults, not just different wording — the badge said "ключ не принят"
      // while the line underneath said "ключ не отправлен", accusing a key that
      // does not exist. `nokey` is a missing credential, `key` is a refused one.
      const sentKey = headersCarryKey(headers);
      const hint = sentKey ? "проверь API key" : "ключ не отправлен — заполни API key";
      return {
        ok: true, status: r.status, url: c, reach: "up",
        fault: sentKey ? "key" : "nokey", viaProxy: Boolean(r.viaProxy),
        message: `⚠ Нет доступа (${r.status}) — сервер жив, ${hint}`,
      };
    }
    if (r.status >= 300 && r.status < 400) {
      lastErr = `редирект ${r.status} на ${r.headers.get("location") || "?"} — не следуем автоматически`;
      continue;
    }
    lastErr = `HTTP ${r.status}`;
    lastClass = null;
  }
  const kind = lastClass?.kind || "network";
  const fault = kind === "proxy" ? "proxy" : "endpoint";
  const tail = lastClass?.hint ? ` — ${lastClass.hint}` : "";
  return {
    ok: false, reach: "down", fault, kind,
    message: `Не удалось достучаться до Base URL: ${lastErr || "нет ответа"}${tail}`,
  };
}

/**
 * Sends one real, minimal completion request.
 *
 * `testConnection` and `fetchModels` only prove the endpoint exists and the key
 * is accepted for listing. Neither catches the cases that actually break a
 * first chat: a model id that is not served, a key without permission for that
 * model, or a quota that is already exhausted. This is the "does it actually
 * work" check, so the tool can stop reporting success when it only wrote a file.
 *
 * Kept to 1 output token to make the cost negligible.
 */
export async function testCompletion({ baseURL, apiKey, apiFormat, modelId } = {}) {
  const guard = validateProbeUrl(baseURL);
  if (!guard.ok) return { ok: false, message: guard.error };
  const model = String(modelId || "").trim();
  if (!model) return { ok: false, message: "Не указана модель для проверки" };

  const auth = probeHeaders(apiKey, apiFormat);
  if (auth.problem) return { ok: false, message: auth.problem, fault: "key" };

  const base = guard.url.toString().replace(/\/+$/, "");
  const target = completionTarget(base, apiFormat);
  const body = completionBody(model, apiFormat);

  const headers = { ...auth.headers, "Content-Type": "application/json" };
  let r;
  try {
    r = await guardedSend(target, headers, JSON.stringify(body), 20000, guard.blockLocal);
  } catch (e) {
    const c = classifyProbeError(e);
    return {
      ok: false, reach: "down", fault: c.kind === "proxy" ? "proxy" : "endpoint", kind: c.kind,
      message: `Запрос не дошёл: ${c.label}${c.hint ? ` — ${c.hint}` : ""}`,
    };
  }

  const raw = await r.text().catch(() => "");
  if (r.ok) {
    return { ok: true, reach: "up", status: r.status, viaProxy: Boolean(r.viaProxy), message: `✓ Модель ответила (HTTP ${r.status}) — связка рабочая` };
  }
  // Provider error bodies are the only place the real reason appears, so a
  // short excerpt is worth more than the status alone.
  const detail = providerErrorMessage(raw);
  const tail = detail ? ` — ${detail}` : "";
  if (r.status === 401 || r.status === 403) {
    if (!headersCarryKey(auth.headers)) {
      return { ok: false, reach: "up", fault: "nokey", status: r.status, message: `Ключ не отправлен (${r.status}) — заполни API key${tail}` };
    }
    // A 403 often means "your key is fine, this particular model is not
    // included in your plan" — checked live on a gateway that answered
    // "Deposit required to unlock premium models" for one model while another
    // worked on the same key. Calling that "ключ не принят" sends the user off
    // to re-enter a key that was never the problem, and it must not abort a
    // bulk run the way a genuine auth failure does.
    // A 403 with no body at all is not a verdict on the credential. Measured
    // live on a gateway: the same key and model returned 200 five times out of
    // six and an empty-bodied 403 once, while a genuinely wrong key produced a
    // 401 carrying {"error":{"message":"Invalid token"}}. So an empty 403 is a
    // transient block (rate shaping, WAF), and calling it "ключ не принят"
    // makes a working model look permanently dead.
    if (r.status === 403 && !detail) {
      return {
        ok: false, reach: "up", fault: "blocked", status: r.status, transient: true,
        message: "Запрос отклонён шлюзом (403, пустой ответ) — похоже на временную блокировку, не на проблему с ключом",
      };
    }
    if (r.status === 403 && ENTITLEMENT_PATTERN.test(detail)) {
      return {
        ok: false, reach: "up", fault: "plan", status: r.status,
        message: `Модель недоступна на твоём тарифе (403) — ключ рабочий${tail}`,
      };
    }
    return { ok: false, reach: "up", fault: "key", status: r.status, message: `Ключ не принят (${r.status})${tail}` };
  }
  if (r.status === 404) {
    return { ok: false, reach: "up", fault: "model", status: r.status, message: `Модель «${model}» не найдена на этом эндпоинте (404)${tail}` };
  }
  if (r.status === 429) {
    return { ok: false, reach: "up", fault: "quota", status: r.status, message: `Лимит исчерпан (429)${tail}` };
  }
  if (r.status === 400 || r.status === 422) {
    // Seen live: a gateway answers 400 "credit insufficient balance: balance=0
    // required=2404" — the request was fine, the wallet was not. Filing that
    // under "the model is broken" points the user at the wrong fix.
    if (ENTITLEMENT_PATTERN.test(detail)) {
      return {
        ok: false, reach: "up", fault: "plan", status: r.status,
        message: `Не хватает средств или тарифа (${r.status}) — ключ рабочий${tail}`,
      };
    }
    // Not every provider uses 401 for a bad credential: Google answers 400
    // "Please pass a valid API key". Reported as a model fault, that sends the
    // user to check the model name while the key sits wrong.
    if (BAD_KEY_PATTERN.test(detail)) {
      return { ok: false, reach: "up", fault: "key", status: r.status, message: `Ключ не принят (${r.status})${tail}` };
    }
    return { ok: false, reach: "up", fault: "model", status: r.status, message: `Запрос отклонён (${r.status})${tail}` };
  }
  return { ok: false, reach: "up", fault: "endpoint", status: r.status, message: `HTTP ${r.status}${tail}` };
}

/**
 * Where a live completion probe goes, by API format.
 *
 * A responses-only endpoint answers /chat/completions with 404, and probing
 * it the chat way reported a working provider as a dead model. Exported so
 * the rule is unit-testable without standing up a server.
 */
export function completionTarget(baseURL, apiFormat) {
  const base = String(baseURL || "").replace(/\/+$/, "");
  const fmt = String(apiFormat || "");
  const path = fmt.includes("anthropic") ? "/messages"
    : fmt.includes("responses") ? "/responses"
    : "/chat/completions";
  // Same rule as discovery: a version segment anywhere in the path means the
  // base is already inside the API. Appending "/v1" to Google's
  // `/v1beta/openai` produced `/v1beta/openai/v1/chat/completions`, which is a
  // different URL that happens to return the same 400 for a missing key — so
  // the mistake stayed invisible until a real key was used.
  let prefix = "/v1";
  try {
    prefix = hasVersionSegment(new URL(base).pathname) ? "" : "/v1";
  } catch { /* unparseable base: guarded earlier, default to /v1 */ }
  return base + prefix + path;
}

/**
 * What a live completion probe sends, by API format.
 *
 * Responses API speaks its own body (input/max_output_tokens, no messages and
 * no stream flag). The budget rule is shared: 16 tokens, not 1 — asking for a
 * single token is the cheapest possible probe, but some gateways reject it
 * outright ("max_tokens must be greater than 2") and the tool then blamed the
 * model for a limit the probe itself had picked.
 */
export function completionBody(model, apiFormat) {
  const fmt = String(apiFormat || "");
  if (fmt.includes("responses")) {
    return { model, input: "ping", max_output_tokens: PROBE_MAX_TOKENS };
  }
  const body = { model, max_tokens: PROBE_MAX_TOKENS, messages: [{ role: "user", content: "ping" }] };
  if (!fmt.includes("anthropic")) body.stream = false;
  return body;
}

/** Pulls the human-readable message out of a provider's error body. */
function providerErrorMessage(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message || j?.message || j?.error || j?.detail;
    if (typeof m === "string" && m.trim()) return m.trim().slice(0, 200);
  } catch { /* not JSON: fall through to the excerpt */ }
  return text.replace(/\s+/g, " ").slice(0, 160);
}

/** POST counterpart of guardedFetch: same SSRF guard, same proxy handling. */
async function guardedSend(target, headers, body, timeoutMs, blockLocal) {
  const u = new URL(target);
  const risk = await resolvedHostRisk(u.hostname, blockLocal);
  if (risk) throw new Error(risk);

  const proxy = proxyForUrl(target);
  if (proxy) {
    try {
      return await proxyFetch(target, { headers, timeoutMs, proxy, method: "POST", body });
    } catch (e) {
      if (e.proxyFault) throw Object.assign(new Error(`${describeProxy(proxy)}: ${e.message}`), { proxyFault: true });
      throw e;
    }
  }
  return fetch(target, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// ----------------------------------------------------------- model discovery

const VISION_PATTERN = /(vision|image|\bvl\b|gpt-4o|gpt-4\.1|gpt-5|omni|qwen.*-vl|llava|pixtral|moondream|glm-4v|internvl|minicpm-v|phi-3.*vision)/i;
const REASON_PATTERN = /(reason|reasoning|\bthink\b|thinking|deepseek-r\d|deepseek-reasoner|\br1\b|\bo1\b|\bo3\b|\bo4\b|openthink|qwq|kimi-k2|flash-thinking|glm-.+-air|o3-mini)/i;
// Only a "free" that stands as its own segment. The loose /free/i this replaces
// also matched "freeway" and "carefree", and as the last-resort fallback for the
// paid/free verdict a false positive here tells the user a billed model is free.
const FREE_PATTERN = /(^|[:/\-_.\s])free([:/\-_.\s]|$)/i;
// A 403 that is about entitlement, not about the key. Observed live as
// "Access restricted. Deposit required to unlock premium models" on a gateway
// where the same key happily served a non-premium model. Deliberately narrow:
// anything not clearly about plans/credit stays classified as a rejected key,
// because wrongly telling the user their key is fine is the worse mistake.
// A credential problem reported with a 400 instead of a 401. Verified live:
// Google's OpenAI-compatible endpoint answers 400 "Please pass a valid API
// key". Narrow on purpose — "invalid model" must not match.
const BAD_KEY_PATTERN =
  /(valid api[ _-]?key|invalid api[ _-]?key|api[ _-]?key (is )?(invalid|missing|not valid)|missing api[ _-]?key|неверный ключ|некорректный ключ)/i;
const ENTITLEMENT_PATTERN =
  /(deposit|top.?up|insufficient (balance|credit|funds)|no credit|out of credit|upgrade your plan|not (included|available) in your plan|premium model|subscription required|payment required|требуется (пополнен|подписк|оплат)|недостаточно средств|пополните баланс)/i;

function guessCapabilities(id) {
  const input = ["text"];
  if (VISION_PATTERN.test(id)) input.push("image");
  return {
    input,
    output: ["text"],
    vision: input.includes("image"),
    reasoning: REASON_PATTERN.test(id),
    // `free` deliberately does not live here: see extractPricing, which answers
    // it from the payload and falls back to the name only when nothing else is
    // available.
  };
}

function extractModelId(m) {
  let id = typeof m === "string" ? m : (m?.id ?? m?.name ?? "");
  if (typeof id !== "string") return "";
  if (id.startsWith("models/")) id = id.slice(7); // Gemini returns models/<id>
  return id.trim();
}

/**
 * Price per one million tokens, normalised across providers.
 *
 * Providers disagree on the unit and do not always say which they used:
 * OpenRouter quotes dollars per single token ("0.0000025"), while xkiro sends
 * `unit: "per_1m_tokens"` with "0.975". Guessing by magnitude alone is what
 * turns a $2.50/1M model into a $2 500 000/1M one, so the declared unit wins
 * and the magnitude heuristic is only the fallback: a per-token price for any
 * real model is far below one dollar, and a per-1M price is not.
 *
 * Returns null when there is no usable number, which is different from 0 —
 * "unknown" must never render as "free".
 */
function perMillion(value, unit) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  if (n === 0) return 0;
  const u = String(unit || "").toLowerCase();
  if (/1m|million|1_000_000|1000000/.test(u)) return n;
  if (/1k|thousand|1000/.test(u)) return n * 1000;
  if (/token/.test(u)) return n * 1e6;
  // No declared unit: sub-cent numbers are per-token, the rest are per-1M.
  return n < 0.001 ? n * 1e6 : n;
}

/**
 * Pricing and the free/paid verdict, taken from the payload where possible.
 *
 * The old rule was a regex over the model id looking for "free". It matched
 * "freeway" and, worse, missed every free model that is not labelled in its
 * name — on a live xkiro list, 36 models are free and only 17 say so in the id.
 * A declared tier or a zero price is a fact; the name is a guess, and it is
 * kept only as a last resort with `freeSource` recording which one was used so
 * the UI can be honest about how much it actually knows.
 */
function extractPricing(m, id) {
  if (!m || typeof m !== "object") {
    return { costInput: null, costOutput: null, free: FREE_PATTERN.test(id), freeSource: FREE_PATTERN.test(id) ? "name" : "unknown", tier: "" };
  }
  const p = (m.pricing && typeof m.pricing === "object") ? m.pricing : null;
  const unit = p?.unit || m.pricing_unit || "";
  const costInput = perMillion(p?.input ?? p?.prompt ?? m.input_price ?? m.price_input, unit);
  const costOutput = perMillion(p?.output ?? p?.completion ?? m.output_price ?? m.price_output, unit);
  const cacheRead = perMillion(p?.cache_read ?? p?.input_cache_read, unit);
  const cacheWrite = perMillion(p?.cache_write ?? p?.input_cache_write, unit);

  const tier = String(m.access_tier ?? m.tier ?? m.plan ?? "").trim();
  let free = false;
  let freeSource = "unknown";
  if (/^free$/i.test(tier)) { free = true; freeSource = "tier"; }
  else if (tier && /^(paid|premium|pro|standard|enterprise)$/i.test(tier)) { free = false; freeSource = "tier"; }
  else if (costInput != null && costOutput != null) {
    // A declared price of zero is the provider saying "this costs nothing".
    free = costInput === 0 && costOutput === 0;
    freeSource = "price";
  } else if (FREE_PATTERN.test(id)) { free = true; freeSource = "name"; }

  return { costInput, costOutput, cacheRead, cacheWrite, free, freeSource, tier };
}

// Providers disagree on field names and nesting, so probe the known spellings.
function extractNumbers(m) {
  if (!m || typeof m !== "object") return { contextWindow: 0, maxOutput: 0 };
  const num = (v) => {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const pick = (obj, keys) => {
    if (!obj || typeof obj !== "object") return 0;
    for (const k of keys) { const v = num(obj[k]); if (v) return v; }
    return 0;
  };
  const limit = m.limit && typeof m.limit === "object" ? m.limit : null;
  const top = m.top_provider && typeof m.top_provider === "object" ? m.top_provider : null;

  return {
    contextWindow:
      pick(m, ["context_window", "contextWindow", "context_length", "context", "input_token_limit", "max_context_length"]) ||
      pick(limit, ["context", "context_window"]) ||
      pick(top, ["context_length"]),
    maxOutput:
      pick(m, ["max_output_tokens", "maxOutput", "max_tokens", "max_completion_tokens", "output_token_limit"]) ||
      pick(limit, ["output", "max_output_tokens"]) ||
      pick(top, ["max_completion_tokens"]),
  };
}

/**
 * Modality hints taken from the payload, which beat the name-based guess.
 *
 * OpenRouter reports `architecture.modality` as `"text+image->text"`, so the
 * input side is everything before the arrow. Splitting on `-` as well would cut
 * `image->` into `image-` and match nothing.
 */
function modalityFromJson(m) {
  const arch = m?.architecture;
  const raw = m?.modalities || arch?.input_modalities || arch?.modality || [];
  let list;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "string") {
    // Keep only the input half when an arrow is present.
    list = raw.split("->")[0].split(/[+,/|]/);
  } else {
    list = [];
  }
  const norm = list.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (!norm.length) return null;
  const out = ["text"];
  for (const t of ["image", "video", "audio", "pdf"]) {
    if (norm.includes(t) && !out.includes(t)) out.push(t);
  }
  return out.length > 1 ? out : null;
}

/** Normalises a /models response (several shapes) into a flat model list. */
export function parseModels(json) {
  let arr = [];
  if (Array.isArray(json)) arr = json;
  else if (Array.isArray(json?.data)) arr = json.data;      // OpenAI-style
  else if (Array.isArray(json?.models)) arr = json.models;  // Google/Groq-style
  else if (Array.isArray(json?.result)) arr = json.result;

  const out = [];
  const seen = new Set();
  for (const m of arr) {
    const id = extractModelId(m);
    // Duplicate ids would become duplicate config keys, silently overwriting.
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const caps = guessCapabilities(id);
    const mod = modalityFromJson(m);
    if (mod) caps.input = mod;
    // A declared capability beats a guess from the name, same as with pricing.
    const declared = (m && typeof m === "object" && m.capabilities && typeof m.capabilities === "object")
      ? m.capabilities : null;
    if (declared && typeof declared.vision === "boolean" && declared.vision && !caps.input.includes("image")) {
      caps.input = [...caps.input, "image"];
    }
    caps.vision = caps.input.includes("image");
    if (declared && typeof declared.reasoning === "boolean") caps.reasoning = declared.reasoning;
    const nums = extractNumbers(m);
    const price = extractPricing(m, id);
    // Track what the provider actually stated, as opposed to what we inferred
    // from the model id. Both end up in the same fields, and without this a
    // guess ("no 'thinking' in the name, so reasoning: false") is
    // indistinguishable from a fact and blocks better data from the catalogue.
    const declaredFields = [];
    if (nums.contextWindow) declaredFields.push("contextWindow");
    if (nums.maxOutput) declaredFields.push("maxOutput");
    if (mod) declaredFields.push("inputTypes");
    if (declared && typeof declared.reasoning === "boolean") declaredFields.push("reasoning");
    if (declared && typeof declared.tools === "boolean") declaredFields.push("toolUse");
    if (declared && typeof declared.vision === "boolean") declaredFields.push("vision");
    const rawName = m && typeof m === "object"
      ? (typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim()
        : (typeof m.name === "string" && m.name.trim() ? m.name.trim() : id))
      : id;
    const displayName = rawName;

    out.push({
      id,
      name: displayName.startsWith("models/") ? displayName.slice(7) : displayName,
      contextWindow: nums.contextWindow,
      maxOutput: nums.maxOutput,
      inputTypes: caps.input,
      outputTypes: ["text"],
      reasoning: caps.reasoning,
      free: price.free,
      // How the verdict was reached, so the UI can distinguish a fact from a
      // guess instead of presenting both as certainty.
      freeSource: price.freeSource,
      tier: price.tier,
      costInput: price.costInput,
      costOutput: price.costOutput,
      costCacheRead: price.cacheRead ?? null,
      costCacheWrite: price.cacheWrite ?? null,
      vision: caps.vision,
      // Which of the above the endpoint stated itself. Everything not listed
      // here is inference and may be replaced by a better source.
      declaredFields,
    });
  }
  return out;
}

/** Fetches and normalises the model list for a provider endpoint. */
export async function fetchModels({ baseURL, apiKey, apiFormat } = {}) {
  const guard = validateProbeUrl(baseURL);
  if (!guard.ok) return { ok: false, models: [], message: guard.error };

  const auth = probeHeaders(apiKey, apiFormat);
  if (auth.problem) return { ok: false, models: [], message: auth.problem };
  const headers = auth.headers;
  let lastErr = "";
  let lastClass = null;

  for (const c of probeCandidates(guard.url.toString())) {
    let r;
    try {
      r = await guardedFetch(c, headers, 12000, guard.blockLocal);
    } catch (e) {
      lastClass = classifyProbeError(e);
      lastErr = lastClass.label;
      continue;
    }
    if (r.ok) {
      let json;
      try { json = await r.json(); } catch (e) {
        lastErr = "ответ не является JSON";
        continue;
      }
      const models = parseModels(json);
      if (!models.length) {
        lastErr = "в ответе нет моделей";
        continue;
      }
      return { ok: true, models, message: `Найдено моделей: ${models.length}`, url: c };
    }
    if (r.status === 401 || r.status === 403) {
      // Same split as testConnection: blaming a key that was never sent sends
      // the user off to regenerate a token that was never the problem.
      if (!headersCarryKey(headers)) {
        return { ok: false, models: [], reach: "up", fault: "nokey", message: `Сервер доступен (${r.status}), но ключ не отправлен — заполни API key` };
      }
      return { ok: false, models: [], reach: "up", fault: "key", message: "Сервер доступен, но API-ключ не принят (401/403)" };
    }
    lastErr = `HTTP ${r.status}`;
    lastClass = null;
  }
  const kind = lastClass?.kind || "network";
  const tail = lastClass?.hint ? ` — ${lastClass.hint}` : "";
  return {
    ok: false, models: [], reach: "down", fault: kind === "proxy" ? "proxy" : "endpoint", kind,
    message: `Не удалось получить /models: ${lastErr || "нет ответа"}${tail}`,
  };
}
