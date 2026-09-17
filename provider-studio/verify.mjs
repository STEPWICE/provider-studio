// Runtime verification for Provider Studio.
// Boots the server against a throwaway OPENCODE_CONFIG, exercises every route,
// and asserts the resulting config matches the opencode schema expectations.
// Usage: node verify.mjs   (from the provider-studio directory)

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

import { parseJsonc } from "./src/jsonc-edit.mjs";

const results = [];
let failed = 0;

function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? "" : String(detail ?? "") });
  if (!cond) failed++;
}

const work = mkdtempSync(join(tmpdir(), "ps-verify-"));
const CONFIG = join(work, "opencode.jsonc");
// Redirect the whole data dir so the run never touches the real store or the
// real backup history (a restore there would clobber the user's config).
const DATA = join(work, "data");
const STORE = join(DATA, "providers.json");
mkdirSync(DATA, { recursive: true });

// A config with comments and a pre-existing provider, so we can observe both
// the comment-loss signal and that unrelated blocks survive.
writeFileSync(CONFIG, `{
  // user comment that must survive every edit
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "legacy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Legacy",
      "options": { "baseURL": "https://legacy.example/v1" },
      "models": { "legacy-model": { "name": "Legacy Model" } }
    }
  },
  "model": "legacy/legacy-model"
}
`, "utf8");

// Legacy shape: a bare object instead of an array. This used to crash the server.
writeFileSync(STORE, JSON.stringify({
  id: 1, name: "legacyStore", baseURL: "https://old.example/v1",
  apiKey: "sk-should-never-persist", apiFormat: "openai-chat", models: [],
}, null, 2), "utf8");

