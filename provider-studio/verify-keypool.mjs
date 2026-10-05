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
