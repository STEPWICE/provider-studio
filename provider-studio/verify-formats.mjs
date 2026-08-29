// verify-formats.mjs
// Checks the provider -> patch-operation translation, then runs the resulting
// operations through the real patcher against a copy of the user's own config.
// A bug here writes a schema-invalid config, which makes opencode refuse to
// start, so the schema constraints are asserted explicitly.

import {
  FORMATS, MODALITIES, MODEL_STATUSES, PROVIDER_FIELDS, MODEL_FIELDS,
  slugify, normaliseHeaders, buildModelEntry, buildOpencodeProvider, managedModelKeys,
  buildProviderChanges, buildRemovalChanges, decodeApiKey, isPlaintextKey,
  suggestEnvVarName, looksLikePackage, isCustomProviderBlock, detectApiFormat,
  modelEntryToForm,
} from "./src/formats.mjs";
import { applyChangesVerified, parseJsonc, getPath } from "./src/jsonc-edit.mjs";

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

const PROVIDER_ALLOWED = new Set(PROVIDER_FIELDS);
const MODEL_ALLOWED = new Set(MODEL_FIELDS);

// opencode sets additionalProperties:false on both, so an unknown key is fatal.
function assertSchemaShape(label, block) {
  const badTop = Object.keys(block || {}).filter((k) => !PROVIDER_ALLOWED.has(k));
  check(`${label}: no unknown provider fields`, badTop.length === 0, badTop.join(","));
  for (const [id, m] of Object.entries(block?.models || {})) {
    const bad = Object.keys(m).filter((k) => !MODEL_ALLOWED.has(k));
    check(`${label}: model "${id}" has no unknown fields`, bad.length === 0, bad.join(","));
    if (m.limit) {
      check(`${label}: model "${id}" limit is complete`,
        typeof m.limit.context === "number" && typeof m.limit.output === "number", JSON.stringify(m.limit));
    }
    if (m.cost) {
      check(`${label}: model "${id}" cost is complete`,
        typeof m.cost.input === "number" && typeof m.cost.output === "number", JSON.stringify(m.cost));
    }
    for (const dir of ["input", "output"]) {
      const list = m.modalities?.[dir];
      if (list) {
        check(`${label}: model "${id}" ${dir} modalities are valid`,
          list.every((t) => MODALITIES.includes(t)), JSON.stringify(list));
      }
    }
    if (m.status !== undefined) {
      check(`${label}: model "${id}" status is in the enum`, MODEL_STATUSES.includes(m.status), String(m.status));
    }
    if (m.temperature !== undefined) {
      check(`${label}: model "${id}" temperature is boolean`, typeof m.temperature === "boolean", String(m.temperature));
    }
  }
}

// ------------------------------------------------------------------ slugify

eq("slugify lowercases and dashes", slugify("My Provider"), "my-provider");
eq("slugify strips punctuation", slugify("BAI! (v2)"), "bai-v2");
eq("slugify trims dashes", slugify("--x--"), "x");
eq("slugify falls back", slugify(""), "provider");
eq("slugify handles cyrillic-only input", slugify("Провайдер"), "provider");
eq("slugify keeps digits", slugify("gpt 4o"), "gpt-4o");

// ----------------------------------------------------------------- headers

eq("headers from a curl-style string",
  normaliseHeaders("X-Title: My App\nHTTP-Referer: https://x.dev"),
  { "X-Title": "My App", "HTTP-Referer": "https://x.dev" });
eq("headers ignore blank lines", normaliseHeaders("\n\nA: 1\n\n"), { A: "1" });
eq("headers keep colons in the value", normaliseHeaders("URL: https://a.dev:8080/x"), { URL: "https://a.dev:8080/x" });
eq("headers from an array", normaliseHeaders([{ key: "A", value: "1" }, { key: "", value: "skip" }]), { A: "1" });
eq("headers from an object", normaliseHeaders({ A: 1, "": "skip" }), { A: "1" });
eq("headers from junk", normaliseHeaders(null), {});
eq("headers reject an invalid name", normaliseHeaders("bad header: 1"), {});

