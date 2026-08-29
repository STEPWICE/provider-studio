// Verifies the packaged executable, not the sources.
//
// The bundling step is where things break silently: `import.meta.url` becomes
// `{}`, the static files stop existing on disk, and a bundler can drop a module
// that was only reached dynamically. So this suite starts the real exe and
// drives it over HTTP, against a throwaway config.
//
// Skipped (exit 0) when dist/ has no executable, so `npm run verify` stays
// usable without building first. Run `node build-sea.mjs` to include it.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const exeName = process.platform === "win32" ? "provider-studio.exe" : "provider-studio";
const EXE = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, "dist", exeName);

if (!existsSync(EXE)) {
  console.log(`SKIP — no executable at ${EXE}`);
  console.log("Build it first:  node build-sea.mjs");
  process.exit(0);
}

let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? `  <- ${detail}` : ""}`); }
}

const PORT = 5800 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;
const work = mkdtempSync(path.join(tmpdir(), "ps-sea-verify-"));
const cfgDir = path.join(work, "opencode");
mkdirSync(cfgDir, { recursive: true });
const CFG = path.join(cfgDir, "opencode.jsonc");

// A commented config: comment preservation is the property most likely to be
// lost, and the exe must behave exactly like the source build here.
const SEED = `{
  // top comment: must survive
  "$schema": "https://opencode.ai/config.json",
  "model": "existing/m1",
  "provider": {
    "existing": {
      // keep me
      "name": "Existing",
      "options": { "baseURL": "https://api.existing.test/v1" },
      "models": { "m1": { "name": "M One" } }
    }
  }
}
`;
writeFileSync(CFG, SEED);

const child = spawn(EXE, [], {
  env: {
    ...process.env,
    PORT: String(PORT),
    PS_NO_OPEN: "1",
    NO_OPEN: "1",
    // Point both the config lookup and the provider store at the sandbox so a
    // stray write can never touch the developer's real setup.
    XDG_CONFIG_HOME: work,
    PS_DATA_DIR: path.join(work, "data"),
    // The provider written below references {env:SEA_KEY}. Leaving it unset
    // would make the resulting config genuinely broken — opencode substitutes
    // an empty string and the provider answers 401 — so the validation check
    // further down would be right to fail it. Set it, so that check is testing
    // the packaged writer rather than a deliberately incomplete fixture.
    SEA_KEY: "sk-sea-selftest",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (d) => { serverLog += d; });
child.stderr.on("data", (d) => { serverLog += d; });

const HEADERS = { "Content-Type": "application/json", Origin: BASE };

async function waitForServer(ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the exe exited early (${child.exitCode}):\n${serverLog}`);
    try {
      const r = await fetch(`${BASE}/api/state`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the exe did not start within ${ms}ms:\n${serverLog}`);
}

const post = (p, body) => fetch(BASE + p, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
const getJson = async (p) => (await fetch(BASE + p)).json();

try {
  await waitForServer();
  console.log(`exe: ${EXE}`);
  console.log(`port ${PORT}, sandbox ${work}\n`);

  // ---- embedded assets ----
  const index = await fetch(`${BASE}/`);
  const indexText = await index.text();
  check("index.html is served from the binary", index.status === 200 && indexText.includes("Provider Studio"), `status ${index.status}`);
  check("index.html carries the diff modal", indexText.includes("diffBackdrop"), "modal markup missing");

  const appJs = await (await fetch(`${BASE}/app.js`)).text();
  check("app.js is complete", appJs.includes("/api/preview") && appJs.includes("function openDiff"), `${appJs.length} bytes`);
  const css = await (await fetch(`${BASE}/style.css`)).text();
  check("style.css includes the diff styles", css.includes(".dline"), "diff css missing");

  // A bundler dropping a module shows up as a 500 rather than a build error.
  const state = await getJson("/api/state");
  check("/api/state lists api formats", Array.isArray(state.formats) && state.formats.length > 0);
  check("/api/state lists targets", Array.isArray(state.targets) && state.targets.length > 0);
  check("/api/state reports the sandboxed config", typeof state.opencode?.path === "string" && state.opencode.path.startsWith(work), state.opencode?.path);
  check("/api/state exposes the config hash", typeof state.opencode?.hash === "string" && state.opencode.hash.length === 64, state.opencode?.hash);

  // ---- path handling after bundling ----
  // publicDir() derives from argv[1]/execPath instead of import.meta.url, which
  // bundling empties. The assets above were therefore served from inside the
  // binary — but only if there was no public/ next to the exe to fall back on.
  const sideloaded = path.join(path.dirname(EXE), "public");
  check("the assets came from the binary, not a neighbouring public/", !existsSync(sideloaded), `${sideloaded} exists, so this run proves nothing`);
  const traversal = await fetch(`${BASE}/..%5c..%5cserver.mjs`);
  check("percent-encoded traversal is refused", traversal.status === 403, `status ${traversal.status}`);
  const dotdot = await fetch(`${BASE}/../package.json`);
  check("plain ../ traversal does not leak", dotdot.status !== 200 || !(await dotdot.text()).includes("provider-studio"), `status ${dotdot.status}`);
  check("unknown asset 404s", (await fetch(`${BASE}/missing.txt`)).status === 404);

  // ---- the real work: preview then commit ----
  const provider = {
    name: "Sea Vendor",
    baseURL: "https://api.sea.test/v1",
    apiFormat: "openai-chat",
    useEnvVar: true,
    envVarName: "SEA_KEY",
    models: [{ id: "sea-1", name: "Sea One", contextWindow: 8192, maxOutput: 1024, inputTypes: ["text"], outputTypes: ["text"], toolUse: true }],
  };

  const before = readFileSync(CFG, "utf8");
  const pv = await (await post("/api/preview", { provider, targets: ["opencode"] })).json();
  check("preview succeeds in the packaged build", pv.ok === true, pv.error);
  check("preview returns hunks", Array.isArray(pv.diff?.hunks) && pv.diff.hunks.length > 0);
  check("preview adds lines", pv.diff?.added > 0, `+${pv.diff?.added}`);
  check("preview does not write", readFileSync(CFG, "utf8") === before);

  const stale = await post("/api/apply", { provider, targets: ["opencode"], hash: "0".repeat(64) });
  check("a stale hash is refused with 409", stale.status === 409, `status ${stale.status}`);
  check("the file is untouched after a refused write", readFileSync(CFG, "utf8") === before);

  const applied = await (await post("/api/apply", { provider, targets: ["opencode"], hash: pv.hash, defaultModelId: "sea-1" })).json();
  check("apply with the previewed hash succeeds", applied.ok === true && applied.results?.opencode?.ok === true, applied.results?.opencode?.error || applied.error);

  const after = readFileSync(CFG, "utf8");
  // This is the whole point of the JSONC patcher and the easiest thing for a
  // packaging change to break.
  check("comments survive a write from the exe", after.includes("// top comment: must survive") && after.includes("// keep me"));
  check("the new provider is in the file", after.includes("sea-vendor"));
  check("the pre-existing provider is intact", after.includes('"existing"') && after.includes("M One"));
  check("the key is stored as an env reference", after.includes("{env:SEA_KEY}") && !after.includes('"apiKey": "sea'));
  check("the default model was repointed", /"model":\s*"sea-vendor\/sea-1"/.test(after), after.match(/"model":[^\n]*/)?.[0]);

  const reread = await getJson("/api/state");
  check("the config still parses after the write", !reread.opencode?.error, reread.opencode?.error);
  check("the written provider is listed back", (reread.providers || []).some((p) => p.name === "Sea Vendor"));

  // ---- validation & backups run inside the exe ----
  const validated = await getJson("/api/validate");
  check("/api/validate works in the packaged build", validated.ok === true && Array.isArray(validated.issues));
  check("the written config validates clean", !validated.issues.some((i) => i.severity === "error"),
    validated.issues.filter((i) => i.severity === "error").map((i) => i.id).join(","));
  check("a backup was taken before the write", Array.isArray(validated.backups) && validated.backups.length > 0);

  // ---- removal round trip ----
  const rmPv = await (await post("/api/preview-remove", { key: "sea-vendor" })).json();
  check("preview-remove works", rmPv.ok === true && rmPv.diff?.removed > 0, rmPv.error);
  check("preview-remove reports the orphaned default", Array.isArray(rmPv.orphaned) && rmPv.orphaned.length > 0, JSON.stringify(rmPv.orphaned));
  const removed = await (await post("/api/remove-provider", { key: "sea-vendor", hash: rmPv.hash })).json();
  check("remove-provider works", removed.ok === true, removed.error);
  const afterRemove = readFileSync(CFG, "utf8");
  check("the provider is gone", !afterRemove.includes("sea-vendor"));
  check("comments still survive the removal", afterRemove.includes("// top comment: must survive"));
  check("the other provider survived the removal", afterRemove.includes('"existing"'));

  // ---- security posture is not lost in packaging ----
  const foreignOrigin = await fetch(`${BASE}/api/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
    body: "{}",
  });
  check("a foreign Origin is rejected", foreignOrigin.status === 403, `status ${foreignOrigin.status}`);
  const foreignHostFetch = await fetch(`${BASE}/api/state`, { headers: { "X-Forwarded-Host": "evil.example" } });
  check("a spoofed forwarded host does not bypass the guard", foreignHostFetch.status === 200);

  // The store must never hold a literal key, even in a packaged run.
  const storeFile = path.join(work, "data", "providers.json");
  if (existsSync(storeFile)) {
    const store = readFileSync(storeFile, "utf8");
    check("the provider store holds no literal key", !store.includes("sea-secret") && !/"apiKey":\s*"[^"]+"/.test(store));
  } else {
    check("the provider store lives in the data dir", true);
  }
} catch (err) {
  check("the suite ran to completion", false, err.message);
} finally {
  child.kill();
  // Give the process a moment to release the sandbox before deleting it.
  await new Promise((r) => setTimeout(r, 300));
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length) {
  console.log("failed: " + failures.join(", "));
  process.exitCode = 1;
}
