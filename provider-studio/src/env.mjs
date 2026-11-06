// src/env.mjs
// Resolving environment-variable references the way opencode resolves them.
//
// Why this module exists:
//   opencode substitutes `{env:FOO}` in its config with the value of FOO, and
//   substitutes an *empty string* when FOO is unset. An empty API key is not an
//   error opencode reports — it is sent as `Authorization: Bearer ` and the
//   provider answers 401 "Missing or invalid bearer token". That is the single
//   most common failure this tool has to catch, so knowing whether a variable
//   really exists has to be reliable.
//
//   `process.env` alone is not reliable. A process inherits its environment at
//   spawn time, so a variable created with `setx` (or the System Properties
//   dialog) after Provider Studio started is invisible in `process.env` even
//   though every *newly launched* opencode will see it. Reporting "not set" in
//   that case sends the user chasing a variable they already created.
//
//   So on Windows we also read the two places persistent variables actually
//   live: HKCU\Environment (user scope) and the Session Manager key (machine
//   scope). Those are the same stores `setx` writes to.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { IS_WINDOWS, home } from "./paths.mjs";

/** Env var names we accept — matches what opencode's `{env:...}` allows. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Системные переменные, защищённые от изменения и удаления. */
export const PROTECTED_ENV_VARS = new Set([
  "PATH", "TEMP", "TMP", "COMSPEC", "SYSTEMROOT", "WINDIR", "USERPROFILE", "HOMEDRIVE",
]);

export function isProtectedEnvVar(name) {
  return PROTECTED_ENV_VARS.has(String(name || "").trim().toUpperCase());
}

const USER_ENV_KEY = "HKCU\\Environment";
const MACHINE_ENV_KEY =
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

// Reading the registry costs a process spawn (~20ms). The diagnostics endpoint
// resolves a key per provider, so without a cache a dozen providers means a
// dozen spawns per request. TTL is short so a variable created while the UI is
// open is still picked up on the next check.
const CACHE_TTL_MS = 2000;
const cache = new Map(); // name -> { at, result }
// Whole-key dumps share one TTL: one `reg query` per scope serves every
// variable instead of one spawn per variable per scope.
let dumpCache = { at: 0, user: null, machine: null };

/** Drops memoised registry reads. Used by tests and after an explicit refresh. */
export function clearEnvCache() {
  cache.clear();
  dumpCache = { at: 0, user: null, machine: null };
}

/**
 * Reads one value out of a registry key via `reg query`.
 * Returns the string value, or null when the value does not exist.
 *
 * `reg` writes its "not found" message to stderr in the OEM codepage, which
 * arrives as mojibake and differs per system locale — so the message is never
 * parsed. Only the exit code and the parsed stdout decide the outcome.
 *
 * Prefers the whole-key dump (one spawn serves every variable); falls back to
 * the single-value query when the dump is unavailable but a direct read works.
 */
function readRegistryValue(key, name, { fresh = false } = {}) {
  const dumped = readRegistryDump(key, { fresh });
  if (dumped) {
    const v = dumped.get(String(name).toLowerCase());
    return v !== undefined ? v : null;
  }
  let out;
  try {
    out = execFileSync("reg", ["query", key, "/v", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000,
      windowsHide: true,
    });
  } catch {
    return null; // missing value, missing key, or reg.exe unavailable
  }
  return parseRegQuery(out, name);
}

/**
 * Dumps every value under a registry key in a single `reg query` call.
 * Returns a Map of lowercased name -> raw value, or null when unreadable.
 * Cached per TTL window, so a diagnostics run over a dozen providers costs
 * two spawns total (user + machine scope) instead of two per variable.
 */