// -------------------------------------------------------------- model entry

eq("model with no id is rejected", buildModelEntry({ id: "  " }), null);

const basic = buildModelEntry({ id: "m1" });
eq("model id trimmed", basic.id, "m1");
eq("model name defaults to the id", basic.entry.name, "m1");
eq("modalities default to text", basic.entry.modalities, { input: ["text"], output: ["text"] });
eq("tool_call defaults to true", basic.entry.tool_call, true);
check("no attachment for text-only", basic.entry.attachment === undefined);
check("no limit without both halves", basic.entry.limit === undefined);
check("no cost without both halves", basic.entry.cost === undefined);

// A half-filled limit fails schema validation, so it must be dropped, not guessed.
check("limit dropped when only context is given",
  buildModelEntry({ id: "m", contextWindow: 1000 }).entry.limit === undefined);
check("limit dropped when only output is given",
  buildModelEntry({ id: "m", maxOutput: 100 }).entry.limit === undefined);
eq("limit emitted when complete",
  buildModelEntry({ id: "m", contextWindow: 200000, maxOutput: 32000 }).entry.limit,
  { context: 200000, output: 32000 });
check("limit ignores non-numeric input",
  buildModelEntry({ id: "m", contextWindow: "abc", maxOutput: "def" }).entry.limit === undefined);

eq("cost emitted when complete",
  buildModelEntry({ id: "m", costInput: 3, costOutput: 15 }).entry.cost, { input: 3, output: 15 });
eq("cost accepts zero", buildModelEntry({ id: "m", costInput: 0, costOutput: 0 }).entry.cost, { input: 0, output: 0 });
check("cost dropped when output is missing",
  buildModelEntry({ id: "m", costInput: 3 }).entry.cost === undefined);
eq("cost carries cache fields",
  buildModelEntry({ id: "m", costInput: 3, costOutput: 15, costCacheRead: 0.3, costCacheWrite: 3.75 }).entry.cost,
  { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 });
check("cost never contains NaN",
  Number.isFinite(buildModelEntry({ id: "m", costInput: "x", costOutput: "y" }).entry.cost.input));

const vision = buildModelEntry({ id: "v", inputTypes: ["text", "image"] });
eq("attachment set for image input", vision.entry.attachment, true);
const pdf = buildModelEntry({ id: "p", inputTypes: ["text", "pdf"] });
eq("attachment set for pdf input", pdf.entry.attachment, true);
eq("invalid modalities filtered out",
  buildModelEntry({ id: "m", inputTypes: ["text", "hologram"] }).entry.modalities.input, ["text"]);
eq("empty modalities fall back to text",
  buildModelEntry({ id: "m", inputTypes: [] }).entry.modalities.input, ["text"]);
eq("duplicate modalities deduped",
  buildModelEntry({ id: "m", inputTypes: ["text", "text", "image"] }).entry.modalities.input, ["text", "image"]);

eq("tool_call can be disabled", buildModelEntry({ id: "m", toolUse: false }).entry.tool_call, false);
eq("reasoning flag", buildModelEntry({ id: "m", reasoning: true }).entry.reasoning, true);
// The schema types this as a capability flag, not a sampling value.
eq("temperature is emitted as a boolean", buildModelEntry({ id: "m", temperature: true }).entry.temperature, true);
eq("temperature false is preserved", buildModelEntry({ id: "m", temperature: false }).entry.temperature, false);
check("temperature omitted when unset", buildModelEntry({ id: "m" }).entry.temperature === undefined);
check("a numeric temperature is not written",
  buildModelEntry({ id: "m", temperature: 0.7 }).entry.temperature === undefined);
