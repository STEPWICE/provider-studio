// Builds a single self-contained executable.
//
// Why it looks like this:
//
//   * Node's single-executable format only accepts a CommonJS entry point, so
//     the ESM sources are bundled to CJS with esbuild first. There is no way to
//     feed server.mjs to --experimental-sea-config directly.
//   * The bundler rewrites `import.meta.url` to `{}`. Anything deriving a path
//     from it would break silently, which is why src/assets.mjs resolves the
//     static root from argv[1]/execPath instead. The build asserts that no
//     import.meta survived the bundle.
//   * public/ is embedded as SEA assets rather than shipped alongside, so the
//     exe really is one file.
//
// Usage: node build-sea.mjs [--outfile dist/provider-studio.exe] [--keep]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "dist");
const WORK = path.join(DIST, ".sea");
const PUBLIC = path.join(ROOT, "public");

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const outIdx = args.indexOf("--outfile");
const exeName = process.platform === "win32" ? "provider-studio.exe" : "provider-studio";
const OUT = outIdx >= 0 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]) : path.join(DIST, exeName);

const steps = [];
function step(name) {
  steps.push(name);
  process.stdout.write(`\n[${steps.length}] ${name}\n`);
}
function die(msg) {
  process.stderr.write(`\nBUILD FAILED: ${msg}\n`);
  process.exit(1);
}
// `shell: true` on Windows re-splits the command on spaces, so an interpreter
// living in "C:\Program Files\nodejs" is truncated to "C:\Program". Only npx
// needs a shell (it is a .cmd), and it is invoked from PATH without spaces.
function run(cmd, argv, { shell = false, ...opts } = {}) {
  const r = spawnSync(cmd, argv, { stdio: "pipe", encoding: "utf8", shell, ...opts });
  if (r.error) die(`${cmd} could not be started: ${r.error.message}`);
  if (r.status !== 0) die(`${cmd} exited with ${r.status}\n${r.stdout || ""}${r.stderr || ""}`);
  return (r.stdout || "") + (r.stderr || "");
}

// ---------------------------------------------------------------- 0. preflight
step("Checking the toolchain");
const major = Number(process.versions.node.split(".")[0]);
// SEA assets (sea.getRawAsset) landed in 20.x; below that the exe would build
// but serve no UI at all, which is a far more confusing failure.
if (major < 20) die(`Node 20+ is required for single-executable assets, this is ${process.versions.node}`);
console.log(`node ${process.versions.node} on ${process.platform}/${process.arch}`);

if (!existsSync(PUBLIC)) die("public/ is missing — nothing to embed");
const esbuildBin = path.join(ROOT, "node_modules", "esbuild", "bin", "esbuild");
if (!existsSync(esbuildBin) && !existsSync(esbuildBin + ".exe")) {
  die("esbuild is not installed. Run: npm install");
}
// Pinned as a devDependency instead of fetched by npx on every build: an
// offline machine would otherwise fail at the very last step.
const postjectCli = path.join(ROOT, "node_modules", "postject", "dist", "cli.js");
if (!existsSync(postjectCli)) die("postject is not installed. Run: npm install");

// --------------------------------------------------------------- 1. clean work
step("Preparing dist/");
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// ------------------------------------------------------------------- 2. bundle
step("Bundling server.mjs to CommonJS");
const bundle = path.join(WORK, "server.cjs");
const esbuildOut = run(process.execPath, [
  path.join(ROOT, "node_modules", "esbuild", "bin", "esbuild"),
  path.join(ROOT, "server.mjs"),
  "--bundle",
  "--platform=node",
  `--target=node${major}`,
  "--format=cjs",
  // node: builtins must stay external or esbuild tries to polyfill them.
  "--packages=external",
  `--outfile=${bundle}`,
]);
process.stdout.write(esbuildOut.split("\n").filter((l) => l.trim()).slice(-2).join("\n") + "\n");
if (!existsSync(bundle)) die("the bundle was not produced");

// The bundler warns about import.meta but still emits `{}`, so verify rather
// than trust: a surviving import.meta.url means a path lookup will crash at
// runtime with an unhelpful ERR_INVALID_URL.
step("Verifying the bundle");
const bundleText = readFileSync(bundle, "utf8");
if (/\bimport\.meta\b/.test(bundleText)) {
  die("the bundle still contains import.meta — it would be undefined in CJS");
}
if (/\bfileURLToPath\s*\(\s*import_meta/.test(bundleText)) {
  die("the bundle derives a path from import.meta, which is empty once bundled");
}
if (!/createServer/.test(bundleText)) die("the bundle has no HTTP server in it");
console.log(`bundle ok — ${(statSync(bundle).size / 1024).toFixed(0)} KB, no import.meta`);

// Load the bundle in a child process to catch top-level crashes now instead of
// after packaging, when the stack trace is far less readable.
const smoke = spawnSync(process.execPath, ["-e", `process.env.PS_NO_LISTEN="1";require(${JSON.stringify(bundle)})`], {
  encoding: "utf8", timeout: 20000,
});
if (smoke.status !== 0) {
  die(`the bundle throws when loaded:\n${smoke.stdout || ""}${smoke.stderr || ""}`);
}
console.log("bundle loads without throwing");

// ------------------------------------------------------------------- 3. assets
step("Collecting static assets");
const assets = {};
(function walk(dir, prefix) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const key = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) walk(full, key);
    // SEA keys use forward slashes so they match the URL paths the server
    // normalises requests to.
    else assets[key] = full;
  }
})(PUBLIC, "");

