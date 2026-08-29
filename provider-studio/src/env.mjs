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
import { IS_WINDOWS } from "./paths.mjs";

/** Env var names we accept — matches what opencode's `{env:...}` allows. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const USER_ENV_KEY = "HKCU\\Environment";
const MACHINE_ENV_KEY =
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

// Reading the registry costs a process spawn (~20ms). The diagnostics endpoint
// resolves a key per provider, so without a cache a dozen providers means a
// dozen spawns per request. TTL is short so a variable created while the UI is
// open is still picked up on the next check.
const CACHE_TTL_MS = 2000;
const cache = new Map(); // name -> { at, result }

/** Drops memoised registry reads. Used by tests and after an explicit refresh. */
export function clearEnvCache() {
  cache.clear();
}

/**
 * Reads one value out of a registry key via `reg query`.
 * Returns the string value, or null when the value does not exist.
 *
 * `reg` writes its "not found" message to stderr in the OEM codepage, which
 * arrives as mojibake and differs per system locale — so the message is never
 * parsed. Only the exit code and the parsed stdout decide the outcome.
 */
function readRegistryValue(key, name) {
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
    for (const [scope, key] of [["user", USER_ENV_KEY], ["machine", MACHINE_ENV_KEY]]) {
      const raw = readRegistryValue(key, clean);
      if (typeof raw === "string" && raw.trim() !== "") {
        found.push({ scope, value: raw.trim() });
      }
    }
  }

  const winner = found[0] || null;
  const result = {
    name: clean,
    set: Boolean(winner),
    scope: winner ? winner.scope : null,
    length: winner ? winner.value.length : 0,
    value: winner ? winner.value : "",
    scopes: found.map((f) => f.scope),
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
 * correctly.
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

/** The command that creates the variable, for error messages the user can act on. */
export function setEnvCommand(name) {
  const clean = String(name || "NAME").trim() || "NAME";
  return IS_WINDOWS ? `setx ${clean} "<ключ>"` : `export ${clean}="<ключ>"`;
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
  const val = String(value ?? "").trim();
  if (!val) return { ok: false, error: "Пустое значение — переменную создавать нечего" };
  // setx silently truncates past 1024 characters, producing a key that looks
  // set and fails every request.
  if (val.length > SETX_MAX_LENGTH) {
    return {
      ok: false,
      error: `Значение длиннее ${SETX_MAX_LENGTH} символов — setx обрежет его. Задай переменную через «Свойства системы».`,
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
    return (
      `переменная ${r.envVarName} не задана — opencode подставит пустую строку ` +
      `и провайдер ответит 401. Задай её: ${setEnvCommand(r.envVarName)}`
    );
  }
  if (!r.isRef && !r.value) return "API-ключ не задан";
  return "";
}

// `setx` silently truncates at 1024 characters, which corrupts long keys (some
// JWT-style tokens exceed it) in a way that looks like an invalid key.
export const SETX_MAX_LENGTH = 1024;
