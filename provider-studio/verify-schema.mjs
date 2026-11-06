// verify-schema.mjs
// Covers src/schema.mjs: reading a V2 (`providers`) config through the V1 view
// and translating V1 patch operations back into V2 on write.
//
// Why this deserves its own suite: opencode V2 accepts both shapes, but they are
// not interchangeable. A `provider` block is treated as legacy — `capabilities`
// inside it is ignored and `reasoning`/`attachment` are dropped with "omitted
// unsupported legacy setting". A tool that writes V1 fields into a V2 file looks
// like it succeeded while the running process uses a different block, and a tool
// that writes a legacy block next to `providers` gets ignored entirely. Both
// failures are silent, so they are pinned here.

import { applyChangesVerified, parseJsonc } from "./src/jsonc-edit.mjs";

let pass = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  <- " + detail : "")); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `got ${a} want ${b}`);
}

const S = await import("./src/schema.mjs");

// ------------------------------------------------------------------ fixtures

const V2_TEXT = `{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "lunaroute": {
      "name": "lunaroute",
      "env": ["LUNAROUTE_API_KEY"],
      "package": "@ai-sdk/openai-compatible",
      "canonical": "canonical-route",
      "compatibility": { "mode": "strict" },
      "settings": { "baseURL": "https://gw.example/v1", "apiKey": "{env:LUNAROUTE_API_KEY}" },
      "models": {
        "m1": {
          "name": "m1",
          "capabilities": {
            "tools": true,
            "input": ["text", "image"],
            "output": ["text"],
            "reasoning": { "supported": true, "effort": ["low", "high"] }
          },
          "limit": { "context": 1000, "output": 100 }
        }
      }
    }
  },
  "model": "lunaroute/m1"
}
`;

const V1_TEXT = `{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "lunaroute": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "lunaroute",
      "env": ["LUNAROUTE_API_KEY"],
      "options": { "baseURL": "https://gw.example/v1", "apiKey": "{env:LUNAROUTE_API_KEY}" },
      "models": {
        "m1": {
          "name": "m1",
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "attachment": true,
          "reasoning": true,
          "limit": { "context": 1000, "output": 100 }
        }
      }
    }
  },
  "model": "lunaroute/m1"
}
`;

function load(text) {
  const parsed = parseJsonc(text);
  if (!parsed.ok) throw new Error("fixture does not parse: " + parsed.error);
  return S.shadowLegacyProviders(parsed.value);
}

// -------------------------------------------------------------- schema choice

eq("a providers document is V2", S.detectSchema(load(V2_TEXT)), "v2");
eq("a provider document is V1", S.detectSchema(load(V1_TEXT)), "v1");
eq("providers win when both keys exist", S.detectSchema({ providers: { a: {} }, provider: { b: {} } }), "v2");
eq("an empty providers map does not flip the schema", S.detectSchema({ providers: {}, provider: { b: {} } }), "v1");
eq("a non-object config is V1", S.detectSchema(null), "v1");

// Deleting the last V2 provider leaves `providers: {}` behind. Treating that as
// V1 made the next save write a legacy block that opencode V2 never reads.
eq("an empty providers map alone is still V2", S.detectSchema({ providers: {} }), "v2");
{
  const cfg = S.shadowLegacyProviders({ providers: {} });
  const adapted = S.adaptChanges(
    [{ op: "merge", path: ["provider", "fresh"], value: { npm: "@ai-sdk/openai-compatible" } }],
    cfg,
  );
  check("a save after the last V2 provider still writes providers",
    adapted.some((c) => c.path[0] === "providers" && c.path[1] === "fresh"));
  check("no legacy block is created after the map emptied",
    !adapted.some((c) => c.path[0] === "provider"));
}

// A file may carry both maps after a hand-done migration. V2 reads `providers`,
// so readers must see that map — before the fix they saw the legacy one while
// writes went to `providers`, and a delete reported success without removing
// anything the running process used.
{
  const cfg = S.shadowLegacyProviders({
    providers: { live: { package: "p", settings: { apiKey: "{env:LIVE_KEY}" }, models: { m: { name: "m" } } } },
    provider: { stale: { npm: "p", options: { apiKey: "{env:STALE_KEY}" }, models: { m: { name: "m" } } } },
    model: "live/m",
  });
  eq("the active map is the V2 one", Object.keys(cfg.provider), ["live"]);
  eq("the legacy block stays reachable for diagnostics", Object.keys(S.legacyProvidersOf(cfg)), ["stale"]);
  eq("a delete targets providers, not the legacy map",
    S.adaptChanges([{ op: "delete", path: ["provider", "live"] }], cfg),
    [{ op: "delete", path: ["providers", "live"] }]);
  check("shadowing twice keeps the real legacy block", (() => {
    S.shadowLegacyProviders(cfg);
    return Object.keys(S.legacyProvidersOf(cfg)).join() === "stale";
  })());
}