eq("release_date passthrough", buildModelEntry({ id: "m", releaseDate: "2025-01-30" }).entry.release_date, "2025-01-30");
eq("family passthrough", buildModelEntry({ id: "m", family: "claude" }).entry.family, "claude");
eq("valid status kept", buildModelEntry({ id: "m", status: "beta" }).entry.status, "beta");
check("invalid status dropped", buildModelEntry({ id: "m", status: "wip" }).entry.status === undefined);
eq("model headers", buildModelEntry({ id: "m", headers: "X-A: 1" }).entry.headers, { "X-A": "1" });

// ------------------------------------------------------- full block shape

const full = buildOpencodeProvider({
  name: "GoRouter", apiFormat: "openai-chat", baseURL: "https://gorouter.app/v1",
  apiKey: "sk-secret", headers: "X-Title: PS",
  models: [{ id: "claude-opus-5", inputTypes: ["text", "image"], contextWindow: 200000, maxOutput: 32000, reasoning: true }],
});
eq("npm from the format", full.npm, FORMATS["openai-chat"].opencodeNpm);
eq("display name", full.name, "GoRouter");
eq("baseURL in options", full.options.baseURL, "https://gorouter.app/v1");
eq("plaintext key in options", full.options.apiKey, "sk-secret");
eq("provider headers in options", full.options.headers, { "X-Title": "PS" });
assertSchemaShape("full block", full);

const envBlock = buildOpencodeProvider({
  name: "X", apiFormat: "anthropic", useEnvVar: true, envVarName: "X_KEY",
  models: [{ id: "m" }],
});
// A bare $VAR is sent verbatim as the key, which is the bug this encoding avoids.
eq("env key uses the {env:} form", envBlock.options.apiKey, "{env:X_KEY}");
eq("env array declared", envBlock.env, ["X_KEY"]);
eq("anthropic npm", envBlock.npm, "@ai-sdk/anthropic");
assertSchemaShape("env block", envBlock);

eq("displayName overrides name for the label",
  buildOpencodeProvider({ name: "bai", displayName: "BAI EU", models: [{ id: "m" }] }).name, "BAI EU");

// --------------------------------------------------------- change building

const existing = {
  model: "old/m1",
  provider: {
    old: {
      npm: "@ai-sdk/openai-compatible",
      name: "Old",
      options: { baseURL: "https://old.dev/v1", apiKey: "plain" },
      models: { m1: { name: "m1" }, gone: { name: "gone" } },
    },
    other: { npm: "@ai-sdk/openai-compatible", models: { z: { name: "z" } } },
  },
};

const noName = buildProviderChanges({ name: "", models: [{ id: "m" }] });
check("empty name is rejected", !noName.ok, noName.error);
const noModels = buildProviderChanges({ name: "X", models: [] });
check("a provider without models is rejected", !noModels.ok, noModels.error);
check("a provider whose models all lack ids is rejected",
  !buildProviderChanges({ name: "X", models: [{ id: "" }] }).ok);

const created = buildProviderChanges(
  { name: "New Prov", baseURL: "https://n.dev/v1", apiKey: "k", models: [{ id: "a" }] },
  { existingConfig: existing });
check("create succeeds", created.ok, created.error);
eq("create key is slugified", created.providerKey, "new-prov");
check("create uses merge, not set, for the provider",
  created.changes.some((c) => c.op === "merge" && c.path.join(".") === "provider.new-prov"));
check("create does not set a default model unless asked",
  !created.changes.some((c) => c.path.join(".") === "model"));

const withDefault = buildProviderChanges(
  { name: "New", models: [{ id: "a" }, { id: "b" }] },
  { existingConfig: existing, setAsDefault: true, defaultModelId: "b" });
eq("the chosen default model is used",
  withDefault.changes.find((c) => c.path.join(".") === "model").value, "new/b");
const badDefault = buildProviderChanges(
  { name: "New", models: [{ id: "a" }] },
  { existingConfig: existing, setAsDefault: true, defaultModelId: "nope" });
eq("an unknown default falls back to the first model",
  badDefault.changes.find((c) => c.path.join(".") === "model").value, "new/a");

// ----------------------------------------------------------------- renames

