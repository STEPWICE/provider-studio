// verify-env.mjs
// Covers src/env.mjs: resolving the `{env:VAR}` references opencode substitutes
// into its config, and deciding whether the referenced variable actually exists.
//
// Why this deserves its own suite: opencode replaces a reference to a *missing*
// variable with an empty string rather than failing, so the config looks correct
// while every request comes back 401 "Missing or invalid bearer token". Getting
// this lookup wrong in either direction is expensive — a false "set" hides the
// real cause, and a false "unset" sends the user chasing a variable that is
// already there.

import { execFileSync } from "node:child_process";

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

const E = await import("./src/env.mjs");
const IS_WINDOWS = process.platform === "win32";

// ------------------------------------------------------- reference parsing

{
  process.env.PS_ENV_A = "value-a";

  eq("the documented {env:VAR} form resolves", E.resolveKeyRef("{env:PS_ENV_A}").value, "value-a");
  // Older versions of this tool wrote these, so an imported config still has them.
  eq("the legacy $VAR form resolves", E.resolveKeyRef("$PS_ENV_A").value, "value-a");
  eq("the legacy ${VAR} form resolves", E.resolveKeyRef("${PS_ENV_A}").value, "value-a");
  check("a reference is marked as one", E.resolveKeyRef("{env:PS_ENV_A}").isRef === true);
  eq("the variable name is reported", E.resolveKeyRef("{env:PS_ENV_A}").envVarName, "PS_ENV_A");

  // A literal key must pass through untouched, or a key that happens to contain
  // a brace would be mangled.
  const literal = E.resolveKeyRef("sk-abc123");
  eq("a literal key is returned as-is", literal.value, "sk-abc123");
  check("a literal key is not a reference", literal.isRef === false);
  eq("surrounding whitespace is trimmed", E.resolveKeyRef("  sk-abc123  ").value, "sk-abc123");

  // Only an exact full-string match is a reference. A key that merely mentions
  // the syntax is still a key.
  check("a partial match is not treated as a reference",
    E.resolveKeyRef("prefix-{env:PS_ENV_A}").isRef === false);
  check("a malformed reference is not treated as one",
    E.resolveKeyRef("{env:}").isRef === false);
  check("a lowercase name is accepted", E.resolveKeyRef("{env:ps_env_a}").isRef === true);

  eq("an empty input yields an empty value", E.resolveKeyRef("").value, "");
  eq("a null input yields an empty value", E.resolveKeyRef(null).value, "");
  eq("a non-string input yields an empty value", E.resolveKeyRef(42).value, "");

  delete process.env.PS_ENV_A;
}

// --------------------------------------------------- unresolved references

{
  delete process.env.PS_ENV_ABSENT;
  const r = E.resolveKeyRef("{env:PS_ENV_ABSENT}");
  check("an unset reference is still a reference", r.isRef === true);
  check("an unset reference is marked unresolved", r.resolved === false);
  // This empty string is the whole bug: it is exactly what opencode sends.
  eq("an unset reference resolves to the empty string opencode would send", r.value, "");

  const problem = E.keyRefProblem("{env:PS_ENV_ABSENT}");
  check("an unset reference produces a problem message", problem !== "", problem);
  check("the message names the variable", /PS_ENV_ABSENT/.test(problem), problem);
  check("the message explains the 401", /401/.test(problem), problem);
  check("the message gives the command that fixes it", /setx|export/.test(problem), problem);

  process.env.PS_ENV_PRESENT = "sk-present";
  eq("a resolvable reference has no problem", E.keyRefProblem("{env:PS_ENV_PRESENT}"), "");
  eq("a literal key has no problem", E.keyRefProblem("sk-literal"), "");
  // An absent key is a different failure from an absent variable, and the
  // wording has to distinguish them.
  check("an empty key is reported as unset", E.keyRefProblem("") !== "");
  delete process.env.PS_ENV_PRESENT;
}

// ------------------------------------------------------- emptiness handling

{
  // A variable holding only whitespace authenticates exactly as badly as a
  // missing one, but survives a glance at `echo %VAR%`.
  process.env.PS_ENV_BLANK = "   ";
  const blank = E.lookupEnv("PS_ENV_BLANK", { useCache: false });
  check("a whitespace-only variable counts as unset", blank.set === false, JSON.stringify(blank));
  eq("an unset variable reports zero length", blank.length, 0);

  // A pasted key often carries a trailing newline, which breaks auth invisibly.
  process.env.PS_ENV_PADDED = "  sk-padded\n";
  const padded = E.lookupEnv("PS_ENV_PADDED", { useCache: false });
  check("a padded value counts as set", padded.set === true);
  eq("the value is trimmed", padded.value, "sk-padded");
  eq("the reported length is the trimmed length", padded.length, "sk-padded".length);

  delete process.env.PS_ENV_BLANK;
  delete process.env.PS_ENV_PADDED;
}

// ------------------------------------------------------------ name validation