// --------------------------------------------------------------- the V1 view

{
  const cfg = load(V2_TEXT);
  const block = cfg.provider.lunaroute;
  eq("package becomes npm", block.npm, "@ai-sdk/openai-compatible");
  eq("settings become options", block.options, { baseURL: "https://gw.example/v1", apiKey: "{env:LUNAROUTE_API_KEY}" });
  eq("the original V2 key is not renamed in place", cfg.providers.lunaroute.package, "@ai-sdk/openai-compatible");
  const model = block.models.m1;
  eq("capabilities.input becomes modalities.input", model.modalities, { input: ["text", "image"], output: ["text"] });
  eq("a non-text input sets attachment", model.attachment, true);
  eq("capabilities.reasoning.supported becomes reasoning", model.reasoning, true);
  eq("capabilities.tools becomes tool_call", model.tool_call, true);

  // The view is a reading aid, not a second copy on disk: serializing the
  // document must not grow a legacy `provider` block.
  check("the view is not enumerable", !Object.keys(cfg).includes("provider"));
  check("the view does not leak into JSON", !JSON.stringify(cfg).includes('"provider":'));
  check("the V2 map is still the only source", JSON.stringify(cfg).includes('"providers":'));
}

// ------------------------------------------------------------- V1 passthrough

{
  const cfg = load(V1_TEXT);
  const changes = [{ op: "merge", path: ["provider", "lunaroute"], value: { name: "x" } }];
  const out = S.adaptChanges(changes, cfg);
  eq("V1 changes pass through untouched", out, changes);
}

// --------------------------------------------------------- V2 write translation

{
  const cfg = load(V2_TEXT);
  const changes = [
    { op: "merge", path: ["provider", "lunaroute"], value: { name: "renamed" } },
    { op: "set", path: ["model"], value: "lunaroute/m1" },
  ];
  const adapted = S.adaptChanges(changes, cfg);
  check("a provider edit becomes one providers set", adapted.some((c) => c.op === "set" && c.path.join(".") === "providers.lunaroute"));
  check("no legacy provider path survives", !adapted.some((c) => c.path[0] === "provider"));
  check("schema-neutral operations keep their place", adapted.some((c) => c.op === "set" && c.path[0] === "model"));
  const written = adapted.find((c) => c.path[0] === "providers");
  eq("the written block is V2-shaped", Object.keys(written.value).sort(), ["canonical", "compatibility", "env", "models", "name", "package", "settings"]);
  eq("the name is merged", written.value.name, "renamed");
  eq("canonical survives an unrelated provider edit", written.value.canonical, "canonical-route");
  eq("compatibility survives an unrelated provider edit", written.value.compatibility, { mode: "strict" });
  eq("the key reference survives", written.value.settings.apiKey, "{env:LUNAROUTE_API_KEY}");
  eq("the base URL survives", written.value.settings.baseURL, "https://gw.example/v1");
  eq("the limit survives", written.value.models.m1.limit, { context: 1000, output: 100 });
  eq("reasoning effort survives a rename", written.value.models.m1.capabilities.reasoning,
    { supported: true, effort: ["low", "high"] });
}

{
  const cfg = load(V2_TEXT);
  const adapted = S.adaptChanges([
    { op: "delete", path: ["provider", "lunaroute", "models", "m1", "reasoning"] },
  ], cfg);
  const written = adapted.find((c) => c.path[0] === "providers");
  eq("unchecking reasoning removes inherited V2 support", written.value.models.m1.capabilities.reasoning, undefined);
}

// --------------------------------------------------------- end-to-end on text

{
  const cfg = load(V2_TEXT);
  const changes = [
    // What buildProviderChanges() emits for a V1 config, applied to a V2 file.
    { op: "merge", path: ["provider", "lunaroute"], value: { npm: "@ai-sdk/openai-compatible", name: "lunaroute" } },
    { op: "merge", path: ["provider", "lunaroute", "options"], value: { baseURL: "https://gw.example/v1", apiKey: "{env:LUNAROUTE_API_KEY}" } },
    { op: "merge", path: ["provider", "lunaroute", "models", "m1"], value: {
      name: "m1",
      modalities: { input: ["text", "image"], output: ["text"] },
      attachment: true,
      reasoning: true,
      limit: { context: 2000, output: 200 },
    } },
  ];
  const applied = S.applySchemaChanges(V2_TEXT, cfg, changes);
  check("the write succeeds", applied.ok, applied.error || "");
  const parsed = parseJsonc(applied.text);
  check("the result parses", parsed.ok, parsed.error || "");
  if (parsed.value) {
    check("no legacy provider block was created", !("provider" in parsed.value));
    const block = parsed.value.providers.lunaroute;
    eq("the package survives as package", block.package, "@ai-sdk/openai-compatible");
    eq("the key reference survives", block.settings.apiKey, "{env:LUNAROUTE_API_KEY}");
    eq("the updated limit is written", block.models.m1.limit, { context: 2000, output: 200 });
    eq("capabilities are rebuilt from the legacy flags", block.models.m1.capabilities,
      { tools: true, input: ["text", "image"], output: ["text"], reasoning: { supported: true, effort: ["low", "high"] } });
    eq("no legacy modalities key is written", block.models.m1.modalities, undefined);
    eq("no legacy attachment key is written", block.models.m1.attachment, undefined);
    eq("the default model is untouched", parsed.value.model, "lunaroute/m1");
  }
}