const renamed = buildProviderChanges(
  { key: "brand-new", name: "Old", baseURL: "https://old.dev/v1", models: [{ id: "m1" }] },
  { existingConfig: existing, previousKey: "old" });
check("rename succeeds", renamed.ok, renamed.error);
const renameOp = renamed.changes[0];
eq("rename happens first", [renameOp.op, renameOp.path.join("."), renameOp.key], ["rename", "provider.old", "brand-new"]);
check("subsequent edits target the new key",
  renamed.changes.slice(1).filter((c) => c.path[0] === "provider").every((c) => c.path[1] === "brand-new"),
  JSON.stringify(renamed.changes.map((c) => c.path.join("."))));
// Leaving `model` pointing at the old key breaks opencode on startup.
eq("the default model pointer follows the rename",
  renamed.changes.find((c) => c.path.join(".") === "model").value, "brand-new/m1");
check("renaming onto an existing key is refused",
  !buildProviderChanges({ key: "other", name: "Old", models: [{ id: "m" }] },
    { existingConfig: existing, previousKey: "old" }).ok);
check("renaming a missing provider is refused",
  !buildProviderChanges({ key: "x", name: "Y", models: [{ id: "m" }] },
    { existingConfig: existing, previousKey: "ghost" }).ok);
check("a same-key 'rename' emits no rename op",
  !buildProviderChanges({ key: "old", name: "Old", models: [{ id: "m1" }] },
    { existingConfig: existing, previousKey: "old" }).changes.some((c) => c.op === "rename"));

// ------------------------------------------------------------- field clearing

const cleared = buildProviderChanges(
  { key: "old", name: "Old", baseURL: "https://old.dev/v1", models: [{ id: "m1" }] },
  { existingConfig: existing, previousKey: "old" });
const paths = cleared.changes.map((c) => c.op + " " + c.path.join("."));
check("a cleared api key is deleted, not left stale",
  paths.includes("delete provider.old.options.apiKey"), JSON.stringify(paths));
check("a model removed from the form is deleted",
  paths.includes("delete provider.old.models.gone"), JSON.stringify(paths));
check("a model still in the form is not deleted",
  !paths.includes("delete provider.old.models.m1"));

// The distinction that matters: a field the form *submitted as empty* is cleared,
// but a field the form never carried must be left alone. Conflating the two
// silently deletes hand-written config on the next save.
const priorRich = {
  provider: {
    p: {
      npm: "@ai-sdk/openai-compatible",
      models: {
        m: {
          name: "m", cost: { input: 1, output: 2 }, limit: { context: 10, output: 20 },
          release_date: "2024-01-01", variants: { fast: { disabled: true } }, interleaved: true,
        },
      },
    },
  },
};
const untouchedForm = buildProviderChanges(
  { key: "p", name: "P", models: [{ id: "m" }] },
  { existingConfig: priorRich, previousKey: "p" });
const untouchedPaths = untouchedForm.changes.map((c) => c.op + " " + c.path.join("."));
check("a cost the form never submitted is preserved",
  !untouchedPaths.includes("delete provider.p.models.m.cost"), JSON.stringify(untouchedPaths));
check("a limit the form never submitted is preserved",
  !untouchedPaths.includes("delete provider.p.models.m.limit"));
check("a release_date the form never submitted is preserved",
  !untouchedPaths.includes("delete provider.p.models.m.release_date"));
check("unmanaged keys are never deleted",
  !untouchedPaths.some((p) => p.includes("variants") || p.includes("interleaved")), JSON.stringify(untouchedPaths));

const clearedForm = buildProviderChanges(
  { key: "p", name: "P", models: [{ id: "m", costInput: "", costOutput: "", contextWindow: "", maxOutput: "", releaseDate: "" }] },
  { existingConfig: priorRich, previousKey: "p" });
const clearedPaths = clearedForm.changes.map((c) => c.op + " " + c.path.join("."));
check("a cost the form cleared is deleted",
  clearedPaths.includes("delete provider.p.models.m.cost"), JSON.stringify(clearedPaths));
