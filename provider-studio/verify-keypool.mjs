// Пул API-ключей: парсинг, ротация, развёртка в шарды и плагин.
// Без сети: живость ключей проверяют ручные пробы через UI (/api/pool-check).
import { readFileSync, existsSync } from "node:fs";
import * as K from "./src/keypool.mjs";

let pass = 0; const fails = [];
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name); }
  else { fails.push(name + (extra ? `  <- ${extra}` : "")); console.log("FAIL ", name, extra ? ` <- ${extra}` : ""); }
};
const eq = (name, got, want) => check(name, Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ---------------------------------------------------------------- parsing
{
  const p = K.parseKeyPool("sk-a\nsk-b\r\n  \nsk-a\n");
  eq("pool lines split and trimmed", p.keys, ["sk-a", "sk-b"]);
  eq("duplicates dropped", p.droppedDuplicates, 1);
  eq("empty lines counted", p.emptyLines, 2);
  eq("no truncation", p.truncated, 0);
}
{
  const many = Array.from({ length: K.MAX_POOL_KEYS + 5 }, (_, i) => `sk-${i}`).join("\n");
  const p = K.parseKeyPool(many);
  eq("pool capped at MAX_POOL_KEYS", p.keys.length, K.MAX_POOL_KEYS);
  eq("truncation reported", p.truncated, 5);
}
eq("short key masked fully", K.maskKey("abc"), "••••");
eq("long key shows only tail", K.maskKey("sk-abcdefgh"), "••••efgh");

// ------------------------------------------------------------- env naming
eq("single key keeps base name", K.poolEnvNames("X_API_KEY", 1), ["X_API_KEY"]);
eq("pool suffixes from the second key", K.poolEnvNames("X_API_KEY", 3), ["X_API_KEY", "X_API_KEY_2", "X_API_KEY_3"]);
check("empty pool rejected", K.validateKeyPool([]) !== "");
check("oversized pool rejected", K.validateKeyPool(Array.from({ length: K.MAX_POOL_KEYS + 1 }, (_, i) => `sk-long-key-${i}`)) !== "");
check("short key rejected", K.validateKeyPool(["x"]) !== "");
eq("good pool passes", K.validateKeyPool(["sk-long-key-1", "sk-long-key-2"]), "");

// ------------------------------------------------------- rotation policy
eq("success never rotates", K.shouldRotate({ ok: true }).rotate, false);
eq("bad model id never rotates", K.shouldRotate({ ok: false, fault: "model", status: 404 }).rotate, false);
eq("missing credential never rotates", K.shouldRotate({ ok: false, fault: "nokey", status: 401 }).rotate, false);
eq("proxy failure never rotates", K.shouldRotate({ ok: false, fault: "proxy" }).rotate, false);
// A region-blocked model answers the same way for every key from this country,
// so rotating burns requests without changing the outcome.
eq("a region block never rotates", K.shouldRotate({ ok: false, fault: "region", status: 403 }).rotate, false);
eq("429 rotates", K.shouldRotate({ ok: false, fault: "quota", status: 429 }).rotate, true);
eq("plan/balance rotates", K.shouldRotate({ ok: false, fault: "plan", status: 402 }).rotate, true);
eq("rejected key rotates to the next", K.shouldRotate({ ok: false, fault: "key", status: 401 }).rotate, true);
eq("server 5xx rotates", K.shouldRotate({ ok: false, fault: "endpoint", status: 503 }).rotate, true);
eq("transport failure rotates", K.shouldRotate({ ok: false, reach: "down" }).rotate, true);
eq("plain 404 does not rotate", K.shouldRotate({ ok: false, fault: "endpoint", status: 404 }).rotate, false);

// ------------------------------------------------------------ pool state
{
  const st = K.createPoolState(3);
  eq("round-robin order", [K.pickPoolIndex(st, 0), K.pickPoolIndex(st, 0), K.pickPoolIndex(st, 0)], [0, 1, 2]);
  K.recordPoolResult(st, 1, { ok: false, fault: "key", status: 401 }, 1000);
  eq("rejected key leaves rotation", [K.pickPoolIndex(st, 1000), K.pickPoolIndex(st, 1000)], [0, 2]);
  K.recordPoolResult(st, 2, { ok: false, fault: "quota", status: 429 }, 1000);
  check("quota key goes to cooldown", K.pickPoolIndex(st, 1000) === 0, "cooled key was picked");
  check("cooldown expires", K.pickPoolIndex(st, 1000 + 400_000) !== -1, "no key available after cooldown");
  K.recordPoolResult(st, 0, { ok: true }, 2000);
  eq("success clears failures", st.failures[0], 0);
}
{
  const st = K.createPoolState(1);
  K.recordPoolResult(st, 0, { ok: false, fault: "key", status: 401 }, 0);
  eq("last dead key means nobody left", K.pickPoolIndex(st, 0), -1);
}
{
  const st = K.createPoolState(2);
  K.recordPoolResult(st, 0, { ok: false, status: 402 }, 1000);
  check("402 marks key dead", st.dead[0] === true);
  eq("second key picked after 402", K.pickPoolIndex(st, 1000), 1);
}

// ------------------------------------------------------- daily limit patterns
check("Gemini 15 RPM error is NOT daily limit", !K.POOL_DAILY_RE.test("Resource has been exhausted (e.g. check quota)"));
check("Groq daily requests limit matches", K.POOL_DAILY_RE.test("requests per day limit reached"));
check("Cerebras tokens per day matches", K.POOL_DAILY_RE.test("tokens per day limit exceeded"));
check("daily limit matches", K.POOL_DAILY_RE.test("daily limit reached"));
check("usage limit reached matches", K.POOL_DAILY_RE.test("usage limit reached"));

// ------------------------------------------------------- auth headers
eq("auth type gemini is google", K.getPoolAuthType({ providerKey: "google-gemini", baseURL: "https://generativelanguage.googleapis.com" }), "google");
eq("auth type azure is azure", K.getPoolAuthType({ providerKey: "my-azure", baseURL: "https://my-resource.openai.azure.com" }), "azure");
eq("auth type anthropic is anthropic", K.getPoolAuthType({ providerKey: "claude", apiFormat: "anthropic" }), "anthropic");
eq("auth type openai is bearer", K.getPoolAuthType({ providerKey: "openai", apiFormat: "openai-chat" }), "bearer");

eq("google headers use x-goog-api-key", K.poolAuthHeaders("key123", "google"), { "x-goog-api-key": "key123" });
eq("azure headers use api-key", K.poolAuthHeaders("key123", "azure"), { "api-key": "key123" });
eq("anthropic headers use x-api-key", K.poolAuthHeaders("key123", "anthropic"), { "x-api-key": "key123", "anthropic-version": "2023-06-01" });
eq("bearer headers use Authorization", K.poolAuthHeaders("key123", "bearer"), { Authorization: "Bearer key123" });

{
  const geminiPlugin = K.buildKeypoolPlugin({
    providerKey: "gemini", displayName: "Gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", apiFormat: "google", envNames: ["GEMINI_KEY"],
  });
  check("gemini plugin uses x-goog-api-key", geminiPlugin.source.includes("x-goog-api-key"));
  check("gemini plugin checks hasAuth for x-goog-api-key", geminiPlugin.source.includes('headers.has("x-goog-api-key")'));

  const azurePlugin = K.buildKeypoolPlugin({
    providerKey: "azure", displayName: "Azure", baseURL: "https://foo.openai.azure.com", apiFormat: "azure", envNames: ["AZURE_KEY"],
  });
  check("azure plugin uses api-key", azurePlugin.source.includes('"api-key": key'));
  check("azure plugin checks hasAuth for api-key", azurePlugin.source.includes('headers.has("api-key")'));
}

// ------------------------------------------------------- shards + plugin
{
  const provider = {
    name: "Test", baseURL: "https://api.example.com/v1", apiFormat: "openai-chat",
    models: [{ id: "m1", name: "M1" }],
  };
  const shards = K.buildPoolShards(provider, "TEST_API_KEY", ["k1", "k2"]);
  eq("shard count matches keys", shards.length, 2);
  eq("first shard keeps env base", shards[0].envVarName, "TEST_API_KEY");
  eq("second shard gets a suffix", shards[1].envVarName, "TEST_API_KEY_2");
  eq("first shard keeps the key", shards[0].key, "Test");
  // Slugification happens later in buildProviderChanges; shards keep the label.
  eq("second shard is suffixed", shards[1].key, "Test-2");
  check("shards force env mode", shards.every((s) => s.useEnvVar === true));
  check("raw keys do not leak into names", !JSON.stringify(shards.map((s) => ({ k: s.key, e: s.envVarName }))).includes("k1"));

  const plugin = K.buildKeypoolPlugin({
    providerKey: "test", displayName: "Test",
    baseURL: "https://api.example.com/v1", apiFormat: "openai-chat",
    envNames: ["TEST_API_KEY", "TEST_API_KEY_2"],
  });
  eq("plugin file name", plugin.fileName, "keypool-test.mjs");
  check("plugin reads envs", plugin.source.includes("TEST_API_KEY_2"));
  check("plugin pins the base", plugin.source.includes("https://api.example.com/v1"));
  check("plugin carries no secrets", !plugin.source.includes("k1") || plugin.source.includes("keypool"));
  check("plugin patches fetch", plugin.source.includes("globalThis.fetch"));
  check("plugin retries on 429", plugin.source.includes("429"));
  const a = K.buildKeypoolPlugin({
    providerKey: "t", displayName: "T", baseURL: "https://x", apiFormat: "anthropic", envNames: ["T"],
  });
  check("anthropic pool uses x-api-key", a.source.includes("x-api-key"));

  // Two pools in one opencode process: a single shared guard flag used to let
  // the first plugin win, and the second pool silently never installed.
  check("guard flag is per-pool",
    plugin.source.includes('__psKeypoolPatched_test') && !plugin.source.includes("!globalThis.__psKeypoolPatched)"));
  // A bare startsWith(POOL_BASE) also matched "https://api.example.com/v10" —
  // a different provider on the same host — and rewrote its Authorization
  // header with this pool's keys.
  check("url match is exact-prefix",
    plugin.source.includes('url === POOL_BASE || url.startsWith(POOL_BASE + "/")'));
  // The rotation policy is built from the same patterns rescue.mjs classifies
  // probe results with — a hand-copied map already drifted once (empty-403 and
  // account-capacity 404 were rotated by the server but not by the plugin).
  check("plugin rotates an empty 403", plugin.source.includes("s === 403 && !text.trim()"));
  check("plugin knows the account-capacity 404", plugin.source.includes("not supported by any"));
  check("plugin knows the Chinese throttling body", plugin.source.includes("请求过于频繁"));
  check("plugin knows bad-key bodies", plugin.source.includes("valid api"));
  check("plugin knows daily stealth limit", plugin.source.includes("free-models-per-day-stealth"));
  check("plugin includes registry fallback", plugin.source.includes("reg query"));
  check("plugin exports valid OpenCode V2 object", plugin.source.includes("setup:") && plugin.source.includes("id:"));
  eq("plugin package.json name", plugin.packageJson.name, "keypool-test");
  eq("plugin package.json main", plugin.packageJson.main, "index.mjs");
  eq("plugin dirName", plugin.dirName, "keypool-test");
}
eq("plugin entry deduped", K.mergePluginEntry(["a", "b"], "a"), ["a", "b"]);
eq("plugin entry appended", K.mergePluginEntry(["a"], "b"), ["a", "b"]);

// -------------------------------------------------------------- balance
{
  const r = await K.fetchKeyBalance({ baseURL: "https://api.example.com/v1", apiKey: "sk-x" });
  eq("unknown provider has no balance api", r.supported, false);
  const bad = await K.fetchKeyBalance({ baseURL: "not a url", apiKey: "sk-x" });
  eq("bad url is not a balance", bad.ok, false);
}

// ------------------------------------------------- server <-> ui wiring
{
  const serverJs = readFileSync("server.mjs", "utf8");
  const js = readFileSync("public/app.js", "utf8");
  const html = readFileSync("public/index.html", "utf8");
  const css = readFileSync("public/style.css", "utf8");
  for (const route of ["/api/pool-check", "/api/setenv-pool", "/api/pool-preview", "/api/pool-apply"]) {
    check(`server exposes ${route}`, serverJs.includes(`url.pathname === "${route}"`));
    check(`ui calls ${route}`, js.includes(`"${route}"`));
  }
  for (const id of ["f-pool", "btnPoolCheck", "btnPoolSave", "poolCount", "poolStatus", "wiz-pool"]) {
    check(`id #${id} exists in html`, html.includes(`id="${id}"`));
  }
  for (const cls of ["pool-area", "pool-row", "pool-status", "pool-key-row", "pool-mask", "pool-msg",
    "pool-mark-ok", "pool-mark-pay", "pool-mark-retry", "pool-mark-bad", "pool-balance"]) {
    check(`css styles .${cls}`, new RegExp(`\\.${cls}\\b`).test(css));
  }
  check("pool secrets never go to clipboard", !/clipboard\.writeText\([^)]*poolKeys/.test(js));
  check("pool status never renders raw keys", !/pool-key-row[^]*\$\{[^}]*\bkey\b/.test(js) || js.includes("x.mask"));
}

// ------------------------------------------------- gorouter is gone
{
  const presets = await import("./src/presets.mjs");
  check("gorouter preset removed", !presets.PRESETS.some((p) => p.id === "gorouter"));
  const rootPath = new URL("../opencode.json", import.meta.url);
  if (existsSync(rootPath)) {
    const root = JSON.parse(readFileSync(rootPath, "utf8"));
    const keys = Object.keys(root.provider || {});
    check("repo opencode.json has no custom providers", keys.length === 0, keys.join(","));
    check("repo opencode.json has no gorouter", !keys.includes("gorouter"));
  } else {
    check("repo opencode.json exists", false);
  }
}

console.log(`\n${pass}/${pass + fails.length} passed`);
for (const f of fails) console.log("  - " + f);
process.exit(fails.length ? 1 : 0);