const assetKeys = Object.keys(assets);
if (!assetKeys.length) die("public/ contains no files");
for (const must of ["index.html", "app.js", "style.css"]) {
  if (!assetKeys.includes(must)) die(`public/${must} is missing — the UI would not load`);
}
for (const k of assetKeys) console.log(`  + ${k} (${(statSync(assets[k]).size / 1024).toFixed(1)} KB)`);

// --------------------------------------------------------------------- 4. blob
step("Building the SEA preparation blob");
const seaConfig = path.join(WORK, "sea-config.json");
const blob = path.join(WORK, "sea-prep.blob");
writeFileSync(seaConfig, JSON.stringify({
  main: bundle,
  output: blob,
  // The bundle is already a single file; disabling the snapshot keeps the build
  // portable across Node patch releases.
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
}, null, 2));
run(process.execPath, ["--experimental-sea-config", seaConfig]);
if (!existsSync(blob)) die("the preparation blob was not produced");
console.log(`blob ok — ${(statSync(blob).size / 1024 / 1024).toFixed(1)} MB`);

// ---------------------------------------------------------------------- 5. exe
step("Injecting the blob into a copy of node");
mkdirSync(path.dirname(OUT), { recursive: true });
rmSync(OUT, { force: true });

// postject fails with "Can't read resource file" when any argument path
// contains non-ASCII characters (it does not decode the Windows code page), and
// this repo can legitimately live under a Cyrillic path. So the injection is
// always staged in an ASCII-only temp directory and the result copied back.
const needsStaging = /[^\x20-\x7e]/.test(OUT + blob);
const stageDir = needsStaging
  ? mkdtempSync(path.join(tmpdir(), "provider-studio-sea-"))
  : "";
const stageExe = needsStaging ? path.join(stageDir, "out" + path.extname(OUT)) : OUT;
const stageBlob = needsStaging ? path.join(stageDir, "prep.blob") : blob;
if (needsStaging) {
  console.log(`path has non-ASCII characters — staging via ${stageDir}`);
  copyFileSync(blob, stageBlob);
}

copyFileSync(process.execPath, stageExe);
if (process.platform !== "win32") chmodSync(stageExe, 0o755);

const fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const postjectArgs = [stageExe, "NODE_SEA_BLOB", stageBlob, "--sentinel-fuse", fuse];
// macOS binaries are signed, and injection invalidates the signature.
if (process.platform === "darwin") postjectArgs.push("--macho-segment-name", "NODE_SEA");
// The CLI is run through node directly rather than via npx: a shell would
// re-split paths containing spaces, and `shell: true` with arguments is
// deprecated for good reason (nothing is escaped, only concatenated).
run(process.execPath, [postjectCli, ...postjectArgs]);

if (needsStaging) {
  copyFileSync(stageExe, OUT);
  if (process.platform !== "win32") chmodSync(OUT, 0o755);
  rmSync(stageDir, { recursive: true, force: true });
}
if (!existsSync(OUT)) die("the executable was not produced");
console.log(`exe written — ${(statSync(OUT).size / 1024 / 1024).toFixed(1)} MB`);

// --------------------------------------------------------------- 6. verify exe
// Building an exe that cannot serve its own UI is the failure mode worth
// guarding against, so the binary is actually started and probed.
step("Smoke-testing the executable");
const port = 5900 + (process.pid % 90);
const child = spawnSync(OUT, [], {
  encoding: "utf8",
  timeout: 30000,
  env: { ...process.env, PORT: String(port), PS_SELFTEST: "1", PS_NO_OPEN: "1" },
});
const selfOut = (child.stdout || "") + (child.stderr || "");
if (child.status !== 0) {
  die(`the executable failed its self-test (exit ${child.status}):\n${selfOut}`);
}
process.stdout.write(selfOut.split("\n").filter((l) => l.trim()).map((l) => "  " + l).join("\n") + "\n");

if (!keep) rmSync(WORK, { recursive: true, force: true });

step("Done");
console.log(`\n  ${OUT}\n`);
console.log("Run it, then open http://localhost:5173");
console.log("The exe is self-contained: no Node install and no public/ folder needed.");