function readRegistryDump(key, { fresh = false } = {}) {
  if (!IS_WINDOWS) return null;
  const now = Date.now();
  const slot = key === USER_ENV_KEY ? "user" : key === MACHINE_ENV_KEY ? "machine" : null;
  if (!fresh && slot && dumpCache[slot] && now - dumpCache.at < CACHE_TTL_MS) return dumpCache[slot];
  let out;
  try {
    out = execFileSync("reg", ["query", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000,
      windowsHide: true,
    });
  } catch {
    return null;
  }
  const map = new Map();
  for (const line of String(out || "").split(/\r?\n/)) {
    const m = line.match(
      /^\s+(\S+)\s+(REG_SZ|REG_EXPAND_SZ|REG_MULTI_SZ|REG_DWORD|REG_QWORD|REG_BINARY|REG_NONE)\s{2,}([\s\S]*)$/,
    );
    if (m) { map.set(m[1].toLowerCase(), m[3]); continue; }
    const e = line.match(/^\s+(\S+)\s+(REG_[A-Z_]+)\s*$/);
    if (e) map.set(e[1].toLowerCase(), "");
  }
  if (slot) {
    dumpCache = { ...dumpCache, at: now, [slot]: map };
    return map;
  }
  return map;
}

/**
 * Extracts a value from `reg query` output.
 *
 * The layout is `    NAME    TYPE    VALUE`, separated by runs of whitespace.
 * Splitting on whitespace would corrupt any value containing spaces, so the
 * split is anchored on the type token and limited to three parts.
 *
 * Exported for tests: this parser cannot be exercised on non-Windows hosts.
 */
export function parseRegQuery(stdout, name) {
  const lines = String(stdout || "").split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(
      /^\s+(\S+)\s+(REG_SZ|REG_EXPAND_SZ|REG_MULTI_SZ|REG_DWORD|REG_QWORD|REG_BINARY|REG_NONE)\s{2,}([\s\S]*)$/,
    );
    if (!m) continue;
    // Registry value names are case-insensitive, like the variables themselves.
    if (m[1].toLowerCase() !== String(name).toLowerCase()) continue;
    return m[3];
  }
  // A value present but empty prints the type with no trailing value, which the
  // regex above rejects because it requires two spaces plus content. Treat that
  // as "exists but empty" so it is reported as unset rather than as missing —
  // both break auth identically, and "empty" is the more accurate wording.
  for (const line of lines) {
    const m = line.match(/^\s+(\S+)\s+(REG_[A-Z_]+)\s*$/);
    if (m && m[1].toLowerCase() === String(name).toLowerCase()) return "";
  }
  return null;
}

/**
 * Looks a variable up in every scope that matters, nearest first.
 *
 * Scopes, in the order opencode would see them:
 *   process — inherited by this process; what a program launched right now gets
 *   user    — HKCU\Environment, written by `setx NAME value`
 *   machine — system-wide, written by `setx /m NAME value`
 *
 * Values are trimmed before the emptiness test because a variable holding only
 * whitespace authenticates exactly as badly as a missing one, and a trailing
 * newline from a copy-paste is a real and invisible failure mode.
 *
 * Returns { name, set, scope, length, value, scopes }.
 * `value` is included so callers can probe with the real key; it must never be
 * put in an HTTP response.
 */
export function lookupEnv(name, { useCache = true } = {}) {
  const clean = String(name || "").trim();
  if (!ENV_NAME_RE.test(clean)) {
    return { name: clean, set: false, scope: null, length: 0, value: "", scopes: [], invalid: true };
  }
  const hit = useCache ? cache.get(clean) : null;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  const found = [];
  const fromProcess = process.env[clean];
  if (typeof fromProcess === "string" && fromProcess.trim() !== "") {
    found.push({ scope: "process", value: fromProcess.trim() });
  }
  if (IS_WINDOWS) {
    // fresh follows useCache: the setx read-back check must see the registry
    // as it is right now, not the dump from a moment ago.
    const fresh = !useCache;
    for (const [scope, key] of [["user", USER_ENV_KEY], ["machine", MACHINE_ENV_KEY]]) {
      const raw = readRegistryValue(key, clean, { fresh });
      if (typeof raw === "string" && raw.trim() !== "") {
        found.push({ scope, value: raw.trim() });
      }
    }
  }

  const winner = found[0] || null;
  // Where the value actually persists, which is the only thing that survives a
  // restart. A variable present in both this process and HKCU is a *user*
  // variable that this process happens to inherit — reporting it as "process"
  // hid the fact that the persistent copy was written and told the user
  // nothing about durability.
  const durable = found.find((f) => f.scope === "user" || f.scope === "machine") || null;
  const result = {
    name: clean,
    set: Boolean(winner),
    scope: durable ? durable.scope : (winner ? winner.scope : null),
    length: winner ? winner.value.length : 0,
    value: winner ? winner.value : "",
    scopes: found.map((f) => f.scope),
    // inherited — a program launched right now would see it.
    inherited: found.some((f) => f.scope === "process"),
    // durable — it survives a reboot, so a *newly started* opencode will see it.
    durable: Boolean(durable),
  };
  cache.set(clean, { at: Date.now(), result });
  return result;
}