{
  for (const bad of ["", "  ", "1STARTS_WITH_DIGIT", "HAS-DASH", "HAS SPACE", "HAS.DOT", "$VAR"]) {
    const r = E.lookupEnv(bad, { useCache: false });
    check(`an invalid name is rejected: ${JSON.stringify(bad)}`, r.invalid === true && r.set === false);
  }
  for (const good of ["A", "_A", "a1", "LONG_NAME_9"]) {
    check(`a valid name is accepted: ${good}`, E.lookupEnv(good, { useCache: false }).invalid !== true);
  }
}

// ---------------------------------------------------------------- scopes

{
  process.env.PS_ENV_SCOPE = "from-process";
  const r = E.lookupEnv("PS_ENV_SCOPE", { useCache: false });
  eq("a process variable reports the process scope", r.scope, "process");
  check("the process scope is listed", r.scopes.includes("process"));
  delete process.env.PS_ENV_SCOPE;
}

// -------------------------------------------------------------- reg parsing
// The registry reader cannot run on a non-Windows host, so the parser is tested
// directly. `reg query` prints "  NAME  TYPE  VALUE", and its "not found"
// message goes to stderr in the OEM codepage — unparseable and locale-specific,
// which is why only the exit code and this parser decide the outcome.

{
  const OUT = "\r\nHKEY_CURRENT_USER\\Environment\r\n    MY_KEY    REG_SZ    sk-abc123\r\n\r\n";
  eq("a value is extracted from reg output", E.parseRegQuery(OUT, "MY_KEY"), "sk-abc123");
  eq("a different name does not match", E.parseRegQuery(OUT, "OTHER"), null);
  eq("empty output yields null", E.parseRegQuery("", "MY_KEY"), null);
  // Registry value names are case-insensitive, like the variables themselves.
  eq("the name match is case-insensitive", E.parseRegQuery(OUT, "my_key"), "sk-abc123");

  // A value containing spaces must survive: splitting on whitespace would
  // truncate a key at its first space.
  const SPACED = "\r\n    MY_KEY    REG_SZ    a b  c\r\n";
  eq("spaces inside a value are preserved", E.parseRegQuery(SPACED, "MY_KEY"), "a b  c");
  // A long PATH-like value must not be truncated either.
  const LONG = "\r\n    PATH    REG_EXPAND_SZ    C:\\a;C:\\b;C:\\c\r\n";
  eq("REG_EXPAND_SZ is supported", E.parseRegQuery(LONG, "PATH"), "C:\\a;C:\\b;C:\\c");
  // Present but empty is reported as "" (exists, unusable) rather than null.
  eq("a present but empty value is distinguished from a missing one",
    E.parseRegQuery("\r\n    MY_KEY    REG_SZ\r\n", "MY_KEY"), "");
}

// --------------------------------------------------- the setx regression
// The bug that started all of this: a variable created with `setx` after this
// process started is real, opencode will see it, but it is absent from
// process.env. Reporting it as unset is a false negative that sends the user
// looking for a variable they already created.

if (IS_WINDOWS) {
  const NAME = "PS_ENV_SELFTEST_TMP";
  try {
    execFileSync("setx", [NAME, "registry-only-value"], { stdio: "ignore", windowsHide: true });
    E.clearEnvCache();
    check("a variable absent from process.env is genuinely not inherited",
      process.env[NAME] === undefined, String(process.env[NAME]));
    const r = E.lookupEnv(NAME, { useCache: false });
    check("a setx variable is found despite process.env", r.set === true, JSON.stringify(r));
    eq("it is attributed to the user scope", r.scope, "user");
    eq("its value is read back intact", r.value, "registry-only-value");
    // The distinction that matters for advice: already-open terminals still see
    // nothing, so opencode has to be restarted from a new one.
    check("the process scope is correctly absent", r.scopes.includes("process") === false);

    // Values containing spaces must survive the round trip through reg query.
    execFileSync("setx", [NAME, "two words here"], { stdio: "ignore", windowsHide: true });
    E.clearEnvCache();
    eq("a spaced value survives the round trip",
      E.lookupEnv(NAME, { useCache: false }).value, "two words here");

    // A reference to it must now resolve, which is what unblocks the probe.
    E.clearEnvCache();
    const ref = E.resolveKeyRef(`{env:${NAME}}`);
    check("a reference to a setx variable resolves", ref.resolved === true, JSON.stringify(ref));
    eq("no problem is reported for it", E.keyRefProblem(`{env:${NAME}}`), "");
  } finally {
    try {
      execFileSync("reg", ["delete", "HKCU\\Environment", "/v", NAME, "/f"],
        { stdio: "ignore", windowsHide: true });
    } catch { /* already gone */ }
    E.clearEnvCache();
  }
  // And once deleted it must be reported missing again — proving the check
  // reflects reality rather than a stale cache.
  const gone = E.lookupEnv(NAME, { useCache: false });
  check("a deleted variable is reported missing again", gone.set === false, JSON.stringify(gone));
} else {
  console.log("SKIP  setx round-trip (Windows only)");
}

// ------------------------------------------------- writing the variable
// setUserEnvVar closes the last manual step in the setup flow, so its guards
// matter: a bad name or an over-long value must be refused before setx gets a
// chance to write something broken.

