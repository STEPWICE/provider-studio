// verify-rescue.mjs
// Covers the safety net: snapshots/restore, config validation, the SSRF guard
// on outbound probes, and /models normalisation.
//
// These are the paths where a mistake is expensive: restore overwrites the live
// config, and the probe helpers fetch a URL supplied by the browser.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

// The data dir must be redirected before the module is imported, so a stray
// restore can never touch the developer's real backup history.
const root = mkdtempSync(join(tmpdir(), "ps-rescue-"));
process.env.PS_DATA_DIR = join(root, "data");
delete process.env.PS_BLOCK_LOCAL_PROBE;

const R = await import("./src/rescue.mjs");

// --------------------------------------------------------------- backups

const CONFIG = join(root, "opencode.jsonc");
const ORIGINAL = '{\n  // keep me\n  "$schema": "https://opencode.ai/config.json",\n  "provider": { "a": { "npm": "@ai-sdk/openai-compatible", "models": { "m": {} } } },\n  "model": "a/m",\n}\n';
writeFileSync(CONFIG, ORIGINAL, "utf8");

eq("backups live under PS_DATA_DIR", R.backupDir(), join(root, "data", "backups"));
check("a missing file yields no snapshot", R.backupConfig(join(root, "nope.jsonc")) === null);
eq("no backups before the first snapshot", R.listBackups(), []);

const b1 = R.backupConfig(CONFIG, "first");
check("backupConfig returns a path", !!b1 && existsSync(b1), String(b1));
check("the snapshot is byte-identical", readFileSync(b1, "utf8") === ORIGINAL);
check("the snapshot keeps comments", readFileSync(b1, "utf8").includes("// keep me"));
check("the label appears in the name", /first/.test(String(b1)), String(b1));
eq("one backup is listed", R.listBackups().length, 1);

// Several writes inside one second are routine; a second-resolution name alone
// silently overwrote the earlier snapshot.
const b2 = R.backupConfig(CONFIG, "first");
const b3 = R.backupConfig(CONFIG, "first");
check("same-second snapshots do not collide", b1 !== b2 && b2 !== b3, [b1, b2, b3].join("\n"));
eq("all three are kept", R.listBackups().length, 3);
check("a label with path characters is sanitised",
  !/[\\/:]/.test(String(R.backupConfig(CONFIG, "../../etc/passwd")).split(/[\\/]/).pop()),
  String(R.backupConfig(CONFIG, "../../etc/passwd")));

// ---------------------------------------------------------------- restore

const listed = R.listBackups()[0].file;
const good = R.restoreBackup(listed);
check("restore accepts a listed snapshot", good.ok === true, JSON.stringify(good).slice(0, 200));
check("restore returns the parsed config", good.config?.provider?.a?.npm === "@ai-sdk/openai-compatible", JSON.stringify(good.config));
check("restore returns the raw text too", typeof good.raw === "string" && good.raw.includes("// keep me"));

// A backup legitimately contains comments and trailing commas. The previous
// JSON.parse-based check rejected both, so a valid snapshot looked corrupt.
check("a snapshot with comments and a trailing comma is restorable",
  R.restoreBackup(listed).ok === true, JSON.stringify(R.restoreBackup(listed)).slice(0, 200));

for (const bad of ["../../../opencode.jsonc", "..\\..\\opencode.jsonc", CONFIG, "/etc/passwd", "", "   ", "nope.jsonc"]) {
  check(`restore refuses ${JSON.stringify(bad)}`, R.restoreBackup(bad).ok === false, JSON.stringify(R.restoreBackup(bad)));
}
// A traversal that ends in a real backup name must still be refused: accepting
// it would mean the path, not the listing, decided what gets read.
check("restore refuses a traversal that ends in a valid name",
  R.restoreBackup("../backups/" + listed).ok === false,
  JSON.stringify(R.restoreBackup("../backups/" + listed)));

// A corrupt snapshot must be reported, not restored over a working config.
writeFileSync(join(R.backupDir(), "opencode-20200101-000000-broken.jsonc"), "{ this is not json", "utf8");
const broken = R.restoreBackup("opencode-20200101-000000-broken.jsonc");
check("a corrupt snapshot is refused", broken.ok === false && /повреждён/.test(broken.error), JSON.stringify(broken));
writeFileSync(join(R.backupDir(), "opencode-20200101-000001-array.jsonc"), "[1,2,3]", "utf8");
check("a non-object snapshot is refused", R.restoreBackup("opencode-20200101-000001-array.jsonc").ok === false);

// Pruning keeps the history bounded.
for (let i = 0; i < 40; i++) R.backupConfig(CONFIG, "bulk" + i);
check("pruning caps the history at 30", R.listBackups().length <= 30, String(R.listBackups().length));
check("the newest snapshot survives pruning", /bulk39/.test(R.listBackups()[0].file), R.listBackups()[0].file);

// ------------------------------------------------------------- stripJsonc

eq("stripJsonc drops a line comment", JSON.parse(R.stripJsonc('{ "a": 1 } // tail')), { a: 1 });
eq("stripJsonc drops a block comment", JSON.parse(R.stripJsonc('{ /* x */ "a": 1 }')), { a: 1 });
// Trailing commas are valid JSONC; leaving them broke JSON.parse downstream.
eq("stripJsonc drops a trailing comma", JSON.parse(R.stripJsonc('{ "a": 1, }')), { a: 1 });
eq("stripJsonc drops nested trailing commas", JSON.parse(R.stripJsonc('{ "a": [1, 2,], "b": { "c": 3, }, }')), { a: [1, 2], b: { c: 3 } });
eq("stripJsonc keeps // inside a string", JSON.parse(R.stripJsonc('{ "u": "https://x.dev/v1" }')), { u: "https://x.dev/v1" });
eq("stripJsonc keeps an escaped quote", JSON.parse(R.stripJsonc('{ "q": "a\\"b" }')), { q: 'a"b' });

// ------------------------------------------------------------- validation

function ids(config) {
  return R.validateConfig(config).map((i) => i.id);
}
function has(config, id) {
  return ids(config).includes(id);
}