/**
 * Resolves whatever sits in an `apiKey` field into the bytes that would
 * actually be sent, mirroring opencode's own substitution.
 *
 * Accepts the `{env:VAR}` form opencode documents plus the `$VAR` / `${VAR}`
 * forms older versions of this tool wrote, so an imported config still probes
 * correctly. `{file:...}` is read from disk the way opencode reads it, so a
 * file-backed key probes with the real bytes instead of the literal path.
 *
 * Returns { value, isRef, envVarName, resolved, scope }.
 *   isRef    — the field was a reference, not a literal key
 *   resolved — the reference pointed at a variable that exists and is non-empty
 * When isRef is true and resolved is false, `value` is "" — which is precisely
 * what opencode would send, so a probe using it reproduces the real 401 instead
 * of hiding it.
 */
export function resolveKeyRef(apiKey) {
  const raw = typeof apiKey === "string" ? apiKey.trim() : "";
  const file = raw.match(/^\{file:([^}]+)\}$/);
  if (file) {
    const p = expandUser(file[1].trim());
    let value = "";
    try { value = readFileSync(p, "utf8").trim(); } catch { value = ""; }
    return {
      value, isRef: true, envVarName: "", filePath: p,
      resolved: value !== "", scope: value !== "" ? "file" : null,
    };
  }
  const ref =
    raw.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/) ||
    raw.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/) ||
    raw.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (!ref) {
    return { value: raw, isRef: false, envVarName: "", resolved: Boolean(raw), scope: null };
  }
  const info = lookupEnv(ref[1]);
  return {
    value: info.value,
    isRef: true,
    envVarName: info.name,
    resolved: info.set,
    scope: info.scope,
  };
}

/** Expands a leading ~ the way shells do, so {file:~/...} resolves. */
function expandUser(p) {
  const s = String(p || "");
  if (s === "~") return home();
  if (s.startsWith("~/") || s.startsWith("~\\")) return home() + s.slice(1);
  return s;
}

