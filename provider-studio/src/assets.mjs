// Where the static UI files come from.
//
// Two very different situations have to look identical to the server:
//
//   * running from source  -> the files sit in ./public next to server.mjs
//   * running as a SEA exe -> there is no ./public; the files are embedded in
//     the binary and only reachable through node:sea.getRawAsset()
//
// The single-executable format only accepts a CommonJS entry point, so the exe
// is produced by bundling this ESM code with esbuild. That bundling step
// rewrites `import.meta.url` to `{}`, which silently turns
// `fileURLToPath(import.meta.url)` into a crash. So the source root is resolved
// from `process.argv[1]` / `process.execPath` instead, never from import.meta.
//
// Keeping this in one module means the request handler never has to care which
// mode it is in.
import path from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

// A bare `import sea from "node:sea"` would make the module unloadable on Node
// versions without SEA support, so it is resolved lazily and defensively.
let seaMod = null;
let seaTried = false;

function sea() {
  if (seaTried) return seaMod;
  seaTried = true;
  try {
    // createRequire is avoided on purpose: esbuild turns it into a shim that
    // resolves against the wrong base once bundled.
    seaMod = process.getBuiltinModule ? process.getBuiltinModule("node:sea") : null;
  } catch {
    seaMod = null;
  }
  return seaMod;
}

/** True when running inside a single-executable build. */
export function isPackaged() {
  const s = sea();
  try {
    return !!(s && s.isSea());
  } catch {
    return false;
  }
}

// Candidate directories for the source-mode `public/`. argv[1] is the script
// that was started, which is correct both for `node server.mjs` and for an
// unbundled run from another cwd.
function sourceRoots() {
  const roots = [];
  const script = process.argv[1];
  if (script) {
    const dir = path.dirname(path.resolve(script));
    roots.push(path.join(dir, "public"));
    // A bundle placed in dist/ still wants the repo's public/ during testing.
    roots.push(path.join(dir, "..", "public"));
  }
  roots.push(path.join(process.cwd(), "public"));
  return roots;
}

let cachedDir;

/**
 * The on-disk public directory, or "" when the assets are embedded.
 * Exposed so the traversal guard can keep comparing real paths in source mode.
 */
export function publicDir() {
  if (cachedDir !== undefined) return cachedDir;
  if (isPackaged()) return (cachedDir = "");
  for (const dir of sourceRoots()) {
    try {
      if (existsSync(dir) && statSync(dir).isDirectory()) return (cachedDir = path.resolve(dir));
    } catch { /* keep looking */ }
  }
  return (cachedDir = "");
}

/**
 * Reads a static asset by its relative path (e.g. "index.html").
 *
 * Returns a Buffer, or null when the asset does not exist. The path is
 * validated here as well as at the HTTP layer: an embedded lookup has no
 * filesystem to fall back on, so a traversal attempt must not be forwarded to
 * getRawAsset() where a crafted key could match something unintended.
 */
export function readAsset(relPath) {
  const rel = normaliseRel(relPath);
  if (rel === null) return null;

  if (isPackaged()) {
    const s = sea();
    if (!s) return null;
    try {
      // getRawAsset returns an ArrayBuffer and throws when the key is absent.
      const raw = s.getRawAsset(rel);
      return Buffer.from(raw);
    } catch {
      return null;
    }
  }

  const root = publicDir();
  if (!root) return null;
  const target = path.resolve(root, rel);
  // Defence in depth: even though rel is already normalised, never read outside.
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  try {
    if (!statSync(target).isFile()) return null;
    return readFileSync(target);
  } catch {
    return null;
  }
}

/** Which assets exist, for the build to verify nothing was left behind. */
export function listAssets() {
  if (isPackaged()) {
    const s = sea();
    try { return s ? s.getAssetKeys() : []; } catch { return []; }
  }
  const root = publicDir();
  if (!root) return [];
  const out = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSafe(dir)) {
      const full = path.join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, prefix ? `${prefix}/${name}` : name);
      else out.push(prefix ? `${prefix}/${name}` : name);
    }
  };
  walk(root, "");
  return out.sort();
}

function readdirSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

/**
 * Turns a URL path into a safe asset key, or null when it escapes the root.
 * SEA asset keys are flat strings, so they are always normalised to forward
 * slashes: "/" and "\" both have to collapse to the same key.
 */
export function normaliseRel(urlPath) {
  let decoded = String(urlPath == null ? "" : urlPath);
  try { decoded = decodeURIComponent(decoded); } catch { /* use as-is */ }
  // %5c survives URL parsing and acts as a separator on Windows.
  decoded = decoded.replace(/\\/g, "/");
  if (decoded === "/" || decoded === "") decoded = "/index.html";
  decoded = decoded.replace(/^\/+/, "");
  if (!decoded) return null;

  const parts = [];
  for (const seg of decoded.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      // Refuse rather than pop: a request that climbs out is hostile, not a
      // path in need of cleaning.
      return null;
    }
    parts.push(seg);
  }
  if (!parts.length) return null;
  // Reject NUL and drive letters, which can confuse the filesystem layer.
  const rel = parts.join("/");
  if (rel.includes("\0") || /^[A-Za-z]:/.test(rel)) return null;
  return rel;
}
