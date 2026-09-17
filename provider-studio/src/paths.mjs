// src/paths.mjs
// Single source of truth for every filesystem location the tool touches.
//
// Two reasons this is its own module:
//  1. The previous code hardcoded backslashes and `${home}\.config\...`, so it
//     only worked on Windows and silently missed `./opencode.json`.
//  2. Writable data (backups) used to live next to the source. Under a packaged
//     exe that directory is read-only, so it now goes to the per-user data dir.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";

export const IS_WINDOWS = process.platform === "win32";

/** The user's home directory, with env overrides honoured before os.homedir(). */
export function home() {
  return process.env.USERPROFILE || process.env.HOME || homedir() || ".";
}

/**
 * Base directory for user configuration.
 * opencode itself reads XDG_CONFIG_HOME on every platform (including Windows),
 * so we must follow the same rule or we would edit a file it never loads.
 */
export function configHome() {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim()) return xdg;
  return join(home(), ".config");
}

/** Directory opencode keeps its global config in. */
export function opencodeConfigDir() {
  return join(configHome(), "opencode");
}

/**
 * Writable directory for this tool's own data (backups, preferences).
 * Kept outside the install directory so a packaged exe still works.
 */
export function dataDir() {
  const override = process.env.PS_DATA_DIR;
  if (override && override.trim()) return override;
  if (IS_WINDOWS) {
    const local = process.env.LOCALAPPDATA;
    if (local && local.trim()) return join(local, "ProviderStudio");
    return join(home(), "AppData", "Local", "ProviderStudio");
  }
  const xdgData = process.env.XDG_DATA_HOME;
  if (xdgData && xdgData.trim()) return join(xdgData, "provider-studio");
  if (process.platform === "darwin") {
    return join(home(), "Library", "Application Support", "ProviderStudio");
  }
  return join(home(), ".local", "share", "provider-studio");
}

export function backupDir() {
  return join(dataDir(), "backups");
}

/**
 * Every place an opencode config may live, most specific first.
 *
 * Project-local files win over the global one because that is opencode's own
 * precedence, and a user editing a repo expects the repo file to be touched.
 */
export function opencodeConfigCandidates(cwd = process.cwd()) {
  const dir = opencodeConfigDir();
  const out = [
    join(cwd, "opencode.jsonc"),
    join(cwd, "opencode.json"),
    join(cwd, ".opencode", "opencode.jsonc"),
    join(cwd, ".opencode", "opencode.json"),
    join(dir, "opencode.jsonc"),
    join(dir, "opencode.json"),
  ];
  return dedupe(out);
}

/** The config we write to when the user has not picked one explicitly. */
export function defaultOpencodeConfigPath() {
  return join(opencodeConfigDir(), "opencode.jsonc");
}

/**
 * Resolves which config to operate on.
 * OPENCODE_CONFIG is honoured first because opencode itself does so — ignoring
 * it would mean editing a file that is not the one actually in use.
 */
export function resolveOpencodeConfigPath(explicit, cwd = process.cwd()) {
  const pick = (p) => (p && String(p).trim() ? resolve(String(p).trim()) : "");
  const fromEnv = pick(process.env.OPENCODE_CONFIG);
  const chosen = pick(explicit);
  if (chosen) {
    // An explicit path arrives over HTTP, so it is only honoured when it names
    // a real config location: a candidate or the OPENCODE_CONFIG override.
    // A foreign path is ignored entirely — the fallthrough below can only ever
    // yield a known config, never the arbitrary file that was asked for.
    // Otherwise every read/write endpoint doubles as a file accessor for any
    // local process able to reach loopback.
    const known = new Set([
      ...opencodeConfigCandidates(cwd).map((p) => resolve(p)),
      ...(fromEnv ? [fromEnv] : []),
    ]);
    const hit = [...known].some((k) =>
      IS_WINDOWS ? k.toLowerCase() === chosen.toLowerCase() : k === chosen);
    if (hit) return chosen;
  }
  if (fromEnv) return fromEnv;
  for (const p of opencodeConfigCandidates(cwd)) {
    if (existsSync(p)) return p;
  }
  return defaultOpencodeConfigPath();
}

/** Lists the configs that exist right now, so the UI can offer a choice. */
export function listOpencodeConfigs(cwd = process.cwd()) {
  const active = resolveOpencodeConfigPath("", cwd);
  const known = dedupe([...opencodeConfigCandidates(cwd), active]);
  const out = [];
  for (const path of known) {
    let size = 0;
    let mtime = 0;
    const exists = existsSync(path);
    if (exists) {
      try {
        const st = statSync(path);
        size = st.size;
        mtime = st.mtimeMs;
      } catch { /* unreadable: report it as present but empty */ }
    }
    out.push({
      path,
      exists,
      size,
      mtime,
      scope: isInside(opencodeConfigDir(), path) ? "global" : "project",
      active: path === active,
    });
  }
  return out;
}

/**
 * True when two config paths name the same file. Used to match a backup to
 * the config it was taken from: a backup restored into the wrong file is a
 * silent cross-file overwrite, not a restore.
 */
export function sameConfigPath(a, b) {
  const x = resolve(String(a || ""));
  const y = resolve(String(b || ""));
  return IS_WINDOWS ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** True when `child` is `parent` or sits underneath it. Blocks `..` traversal. */
export function isInside(parent, child) {
  const a = resolve(String(parent || ""));
  const b = resolve(String(child || ""));
  if (a === b) return true;
  const rel = relative(a, b);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function sha256(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

/**
 * Fingerprints a file so a write can detect that something else changed it in
 * the meantime. Size and mtime alone are too coarse: editors routinely rewrite a
 * file within the same millisecond and with an identical length.
 */
export function fileStamp(path) {
  if (!existsSync(path)) return { exists: false, size: 0, mtime: 0, hash: "" };
  const st = statSync(path);
  let hash = "";
  try { hash = sha256(readFileSync(path, "utf8")); } catch { /* binary or locked */ }
  return { exists: true, size: st.size, mtime: st.mtimeMs, hash };
}

/**
 * Writes via a temp file in the same directory, then renames.
 * A crash or a full disk mid-write leaves the original config intact instead of
 * truncated — the difference between a recoverable failure and a lost config.
 */
export function writeFileAtomic(path, text) {
  const target = resolve(path);
  const dir = dirname(target);
  ensureDir(dir);
  const tmp = join(dir, `.${basenameSafe(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, target);
  } catch (e) {
    // rename across a locked target can fail; never leave the temp file behind
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    throw e;
  }
  return target;
}

function basenameSafe(p) {
  const b = String(p).split(/[\\/]/).pop() || "file";
  return b.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 60) || "file";
}

/** Scratch space for build steps and throwaway files. */
export function tempDir() {
  return join(tmpdir(), "provider-studio");
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const key = IS_WINDOWS ? p.toLowerCase() : p;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