check("a limit the form cleared is deleted",
  clearedPaths.includes("delete provider.p.models.m.limit"));
check("a release_date the form cleared is deleted",
  clearedPaths.includes("delete provider.p.models.m.release_date"));
check("clearing still does not touch unmanaged keys",
  !clearedPaths.some((p) => p.includes("variants") || p.includes("interleaved")));

// The same "never submitted" vs "submitted empty" rule applies to provider
// headers, and getting it wrong there was worse: the form has no headers input
// at all, so every ordinary save looked like "the user cleared the headers" and
// deleted hand-written ones — an anthropic-version pin, a proxy token — the
// first time an imported provider was re-saved.
const priorHeaders = {
  provider: {
    p: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://p.dev/v1", headers: { "anthropic-version": "2023-06-01" } },
      models: { m: { name: "m" } },
    },
  },
};
const headerPaths = (form) => buildProviderChanges(form, { existingConfig: priorHeaders, previousKey: "p" })
  .changes.map((c) => c.op + " " + c.path.join("."));
const baseHeaderForm = { key: "p", name: "P", baseURL: "https://p.dev/v1", models: [{ id: "m" }] };

check("headers the form never submitted are preserved",
  !headerPaths(baseHeaderForm).includes("delete provider.p.options.headers"),
  JSON.stringify(headerPaths(baseHeaderForm)));
check("headers submitted as an empty object are cleared",
  headerPaths({ ...baseHeaderForm, headers: {} }).includes("delete provider.p.options.headers"));
check("headers submitted as an empty string are cleared",
  headerPaths({ ...baseHeaderForm, headers: "" }).includes("delete provider.p.options.headers"));
const replacedHeaders = buildProviderChanges(
  { ...baseHeaderForm, headers: { "x-proxy": "tok" } },
  { existingConfig: priorHeaders, previousKey: "p" });
eq("submitted headers replace the old ones",
  replacedHeaders.changes.find((c) => c.op === "merge" && c.path.join(".") === "provider.p").value.options.headers,
  { "x-proxy": "tok" });

eq("managedModelKeys covers always-derived keys",
  managedModelKeys({ id: "m" }), ["name", "modalities", "attachment"]);
check("managedModelKeys picks up a submitted cost input",
  managedModelKeys({ id: "m", costInput: "" }).includes("cost"));
check("managedModelKeys picks up a submitted limit input",
  managedModelKeys({ id: "m", maxOutput: "" }).includes("limit"));
check("managedModelKeys tolerates junk", Array.isArray(managedModelKeys(null)));

const keptKey = buildProviderChanges(
  { key: "old", name: "Old", apiKey: "still-here", models: [{ id: "m1" }] },
  { existingConfig: existing, previousKey: "old" });
check("an unchanged key is not deleted",
  !keptKey.changes.some((c) => c.op === "delete" && c.path.join(".").endsWith("options.apiKey")));

// `apiKey` at the provider level is not in the schema; the user's config has one.
const withStrayKey = {
  provider: { opencode: { name: "OpenCode", apiKey: "$OPENCODE_API_KEY", models: { m: {} } } },
};
const fixedStray = buildProviderChanges(
  { key: "opencode", name: "OpenCode", useEnvVar: true, envVarName: "OPENCODE_API_KEY", models: [{ id: "m" }] },
  { existingConfig: withStrayKey, previousKey: "opencode" });
check("a schema-invalid top-level apiKey is removed",
  fixedStray.changes.some((c) => c.op === "delete" && c.path.join(".") === "provider.opencode.apiKey"),
  JSON.stringify(fixedStray.changes.map((c) => c.op + " " + c.path.join("."))));

const envSwitched = buildProviderChanges(
  { key: "old", name: "Old", useEnvVar: true, envVarName: "OLD_KEY", models: [{ id: "m1" }] },
  { existingConfig: existing, previousKey: "old" });