const PORT = 5999;
const BASE = `http://127.0.0.1:${PORT}`;
// PS_HOST and PS_DATA_DIR are pinned so ambient values can't affect the run.
const childEnv = {
  ...process.env,
  PORT: String(PORT), OPENCODE_CONFIG: CONFIG, NO_OPEN: "1",
  PS_HOST: "127.0.0.1", PS_DATA_DIR: DATA, TESTVAR_API_KEY: "",
  // A variable the child definitely has, so the env checks below assert against
  // a known state rather than whatever the developer's shell happens to export.
  PS_VERIFY_KEY_SET: "sk-verify-value",
};
// Deleted rather than set to undefined: an undefined value would be passed
// through as the literal string "undefined" on some platforms, which is very
// much "set" and would invert the test it is meant to support.
delete childEnv.PS_VERIFY_KEY_ABSENT;
const child = spawn(process.execPath, ["server.mjs"], {
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (d) => (serverLog += d));
child.stderr.on("data", (d) => (serverLog += d));

async function waitUp(ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/api/state`);
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const jsonHeaders = { "Content-Type": "application/json", Origin: BASE };
const post = (p, body, headers) =>
  fetch(BASE + p, { method: "POST", headers: { ...jsonHeaders, ...headers }, body: JSON.stringify(body ?? {}) });
const get = (p) => fetch(BASE + p, { headers: { Origin: BASE } });

// The config keeps its comments now, so a plain JSON.parse would throw.
function readConfigFile() {
  const parsed = parseJsonc(readFileSync(CONFIG, "utf8"));
  if (!parsed.ok) throw new Error("config no longer parses: " + parsed.error);
  return parsed.value;
}

function readConfigText() {
  return readFileSync(CONFIG, "utf8");
}

// fetch() refuses to set forbidden headers such as Host, so use the raw client
// for the DNS-rebinding probe.
function rawRequest({ method = "GET", path = "/", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path, headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

try {
  check("server starts and answers /api/state", await waitUp(), serverLog);

  // ---- store normalisation (used to be a hard crash) ----
  const state = await (await get("/api/state")).json();
  check("state.providers is an array despite legacy object store", Array.isArray(state.providers), JSON.stringify(state.providers));
  check("legacy store entry is loaded", state.providers.some((p) => p.name === "legacyStore"), JSON.stringify(state.providers));
  check("state reports JSONC comments", state.opencode.comments === true, state.opencode.comments);
  check("existing provider is listed", state.opencode.providers.some((p) => p.name === "Legacy" || p.name === "legacy"),
    JSON.stringify(state.opencode.providers.map((p) => p.name)));

  // ---- apply with env-var key ----
  const applyRes = await (await post("/api/apply", {
    provider: {
      name: "BAI Test", baseURL: "https://api.b.ai/v1",
      apiKey: "sk-secret-should-not-persist",
      apiFormat: "openai-chat", useEnvVar: true, envVarName: "TESTVAR_API_KEY",
      setAsDefault: true,
      models: [
        { id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 200000, maxOutput: 65536, inputTypes: ["text"], outputTypes: ["text"], reasoning: true, toolUse: true },
        { id: "vision-exp", name: "Vision", contextWindow: 0, maxOutput: 0, inputTypes: ["text", "image"], outputTypes: ["text"], reasoning: false, toolUse: true },
      ],
    },
    targets: ["opencode", "kilo"],
  })).json();
  check("/api/apply succeeds", applyRes.ok === true && applyRes.results?.opencode?.ok === true, JSON.stringify(applyRes).slice(0, 400));
  // The patcher edits text in place, so an edit no longer costs the user their comments.
  check("apply no longer reports comment loss", applyRes.results?.opencode?.commentsLost === false, applyRes.results?.opencode?.commentsLost);
  check("apply created an auto backup", !!applyRes.backupFile, applyRes.backupFile);

  const textAfterApply = readConfigText();
  check("comments survive an apply", textAfterApply.includes("must survive every edit"), textAfterApply.slice(0, 200));

  const cfg = readConfigFile();
  const bai = cfg.provider?.["bai-test"];
  check("provider written under slugified key", !!bai, Object.keys(cfg.provider || {}));
  check("npm holds the AI SDK package", bai?.npm === "@ai-sdk/openai-compatible", bai?.npm);
  check("name holds the display label, not the package", bai?.name === "BAI Test", bai?.name);
  check("apiKey uses {env:VAR} syntax", bai?.options?.apiKey === "{env:TESTVAR_API_KEY}", bai?.options?.apiKey);
  check("literal key never reaches the config", !JSON.stringify(cfg).includes("sk-secret-should-not-persist"), "key leaked into config");
  check("env array declares the variable", Array.isArray(bai?.env) && bai.env.includes("TESTVAR_API_KEY"), JSON.stringify(bai?.env));
  check("baseURL written", bai?.options?.baseURL === "https://api.b.ai/v1", bai?.options?.baseURL);
  check("full limit is written when both values known",
    bai?.models?.["deepseek-v4"]?.limit?.context === 200000 && bai?.models?.["deepseek-v4"]?.limit?.output === 65536,
    JSON.stringify(bai?.models?.["deepseek-v4"]?.limit));
  check("partial limit is omitted entirely", bai?.models?.["vision-exp"]?.limit === undefined, JSON.stringify(bai?.models?.["vision-exp"]?.limit));
  check("attachment set for image input", bai?.models?.["vision-exp"]?.attachment === true, bai?.models?.["vision-exp"]?.attachment);
  check("attachment absent for text-only model", bai?.models?.["deepseek-v4"]?.attachment === undefined, bai?.models?.["deepseek-v4"]?.attachment);
  check("reasoning flag preserved", bai?.models?.["deepseek-v4"]?.reasoning === true, bai?.models?.["deepseek-v4"]?.reasoning);
  check("default model points at the new provider", cfg.model === "bai-test/deepseek-v4", cfg.model);
  check("$schema preserved", cfg.$schema === "https://opencode.ai/config.json", cfg.$schema);
  check("unrelated provider survives the edit", !!cfg.provider?.legacy, Object.keys(cfg.provider || {}));
  check("unrelated provider keeps its baseURL",
    cfg.provider?.legacy?.options?.baseURL === "https://legacy.example/v1", JSON.stringify(cfg.provider?.legacy));
  check("unrelated provider keeps its models",
    cfg.provider?.legacy?.models?.["legacy-model"]?.name === "Legacy Model", JSON.stringify(cfg.provider?.legacy?.models));

  // ---- preview must describe the write, without performing it ----
  const beforePreview = readConfigText();
  const prevRes = await (await post("/api/preview", {
    provider: {
      name: "BAI Test", baseURL: "https://api.b.ai/v1", apiFormat: "openai-chat",
      useEnvVar: true, envVarName: "TESTVAR_API_KEY",
      models: [{ id: "deepseek-v4", contextWindow: 200000, maxOutput: 65536 }, { id: "brand-new", contextWindow: 1000, maxOutput: 100 }],
    },
    previousKey: "bai-test",
  })).json();
  check("/api/preview succeeds", prevRes.ok === true, JSON.stringify(prevRes).slice(0, 300));
  check("preview does not write to the file", readConfigText() === beforePreview, "the file changed during a preview");
  check("preview reports a diff", prevRes.diff?.added > 0, JSON.stringify(prevRes.diff).slice(0, 200));
  check("preview returns hunks", Array.isArray(prevRes.diff?.hunks) && prevRes.diff.hunks.length > 0, JSON.stringify(prevRes.diff?.hunks || []).slice(0, 200));
  check("preview returns the hash to commit against", typeof prevRes.hash === "string" && prevRes.hash.length === 64, prevRes.hash);
  check("preview shows the added model", JSON.stringify(prevRes.diff).includes("brand-new"), JSON.stringify(prevRes.diff).slice(0, 300));

  // A preview of an unchanged provider must report no change at all.
  const samePrev = await (await post("/api/preview", {
    provider: {
      name: "BAI Test", baseURL: "https://api.b.ai/v1", apiFormat: "openai-chat",
      useEnvVar: true, envVarName: "TESTVAR_API_KEY", setAsDefault: false,
      models: [
        { id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 200000, maxOutput: 65536, inputTypes: ["text"], outputTypes: ["text"], reasoning: true, toolUse: true },
        { id: "vision-exp", name: "Vision", inputTypes: ["text", "image"], outputTypes: ["text"], toolUse: true },
      ],
    },
    previousKey: "bai-test",
  })).json();
  check("re-previewing an unchanged provider reports no diff",
    samePrev.ok === true && samePrev.diff?.identical === true,
    JSON.stringify(samePrev.diff || {}).slice(0, 300));

  // ---- stale-hash writes must be refused, not silently applied ----
  const staleApply = await post("/api/apply", {
    provider: { name: "BAI Test", baseURL: "https://api.b.ai/v1", apiFormat: "openai-chat", models: [{ id: "deepseek-v4" }] },
    targets: ["opencode"],
    hash: "0".repeat(64),
  });
  check("apply with a stale hash returns 409", staleApply.status === 409, staleApply.status);
  check("a refused apply leaves the file alone", readConfigText() === beforePreview, "file changed despite the conflict");

  // The hash from a fresh preview must be accepted.
  const freshPrev = await (await post("/api/preview", {
    provider: { name: "BAI Test", baseURL: "https://api.b.ai/v1", apiFormat: "openai-chat", setAsDefault: false, models: [{ id: "deepseek-v4", contextWindow: 200000, maxOutput: 65536 }] },
    previousKey: "bai-test",
  })).json();
  const guarded = await (await post("/api/apply", {
    provider: { name: "BAI Test", baseURL: "https://api.b.ai/v1", apiFormat: "openai-chat", setAsDefault: false, models: [{ id: "deepseek-v4", contextWindow: 200000, maxOutput: 65536 }] },
    targets: ["opencode"], previousKey: "bai-test", hash: freshPrev.hash,
  })).json();
  check("apply with a current hash succeeds", guarded.results?.opencode?.ok === true, JSON.stringify(guarded).slice(0, 300));

  // ---- config listing ----
  const cfgList = await (await get("/api/configs")).json();
  check("/api/configs lists candidates", cfgList.ok === true && cfgList.configs.length > 0, JSON.stringify(cfgList).slice(0, 200));
  check("exactly one config is marked active", cfgList.configs.filter((c) => c.active).length === 1,
    JSON.stringify(cfgList.configs.map((c) => [c.path, c.active])));
  check("the active config is the one under test", cfgList.configs.find((c) => c.active)?.path === CONFIG,
    cfgList.configs.find((c) => c.active)?.path);

  // ---- rename keeps the block and repoints the default model ----
  const renamed = await (await post("/api/rename-provider", { from: "bai-test", to: "bai-renamed" })).json();
  check("/api/rename-provider succeeds", renamed.ok === true, JSON.stringify(renamed).slice(0, 300));
  const cfgRen = readConfigFile();
  check("rename removes the old key", cfgRen.provider?.["bai-test"] === undefined, Object.keys(cfgRen.provider || {}));
  check("rename creates the new key", !!cfgRen.provider?.["bai-renamed"], Object.keys(cfgRen.provider || {}));
  check("rename keeps the models", Object.keys(cfgRen.provider?.["bai-renamed"]?.models || {}).length > 0,
    JSON.stringify(cfgRen.provider?.["bai-renamed"]?.models || {}));
  check("rename keeps comments", readConfigText().includes("must survive every edit"));
  const renDup = await post("/api/rename-provider", { from: "bai-renamed", to: "legacy" });
  check("renaming onto an existing key is refused", renDup.status === 400, renDup.status);

  // ---- removal from the opencode config, with the orphan repointed ----
  const rmPrev = await (await post("/api/preview-remove", { key: "bai-renamed" })).json();
  check("/api/preview-remove succeeds", rmPrev.ok === true, JSON.stringify(rmPrev).slice(0, 300));
  check("removal preview reports removed lines", rmPrev.diff?.removed > 0, JSON.stringify(rmPrev.diff).slice(0, 200));
  const rmRes = await (await post("/api/remove-provider", { key: "bai-renamed" })).json();
  check("/api/remove-provider succeeds", rmRes.ok === true, JSON.stringify(rmRes).slice(0, 300));
  const cfgRm = readConfigFile();
  check("the provider is gone from the config", cfgRm.provider?.["bai-renamed"] === undefined, Object.keys(cfgRm.provider || {}));
  check("an unrelated provider survives the removal", !!cfgRm.provider?.legacy, Object.keys(cfgRm.provider || {}));
  // A dangling default model stops opencode from starting.
  check("the orphaned default model was repointed",
    !String(cfgRm.model || "").startsWith("bai-renamed/"), cfgRm.model);
  check("removal keeps comments", readConfigText().includes("must survive every edit"));
  const rmGhost = await post("/api/remove-provider", { key: "does-not-exist" });
  check("removing a missing provider is refused", rmGhost.status === 400, rmGhost.status);
  const rmGhostBody = await rmGhost.json();
  check("the refusal is flagged notFound", rmGhostBody.notFound === true, JSON.stringify(rmGhostBody).slice(0, 160));
  const rmPrevGhost = await (await post("/api/preview-remove", { key: "does-not-exist" })).json();
  check("the removal preview flags notFound too",
    rmPrevGhost.ok === false && rmPrevGhost.notFound === true, JSON.stringify(rmPrevGhost).slice(0, 160));

  // ---- non-ASCII bodies must survive the request decode ----
  const uni = await (await post("/api/preview", {
    provider: {
      name: "Провайдер Тест", baseURL: "https://uni.example/v1", apiFormat: "openai-chat",
      models: [{ id: "модель-1", name: "Модель — 中文 🎉" }],
    },
  })).json();
  check("a cyrillic provider name survives the round trip",
    uni.ok === true && JSON.stringify(uni.diff).includes("Модель"), JSON.stringify(uni).slice(0, 300));
  check("multi-byte characters are not corrupted",
    JSON.stringify(uni.diff).includes("中文"), JSON.stringify(uni.diff).slice(0, 300));

  // ---- previews must never carry a plaintext key to the browser ----
  const leaky = await (await post("/api/preview", {
    provider: {
      name: "Leak Test", baseURL: "https://leak.example/v1", apiFormat: "openai-chat",
      apiKey: "sk-plaintext-must-not-appear-in-diff", models: [{ id: "m" }],
    },
  })).json();
  check("preview masks the plaintext key it would write",
    !JSON.stringify(leaky.diff || {}).includes("sk-plaintext-must-not-appear-in-diff"),
    JSON.stringify(leaky.diff || {}).slice(0, 400));

  // ---- secrets never persisted in the local store ----
  const storeRaw = readFileSync(STORE, "utf8");
  check("store file is an array after migration", Array.isArray(JSON.parse(storeRaw)), storeRaw.slice(0, 120));
  check("store never holds an API key", !storeRaw.includes("sk-secret-should-not-persist") && !storeRaw.includes("sk-should-never-persist"),
    "key leaked into data/providers.json");

  // ---- Kilo manifest must not carry the key ----
  const kilo = applyRes.results?.kilo;
  check("kilo manifest omits the literal key", !JSON.stringify(kilo || {}).includes("sk-secret-should-not-persist"), "key leaked into manifest");

  // ---- validation catches the seeded problems ----
  writeFileSync(CONFIG, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      broken: {
        name: "@ai-sdk/openai-compatible", // package in the wrong field
        options: { baseURL: "https://x.example/v1", apiKey: "$SOME_VAR" }, // legacy $VAR syntax
        models: {
          half: { name: "Half", limit: { context: 100000 } }, // partial limit
          novis: { name: "NoVis", modalities: { input: ["text", "image"], output: ["text"] } }, // missing attachment
        },
      },
    },
    model: "broken/missing-model",
  }, null, 2), "utf8");
  const val = await (await get("/api/validate")).json();
  const ids = (val.issues || []).map((i) => i.id);
  check("validate flags package-in-name", ids.includes("npm-as-name"), JSON.stringify(ids));
  check("validate flags $VAR key syntax", ids.includes("bad-env-ref"), JSON.stringify(ids));
  check("validate flags partial limit", ids.includes("partial-limit"), JSON.stringify(ids));
  check("validate flags missing attachment", ids.includes("no-attachment"), JSON.stringify(ids));
  check("validate flags unknown default model", ids.includes("bad-default"), JSON.stringify(ids));

  // ---- import round-trip ----
  const imp = await (await post("/api/import", {})).json();
  check("/api/import succeeds", imp.ok === true, JSON.stringify(imp).slice(0, 200));
  const impBroken = (imp.providers || []).find((p) => p.name === "broken");
  check("imported provider recognised via api/npm fallback", !!impBroken, JSON.stringify((imp.providers || []).map((p) => p.name)));
  check("imported provider decodes legacy $VAR into env mode",
    impBroken?.useEnvVar === true && impBroken?.envVarName === "SOME_VAR",
    JSON.stringify({ useEnvVar: impBroken?.useEnvVar, envVarName: impBroken?.envVarName }));

  // ---- apply is idempotent: no duplicate store entries ----
  const before = (await (await get("/api/state")).json()).providers.length;
  await post("/api/apply", {
    provider: { name: "BAI Test", baseURL: "https://api.b.ai/v1", apiFormat: "openai-chat", useEnvVar: true, envVarName: "TESTVAR_API_KEY", models: [{ id: "deepseek-v4", contextWindow: 200000, maxOutput: 65536, inputTypes: ["text"], outputTypes: ["text"] }] },
    targets: ["opencode"],
  });
  const after = (await (await get("/api/state")).json()).providers.length;
  check("re-applying the same provider does not duplicate it", after === before, `${before} -> ${after}`);

  // ---- apply rejects a nameless provider instead of writing junk ----
  const noName = await post("/api/apply", { provider: { name: "   ", baseURL: "https://x/v1", models: [] }, targets: ["opencode"] });
  check("apply rejects an empty name with 400", noName.status === 400, noName.status);

  // ---- backup / restore ----
  const bk = await (await post("/api/backup", {})).json();
  check("/api/backup creates a snapshot", !!bk.file && Array.isArray(bk.backups) && bk.backups.length > 0, JSON.stringify(bk).slice(0, 200));

  const traversal = await (await post("/api/restore", { file: "../../../opencode.jsonc" })).json();
  check("restore rejects a traversal path", traversal.ok === false, JSON.stringify(traversal));
  const absTraversal = await (await post("/api/restore", { file: CONFIG })).json();
  check("restore rejects an absolute path", absTraversal.ok === false, JSON.stringify(absTraversal));

  const good = bk.backups[0].file;
  const beforeRestore = readConfigText();
  const restored = await (await post("/api/restore", { file: good })).json();
  check("restore accepts a listed backup", restored.ok === true, JSON.stringify(restored).slice(0, 200));
  check("restore snapshots the current config first", !!restored.preFile, restored.preFile);
  // Restoring must reinstate the snapshot byte for byte.
  check("restore reinstates the snapshot exactly", readConfigText() === beforeRestore,
    "restored text differs from the snapshot that was just taken");

  // Restoring must return the *text*, not a re-serialisation of the parsed
  // object: the latter silently drops every comment the snapshot preserved.
  // The config at this point is plain JSON, so seed a commented one first.
  const COMMENTED = '{\n  // restore must bring this line back\n  "$schema": "https://opencode.ai/config.json",\n  "provider": {\n    "keepme": {\n      "npm": "@ai-sdk/openai-compatible",\n      "options": { "baseURL": "https://keep.example/v1" },\n      "models": { "km": { "name": "KM" } }\n    }\n  },\n  "model": "keepme/km",\n}\n';
  writeFileSync(CONFIG, COMMENTED, "utf8");
  const bkCommented = await (await post("/api/backup", {})).json();
  check("a commented config can be snapshotted", !!bkCommented.file, JSON.stringify(bkCommented).slice(0, 200));

  await post("/api/apply", {
    provider: { name: "Temp Wipe", baseURL: "https://tmp.example/v1", apiFormat: "openai-chat", setAsDefault: false, models: [{ id: "t" }] },
    targets: ["opencode"],
  });
  check("the edit landed before the rollback", readConfigText().includes("tmp.example"), readConfigText().slice(0, 200));

  const reRestored = await (await post("/api/restore", { file: bkCommented.file.split(/[\\/]/).pop() })).json();
  check("restore after an edit succeeds", reRestored.ok === true, JSON.stringify(reRestored).slice(0, 200));
  check("restore rolls the edit back", !readConfigText().includes("tmp.example"), readConfigText().slice(0, 300));
  check("restore keeps comments", readConfigText().includes("restore must bring this line back"), readConfigText().slice(0, 300));
  check("restore reinstates the file byte for byte", readConfigText() === COMMENTED, JSON.stringify(readConfigText().slice(0, 120)));
  // A trailing comma is valid JSONC; the old JSON.parse-based check rejected the
  // whole snapshot as corrupt.
  check("a snapshot with a trailing comma is restorable", readConfigText().includes('"model": "keepme/km",'), readConfigText().slice(-120));

  // ---- path traversal in static serving ----
  for (const probe of ["/..%5c..%5cserver.mjs", "/..%2f..%2fserver.mjs", "/%2e%2e%5cserver.mjs"]) {
    const r = await fetch(BASE + probe, { headers: { Origin: BASE } });
    const body = await r.text();
    check(`static traversal blocked: ${probe}`, r.status !== 200 && !body.includes("createServer"), `${r.status} ${body.slice(0, 80)}`);
  }
  const okAsset = await fetch(`${BASE}/app.js`, { headers: { Origin: BASE } });
  check("legitimate asset still served", okAsset.status === 200, okAsset.status);
  const indexRes = await fetch(BASE + "/", { headers: { Origin: BASE } });
  check("index page still served", indexRes.status === 200, indexRes.status);

  // ---- CSRF / DNS-rebinding guards ----
  const foreign = await fetch(`${BASE}/api/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ provider: { name: "evil", baseURL: "https://evil/v1", models: [] } }),
  });
  check("POST with foreign Origin rejected", foreign.status === 403, foreign.status);
  const crossSite = await fetch(`${BASE}/api/backup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
    body: "{}",
  });
  check("POST with cross-site Sec-Fetch-Site rejected", crossSite.status === 403, crossSite.status);
  // fetch() forbids overriding Host, so drive this one through the raw client.
  const badHost = await rawRequest({ path: "/api/validate", headers: { Host: "evil.example" } });
  check("request with foreign Host rejected", badHost.status === 403, `${badHost.status} ${badHost.body.slice(0, 120)}`);
  const goodHost = await rawRequest({ path: "/api/validate", headers: { Host: `localhost:${PORT}` } });
  check("request with localhost Host accepted", goodHost.status === 200, goodHost.status);

  // ---- body size limit ----
  const huge = await fetch(`${BASE}/api/apply`, {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ provider: { name: "x", baseURL: "y", note: "A".repeat(2 * 1024 * 1024), models: [] } }),
  }).catch((e) => ({ status: "connection reset: " + e.message }));
  check("oversized body rejected", huge.status !== 200, huge.status);

  // ---- model discovery must not crash on odd payloads ----
  const disc = await (await post("/api/discover", { provider: { baseURL: "http://127.0.0.1:1/v1", apiKey: "" } })).json();
  check("discover fails gracefully on a dead endpoint", disc.ok === true && disc.result?.ok === false, JSON.stringify(disc).slice(0, 200));

  // ---- env var checking ----
  // The check that decides whether a provider will authenticate at all. Writing
  // {env:FOO} while FOO is unset yields an empty bearer token and a 401 that
  // looks like a bad key, so both answers have to be right.
  const envSet = await (await post("/api/envcheck", { name: "PS_VERIFY_KEY_SET" })).json();
  check("/api/envcheck finds a variable the server has",
    envSet.ok === true && envSet.set === true, JSON.stringify(envSet));
  check("/api/envcheck reports the length", envSet.length === "sk-verify-value".length, JSON.stringify(envSet));
  check("/api/envcheck attributes it to the process scope",
    envSet.scope === "process", JSON.stringify(envSet));
  // The value itself must never cross the wire, or the API becomes a way to
  // read secrets out of the server's environment.
  check("/api/envcheck never returns the value",
    !JSON.stringify(envSet).includes("sk-verify-value"), JSON.stringify(envSet));

  const envAbsent = await (await post("/api/envcheck", { name: "PS_VERIFY_KEY_ABSENT" })).json();
  check("/api/envcheck reports a missing variable as unset",
    envAbsent.ok === true && envAbsent.set === false, JSON.stringify(envAbsent));
  check("/api/envcheck explains how to set it",
    /setx|export/.test(envAbsent.note || ""), JSON.stringify(envAbsent));

  const envBad = await (await post("/api/envcheck", { name: "not a valid name" })).json();
  check("/api/envcheck rejects an invalid name", envBad.ok === false, JSON.stringify(envBad));

  // ---- probes resolve env references the way opencode does ----
  // A provider imported from the config carries {env:VAR}, not a literal key.
  // Probing with the reference verbatim, or with an empty string, produced a
  // 401 that read as "your key is wrong" instead of "your variable is missing".
  const testMissingEnv = await (await post("/api/test", {
    provider: { baseURL: "https://example.invalid/v1", apiFormat: "openai-chat", useEnvVar: true, envVarName: "PS_VERIFY_KEY_ABSENT" },
  })).json();
  check("/api/test refuses to probe when the referenced variable is missing",
    testMissingEnv.result?.ok === false && /PS_VERIFY_KEY_ABSENT/.test(testMissingEnv.result?.message || ""),
    JSON.stringify(testMissingEnv).slice(0, 300));
  check("/api/test names the 401 cause rather than blaming the key",
    /401/.test(testMissingEnv.result?.message || ""), JSON.stringify(testMissingEnv).slice(0, 300));

  const discMissingEnv = await (await post("/api/discover", {
    provider: { baseURL: "https://example.invalid/v1", apiFormat: "openai-chat", useEnvVar: true, envVarName: "PS_VERIFY_KEY_ABSENT" },
  })).json();
  check("/api/discover refuses to probe when the referenced variable is missing",
    discMissingEnv.result?.ok === false && /PS_VERIFY_KEY_ABSENT/.test(discMissingEnv.result?.message || ""),
    JSON.stringify(discMissingEnv).slice(0, 300));

  // With the variable present the probe proceeds and fails on the network
  // instead — proving the block above is about the variable, not the URL.
  const testResolved = await (await post("/api/test", {
    provider: { baseURL: "http://127.0.0.1:1/v1", apiFormat: "openai-chat", useEnvVar: true, envVarName: "PS_VERIFY_KEY_SET" },
  })).json();
  check("/api/test proceeds once the variable resolves",
    testResolved.result?.ok === false && !/PS_VERIFY_KEY_SET/.test(testResolved.result?.message || ""),
    JSON.stringify(testResolved).slice(0, 300));

  // ---- what the probes actually put on the wire ----
  // A local stub records the request, so these assert the bytes sent rather
  // than trusting the message the endpoint reports back.
  const seen = [];
  const stub = http.createServer((rq, rs) => {
    seen.push({ url: rq.url, headers: rq.headers });
    rs.writeHead(200, { "Content-Type": "application/json" });
    rs.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const stubURL = `http://127.0.0.1:${stub.address().port}/v1`;
  try {
    // The regression: /api/discover dropped apiFormat, so an anthropic provider
    // was probed with `Authorization: Bearer`. Anthropic endpoints ignore that
    // header and answer 401, which looked like a rejected key.
    seen.length = 0;
    const anth = await (await post("/api/discover", {
      provider: { baseURL: stubURL, apiKey: "sk-anthropic", apiFormat: "anthropic-messages" },
    })).json();
    check("discover reaches the stub", anth.result?.ok === true, JSON.stringify(anth).slice(0, 200));
    check("discover honours the anthropic format",
      seen[0]?.headers["x-api-key"] === "sk-anthropic", JSON.stringify(seen[0]?.headers));
    check("discover sends the anthropic version header",
      seen[0]?.headers["anthropic-version"] === "2023-06-01", JSON.stringify(seen[0]?.headers));
    check("discover sends no Bearer for anthropic",
      seen[0]?.headers.authorization === undefined, JSON.stringify(seen[0]?.headers));

    seen.length = 0;
    await post("/api/discover", { provider: { baseURL: stubURL, apiKey: "sk-openai", apiFormat: "openai-chat" } });
    check("discover uses Bearer for openai-compatible",
      seen[0]?.headers.authorization === "Bearer sk-openai", JSON.stringify(seen[0]?.headers));

    // In $ENV mode the typed key is discarded on write, so the probe has to use
    // the variable — otherwise it validates a configuration nobody will run.
    seen.length = 0;
    await post("/api/discover", {
      provider: { baseURL: stubURL, apiKey: "typed-key-that-is-discarded", apiFormat: "openai-chat", useEnvVar: true, envVarName: "PS_VERIFY_KEY_SET" },
    });
    check("in $ENV mode the probe sends the variable, not the typed key",
      seen[0]?.headers.authorization === "Bearer sk-verify-value", JSON.stringify(seen[0]?.headers));

    // An imported provider arrives with the reference in the key field itself.
    seen.length = 0;
    await post("/api/test", { provider: { baseURL: stubURL, apiKey: "{env:PS_VERIFY_KEY_SET}", apiFormat: "openai-chat" } });
    check("/api/test resolves an {env:VAR} left in the key field",
      seen[0]?.headers.authorization === "Bearer sk-verify-value", JSON.stringify(seen[0]?.headers));
  } finally {
    await new Promise((r) => stub.close(r));
  }

  const { parseModels } = await import("./src/rescue.mjs");
  const parsed = parseModels({ data: [
    { id: "m-null-limit", limit: null },
    { id: "m-nested", limit: { context: 128000, output: 4096 } },
    { id: "models/gemini-2.0-flash", context_length: 1000000 },
    "bare-string-model",
  ] });
  check("parseModels survives limit:null", parsed.length === 4, JSON.stringify(parsed.map((m) => m.id)));
  check("parseModels reads nested limit", parsed.find((m) => m.id === "m-nested")?.contextWindow === 128000,
    JSON.stringify(parsed.find((m) => m.id === "m-nested")));
  check("parseModels strips the models/ prefix", parsed.some((m) => m.id === "gemini-2.0-flash"), JSON.stringify(parsed.map((m) => m.id)));

  // ---- diagnostics ----
  const diag = await (await get("/api/diagnostics")).json();
  check("/api/diagnostics responds", diag.ok === true && Array.isArray(diag.providers), JSON.stringify(diag).slice(0, 200));

  // ---- delete ----
  const del = await (await post("/api/delete", { name: "BAI Test" })).json();
  check("/api/delete removes the provider", del.ok === true && !(del.providers || []).some((p) => p.name === "BAI Test"),
    JSON.stringify((del.providers || []).map((p) => p.name)));

  // ----------------------------------------------- setenv guards over HTTP
  // The endpoint writes a real persistent variable, so only its refusals are
  // exercised here; the successful write is covered in verify-env.mjs where the
  // cleanup is guaranteed.
  {
    const bad = await (await post("/api/setenv", { name: "bad-name", value: "v" })).json();
    check("/api/setenv refuses an invalid name", bad.ok === false && /имя/i.test(bad.error || ""), JSON.stringify(bad));
    const empty = await (await post("/api/setenv", { name: "PS_HTTP_SETENV_TMP", value: "" })).json();
    check("/api/setenv refuses an empty value", empty.ok === false, JSON.stringify(empty));
    const long = await (await post("/api/setenv", { name: "PS_HTTP_SETENV_TMP", value: "x".repeat(2000) })).json();
    check("/api/setenv refuses an over-long value", long.ok === false, JSON.stringify(long));
    // Whatever happens, the value must never come back out of the server.
    check("/api/setenv never echoes the value",
      !JSON.stringify([bad, empty, long]).includes("xxxxx"));
  }

  // -------------------------------------------------- the live-fire request
  // A local stub stands in for the provider, so this asserts the actual bytes
  // of the completion request rather than mocking the layer under test.
  {
    let seen = null;
    const chatStub = http.createServer((rq, rs) => {
      let raw = "";
      rq.on("data", (d) => { raw += d; });
      rq.on("end", () => {
        seen = { url: rq.url, method: rq.method, auth: rq.headers.authorization || "", xkey: rq.headers["x-api-key"] || "", body: raw };
        if (/no-such-model/.test(raw)) {
          rs.writeHead(404, { "content-type": "application/json" });
          rs.end(JSON.stringify({ error: { message: "The model does not exist" } }));
          return;
        }
        // Live case: 400 "credit insufficient balance: balance=0 required=2404".
        // The request was well-formed; the account had no money.
        if (/broke-model/.test(raw)) {
          rs.writeHead(400, { "content-type": "application/json" });
          rs.end(JSON.stringify({ error: { message: "credit insufficient balance: balance=0 required=2404" } }));
          return;
        }
        // Google answers 400 "Please pass a valid API key" rather than 401.
        if (/googlish-model/.test(raw)) {
          rs.writeHead(400, { "content-type": "application/json" });
          rs.end(JSON.stringify({ error: { code: 400, message: "Please pass a valid API key", status: "INVALID_ARGUMENT" } }));
          return;
        }
        if (/malformed-model/.test(raw)) {
          rs.writeHead(400, { "content-type": "application/json" });
          rs.end(JSON.stringify({ error: { message: "unsupported parameter: top_k" } }));
          return;
        }
        if (/quota-model/.test(raw)) {
          rs.writeHead(429, { "content-type": "application/json" });
          rs.end(JSON.stringify({ error: { message: "Rate limit reached" } }));
          return;
        }
        // A real gateway (gorouter) refuses max_tokens <= 2. When the probe
        // asked for 1, the tool reported the model as broken over a limit it
        // had chosen itself, so hold the probe to that minimum here.
        try {
          const mt = JSON.parse(raw).max_tokens;
          if (typeof mt === "number" && mt <= 2) {
            rs.writeHead(400, { "content-type": "application/json" });
            rs.end(JSON.stringify({ error: { message: "max_tokens must be greater than 2" } }));
            return;
          }
        } catch { /* body assertions below will catch malformed JSON */ }
        // Refuse anything unauthenticated, so the "no key sent" path is driven
        // by a real 401 rather than by a special-cased model name.
        if (!rq.headers.authorization && !rq.headers["x-api-key"]) {
          rs.writeHead(401, { "content-type": "application/json" });
          rs.end(JSON.stringify({ error: { message: "Missing credentials" } }));
          return;
        }
        if (/bad-key-model/.test(raw)) {
          rs.writeHead(401, { "content-type": "application/json" });
          rs.end(JSON.stringify({ error: { message: "Invalid API key" } }));
          return;
        }
        // Measured live: the same key and model answered 200 five times out of
        // six and returned an empty-bodied 403 once. That is a transient block,
        // not a verdict on the key.
        if (/flaky-model/.test(raw)) {
          rs.writeHead(403);
          rs.end();
          return;
        }
        // Seen live: a gateway refuses a premium model with 403 while the same
        // key works elsewhere. That is the plan, not the credential.
        if (/premium-model/.test(raw)) {
          rs.writeHead(403, { "content-type": "application/json" });
          rs.end(JSON.stringify({ error: { message: "Access restricted. Deposit required to unlock premium models." } }));
          return;
        }
        // A 403 that really is about the credential must keep saying so.
        if (/revoked-model/.test(raw)) {
          rs.writeHead(403, { "content-type": "application/json" });
          rs.end(JSON.stringify({ error: { message: "API key revoked" } }));
          return;
        }
        // Responses API lives on its own path with its own body. A
        // responses-only endpoint 404s /chat/completions, which used to read
        // as a dead model rather than a wrong path.
        if (seen.url === "/v1/responses") {
          rs.writeHead(200, { "content-type": "application/json" });
          rs.end(JSON.stringify({ output: [{ content: [{ text: "pong" }] }] }));
          return;
        }
        rs.writeHead(200, { "content-type": "application/json" });
        rs.end(JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
      });
    });
    await new Promise((r) => chatStub.listen(0, "127.0.0.1", r));
    const chatURL = `http://127.0.0.1:${chatStub.address().port}/v1`;

    const good = await (await post("/api/testchat", {
      provider: { baseURL: chatURL, apiKey: "sk-chat", apiFormat: "openai-chat" },
      modelId: "good-model",
    })).json();
    check("a live-fire request that succeeds is reported as working",
      good.result?.ok === true, JSON.stringify(good).slice(0, 200));
    check("it POSTs to /chat/completions", seen?.method === "POST" && seen.url === "/v1/chat/completions",
      `${seen?.method} ${seen?.url}`);
    check("it sends the bearer token", seen?.auth === "Bearer sk-chat", seen?.auth);
    // The probe must stay cheap, but "cheapest possible" was too cheap: some
    // gateways reject max_tokens <= 2, and the tool then reported a working
    // model as broken. Assert a window instead of an exact value.
    {
      const mt = JSON.parse(seen?.body || "{}").max_tokens;
      check("the probe asks for more tokens than gateways reject", mt > 2, String(mt));
      check("the probe stays cheap", mt <= 32, String(mt));
    }
    check("it names the model under test", /"model":"good-model"/.test(seen?.body || ""), seen?.body);

    // The version segment does not have to be the last part of the base URL.
    // Google's OpenAI-compatible root is `/v1beta/openai`, and the old rule
    // only looked for a version at the end, so it appended another `/v1` and
    // posted to `/v1beta/openai/v1/chat/completions`. Both URLs answer 400 for
    // a missing key, which is why this stayed hidden until a real key was used.
    for (const [base, want] of [
      ["/v1beta/openai", "/v1beta/openai/chat/completions"],
      ["/v1beta", "/v1beta/chat/completions"],
      ["/v1", "/v1/chat/completions"],
      ["", "/v1/chat/completions"],
      ["/openai", "/openai/v1/chat/completions"],
    ]) {
      seen = null;
      await (await post("/api/testchat", {
        provider: { baseURL: `http://127.0.0.1:${chatStub.address().port}${base}`, apiKey: "sk-chat", apiFormat: "openai-chat" },
        modelId: "good-model",
      })).json();
      check(`base "${base || "(none)"}" posts to ${want}`, seen?.url === want, seen?.url);
    }

    const missing = await (await post("/api/testchat", {
      provider: { baseURL: chatURL, apiKey: "sk-chat", apiFormat: "openai-chat" },
      modelId: "no-such-model",
    })).json();
    // The distinction the whole change is about: the server is up, the model is
    // the problem, and the provider's own words explain why.
    check("a 404 is blamed on the model, not the server",
      missing.result?.ok === false && missing.result?.fault === "model" && missing.result?.reach === "up",
      JSON.stringify(missing.result));
    check("the provider's error text is surfaced",
      /does not exist/.test(missing.result?.message || ""), missing.result?.message);

    const quota = await (await post("/api/testchat", {
      provider: { baseURL: chatURL, apiKey: "sk-chat", apiFormat: "openai-chat" },
      modelId: "quota-model",
    })).json();
    check("a 429 is reported as a quota problem", quota.result?.fault === "quota", JSON.stringify(quota.result));

    const anth = await (await post("/api/testchat", {
      provider: { baseURL: chatURL, apiKey: "sk-anth", apiFormat: "anthropic-messages" },
      modelId: "claude-x",
    })).json();
    check("the anthropic format posts to /messages with x-api-key",
      anth.result?.ok === true && seen?.url === "/v1/messages" && seen?.xkey === "sk-anth",
      `${seen?.url} xkey=${seen?.xkey}`);

    const resp = await (await post("/api/testchat", {
      provider: { baseURL: chatURL, apiKey: "sk-chat", apiFormat: "openai-responses" },
      modelId: "good-model",
    })).json();
    check("the responses format posts to /responses",
      resp.result?.ok === true && seen?.url === "/v1/responses",
      `${seen?.url} ${JSON.stringify(resp.result)}`);
    {
      const b = JSON.parse(seen?.body || "{}");
      check("the responses probe uses the responses body shape",
        b.input === "ping" && b.max_output_tokens > 2 && b.max_output_tokens <= 32 && b.messages === undefined,
        seen?.body);
    }

    // An unresolvable {env:VAR} must be named as such instead of producing a
    // generic auth failure.
    const noEnv = await (await post("/api/testchat", {
      provider: { baseURL: chatURL, apiKey: "{env:PS_VERIFY_KEY_ABSENT}", apiFormat: "openai-chat" },
      modelId: "good-model",
    })).json();
    check("a missing env var blocks the live-fire request",
      noEnv.result?.ok === false && /PS_VERIFY_KEY_ABSENT/.test(noEnv.result?.message || ""),
      JSON.stringify(noEnv.result));

    // A 401 has two different causes and they need two different faults: the
    // UI showed "ключ не принят" over a provider that never sent one, blaming a
    // credential that does not exist.
    const noKey = await (await post("/api/testchat", {
      provider: { baseURL: chatURL, apiKey: "", apiFormat: "openai-chat" },
      modelId: "good-model",
    })).json();
    check("a 401 with no key sent is reported as a missing key, not a rejected one",
      noKey.result?.fault === "nokey", JSON.stringify(noKey.result));
    check("the missing-key message tells the user to fill the key in",
      /не отправлен/.test(noKey.result?.message || ""), noKey.result?.message);

    // A plan limit is not a bad key. Sending the user off to re-enter a working
    // credential is the wrong instruction, and in a bulk run this verdict also
    // decides whether the remaining models get checked at all.
    const premium = await (await post("/api/testchat", {
      provider: { baseURL: chatURL, apiKey: "sk-chat", apiFormat: "openai-chat" },
      modelId: "premium-model",
    })).json();
    check("a 403 about payment is blamed on the plan, not the key",
      premium.result?.fault === "plan", JSON.stringify(premium.result));
    check("the plan message says the key is fine",
      /ключ рабочий/.test(premium.result?.message || ""), premium.result?.message);
    check("the provider's own wording is kept",
      /Deposit required/.test(premium.result?.message || ""), premium.result?.message);

    // An empty wallet arrives as a 400. Blaming the model sends the user to
    // delete an entry that would work the moment the account is topped up.
    const broke = await (await post("/api/testchat", {
      provider: { baseURL: chatURL, apiKey: "sk-chat", apiFormat: "openai-chat" },
      modelId: "broke-model",
    })).json();
    check("a 400 about balance is blamed on the account, not the model",
      broke.result?.fault === "plan", JSON.stringify(broke.result));

    // A 400 can also mean "bad key" — Google says so in the body instead of
    // using 401. Blaming the model sends the user to fix the wrong thing.
    const googlish = await (await post("/api/testchat", {
      provider: { baseURL: chatURL, apiKey: "sk-chat", apiFormat: "openai-chat" },
      modelId: "googlish-model",
    })).json();
    check("a 400 that says the key is invalid is blamed on the key",
      googlish.result?.fault === "key", JSON.stringify(googlish.result));

    // A genuinely malformed request must still be reported against the model.
    const malformed = await (await post("/api/testchat", {
      provider: { baseURL: chatURL, apiKey: "sk-chat", apiFormat: "openai-chat" },
      modelId: "malformed-model",
    })).json();
    check("an ordinary 400 is still blamed on the model",
      malformed.result?.fault === "model", JSON.stringify(malformed.result));

    // An empty 403 must not be read as a rejected key: the key demonstrably
    // works, and a wrong one produces a 401 with an error body instead.
    const flaky = await (await post("/api/testchat", {
      provider: { baseURL: chatURL, apiKey: "sk-chat", apiFormat: "openai-chat" },
      modelId: "flaky-model",
    })).json();
    check("an empty 403 is reported as a temporary block, not a bad key",
      flaky.result?.fault === "blocked", JSON.stringify(flaky.result));
    check("the empty 403 is marked as worth retrying",
      flaky.result?.transient === true, JSON.stringify(flaky.result));
    check("the message says it is not about the key",
      /не на проблему с ключом/.test(flaky.result?.message || ""), flaky.result?.message);

    const revoked = await (await post("/api/testchat", {
      provider: { baseURL: chatURL, apiKey: "sk-chat", apiFormat: "openai-chat" },
      modelId: "revoked-model",
    })).json();
    check("a 403 about the credential is still blamed on the key",
      revoked.result?.fault === "key", JSON.stringify(revoked.result));

    const badKey = await (await post("/api/testchat", {
      provider: { baseURL: chatURL, apiKey: "sk-wrong", apiFormat: "openai-chat" },
      modelId: "bad-key-model",
    })).json();
    check("a 401 with a key actually sent is reported as a rejected key",
      badKey.result?.fault === "key", JSON.stringify(badKey.result));

    const noModel = await (await post("/api/testchat", {
      provider: { baseURL: chatURL, apiKey: "sk-chat", apiFormat: "openai-chat" }, modelId: "",
    })).json();
    check("a live-fire request without a model is refused",
      noModel.result?.ok === false && /модел/i.test(noModel.result?.message || ""), JSON.stringify(noModel.result));

    await new Promise((r) => chatStub.close(r));
  }

  // ------------------------------------------- repointing the default model
  // The fix for "opencode won't start because `model` names a dead provider".
  // It must touch exactly one line and leave provider blocks and comments alone.
  {
    // Earlier tests have rewritten the fixture, so this block lays down its own
    // config rather than depending on their leftovers.
    writeFileSync(CONFIG, `{
  // default-model comment that must survive
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "dead": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Dead",
      "options": { "baseURL": "https://dead.invalid/v1" },
      "models": { "dead-model": { "name": "Dead Model" } }
    },
    "alive": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Alive",
      "options": { "baseURL": "https://alive.example/v1" },
      "models": { "alive-model": { "name": "Alive Model" } }
    }
  },
  "model": "dead/dead-model"
}
`, "utf8");

    const before = readConfigFile();
    const beforeText = readConfigText();
    check("the block's own fixture starts on dead/dead-model", before.model === "dead/dead-model", String(before.model));

    const bad = await (await post("/api/set-default-model", { model: "dead-model" })).json();
    check("a model without a slash is refused", bad.ok === false && /provider\/model/.test(bad.error || ""),
      JSON.stringify(bad));
    const ghost = await (await post("/api/set-default-model", { model: "nosuch/model" })).json();
    check("a model on an unknown provider is refused", ghost.ok === false && /nosuch/.test(ghost.error || ""),
      JSON.stringify(ghost));
    const same = await (await post("/api/set-default-model", { model: "dead/dead-model" })).json();
    check("setting the current default is reported as a no-op", same.ok === false && same.noop === true,
      JSON.stringify(same));
    // An unlisted model is allowed through, because a provider may serve models
    // it does not enumerate; refusing would block a legitimate fix.
    const unlistedPlan = await (await post("/api/set-default-model", { model: "alive/not-listed" })).json();
    check("an unlisted model is accepted but flagged",
      unlistedPlan.ok === true && unlistedPlan.unlisted === true, JSON.stringify(unlistedPlan).slice(0, 160));
    writeFileSync(CONFIG, beforeText, "utf8"); // undo that write
    check("the refusals themselves wrote nothing", readConfigText() === beforeText);

    const stale = await (await post("/api/set-default-model", { model: "alive/alive-model", hash: "deadbeef" })).json();
    check("a stale hash blocks the default-model write", stale.ok === false && stale.conflict === true,
      JSON.stringify(stale));
    check("the file is untouched after a refused write", readConfigText() === beforeText);

    const target = "alive/alive-model";
    const okHash = (await (await get("/api/state")).json()).opencode?.hash;
    const moved = await (await post("/api/set-default-model", { model: target, hash: okHash })).json();
    const after = readConfigFile();
    check("the default model is repointed", moved.ok === true && after.model === target,
      `${JSON.stringify(moved).slice(0, 140)} model=${after.model}`);
    check("the previous default is reported back", moved.previousModel === "dead/dead-model", String(moved.previousModel));
    check("the abandoned provider block is left intact",
      Boolean(after.provider?.dead?.models?.["dead-model"]), JSON.stringify(after.provider?.dead || null));
    check("comments survive the default-model change",
      readConfigText().includes("default-model comment that must survive"));
    check("a backup precedes the default-model write", Array.isArray(moved.backups) && moved.backups.length > 0);
    // One line changed, nothing else: the whole point of not reusing the
    // provider-upsert path for this.
    const changedLines = readConfigText().split("\n")
      .filter((l, i) => l !== beforeText.split("\n")[i]).length;
    check("only the model line changed", changedLines === 1, `${changedLines} lines differ`);

    const diag = await (await get("/api/diagnostics")).json();
    const dp = (diag.providers || []).find((p) => p.key === "alive");
    check("diagnostics marks the new default", dp?.isDefault === true, JSON.stringify(dp || null));
    // The UI builds its "switch to" list from this field.
    check("diagnostics reports each provider's models", Array.isArray(dp?.models) && dp.models.includes("alive-model"),
      JSON.stringify(dp?.models || null));
    // A provider whose endpoint lives inside its npm package has nothing to
    // probe. Reporting it as unreachable is a false alarm about a provider that
    // works — the same class of bug the reach/fault split exists to kill.
    writeFileSync(CONFIG, readConfigText().replace(
      '"provider": {',
      '"provider": {\n    "packaged": { "npm": "@ai-sdk/anthropic", "name": "Packaged", "models": { "m": {} } },',
    ), "utf8");
    const withPackaged = await (await get("/api/diagnostics")).json();
    const pk = (withPackaged.providers || []).find((p) => p.key === "packaged");
    check("a provider without a baseURL is not called unreachable",
      pk?.reach === "unknown" && pk?.fault === null, JSON.stringify(pk || null));
    check("and it is not probed over the network",
      /Base URL/.test(pk?.conn || "") && !/таймаут|недоступ/.test(pk?.conn || ""), pk?.conn);

    check("diagnostics separates reachability from auth",
      (diag.providers || []).every((p) => "reach" in p && "fault" in p),
      JSON.stringify((diag.providers || []).map((p) => [p.key, p.reach, p.fault])));
    check("diagnostics carries the smart audit",
      diag.smart && typeof diag.smart.score === "number" && Array.isArray(diag.smart.findings),
      JSON.stringify(diag.smart || null).slice(0, 160));

    // ---- undo reverts the last write, then has nothing left ----
    // The fixture at this point: dead/alive/packaged providers, default on
    // alive/alive-model, and a last-write record from the repoint above.
    const undoState = await (await get("/api/state")).json();
    check("state advertises the last write for undo",
      !!undoState.undo && typeof undoState.undo.label === "string",
      JSON.stringify(undoState.undo || null));
    const moveBack = await (await post("/api/set-default-model", { model: "dead/dead-model" })).json();
    check("repoint for the undo test succeeds",
      moveBack.ok === true && readConfigFile().model === "dead/dead-model",
      `${JSON.stringify(moveBack).slice(0, 140)} model=${readConfigFile().model}`);
    const undone = await (await post("/api/undo", {})).json();
    check("undo succeeds", undone.ok === true, JSON.stringify(undone).slice(0, 200));
    check("undo restores the previous default",
      readConfigFile().model === "alive/alive-model", readConfigFile().model);
    check("undo snapshots before reverting",
      !!undone.preFile, JSON.stringify(undone).slice(0, 200));
    check("undo hands back the new hash", typeof undone.hash === "string" && undone.hash.length === 64, undone.hash);
    const undoneAgain = await (await post("/api/undo", {})).json();
    check("a second undo reports nothing to revert", undoneAgain.ok === false, JSON.stringify(undoneAgain).slice(0, 160));
    const undoEmpty = await (await get("/api/state")).json();
    check("state stops advertising undo once spent", !undoEmpty.undo, JSON.stringify(undoEmpty.undo || null));
  }

  // ---- refresh-models: preview with free flags, whitelist apply, prune ----
  // A local stub stands in for the gateway so the bytes of /models are fixed.
  {
    const modelStub = http.createServer((rq, rs) => {
      rs.writeHead(200, { "Content-Type": "application/json" });
      rs.end(JSON.stringify({ data: [
        { id: "stub-free", pricing: { prompt: "0", completion: "0" } },
        { id: "stub-paid", pricing: { prompt: "0.0000025", completion: "0.00001" } },
      ] }));
    });
    await new Promise((r) => modelStub.listen(0, "127.0.0.1", r));
    const modelsURL = `http://127.0.0.1:${modelStub.address().port}/v1`;
    try {
      const mk = await (await post("/api/apply", {
        provider: { name: "Refreshable", baseURL: modelsURL, apiFormat: "openai-chat", setAsDefault: false, models: [{ id: "seed-model" }] },
        targets: ["opencode"],
      })).json();
      check("refresh fixture provider applies",
        mk.results?.opencode?.ok === true, JSON.stringify(mk).slice(0, 200));

      const prev = await (await post("/api/refresh-models", { providers: ["refreshable"] })).json();
      check("refresh preview succeeds", prev.ok === true, JSON.stringify(prev).slice(0, 200));
      const rp = (prev.providers || []).find((p) => p.key === "refreshable");
      const addedBy = Object.fromEntries((rp?.added || []).map((a) => [a.id, a.free]));
      check("refresh finds both stub models with correct free flags",
        addedBy["stub-free"] === true && addedBy["stub-paid"] === false, JSON.stringify(rp?.added));
      check("the seed model shows up as removed",
        (rp?.removed || []).includes("seed-model"), JSON.stringify(rp?.removed));

      // Object form: ids apply inside their own provider only.
      const onlyFree = await (await post("/api/refresh-models", {
        providers: ["refreshable"], apply: true, models: { refreshable: ["stub-free"] }, hash: prev.hash,
      })).json();
      check("whitelisted apply succeeds", onlyFree.ok === true, JSON.stringify(onlyFree).slice(0, 200));
      const cfgAfterFree = readConfigFile();
      check("only the whitelisted model is added",
        !!cfgAfterFree.provider?.refreshable?.models?.["stub-free"] &&
        !cfgAfterFree.provider?.refreshable?.models?.["stub-paid"],
        Object.keys(cfgAfterFree.provider?.refreshable?.models || {}));
      check("a free model records its zero cost",
        cfgAfterFree.provider?.refreshable?.models?.["stub-free"]?.cost?.input === 0 &&
        cfgAfterFree.provider?.refreshable?.models?.["stub-free"]?.cost?.output === 0,
        JSON.stringify(cfgAfterFree.provider?.refreshable?.models?.["stub-free"]?.cost));

      const prev2 = await (await post("/api/refresh-models", { providers: ["refreshable"] })).json();
      const rp2 = (prev2.providers || []).find((p) => p.key === "refreshable");
      check("an added model is no longer pending",
        (rp2?.added || []).map((a) => a.id).join(",") === "stub-paid",
        JSON.stringify(rp2?.added));

      const pruned = await (await post("/api/refresh-models", {
        providers: ["refreshable"], apply: true, prune: true, hash: prev2.hash,
      })).json();
      check("prune apply succeeds", pruned.ok === true, JSON.stringify(pruned).slice(0, 200));
      const keys = Object.keys(readConfigFile().provider?.refreshable?.models || {}).sort();
      check("prune adds the rest and drops the ghost",
        JSON.stringify(keys) === JSON.stringify(["stub-free", "stub-paid"]), keys);
    } finally {
      await new Promise((r) => modelStub.close(r));
    }
  }

  // ---- configPath scoping: a foreign path is ignored, never honoured ----
  {
    const FOREIGN = join(work, "foreign.json");
    writeFileSync(FOREIGN, '{"provider":{}}', "utf8");
    const enc = encodeURIComponent(FOREIGN);
    const scoped = await (await get("/api/state?configPath=" + enc)).json();
    check("a foreign configPath falls back to the active config",
      scoped.opencode?.path === CONFIG, scoped.opencode?.path);
    const vscoped = await (await get("/api/validate?configPath=" + enc)).json();
    check("validate ignores a foreign configPath too",
      vscoped.ok === true && vscoped.path === CONFIG, vscoped.path);
    const bk = await (await post("/api/backup", { configPath: FOREIGN })).json();
    check("backup ignores a foreign configPath", bk.ok === true && !!bk.file,
      JSON.stringify(bk).slice(0, 160));
    const blist = await (await get("/api/validate")).json();
    const latest = (blist.backups || [])[0] || {};
    check("backups record their origin config",
      latest.origin === CONFIG, JSON.stringify(latest).slice(0, 200));
    // The backup belongs to CONFIG even though the request names FOREIGN:
    // restoring must follow the origin, not the request.
    const re = await (await post("/api/restore", { file: latest.file, configPath: FOREIGN })).json();
    check("restore follows the backup origin, not the requested file",
      re.ok === true && re.path === CONFIG, JSON.stringify(re).slice(0, 200));
  }

  // ---- undo refuses when the file moved on since the reverted write ----
  {
    const st2 = await (await get("/api/state")).json();
    const ap = await (await post("/api/apply", {
      provider: { name: "Undo Guard", baseURL: "https://guard.example/v1", apiFormat: "openai-chat", setAsDefault: false, models: [{ id: "g" }] },
      targets: ["opencode"], hash: st2.opencode?.hash,
    })).json();
    check("undo-guard fixture applies", ap.results?.opencode?.ok === true,
      JSON.stringify(ap).slice(0, 200));
    writeFileSync(CONFIG, readConfigText().replace("undo-guard", "undo-guard-external"), "utf8");
    const refused = await (await post("/api/undo", {})).json();
    check("undo refuses after an external edit", refused.ok === false,
      JSON.stringify(refused).slice(0, 200));
    check("the external edit survives the refused undo",
      readConfigText().includes("undo-guard-external"), readConfigText().slice(-300));
  }

  // ---- a cyrillic name gets a transliterated key, not a "provider" pile-up ----
  {
    const cy = await (await post("/api/apply", {
      provider: { name: "БайТест", baseURL: "https://cyr.example/v1", apiFormat: "openai-chat", setAsDefault: false, models: [{ id: "m" }] },
      targets: ["opencode"],
    })).json();
    check("a cyrillic name applies under a transliterated key",
      cy.results?.opencode?.ok === true && readConfigFile().provider?.["baytest"]?.name === "БайТест",
      Object.keys(readConfigFile().provider || {}));
  }
} finally {
  child.kill();
  rmSync(work, { recursive: true, force: true });
}

const pad = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(pad)}${r.ok ? "" : "  <- " + r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exitCode = 1;