/** The command that creates the variable, for error messages the user can act on. */
export function setEnvCommand(name, value = "<ключ>") {
  const clean = String(name || "NAME").trim() || "NAME";
  const val = String(value ?? "<ключ>");
  if (IS_WINDOWS) {
    if (val.length > SETX_MAX_LENGTH) {
      return `powershell -Command "[Environment]::SetEnvironmentVariable('${clean}', '${val.replace(/'/g, "''")}', 'User')"`;
    }
    return `setx ${clean} "${val}"`;
  }
  return `export ${clean}="${val.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * The command that makes a *running* OpenCode see a variable written after it
 * started.
 *
 * This is the trap behind the "Provide your ... API key" / 401-after-setx
 * reports: OpenCode Desktop keeps a background service (`opencode serve
 * --service`) alive for hours, and a process keeps the environment it was born
 * with. `setx` updates the registry; closing and reopening the window does not
 * replace the service. Only a service restart (or a reboot) does.
 *
 * Caveat: `service` exists only in the CLI shipped with OpenCode Desktop. An
 * older global install prints its help page instead, which is why the UI's
 * restart button resolves the bundled CLI itself rather than trusting PATH.
 */
export const OPENCODE_RESTART_COMMAND = "opencode service restart";

/**
 * One sentence about the service, for places that just wrote a variable.
 * Kept next to the command so the UI, endpoints and docs cannot drift apart.
 */
export function opencodeRestartHint() {
  return `OpenCode запускается фоновой службой и не видит переменные, записанные после её старта. ` +
    `Перезапусти службу (кнопка «↻ перезапустить OpenCode» рядом) — или приложение OpenCode целиком, ` +
    `либо компьютер.`;
}


/**
 * Creates or updates a persistent user-scope variable.
 *
 * Writing it for the user closes the last gap in the setup flow: the tool would
 * otherwise write a config referencing `{env:KEY}`, report success, and leave
 * the one step that actually makes it work as a command to paste by hand.
 *
 * Deliberate limits:
 *   - user scope only. Machine scope needs elevation, and a key belongs to a
 *     user, not to the machine.
 *   - `setx`, not a raw registry write, because setx broadcasts the settings
 *     change that lets newly started processes see the value.
 *   - `process.env` is updated too, so probes in *this* process stop reporting
 *     the variable as missing without waiting for a restart.
 */
export function setUserEnvVar(name, value) {
  const clean = String(name || "").trim();
  if (!ENV_NAME_RE.test(clean)) {
    return { ok: false, error: `Недопустимое имя переменной: «${clean || "(пусто)"}»` };
  }
  if (isProtectedEnvVar(clean)) {
    return { ok: false, error: "Переменная защищена от изменения" };
  }
  const val = String(value ?? "").trim();
  if (!val) return { ok: false, error: "Пустое значение — переменную создавать нечего" };
  // setx silently truncates past 1024 characters, producing a key that looks
  // set and fails every request.
  if (val.length > SETX_MAX_LENGTH) {
    const cmd = `powershell -Command "[Environment]::SetEnvironmentVariable('${clean}', 'VAL', 'User')"`;
    return {
      ok: false,
      error: `Значение длиннее ${SETX_MAX_LENGTH} символов — setx обрежет его. Задай переменную через PowerShell: ${cmd}`,
      command: cmd,
    };
  }
  if (!IS_WINDOWS) {
    // No persistent per-user store to write on POSIX: the shell profile is the
    // user's file and guessing which one to edit does more harm than good.
    return {
      ok: false,
      error: "Автоматическая установка поддерживается только в Windows. Добавь строку в свой профиль оболочки:",
      command: `export ${clean}="${val.replace(/(["\\$`])/g, "\\$1")}"`,
      manual: true,
    };
  }
  try {
    execFileSync("setx", [clean, val], { encoding: "utf8", timeout: 10000, windowsHide: true });
  } catch (e) {
    const detail = String(e.stderr || e.stdout || e.message || "").trim().split(/\r?\n/)[0] || "неизвестная ошибка";
    return { ok: false, error: `setx не сработал: ${detail}` };
  }
  // Read back *before* touching process.env. Setting it first would make the
  // check pass on this process's own copy and report scope "process", which
  // says nothing about whether the value survives a reboot — the entire point
  // of writing it. Verify the persistent store on its own terms first.
  clearEnvCache();
  const persisted = lookupEnv(clean, { useCache: false });
  const durable = persisted.scopes.includes("user") || persisted.scopes.includes("machine");

  process.env[clean] = val;
  clearEnvCache();

  if (!durable) {
    return {
      ok: false,
      error: IS_WINDOWS
        ? "setx завершился без ошибки, но переменная не читается из реестра — задай её через «Свойства системы»"
        : "setx завершился без ошибки, но переменная не читается — проверь вручную",
    };
  }
  // Report where it actually persists, not the process copy we just made.
  const scope = persisted.scopes.includes("user") ? "user" : "machine";
  return { ok: true, name: clean, length: val.length, scope };
}

/**
 * One sentence explaining why auth will fail, or "" when the key is usable.
 * Centralised so the UI, the probe and the validator cannot drift apart.
 */
export function keyRefProblem(apiKey) {
  const r = resolveKeyRef(apiKey);
  if (r.isRef && !r.resolved) {
    if (r.filePath) {
      return `файл с ключом ${r.filePath} не читается — opencode подставит пустую строку и провайдер ответит 401`;
    }
    return (
      `переменная ${r.envVarName} не задана — opencode подставит пустую строку ` +
      `и провайдер ответит 401. Задай её: ${setEnvCommand(r.envVarName)}, ` +
      `затем перезапусти службу OpenCode (кнопка «↻» рядом с переменной или перезапуск приложения)`
    );
  }
  if (!r.isRef && !r.value) return "API-ключ не задан";
  return "";
}