const envMerge = envSwitched.changes.find((c) => c.op === "merge" && c.path.join(".") === "provider.old");
eq("switching to an env var writes the reference", envMerge.value.options.apiKey, "{env:OLD_KEY}");
eq("switching to an env var declares env", envMerge.value.env, ["OLD_KEY"]);

const envDropped = buildProviderChanges(
  { key: "e", name: "E", apiKey: "plain", models: [{ id: "m" }] },
  { existingConfig: { provider: { e: { npm: "x", env: ["E_KEY"], options: { apiKey: "{env:E_KEY}" }, models: { m: {} } } } }, previousKey: "e" });
check("dropping the env var removes the env array",
  envDropped.changes.some((c) => c.op === "delete" && c.path.join(".") === "provider.e.env"));

// --------------------------------------------------------------- removal

const rm = buildRemovalChanges("old", existing);
check("removal succeeds", rm.ok, rm.error);
eq("removal deletes the provider", rm.changes[0], { op: "delete", path: ["provider", "old"] });
// A dangling `model` pointer stops opencode from starting.
eq("removal repoints the orphaned default model",
  rm.changes.find((c) => c.path.join(".") === "model").value, "other/z");
check("removing a missing provider is refused", !buildRemovalChanges("ghost", existing).ok);
check("removal with a blank key is refused", !buildRemovalChanges("", existing).ok);

const rmLast = buildRemovalChanges("only", { model: "only/m", provider: { only: { models: { m: {} } } } });
eq("removing the last provider deletes the default model",
  rmLast.changes.find((c) => c.path.join(".") === "model"), { op: "delete", path: ["model"] });
const rmUnrelated = buildRemovalChanges("other", existing);
check("removing an unrelated provider leaves the default model alone",
  !rmUnrelated.changes.some((c) => c.path.join(".") === "model"));
const rmSmall = buildRemovalChanges("old", { ...existing, model: "other/z", small_model: "old/m1" });
eq("removal repoints small_model too",
  rmSmall.changes.find((c) => c.path.join(".") === "small_model").value, "other/z");

// ----------------------------------------------------------- key encoding

eq("decode {env:VAR}", decodeApiKey("{env:MY_KEY}"), { useEnvVar: true, envVarName: "MY_KEY", apiKey: "" });
eq("decode legacy $VAR", decodeApiKey("$MY_KEY"), { useEnvVar: true, envVarName: "MY_KEY", apiKey: "" });
eq("decode ${VAR}", decodeApiKey("${MY_KEY}"), { useEnvVar: true, envVarName: "MY_KEY", apiKey: "" });
eq("decode a plaintext key", decodeApiKey("sk-abc"), { useEnvVar: false, envVarName: "", apiKey: "sk-abc" });
eq("decode trims", decodeApiKey("  {env:A}  ").envVarName, "A");
eq("decode handles undefined", decodeApiKey(undefined).apiKey, "");
check("a key merely containing a $ is not an env ref", !decodeApiKey("sk-a$b").useEnvVar);

check("plaintext key detected", isPlaintextKey("gsk-abcdef"));
check("env reference is not plaintext", !isPlaintextKey("{env:A}"));
check("legacy $VAR is not plaintext", !isPlaintextKey("$A"));
check("empty is not plaintext", !isPlaintextKey(""));

eq("env var suggestion", suggestEnvVarName("baitestik"), "BAITESTIK_API_KEY");
eq("env var suggestion sanitises", suggestEnvVarName("go-router.v2"), "GO_ROUTER_V2_API_KEY");
eq("env var suggestion avoids a double suffix", suggestEnvVarName("x_api_key"), "X_API_KEY");
eq("env var suggestion avoids a leading digit", suggestEnvVarName("4o"), "P_4O_API_KEY");
check("env var suggestion is a valid identifier", /^[A-Za-z_][A-Za-z0-9_]*$/.test(suggestEnvVarName("!!")));

// -------------------------------------------------------------- detection