// ----------------------------------------------------------------- rename/delete

{
  const cfg = load(V2_TEXT);
  const ren = S.adaptChanges([{ op: "rename", path: ["provider", "lunaroute"], key: "lr2" }], cfg);
  eq("rename targets the providers map", ren, [{ op: "rename", path: ["providers", "lunaroute"], key: "lr2" }]);

  const del = S.adaptChanges([{ op: "delete", path: ["provider", "lunaroute"] }], cfg);
  eq("delete targets the providers map", del, [{ op: "delete", path: ["providers", "lunaroute"] }]);

  const delApplied = S.applySchemaChanges(V2_TEXT, cfg, [{ op: "delete", path: ["provider", "lunaroute"] }]);
  check("delete applies", delApplied.ok, delApplied.error || "");
  const parsed = parseJsonc(delApplied.text);
  check("the provider is gone", parsed.ok && !parsed.value.providers.lunaroute);
  check("the rest of the file is intact", parsed.ok && parsed.value.model === "lunaroute/m1");
}

// ------------------------------------------------------- idempotent round-trip

{
  const cfg = load(V2_TEXT);
  const changes = [{ op: "merge", path: ["provider", "lunaroute"], value: { name: "lunaroute" } }];
  const once = S.applySchemaChanges(V2_TEXT, cfg, changes);
  const twiceCfg = load(once.text);
  const twice = S.applySchemaChanges(once.text, twiceCfg, changes);
  check("a second identical save changes nothing", once.text === twice.text);
}

// ---------------------------------------------------------- malformed inputs

{
  const cfg = load(V2_TEXT);
  eq("a non-array change list is returned as is", S.adaptChanges(null, cfg), null);
  const empty = S.adaptChanges([], cfg);
  eq("an empty list stays empty", empty, []);
  check("a deeper edit on an unknown provider does not throw", (() => {
    try {
      S.adaptChanges([{ op: "merge", path: ["provider", "ghost", "options"], value: { apiKey: "x" } }], cfg);
      return true;
    } catch { return false; }
  })());
}

// -------------------------------------------------- validation sees the schema
// The rescue checks are written against `config.provider`. On a V2 document that
// key only exists as the synthesized view, so validation must build it rather
// than report "Нет блока provider" for a perfectly valid file.

{
  const R = await import("./src/rescue.mjs");
  const ids = (cfg) => R.validateConfig(cfg).map((i) => i.id);
  const v2 = {
    $schema: "https://opencode.ai/config.json",
    providers: {
      p: {
        name: "p",
        package: "@ai-sdk/openai-compatible",
        settings: { baseURL: "https://x.dev", apiKey: "{env:X}" },
        models: { m: { capabilities: { tools: true, input: ["text", "image"], output: ["text"], reasoning: { supported: true } }, limit: { context: 1000, output: 100 } } },
      },
    },
    model: "p/m",
  };
  check("a V2 document is not reported as provider-less", !ids(v2).includes("no-provider"));
  check("V2 capabilities are not mistaken for dropped legacy fields", !ids(v2).includes("v2-dropped-model-fields"));

  const mixed = {
    providers: { live: { package: "@ai-sdk/openai-compatible", settings: { baseURL: "https://x.dev", apiKey: "{env:LIVE}" } } },
    provider: { stale: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://y.dev", apiKey: "{env:STALE}" } } },
  };
  check("a mixed providers/provider file is flagged", ids(mixed).includes("mixed-provider-maps"));
  check("a clean V2 file is not flagged", !ids(v2).includes("mixed-provider-maps"));

  const v1 = { provider: { p: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://x.dev" }, models: { m: { reasoning: true } } } } };
  check("legacy reasoning in a V1 document is still flagged", ids(v1).includes("v2-dropped-model-fields"));
}

// ------------------------------------------------------------------- summary

console.log("");
if (fails.length) {
  console.log("FAILED: " + fails.length + " of " + (pass + fails.length));
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
console.log(pass + "/" + pass + " passed");