// `setx` silently truncates at 1024 characters, which corrupts long keys (some
// JWT-style tokens exceed it) in a way that looks like an invalid key.
export const SETX_MAX_LENGTH = 1024;

/** Names that look like API-key holders, for the orphan cleanup. */
export const KEY_LIKE_RE = /(?:API_KEY|_KEY|TOKEN|SECRET)(?:_\d+)?$|^[A-Z0-9_]*_API_KEY(?:_[A-Za-z0-9]+)?$/i;

/**
 * Lists value names stored under HKCU\Environment (user scope), without values.
 * Used by the env audit to find variables no provider references anymore.
 * Returns [] on non-Windows or when the registry cannot be read.
 */
export function listUserEnvNames({ fresh = true } = {}) {
  if (!IS_WINDOWS) return [];
  if (fresh) clearEnvCache();
  const dump = readRegistryDump(USER_ENV_KEY, { fresh });
  if (!dump) return [];
  const out = [];
  for (const lower of dump.keys()) {
    // The dump map is keyed lowercased; recover display case from process.env
    // when available, otherwise upper-case (env names are case-insensitive
    // on Windows and conventionally upper-case).
    const fromProc = Object.keys(process.env).find((k) => k.toLowerCase() === lower);
    out.push(fromProc || lower.toUpperCase());
  }
  return out.sort();
}

/**
 * Deletes a persistent user-scope variable (the "очистка" for orphaned keys).
 *
 * Guarded: refuses invalid names, key-like allowlist outside of explicit
 * force, and — unless force — names still referenced by the given config text.
 * Never touches process.env copies of other variables; the deleted name is
 * removed from this process too so later lookups stop seeing a stale copy.
 */
export function removeUserEnvVar(name, { allowReferenced = false, referenced = [] } = {}) {
  const clean = String(name || "").trim();
  if (!ENV_NAME_RE.test(clean)) {
    return { ok: false, error: `Недопустимое имя переменной: «${clean || "(пусто)"}»` };
  }
  if (isProtectedEnvVar(clean)) {
    return { ok: false, error: "Переменная защищена от изменения" };
  }
  if (!IS_WINDOWS) {
    return {
      ok: false,
      error: "Автоматическое удаление поддерживается только в Windows.",
      command: `unset ${clean}`,
      manual: true,
    };
  }
  const refSet = new Set((Array.isArray(referenced) ? referenced : []).map((n) => String(n).toLowerCase()));
  if (!allowReferenced && refSet.has(clean.toLowerCase())) {
    return { ok: false, error: `Переменная ${clean} используется в конфиге — сначала убери ссылку {env:${clean}}` };
  }
  try {
    execFileSync("reg", ["delete", USER_ENV_KEY, "/v", clean, "/f"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
      windowsHide: true,
    });
  } catch (e) {
    return { ok: false, error: `Не удалось удалить ${clean}: переменная не найдена или нет доступа` };
  }
  delete process.env[clean];
  clearEnvCache();
  return { ok: true, name: clean };
}

/**
 * Обнаружение переменных-призраков (ключи в HKCU\Environment, не используемые в активных провайдерах/шардах).
 */
export function findGhostEnvVars({ referenced = [] } = {}) {
  const refSet = new Set((Array.isArray(referenced) ? referenced : []).map((n) => String(n).toLowerCase()));
  return listUserEnvNames().filter(
    (n) => KEY_LIKE_RE.test(n) && !refSet.has(String(n).toLowerCase()) && !isProtectedEnvVar(n),
  );
}

/**
 * Очистка переменных-призраков.
 */
export function cleanGhostEnvVars({ referenced = [] } = {}) {
  const ghosts = findGhostEnvVars({ referenced });
  const removed = [];
  const errors = [];
  for (const name of ghosts) {
    const r = removeUserEnvVar(name, { referenced });
    if (r.ok) removed.push(name);
    else errors.push({ name, error: r.error });
  }
  return { ok: true, removed, errors };
}