check("package in name recognised", looksLikePackage("@ai-sdk/openai-compatible"));
check("plain label is not a package", !looksLikePackage("GoRouter"));
check("custom block via npm", isCustomProviderBlock({ npm: "@ai-sdk/openai" }));
check("custom block via api", isCustomProviderBlock({ api: "https://x/v1" }));
check("override-only block is not custom", !isCustomProviderBlock({ models: { a: {} } }));
check("junk is not a custom block", !isCustomProviderBlock(null));
eq("detect openai-compatible", detectApiFormat({ npm: "@ai-sdk/openai-compatible" }), "openai-chat");
eq("detect anthropic", detectApiFormat({ npm: "@ai-sdk/anthropic" }), "anthropic");
eq("detect responses", detectApiFormat({ npm: "@ai-sdk/openai" }), "openai-responses");
eq("detect from a legacy package-in-name", detectApiFormat({ name: "@ai-sdk/anthropic" }), "anthropic");
eq("detect falls back to chat", detectApiFormat({}), "openai-chat");

// ------------------------------------------------------------ round trip

const roundTripped = modelEntryToForm("m", {
  name: "M", modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 200000, output: 32000 }, cost: { input: 3, output: 15, cache_read: 0.3 },
  attachment: true, reasoning: true, tool_call: true, temperature: false,
  release_date: "2025-01-01", family: "f", status: "beta", headers: { A: "1" },
});
const rebuilt = buildModelEntry(roundTripped);
eq("round trip keeps modalities", rebuilt.entry.modalities, { input: ["text", "image"], output: ["text"] });
eq("round trip keeps limit", rebuilt.entry.limit, { context: 200000, output: 32000 });
eq("round trip keeps cost", rebuilt.entry.cost, { input: 3, output: 15, cache_read: 0.3 });
eq("round trip keeps reasoning", rebuilt.entry.reasoning, true);
eq("round trip keeps temperature", rebuilt.entry.temperature, false);
eq("round trip keeps release_date", rebuilt.entry.release_date, "2025-01-01");
eq("round trip keeps status", rebuilt.entry.status, "beta");
eq("round trip keeps headers", rebuilt.entry.headers, { A: "1" });
eq("round trip of a bare entry", modelEntryToForm("m", {}).inputTypes, ["text"]);
eq("round trip tolerates junk", modelEntryToForm("m", null).name, "m");
check("round trip drops an invalid stored modality",
  !modelEntryToForm("m", { modalities: { input: ["text", "hologram"] } }).inputTypes.includes("hologram"));

// ------------------------------- integration against the real config shape

const REAL = `{
  "$schema": "https://opencode.ai/config.json",
  "model": "baitestik/deepseek-v4-flash-vision-exp",
  "provider": {
    // hand-written comment that must survive
    "baitestik": {
      "name": "BAI",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://api.b.ai/v1" },
      "models": {
        "deepseek-v4-flash": { "name": "deepseek-v4-flash" },
        "deepseek-v4-flash-vision-exp": {
          "name": "deepseek-v4-flash-vision-exp",
          "modalities": { "input": ["text", "image"] },
          "cost": { "input": 0.1, "output": 0.3 }
        }
      }
    },
    "other": { "npm": "@ai-sdk/openai-compatible", "models": { "z": { "name": "z" } } }
  },
  "mcp": { "godot-ai": { "type": "remote", "url": "http://127.0.0.1:8000/mcp", "enabled": true } },
  "disabled_providers": []
}`;
const realCfg = parseJsonc(REAL).value;

// Editing one model must not disturb the sibling's hand-tuned cost.
const edit = buildProviderChanges({
  key: "baitestik", name: "baitestik", displayName: "BAI",
  baseURL: "https://api.b.ai/v1", useEnvVar: true, envVarName: "BAI_API_KEY",
  models: [
    { id: "deepseek-v4-flash", contextWindow: 128000, maxOutput: 8000 },
    { id: "deepseek-v4-flash-vision-exp", inputTypes: ["text", "image"] },
  ],
}, { existingConfig: realCfg, previousKey: "baitestik" });
check("real config: change set builds", edit.ok, edit.error);