eq("an invalid variable name is refused", E.setUserEnvVar("no-dashes", "v").ok, false);
eq("an empty name is refused", E.setUserEnvVar("", "v").ok, false);
eq("a name starting with a digit is refused", E.setUserEnvVar("9BAD", "v").ok, false);
eq("an empty value is refused", E.setUserEnvVar("PS_ENV_WRITE_TMP", "   ").ok, false);
{
  // setx truncates silently past 1024 chars, which yields a key that looks set
  // and fails every request; refusing is the only honest option.
  const long = E.setUserEnvVar("PS_ENV_WRITE_TMP", "x".repeat(E.SETX_MAX_LENGTH + 1));
  check("an over-long value is refused rather than truncated",
    long.ok === false && /1024|обрежет/.test(long.error || ""), JSON.stringify(long));
}

if (IS_WINDOWS) {
  const NAME = "PS_ENV_WRITE_TMP";
  try {
    const w = E.setUserEnvVar(NAME, "written-by-selftest");
    check("a valid variable is written", w.ok === true, JSON.stringify(w));
    // "user", not "process". The write also updates this process, but saying
    // so would answer the wrong question: the caller needs to know the value
    // survives a reboot, and "process" is true of a value that does not.
    eq("it reports the scope it persists in", w.scope, "user");
    eq("it reports the value length", w.length, "written-by-selftest".length);
    check("the response carries no value", !("value" in w), JSON.stringify(w));
    // Writing must also fix the *current* process, otherwise a probe run right
    // after still reports the key as missing.
    eq("process.env is updated in place", process.env[NAME], "written-by-selftest");
    const back = E.lookupEnv(NAME, { useCache: false });
    check("it is readable back from the registry", back.set === true, JSON.stringify(back));
    // Persistence is the whole point: it must be in the user scope too, so a
    // newly launched opencode sees it.
    check("it is persisted to the user scope, not just this process",
      back.scopes.includes("user"), JSON.stringify(back.scopes));
    eq("a reference to it now resolves", E.keyRefProblem(`{env:${NAME}}`), "");
    // The failure this guards: if the persistent write silently does nothing,
    // the in-process copy must not be mistaken for success. Simulate it by
    // deleting the registry value while process.env still holds it — the old
    // code read process.env first and reported ok.
    {
      execFileSync("reg", ["delete", "HKCU\\Environment", "/v", NAME, "/f"],
        { stdio: "ignore", windowsHide: true });
      E.clearEnvCache();
      const stale = E.lookupEnv(NAME, { useCache: false });
      check("a value left only in this process is not counted as persisted",
        stale.set === true && !stale.scopes.includes("user"), JSON.stringify(stale.scopes));
    }
    // Overwriting an existing variable must replace, not append.
    E.setUserEnvVar(NAME, "second-value");
    eq("a rewrite replaces the value", E.lookupEnv(NAME, { useCache: false }).value, "second-value");
  } finally {
    try {
      execFileSync("reg", ["delete", "HKCU\\Environment", "/v", NAME, "/f"],
        { stdio: "ignore", windowsHide: true });
    } catch { /* already gone */ }
    delete process.env[NAME];
    E.clearEnvCache();
  }
  check("the written variable is cleaned up", E.lookupEnv(NAME, { useCache: false }).set === false);
} else {
  const r = E.setUserEnvVar("PS_ENV_WRITE_TMP", "v");
  check("on POSIX it declines and hands back a shell line",
    r.ok === false && r.manual === true && /export/.test(r.command || ""), JSON.stringify(r));
}

// ----------------------------------------------------------------- caching
// The cache exists so the diagnostics endpoint does not spawn reg.exe once per
// provider. It must not outlive a deliberate refresh.

{
  process.env.PS_ENV_CACHE = "first";
  eq("the first read sees the current value", E.lookupEnv("PS_ENV_CACHE").value, "first");
  process.env.PS_ENV_CACHE = "second";
  eq("a cached read may return the old value", E.lookupEnv("PS_ENV_CACHE").value, "first");
  eq("useCache:false bypasses the cache", E.lookupEnv("PS_ENV_CACHE", { useCache: false }).value, "second");
  E.clearEnvCache();
  eq("clearEnvCache forces a fresh read", E.lookupEnv("PS_ENV_CACHE").value, "second");
  delete process.env.PS_ENV_CACHE;
}

// ------------------------------------------------------------ setx command

{
  const cmd = E.setEnvCommand("MY_KEY");
  check("the command names the variable", cmd.includes("MY_KEY"), cmd);
  check("the command matches the platform",
    IS_WINDOWS ? cmd.startsWith("setx ") : cmd.startsWith("export "), cmd);
  // setx truncates silently at 1024 characters, which corrupts long tokens in a
  // way that presents as an invalid key.
  check("the setx limit is documented as a number",
    typeof E.SETX_MAX_LENGTH === "number" && E.SETX_MAX_LENGTH === 1024, String(E.SETX_MAX_LENGTH));
}

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.log("Failed:");
  for (const f of fails) console.log("  - " + f);
  process.exitCode = 1;
}