check("a non-object config is rejected", has(null, "not-object") && has("x", "not-object"));
check("an array config is rejected", has([], "not-object"));
check("a missing provider block is reported", has({}, "no-provider"));
// The referenced variable is set, so this config is genuinely complete: an
// unset variable is itself an error now (see the env-missing checks below), so
// leaving it unset here would no longer be testing structural validity.
process.env.A_KEY = "sk-valid-for-test";
const VALID_CONFIG = {
  provider: { a: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://a.dev/v1", apiKey: "{env:A_KEY}" }, models: { m: { name: "m", limit: { context: 1000, output: 100 } } } } },
  model: "a/m",
};
check("a valid config reports no error",
  R.validateConfig(VALID_CONFIG).filter((i) => i.severity === "error").length === 0,
  JSON.stringify(R.validateConfig(VALID_CONFIG)));

// additionalProperties:false — one stray field invalidates the whole config.
check("an unknown provider field is an error",
  has({ provider: { a: { npm: "x", baseUrl: "typo", models: {} } } }, "unknown-provider-field"));
check("an unknown model field is an error",
  has({ provider: { a: { npm: "x", models: { m: { contextWindow: 999 } } } } }, "unknown-model-field"));
check("a known model field is accepted",
  !has({ provider: { a: { npm: "x", models: { m: { interleaved: true } } } } }, "unknown-model-field"));

// apiKey at the top level is never sent, so auth fails with no visible cause.
check("apiKey on the provider root is an error",
  has({ provider: { a: { npm: "x", apiKey: "sk-1", models: {} } } }, "apikey-top-level"));
check("baseURL on the provider root is an error",
  has({ provider: { a: { npm: "x", baseURL: "https://a.dev", models: {} } } }, "baseurl-top-level"));
// It breaks additionalProperties:false either way, so it is still reported when
// options carries a baseURL too — only the wording changes.
check("a duplicated root baseURL is still reported",
  has({ provider: { a: { npm: "x", baseURL: "https://a.dev", options: { baseURL: "https://a.dev" }, models: {} } } }, "baseurl-top-level"));
check("the duplicate case says so",
  /дублирует/.test(R.validateConfig({ provider: { a: { npm: "x", baseURL: "https://a.dev", options: { baseURL: "https://a.dev" }, models: {} } } })
    .find((i) => i.id === "baseurl-top-level")?.message || ""));
// A misplaced field must not be reported twice, once generically and once
// specifically — that reads as two separate problems.
eq("a misplaced apiKey is reported exactly once",
  R.validateConfig({ provider: { a: { name: "A", apiKey: "sk-1" } } }).filter((i) => i.id === "unknown-provider-field").length, 0);
check("a genuine typo is still caught generically",
  has({ provider: { a: { npm: "x", baseUrl: "https://a.dev", models: {} } } }, "unknown-provider-field"));

// A custom block with an address but no credential authenticates as "".
check("a keyless public provider warns about credentials",
  has({ provider: { a: { npm: "x", options: { baseURL: "https://a.dev/v1" }, models: { m: {} } } } }, "no-credentials"));
check("no-credentials stays quiet when a key exists",
  !has({ provider: { a: { npm: "x", options: { baseURL: "https://a.dev/v1", apiKey: "{env:A_KEY}" }, models: { m: {} } } } }, "no-credentials"));
check("no-credentials stays quiet for localhost gateways",
  !has({ provider: { a: { npm: "x", options: { baseURL: "http://127.0.0.1:11434/v1" }, models: { m: {} } } } }, "no-credentials"));
check("no-credentials stays quiet for package providers without a baseURL",
  !has({ provider: { a: { npm: "@ai-sdk/anthropic", models: { m: {} } } } }, "no-credentials"));

// A bare $VAR is sent verbatim as the credential.
check("$VAR is reported as a bad env reference",
  has({ provider: { a: { npm: "x", options: { apiKey: "$MY_KEY" }, models: {} } } }, "bad-env-ref"));
check("${VAR} is reported too",
  has({ provider: { a: { npm: "x", options: { apiKey: "${MY_KEY}" }, models: {} } } }, "bad-env-ref"));
check("the suggestion uses {env:...}",
  R.validateConfig({ provider: { a: { npm: "x", options: { apiKey: "$MY_KEY" }, models: {} } } })
    .find((i) => i.id === "bad-env-ref")?.suggest === "{env:MY_KEY}");
check("a plaintext key is flagged",
  has({ provider: { a: { npm: "x", options: { apiKey: "sk-abcdef123456" }, models: {} } } }, "plaintext-key"));
check("a malformed {env:} is an error",
  has({ provider: { a: { npm: "x", options: { apiKey: "{env:}" }, models: {} } } }, "malformed-env-ref"));
process.env.PS_TEST_KEY_PRESENT = "yes";
check("a set env var is not reported missing",
  !has({ provider: { a: { npm: "x", options: { apiKey: "{env:PS_TEST_KEY_PRESENT}" }, models: {} } } }, "env-missing"));
delete process.env.PS_TEST_KEY_ABSENT;
const ABSENT_CFG = { provider: { a: { npm: "x", options: { apiKey: "{env:PS_TEST_KEY_ABSENT}" }, models: {} } } };
check("an unset env var is reported", has(ABSENT_CFG, "env-missing"));
// This is the failure that produced a silently broken provider: opencode
// substitutes "" for a missing variable, so the 401 is guaranteed rather than
// merely possible. On Windows every persistent scope is visible, so the verdict
// is certain and must be an error; elsewhere the variable could come from a
// wrapper this process cannot see, so a warning is the honest severity.
{
  const found = R.validateConfig(ABSENT_CFG).find((i) => i.id === "env-missing");
  const wanted = process.platform === "win32" ? "error" : "warn";
  eq("an unset env var carries the severity the platform can justify", found?.severity, wanted);
  // The message has to name the fix, not just the symptom.
  check("the env-missing message includes the command that fixes it",
    /setx|export/.test(found?.message || ""), found?.message);
  check("the env-missing message explains the 401",
    /401/.test(found?.message || ""), found?.message);
}
// A variable holding only whitespace authenticates exactly as badly as a
// missing one, and is far harder to spot by eye.
process.env.PS_TEST_KEY_BLANK = "   ";
check("a whitespace-only env var counts as unset",
  has({ provider: { a: { npm: "x", options: { apiKey: "{env:PS_TEST_KEY_BLANK}" }, models: {} } } }, "env-missing"));
delete process.env.PS_TEST_KEY_BLANK;

// options.timeout must be a positive number; env must hold valid var names.
check("a string timeout is an error",
  has({ provider: { a: { npm: "x", options: { timeout: "fast" }, models: {} } } }, "bad-timeout"));
check("a zero timeout is an error",
  has({ provider: { a: { npm: "x", options: { timeout: 0 }, models: {} } } }, "bad-timeout"));
check("a positive timeout is accepted",
  !has({ provider: { a: { npm: "x", options: { timeout: 30000 }, models: {} } } }, "bad-timeout"));
check("a non-array env is an error",
  has({ provider: { a: { npm: "x", env: "FOO", models: {} } } }, "bad-env"));
check("an invalid env entry is an error",
  has({ provider: { a: { npm: "x", env: ["GOOD_KEY", "has-dash"], models: {} } } }, "bad-env-name"));
check("valid env entries are accepted",
  !has({ provider: { a: { npm: "x", env: ["GOOD_KEY"], models: {} } } }, "bad-env-name"));
// Two providers on one address are almost always a copy-paste. A warning, not
// an error: mirrors of one gateway exist on purpose.
{
  const dup = R.validateConfig({ provider: {
    a: { npm: "x", options: { baseURL: "https://same.dev/v1/" }, models: {} },
    b: { npm: "x", options: { baseURL: "https://same.dev/v1" }, models: {} },
  } });
  check("a shared baseURL is reported",
    dup.some((i) => i.id === "duplicate-baseurl"), JSON.stringify(dup.map((i) => i.id)));
  check("a shared baseURL is only a warning",
    dup.filter((i) => i.id === "duplicate-baseurl").every((i) => i.severity === "warn"));
  check("distinct baseURLs are not reported",
    !has({ provider: {
      a: { npm: "x", options: { baseURL: "https://one.dev/v1" }, models: {} },
      b: { npm: "x", options: { baseURL: "https://two.dev/v1" }, models: {} },
    } }, "duplicate-baseurl"));
}

// Anthropic-compatible endpoints need a version header to authenticate.
check("a raw anthropic block without anthropic-version is flagged",
  has({ provider: { a: { api: "anthropic", options: { baseURL: "https://a.dev" }, models: {} } } }, "no-anthropic-version"));
check("the official anthropic package is not flagged",
  !has({ provider: { a: { npm: "@ai-sdk/anthropic", options: { baseURL: "https://a.dev" }, models: {} } } }, "no-anthropic-version"));
check("an explicit anthropic-version satisfies the check",
  !has({ provider: { a: { api: "anthropic", options: { baseURL: "https://a.dev", headers: { "anthropic-version": "2023-06-01" } } , models: {} } } }, "no-anthropic-version"));
check("the header check is case-insensitive",
  !has({ provider: { a: { api: "anthropic", options: { baseURL: "https://a.dev", headers: { "Anthropic-Version": "2023-06-01" } }, models: {} } } }, "no-anthropic-version"));
check("an openai provider is not asked for anthropic headers",
  !has({ provider: { a: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://a.dev" }, models: {} } } }, "no-anthropic-version"));

// limit/cost are all-or-nothing in the schema.
check("a half-filled limit is an error",
  has({ provider: { a: { npm: "x", models: { m: { limit: { context: 1000 } } } } } }, "partial-limit"));
check("a complete limit is accepted",
  !has({ provider: { a: { npm: "x", models: { m: { limit: { context: 1000, output: 100 } } } } } }, "partial-limit"));
check("a half-filled cost is an error",
  has({ provider: { a: { npm: "x", models: { m: { cost: { input: 1 } } } } } }, "partial-cost"));
check("output larger than context is a warning",
  has({ provider: { a: { npm: "x", models: { m: { limit: { context: 100, output: 1000 } } } } } }, "output-over-context"));
check("a non-object limit is an error",
  has({ provider: { a: { npm: "x", models: { m: { limit: 1000 } } } } }, "bad-limit"));

// Modalities and status come from closed enums.
check("an unknown modality is an error",
  has({ provider: { a: { npm: "x", models: { m: { modalities: { input: ["text", "hologram"] } } } } } }, "bad-modality"));
check("every documented modality is accepted",
  !has({ provider: { a: { npm: "x", models: { m: { attachment: true, modalities: { input: ["text", "image", "video", "audio", "pdf"] } } } } } }, "bad-modality"));
check("a missing text input is a warning",
  has({ provider: { a: { npm: "x", models: { m: { attachment: true, modalities: { input: ["image"] } } } } } }, "no-text-input"));
check("non-text input without attachment is a warning",
  has({ provider: { a: { npm: "x", models: { m: { modalities: { input: ["text", "image"] } } } } } }, "no-attachment"));
check("attachment:true clears that warning",
  !has({ provider: { a: { npm: "x", models: { m: { attachment: true, modalities: { input: ["text", "image"] } } } } } }, "no-attachment"));
check("an unknown status is an error",
  has({ provider: { a: { npm: "x", models: { m: { status: "cooked" } } } } }, "bad-status"));
check("a documented status is accepted",
  !has({ provider: { a: { npm: "x", models: { m: { status: "beta" } } } } }, "bad-status"));
check("a malformed release_date is a warning",
  has({ provider: { a: { npm: "x", models: { m: { release_date: "01/02/2024" } } } } }, "bad-release-date"));

// A dangling default model stops opencode from starting.
check("a dangling model is reported", has({ provider: { a: { npm: "x", models: {} } }, model: "a/ghost" }, "bad-default"));
check("a dangling small_model is reported too",
  has({ provider: { a: { npm: "x", models: { m: {} } } }, model: "a/m", small_model: "a/ghost" }, "bad-small-model"));
check("a valid small_model is accepted",
  !has({ provider: { a: { npm: "x", models: { m: {} } } }, model: "a/m", small_model: "a/m" }, "bad-small-model"));
check("a model without a slash is an error",
  has({ provider: { a: { npm: "x", models: { m: {} } } }, model: "justamodel" }, "bad-model-format"));
check("a missing default model is a warning", has({ provider: { a: { npm: "x", models: {} } } }, "no-default"));
check("a model id containing a slash still resolves",
  !has({ provider: { a: { npm: "x", models: { "org/m": {} } } }, model: "a/org/m" }, "bad-default"));
// A package in `name` was written by older versions of this tool.
check("a package in name is an error",
  has({ provider: { a: { name: "@ai-sdk/openai-compatible", models: {} } } }, "npm-as-name"));
check("local providers are skipped", ids({ provider: { l: { type: "local", whatever: 1 } } }).every((i) => i !== "unknown-provider-field"));

// -------------------------------------------------------------- SSRF guard

function allowed(url) {
  return R.validateProbeUrl(url).ok;
}
// Local model servers are the main use case, so they must work by default.
for (const u of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://192.168.1.50:8000/v1", "https://api.openai.com/v1", "http://[::ffff:127.0.0.1]/v1"]) {
  check(`probe allows ${u}`, allowed(u), u);
}
// The metadata range hands out cloud credentials and is never a model endpoint.
for (const u of ["http://169.254.169.254/latest/meta-data/", "http://metadata.google.internal/", "http://[::ffff:169.254.169.254]/", "http://[::ffff:a9fe:a9fe]/", "http://[fe80::1]/"]) {
  check(`probe blocks ${u}`, !allowed(u), u);
}
for (const u of ["file:///etc/passwd", "ftp://x.dev/", "gopher://x.dev/", "http://user:pw@x.dev/", "", "   ", "not a url", "//x.dev/v1"]) {
  check(`probe rejects ${JSON.stringify(u)}`, !allowed(u), u);
}
check("the metadata block cannot be opted out of",
  !R.validateProbeUrl("http://169.254.169.254/", { blockLocal: false }).ok);
check("blockLocal closes off loopback",
  !R.validateProbeUrl("http://127.0.0.1:11434/v1", { blockLocal: true }).ok);
check("blockLocal leaves public URLs alone",
  R.validateProbeUrl("https://api.openai.com/v1", { blockLocal: true }).ok);
check("isPrivateHost treats an empty host as private", R.isPrivateHost("") === true);
check("isPrivateHost knows .local", R.isPrivateHost("printer.local") === true);
check("isPrivateHost lets a public name through", R.isPrivateHost("api.openai.com") === false);
check("a trailing dot does not bypass the check", R.isMetadataHost("metadata.google.internal.") === true);

// A dead port must fail as a normal error rather than throw.
const dead = await R.testConnection({ baseURL: "http://127.0.0.1:1/v1" });
check("a dead endpoint reports failure", dead.ok === false, JSON.stringify(dead));
const blockedProbe = await R.testConnection({ baseURL: "http://169.254.169.254/" });
check("testConnection refuses the metadata address", blockedProbe.ok === false, JSON.stringify(blockedProbe));
const deadModels = await R.fetchModels({ baseURL: "http://127.0.0.1:1/v1" });
check("fetchModels fails cleanly on a dead endpoint", deadModels.ok === false && Array.isArray(deadModels.models), JSON.stringify(deadModels));

// ------------------------------------------------- completion target/body
// A responses-only endpoint answers /chat/completions with 404. Probing it the
// chat way reported a working provider as a dead model, so the format decides
// both the path and the body shape.
{
  eq("chat posts to /chat/completions",
    R.completionTarget("https://x.dev/v1", "openai-chat"), "https://x.dev/v1/chat/completions");
  eq("a version anywhere in the path suppresses the extra /v1",
    R.completionTarget("https://x.dev/v1beta/openai", "openai-chat"), "https://x.dev/v1beta/openai/chat/completions");
  eq("a bare host gets /v1",
    R.completionTarget("https://x.dev/openai", "openai-chat"), "https://x.dev/openai/v1/chat/completions");
  eq("anthropic posts to /messages",
    R.completionTarget("https://x.dev/v1", "anthropic"), "https://x.dev/v1/messages");
  eq("responses posts to /responses",
    R.completionTarget("https://x.dev/v1", "openai-responses"), "https://x.dev/v1/responses");
  eq("responses keeps the version rule too",
    R.completionTarget("https://x.dev/openai", "openai-responses"), "https://x.dev/openai/v1/responses");

  const chat = R.completionBody("m", "openai-chat");
  eq("chat sends messages without streaming", [chat.model, chat.max_tokens, chat.stream, Array.isArray(chat.messages)],
    ["m", 16, false, true]);
  const anth = R.completionBody("m", "anthropic");
  check("anthropic sends no stream flag", anth.stream === undefined, JSON.stringify(anth));
  const resp = R.completionBody("m", "openai-responses");
  eq("responses speaks its own body", [resp.model, resp.input, resp.max_output_tokens, resp.messages],
    ["m", "ping", 16, undefined]);
  check("the probe stays cheap in every format",
    [chat.max_tokens, resp.max_output_tokens].every((n) => n > 2 && n <= 32));
}

// ------------------------------------------------- probe auth headers
// Format decides the header name: an anthropic endpoint ignores Bearer, so
// sending the wrong one turns a valid key into a 401 that reads as a bad key.
{
  process.env.PS_PROBE_KEY = "sk-probe-123";
  const openai = R.probeHeaders("sk-literal", "openai-chat");
  eq("openai format authenticates with Bearer", openai.headers.Authorization, "Bearer sk-literal");
  check("openai format sends no x-api-key", openai.headers["x-api-key"] === undefined);

  const anthropic = R.probeHeaders("sk-literal", "anthropic-messages");
  eq("anthropic format uses x-api-key", anthropic.headers["x-api-key"], "sk-literal");
  eq("anthropic format pins the version", anthropic.headers["anthropic-version"], "2023-06-01");
  check("anthropic format sends no Bearer", anthropic.headers.Authorization === undefined);

  // An env reference must be resolved, not passed through as a literal: sending
  // "{env:FOO}" as the credential is a guaranteed 401.
  const resolved = R.probeHeaders("{env:PS_PROBE_KEY}", "openai-chat");
  eq("an {env:VAR} reference is resolved before sending", resolved.headers.Authorization, "Bearer sk-probe-123");
  eq("a resolved reference reports no problem", resolved.problem, "");
  const legacy = R.probeHeaders("$PS_PROBE_KEY", "openai-chat");
  eq("a legacy $VAR reference is resolved too", legacy.headers.Authorization, "Bearer sk-probe-123");

  // The regression this replaces: an unresolvable reference used to drop the
  // auth header silently, so the probe blamed the key instead of the variable.
  delete process.env.PS_PROBE_ABSENT;
  const missing = R.probeHeaders("{env:PS_PROBE_ABSENT}", "openai-chat");
  check("an unset reference is reported as a problem", missing.problem !== "", JSON.stringify(missing));
  check("the problem names the variable", /PS_PROBE_ABSENT/.test(missing.problem), missing.problem);
  check("no bogus credential is sent for an unset reference",
    missing.headers.Authorization === undefined && missing.headers["x-api-key"] === undefined);

  // Probing without a key is legitimate (some endpoints list models publicly).
  const anon = R.probeHeaders("", "openai-chat");
  eq("an empty key probes anonymously without complaint", anon.problem, "");
  check("an empty key sends no auth header", anon.headers.Authorization === undefined);

  // The probe must not even be attempted when the reference cannot resolve.
  const blocked = await R.testConnection({ baseURL: "https://example.invalid/v1", apiKey: "{env:PS_PROBE_ABSENT}" });
  check("testConnection refuses to probe with an unresolvable reference",
    blocked.ok === false && /PS_PROBE_ABSENT/.test(blocked.message), JSON.stringify(blocked));
  const blockedList = await R.fetchModels({ baseURL: "https://example.invalid/v1", apiKey: "{env:PS_PROBE_ABSENT}" });
  check("fetchModels refuses to probe with an unresolvable reference",
    blockedList.ok === false && /PS_PROBE_ABSENT/.test(blockedList.message), JSON.stringify(blockedList));
  delete process.env.PS_PROBE_KEY;
}

// ------------------------------------------------- 401: missing vs refused
// A 401 says nothing about which of the two it is; only the request we built
// knows whether a credential was attached. Collapsing them produced a badge
// reading "ключ не принят" above a line reading "ключ не отправлен".
{
  const http = await import("node:http");
  const unauthorized = http.createServer((rq, rs) => {
    const sent = rq.headers.authorization || rq.headers["x-api-key"];
    rs.writeHead(401, { "content-type": "application/json" });
    rs.end(JSON.stringify({ error: { message: sent ? "Invalid API key" : "Missing credentials" } }));
  });
  await new Promise((r) => unauthorized.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${unauthorized.address().port}/v1`;

  const anon = await R.testConnection({ baseURL: base, apiFormat: "openai-chat", apiKey: "" });
  eq("testConnection: a 401 with no key sent is fault=nokey", anon.fault, "nokey");
  check("the endpoint is still reported as reachable", anon.reach === "up", JSON.stringify(anon));
  check("the message does not claim the key was rejected",
    !/не принят/.test(anon.message) && /не отправлен/.test(anon.message), anon.message);

  const withKey = await R.testConnection({ baseURL: base, apiFormat: "openai-chat", apiKey: "sk-wrong" });
  eq("testConnection: a 401 with a key sent is fault=key", withKey.fault, "key");

  const anonModels = await R.fetchModels({ baseURL: base, apiFormat: "openai-chat", apiKey: "" });
  eq("fetchModels: a 401 with no key sent is fault=nokey", anonModels.fault, "nokey");
  const keyModels = await R.fetchModels({ baseURL: base, apiFormat: "openai-chat", apiKey: "sk-wrong" });
  eq("fetchModels: a 401 with a key sent is fault=key", keyModels.fault, "key");

  // anthropic authenticates with x-api-key, so a header-name mixup here would
  // silently reclassify a real key as "never sent".
  const anthKey = await R.testConnection({ baseURL: base, apiFormat: "anthropic-messages", apiKey: "sk-anth" });
  eq("an anthropic x-api-key counts as a key that was sent", anthKey.fault, "key");

  await new Promise((r) => unauthorized.close(r));
}

// --------------------------------------------------------- model parsing

eq("an empty payload yields nothing", R.parseModels({}), []);
eq("null is handled", R.parseModels(null), []);
eq("a bare array is accepted", R.parseModels(["a", "b"]).map((m) => m.id), ["a", "b"]);
eq("OpenAI's data[] is accepted", R.parseModels({ data: [{ id: "x" }] }).map((m) => m.id), ["x"]);
eq("Google's models[] is accepted", R.parseModels({ models: [{ name: "models/gemini-2.0-flash" }] }).map((m) => m.id), ["gemini-2.0-flash"]);
// Duplicate ids would collide as config keys, silently overwriting each other.
eq("duplicate ids are collapsed", R.parseModels({ data: [{ id: "dup" }, { id: "dup" }] }).length, 1);
eq("entries without an id are skipped", R.parseModels({ data: [{ id: "" }, {}, { id: "keep" }] }).map((m) => m.id), ["keep"]);

const nums = R.parseModels({ data: [
  { id: "a", context_length: 128000, max_completion_tokens: 4096 },
  { id: "b", limit: { context: 200000, output: 8192 } },
  { id: "c", top_provider: { context_length: 64000, max_completion_tokens: 2048 } },
  { id: "d", input_token_limit: 32000, output_token_limit: 1024 },
  { id: "e", context_length: "16000" },
  { id: "f", limit: null },
] });
eq("context/output from flat fields", [nums[0].contextWindow, nums[0].maxOutput], [128000, 4096]);
eq("context/output from limit{}", [nums[1].contextWindow, nums[1].maxOutput], [200000, 8192]);
eq("context/output from top_provider", [nums[2].contextWindow, nums[2].maxOutput], [64000, 2048]);
eq("Google's token-limit spelling", [nums[3].contextWindow, nums[3].maxOutput], [32000, 1024]);
eq("a numeric string is coerced", nums[4].contextWindow, 16000);
eq("a null limit does not throw", [nums[5].contextWindow, nums[5].maxOutput], [0, 0]);

const caps = R.parseModels({ data: [
  { id: "gpt-4o" }, { id: "deepseek-r1" }, { id: "llama-3-8b:free" }, { id: "plain-text-model" },
  { id: "explicit", architecture: { input_modalities: ["text", "image"] } },
  { id: "str-mod", architecture: { modality: "text+image->text" } },
] });
check("vision is inferred from the name", caps[0].inputTypes.includes("image") && caps[0].vision === true, JSON.stringify(caps[0]));
check("reasoning is inferred from the name", caps[1].reasoning === true, JSON.stringify(caps[1]));
check("free is inferred from the name", caps[2].free === true, JSON.stringify(caps[2]));
eq("a plain model stays text-only", caps[3].inputTypes, ["text"]);
eq("explicit modalities win over the guess", caps[4].inputTypes, ["text", "image"]);
eq("a string modality is parsed", caps[5].inputTypes, ["text", "image"]);
check("output is always text", caps.every((m) => JSON.stringify(m.outputTypes) === '["text"]'));
eq("the models/ prefix is stripped from the name",
  R.parseModels({ models: [{ name: "models/gemini-pro" }] })[0].name, "gemini-pro");

// ------------------------------------------------------------ free vs paid
// Picking a free model is the point of the feature, so a wrong verdict here
// costs the user real money. The old rule was /free/i over the model id: on a
// live xkiro list that found 17 of the 36 actually-free models and also matched
// "freeway". A declared tier or price is a fact and must beat the name.
{
  const priced = R.parseModels({ data: [
    // xkiro: explicit tier + per-1m unit.
    { id: "free-tier", access_tier: "free", pricing: { unit: "per_1m_tokens", input: 0, output: 0 } },
    { id: "paid-tier", access_tier: "paid", pricing: { unit: "per_1m_tokens", input: 0.75, output: 1.5 } },
    { id: "premium-tier", access_tier: "premium", pricing: { unit: "per_1m_tokens", input: 0.975, output: 4.875 } },
    // OpenRouter: dollars per single token, no unit field.
    { id: "or-paid", pricing: { prompt: "0.0000025", completion: "0.00001" } },
    { id: "or-free", pricing: { prompt: "0", completion: "0" } },
    // No pricing information at all.
    { id: "silent" },
    // Name is the last resort only.
    { id: "vendor/model:free" },
    { id: "freeway-optimizer" },
  ] });
  const by = Object.fromEntries(priced.map((m) => [m.id, m]));

  check("a declared free tier is free", by["free-tier"].free === true, JSON.stringify(by["free-tier"]));
  eq("a declared tier is recorded as the source", by["free-tier"].freeSource, "tier");
  check("a paid tier is not free", by["paid-tier"].free === false);
  check("a premium tier is not free", by["premium-tier"].free === false);

  // The unit matters: reading per-token dollars as per-1M understates the cost
  // by a factor of a million, which is worse than showing nothing.
  eq("per-1m pricing is taken as-is", [by["paid-tier"].costInput, by["paid-tier"].costOutput], [0.75, 1.5]);
  eq("per-token pricing is scaled to per-1m", [by["or-paid"].costInput, by["or-paid"].costOutput], [2.5, 10]);
  check("a zero price with no tier means free", by["or-free"].free === true, JSON.stringify(by["or-free"]));
  eq("a price-derived verdict says so", by["or-free"].freeSource, "price");

  // "Unknown" is not "free": defaulting to free would invite a surprise bill.
  check("a model with no pricing is not called free", by["silent"].free === false, JSON.stringify(by["silent"]));
  eq("an unknowable verdict is labelled unknown", by["silent"].freeSource, "unknown");
  eq("no pricing means no cost numbers", [by["silent"].costInput, by["silent"].costOutput], [null, null]);

  check("a :free suffix still works when nothing else is known", by["vendor/model:free"].free === true);
  eq("a name-derived verdict is marked as a guess", by["vendor/model:free"].freeSource, "name");
  check("'freeway' is not mistaken for a free model", by["freeway-optimizer"].free === false,
    JSON.stringify(by["freeway-optimizer"]));

  // A tier must win over a contradicting name, or ":free" on a billed model
  // (a real naming pattern) reads as free.
  const conflict = R.parseModels({ data: [{ id: "trap/model:free", access_tier: "paid", pricing: { unit: "per_1m_tokens", input: 3, output: 6 } }] })[0];
  check("a paid tier overrides a ':free' name", conflict.free === false, JSON.stringify(conflict));

  // Cache prices ride the same unit conversion.
  const cache = R.parseModels({ data: [{ id: "c", pricing: { unit: "per_1m_tokens", input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 } }] })[0];
  eq("cache pricing is carried through", [cache.costCacheRead, cache.costCacheWrite], [0.1, 0.2]);

  // Declared capabilities beat name guessing, same principle as pricing.
  const declared = R.parseModels({ data: [
    { id: "plain-name", capabilities: { vision: true, reasoning: true } },
    { id: "deepseek-r1", capabilities: { reasoning: false } },
  ] });
  check("a declared vision capability is honoured", declared[0].vision === true, JSON.stringify(declared[0]));
  check("a declared reasoning:false overrides the name guess", declared[1].reasoning === false, JSON.stringify(declared[1]));

  // display_name is what the provider wants shown; the id stays the key.
  const dn = R.parseModels({ data: [{ id: "z-ai/glm-4.7-flash", display_name: "GLM-4.7 Flash" }] })[0];
  eq("display_name is used for the label", dn.name, "GLM-4.7 Flash");
  eq("the id is left untouched", dn.id, "z-ai/glm-4.7-flash");
}

// ------------------------------------------------------- probe error classes
// The point of the classifier is to keep "their server is down" apart from
// "your key is wrong". Collapsing the two is what sent users to regenerate a
// token that was never the problem.

const P = await import("./src/proxy.mjs");

const classCases = [
  ["timeout", Object.assign(new Error("x"), { name: "TimeoutError" }), "timeout"],
  ["abort", Object.assign(new Error("x"), { name: "AbortError" }), "timeout"],
  ["dns", { cause: { code: "ENOTFOUND" } }, "dns"],
  ["dns retry", { cause: { code: "EAI_AGAIN" } }, "dns"],
  ["refused", { cause: { code: "ECONNREFUSED" } }, "refused"],
  ["reset", { cause: { code: "ECONNRESET" } }, "reset"],
  ["tls", { cause: { code: "CERT_HAS_EXPIRED" } }, "tls"],
  ["unreachable", { cause: { code: "EHOSTUNREACH" } }, "unreachable"],
  ["proxy", Object.assign(new Error("прокси ответил 407"), { proxyFault: true }), "proxy"],
  ["unknown", new Error("something else"), "network"],
];
for (const [label, err, want] of classCases) {
  eq(`classifyProbeError: ${label}`, R.classifyProbeError(err).kind, want);
}
// A dual-stack failure arrives as an AggregateError whose own code is unset.
eq("classifyProbeError digs into AggregateError members",
  R.classifyProbeError({ cause: { errors: [{ code: "ECONNREFUSED" }] } }).kind, "refused");
check("every class carries a label", classCases.every(([, e]) => R.classifyProbeError(e).label));

// --------------------------------------------------------------------- proxy

eq("parseProxyUrl accepts a bare host:port",
  (() => { const p = P.parseProxyUrl("127.0.0.1:10808"); return [p.host, p.port, p.protocol]; })(),
  ["127.0.0.1", 10808, "http:"]);
eq("parseProxyUrl keeps credentials",
  (() => { const p = P.parseProxyUrl("http://u:p%40ss@proxy:3128"); return [p.username, p.password, p.port]; })(),
  ["u", "p@ss", 3128]);
eq("parseProxyUrl defaults the port by scheme", P.parseProxyUrl("https://proxy").port, 443);
check("parseProxyUrl rejects socks", P.parseProxyUrl("socks5://127.0.0.1:1080") === null);
check("parseProxyUrl rejects junk", P.parseProxyUrl("   ") === null && P.parseProxyUrl("http://") === null);

check("matchesNoProxy matches an exact host", P.matchesNoProxy("api.example.com", "api.example.com"));
check("matchesNoProxy matches a dot-prefixed suffix", P.matchesNoProxy("api.example.com", ".example.com"));
check("matchesNoProxy matches a wildcard suffix", P.matchesNoProxy("api.example.com", "*.example.com"));
check("matchesNoProxy honours *", P.matchesNoProxy("anything.test", "*"));
check("matchesNoProxy ignores a port suffix", P.matchesNoProxy("example.com", "example.com:443"));
check("matchesNoProxy does not match a sibling", !P.matchesNoProxy("notexample.com", "example.com"));
check("matchesNoProxy on an empty list is false", !P.matchesNoProxy("example.com", ""));

const proxyEnv = { HTTPS_PROXY: "http://127.0.0.1:10808", HTTP_PROXY: "http://127.0.0.1:10808" };
// `useSystem: false` keeps the assertions independent of whatever proxy the
// machine running the tests happens to have configured in Windows.
const viaProxy = (url, env = proxyEnv) => P.proxyForUrl(url, { env, useCache: false, useSystem: false });
check("a public https target goes through the proxy", viaProxy("https://api.openai.com/v1")?.port === 10808);
// A local model server is the one case where proxying is certainly wrong.
check("loopback is never proxied", viaProxy("http://127.0.0.1:11434/v1") === null);
check("localhost is never proxied", viaProxy("http://localhost:1234/v1") === null);
check("an RFC1918 target is never proxied", viaProxy("http://192.168.1.50:8000/v1") === null);
check("NO_PROXY wins over HTTPS_PROXY",
  viaProxy("https://api.example.com/v1", { ...proxyEnv, NO_PROXY: ".example.com" }) === null);
check("lowercase https_proxy is honoured",
  viaProxy("https://api.openai.com/v1", { https_proxy: "http://127.0.0.1:8888" })?.port === 8888);
check("all_proxy is the fallback",
  viaProxy("https://api.openai.com/v1", { ALL_PROXY: "http://127.0.0.1:7777" })?.port === 7777);
check("no proxy configured means a direct connection",
  viaProxy("https://api.openai.com/v1", {}) === null);
check("a proxy pointing at itself is skipped",
  viaProxy("http://127.0.0.1:10808/v1", proxyEnv) === null);
eq("describeProxy is readable",
  P.describeProxy(P.parseProxyUrl("http://127.0.0.1:10808")), "http://127.0.0.1:10808");
check("describeProxy on null is empty", P.describeProxy(null) === "");

// An end-to-end hop through a real CONNECT proxy. The logic tests above only
// prove which proxy is chosen; this proves the bytes actually travel through
// it, including the auth header and the tunnel handshake.
{
  const http = await import("node:http");
  const net = await import("node:net");

  const origin = http.createServer((rq, rs) => {
    rs.writeHead(200, { "content-type": "application/json" });
    rs.end(JSON.stringify({ data: [{ id: "through-proxy" }] }));
  });
  await new Promise((r) => origin.listen(0, "127.0.0.1", r));
  const originPort = origin.address().port;

  let sawConnect = "";
  let sawAuth = "";
  let sawAbsoluteForm = "";
  const proxySrv = http.createServer((rq, rs) => {
    // Plain http through a proxy uses the absolute-form request target.
    sawAbsoluteForm = rq.url;
    sawAuth = rq.headers["proxy-authorization"] || "";
    const u = new URL(rq.url);
    const relay = http.request(
      { host: u.hostname, port: u.port, path: u.pathname, method: "GET", headers: { ...rq.headers, host: u.host } },
      (r2) => { rs.writeHead(r2.statusCode, r2.headers); r2.pipe(rs); },
    );
    relay.on("error", () => { rs.writeHead(502); rs.end(); });
    relay.end();
  });
  proxySrv.on("connect", (rq, clientSock) => {
    sawConnect = rq.url;
    sawAuth = rq.headers["proxy-authorization"] || "";
    const [h, p] = rq.url.split(":");
    const up = net.connect(Number(p), h, () => {
      clientSock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.pipe(clientSock); clientSock.pipe(up);
    });
    up.on("error", () => clientSock.destroy());
  });
  await new Promise((r) => proxySrv.listen(0, "127.0.0.1", r));
  const proxyPort = proxySrv.address().port;

  const proxy = P.parseProxyUrl(`http://user:secret@127.0.0.1:${proxyPort}`);
  const res = await P.proxyFetch(`http://127.0.0.1:${originPort}/v1/models`, {
    headers: { Authorization: "Bearer sk-through" }, timeoutMs: 5000, proxy,
  });
  const body = await res.json();
  check("proxyFetch returns the origin response", res.ok && res.status === 200, `status ${res.status}`);
  eq("the body survives the proxy hop", body.data[0].id, "through-proxy");
  check("proxyFetch marks the response as proxied", res.viaProxy === true);
  check("http uses the absolute-form target",
    sawAbsoluteForm === `http://127.0.0.1:${originPort}/v1/models`, sawAbsoluteForm);
  eq("proxy credentials are sent", sawAuth, `Basic ${Buffer.from("user:secret").toString("base64")}`);

  // Oversized bodies. The cap exists so an endpoint we do not control cannot
  // exhaust memory, but it used to truncate silently and hand the fragment back
  // as a success — the caller then saw "Unterminated string" and blamed the
  // server for sending broken JSON. It must refuse instead.
  {
    const big = JSON.stringify({ data: Array.from({ length: 4000 }, (_, i) => ({ id: `model-${i}`, filler: "x".repeat(200) })) });
    const bigSrv = http.createServer((rq, rs) => {
      rs.writeHead(200, { "content-type": "application/json" });
      rs.end(big);
    });
    await new Promise((r) => bigSrv.listen(0, "127.0.0.1", r));
    const bigURL = `http://127.0.0.1:${bigSrv.address().port}/v1/models`;

    const cut = await P.proxyFetch(bigURL, { timeoutMs: 5000, proxy, maxBytes: 1000 });
    check("an oversized body is flagged as truncated", cut.truncated === true, JSON.stringify(cut.truncated));
    let readErr = null;
    try { await cut.text(); } catch (e) { readErr = e.message; }
    check("reading a truncated body throws instead of returning a fragment",
      /обрезан/.test(readErr || ""), String(readErr));
    let jsonErr = null;
    try { await cut.json(); } catch (e) { jsonErr = e.message; }
    check("parsing a truncated body throws the same way", /обрезан/.test(jsonErr || ""), String(jsonErr));

    // Raising the ceiling must actually deliver the whole document — this is
    // the models.dev case, where the payload is several megabytes.
    const whole = await P.proxyFetch(bigURL, { timeoutMs: 15000, proxy, maxBytes: 16_000_000 });
    const parsed = await whole.json();
    check("a large body arrives intact when the ceiling allows it",
      whole.truncated === false && parsed.data.length === 4000, `${whole.truncated} ${parsed?.data?.length}`);
    check("the large body really was over the default probe cap",
      big.length > 800_000, String(big.length));
    await new Promise((r) => bigSrv.close(r));
  }

  // 407 must be reported as a proxy fault, not as a dead provider.
  const denySrv = http.createServer((rq, rs) => { rs.writeHead(407); rs.end(); });
  denySrv.on("connect", (rq, sock) => { sock.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); sock.end(); });
  await new Promise((r) => denySrv.listen(0, "127.0.0.1", r));
  let denied = null;
  try {
    await P.proxyFetch(`https://api.openai.com/v1/models`, {
      timeoutMs: 5000, proxy: P.parseProxyUrl(`http://127.0.0.1:${denySrv.address().port}`),
    });
  } catch (e) { denied = e; }
  check("a 407 from the proxy is flagged as a proxy fault", denied?.proxyStage === true, String(denied?.message));
  eq("a proxy fault classifies as proxy",
    R.classifyProbeError(Object.assign(new Error(denied?.message || ""), { proxyFault: true })).kind, "proxy");

  await new Promise((r) => denySrv.close(r));
  await new Promise((r) => proxySrv.close(r));
  await new Promise((r) => origin.close(r));
  check("the CONNECT tunnel was not used for a plain http target", sawConnect === "", sawConnect);
}

// The tests above exercise proxy.mjs on its own. This one proves that the
// probes actually route through it: without the wiring in guardedFetch every
// assertion above can still pass while the feature does nothing.
{
  const http = await import("node:http");
  let proxied = 0;
  // The stub answers the absolute-form request itself, so nothing leaves the
  // machine and the assertion does not depend on example.com being up.
  const srv = http.createServer((rq, rs) => {
    if (!/^https?:\/\//.test(rq.url)) { rs.writeHead(400); rs.end(); return; }
    proxied++;
    rs.writeHead(200, { "content-type": "application/json" });
    rs.end(JSON.stringify({ data: [{ id: "via-guarded-fetch" }] }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));

  const saved = { http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY, no: process.env.NO_PROXY };
  process.env.HTTP_PROXY = `http://127.0.0.1:${srv.address().port}`;
  delete process.env.HTTPS_PROXY;
  delete process.env.NO_PROXY;
  P.clearProxyCache();

  const viaModels = await R.fetchModels({ baseURL: "http://example.com/v1", apiFormat: "openai-chat", apiKey: "sk-x" });
  check("fetchModels routes through the configured proxy", proxied > 0 && viaModels.ok === true,
    `proxied=${proxied} ${JSON.stringify(viaModels).slice(0, 160)}`);
  eq("the proxied model list is parsed", viaModels.models?.[0]?.id, "via-guarded-fetch");

  const beforeLocal = proxied;
  await R.testConnection({ baseURL: "http://127.0.0.1:1/v1", apiFormat: "openai-chat", apiKey: "sk-x" });
  check("a loopback probe bypasses the proxy", proxied === beforeLocal, `proxied went ${beforeLocal}->${proxied}`);

  process.env.HTTP_PROXY = saved.http ?? "";
  if (saved.http === undefined) delete process.env.HTTP_PROXY;
  if (saved.https !== undefined) process.env.HTTPS_PROXY = saved.https;
  if (saved.no !== undefined) process.env.NO_PROXY = saved.no;
  P.clearProxyCache();
  await new Promise((r) => srv.close(r));
}

check("isLocalTarget covers loopback and private ranges",
  ["127.0.0.1", "::1", "10.1.2.3", "192.168.0.1", "172.16.0.1", "localhost", "box.local"].every(P.isLocalTarget));
check("isLocalTarget leaves public hosts alone",
  ["api.openai.com", "8.8.8.8", "1.1.1.1"].every((h) => !P.isLocalTarget(h)));

// ------------------------------------------------------------------ report

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.log("\nFailed:");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