const applied = applyChangesVerified(REAL, edit.changes);
check("real config: patch applies", applied.ok, applied.error);
check("real config: comment survives", applied.text.includes("must survive"));
eq("real config: env reference written", getPath(applied.text, ["provider", "baitestik", "options", "apiKey"]), "{env:BAI_API_KEY}");
eq("real config: display name kept", getPath(applied.text, ["provider", "baitestik", "name"]), "BAI");
eq("real config: limit added", getPath(applied.text, ["provider", "baitestik", "models", "deepseek-v4-flash", "limit"]), { context: 128000, output: 8000 });
// The form has no cost field for this model, so the hand-written value must stay.
eq("real config: hand-written cost preserved",
  getPath(applied.text, ["provider", "baitestik", "models", "deepseek-v4-flash-vision-exp", "cost"]), { input: 0.1, output: 0.3 });
eq("real config: mcp untouched", getPath(applied.text, ["mcp", "godot-ai", "url"]), "http://127.0.0.1:8000/mcp");
eq("real config: other provider untouched", getPath(applied.text, ["provider", "other", "models", "z", "name"]), "z");
eq("real config: disabled_providers untouched", getPath(applied.text, ["disabled_providers"]), []);
assertSchemaShape("patched real config", getPath(applied.text, ["provider", "baitestik"]));

// Rename on the real shape, including the default-model pointer.
const ren = buildProviderChanges({
  key: "bai-eu", name: "baitestik", displayName: "BAI EU",
  baseURL: "https://eu.b.ai/v1",
  models: [{ id: "deepseek-v4-flash-vision-exp", inputTypes: ["text", "image"] }],
}, { existingConfig: realCfg, previousKey: "baitestik" });
const renApplied = applyChangesVerified(REAL, ren.changes);
check("real config: rename applies", renApplied.ok, renApplied.error);
check("real config: old key is gone", getPath(renApplied.text, ["provider", "baitestik"]) === undefined);
eq("real config: default model repointed", getPath(renApplied.text, ["model"]), "bai-eu/deepseek-v4-flash-vision-exp");
eq("real config: renamed block keeps its baseURL", getPath(renApplied.text, ["provider", "bai-eu", "options", "baseURL"]), "https://eu.b.ai/v1");
check("real config: the dropped model is deleted",
  getPath(renApplied.text, ["provider", "bai-eu", "models", "deepseek-v4-flash"]) === undefined);
check("real config: rename keeps the comment", renApplied.text.includes("must survive"));

// Removal on the real shape.
const del = buildRemovalChanges("baitestik", realCfg);
const delApplied = applyChangesVerified(REAL, del.changes);
check("real config: removal applies", delApplied.ok, delApplied.error);
check("real config: provider removed", getPath(delApplied.text, ["provider", "baitestik"]) === undefined);
eq("real config: default model repointed after removal", getPath(delApplied.text, ["model"]), "other/z");
eq("real config: mcp intact after removal", getPath(delApplied.text, ["mcp", "godot-ai", "enabled"]), true);

// Applying the same change twice must produce the same file.
const once = applyChangesVerified(REAL, edit.changes).text;
const twice = applyChangesVerified(once, buildProviderChanges({
  key: "baitestik", name: "baitestik", displayName: "BAI",
  baseURL: "https://api.b.ai/v1", useEnvVar: true, envVarName: "BAI_API_KEY",
  models: [
    { id: "deepseek-v4-flash", contextWindow: 128000, maxOutput: 8000 },
    { id: "deepseek-v4-flash-vision-exp", inputTypes: ["text", "image"] },
  ],
}, { existingConfig: parseJsonc(once).value, previousKey: "baitestik" }).changes).text;
eq("applying the same change twice is idempotent", twice, once);

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.log("failed:\n  " + fails.join("\n  "));
  process.exit(1);
}
