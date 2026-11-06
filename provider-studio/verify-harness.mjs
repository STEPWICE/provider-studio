// verify-harness.mjs — writers for Kilo Code and WorkBuddy AI.
//
// Both are plain files, so these tests exercise the real planners against a
// temporary directory: no user config is touched, and a regression in the
// JSONC patch or the models merge fails here rather than in someone's IDE.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planKiloWrite, planWorkBuddyWrite, kiloConfigPath, workbuddyConfigPath,
  removeKiloProvider, removeWorkBuddyProvider,
} from "./src/harness-config.mjs";
import { parseJsonc } from "./src/jsonc-edit.mjs";

let passed = 0;
const fails = [];
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log("PASS  " + name); }
  else { fails.push(name + (detail ? ": " + detail : "")); console.log("FAIL  " + name + (detail ? " — " + detail : "")); }
}
const eq = (name, actual, expected) => check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

const dir = mkdtempSync(join(tmpdir(), "ps-harness-"));
const provider = {
  name: "Test Provider",
  displayName: "Test Provider",
  key: "test",
  baseURL: "https://api.example.com/v1",
  apiFormat: "openai-chat",
  useEnvVar: true,
  envVarName: "TEST_API_KEY",
  models: [{
    id: "deepseek-v4.1-flash-1017",
    name: "DeepSeek 1017",
    contextWindow: 1048576,
    maxOutput: 393216,
    inputTypes: ["text", "image"],
    outputTypes: ["text"],
    reasoning: true,
    toolUse: true,
    costInput: 0.1,
    costOutput: 0.5,
  }],
};

try {
  // ------------------------------------------------------------------ Kilo
  const kilo = join(dir, "kilo.jsonc");
  writeFileSync(kilo, `{
  "$schema": "https://app.kilo.ai/config.json",
  // a comment the patcher must keep
  "permission": { "bash": "allow" }
}
`);
  const kp = planKiloWrite(provider, { configPath: kilo });
  check("Kilo plan succeeds", kp.ok, kp.error);
  eq("Kilo default model is provider/model", kp.model, "test/deepseek-v4.1-flash-1017");
  eq("Kilo plan reports its models", kp.models.join(","), "deepseek-v4.1-flash-1017");
  const kj = parseJsonc(kp.after);
  check("Kilo result parses", kj.ok, kj.error);
  eq("Kilo block carries the env reference", kj.value.provider.test.options.apiKey, "{env:TEST_API_KEY}");
  eq("Kilo env array is written", kj.value.provider.test.env[0], "TEST_API_KEY");
  check("Kilo never writes the literal key", !kp.after.includes("sk-")); 
  check("Kilo comment survives", /a comment the patcher must keep/.test(kp.after));
  check("Kilo unrelated field survives", kj.value.permission.bash === "allow");
  eq("Kilo modality survives", kj.value.provider.test.models["deepseek-v4.1-flash-1017"].modalities.input.join(","), "text,image");
  eq("Kilo limit survives", kj.value.provider.test.models["deepseek-v4.1-flash-1017"].limit.context, 1048576);

  // A second provider must not steal the default when setAsDefault is false.
  writeFileSync(kilo, kp.after);
  const kp2 = planKiloWrite({ ...provider, name: "Second", key: "second" }, { configPath: kilo, setAsDefault: false });
  const kj2 = parseJsonc(kp2.after);
  check("Kilo second provider added", !!kj2.value.provider.second);
  eq("Kilo default is left alone", kj2.value.model, "test/deepseek-v4.1-flash-1017");

  // ------------------------------------------------------------- WorkBuddy
  const wb = join(dir, "models.json");
  writeFileSync(wb, JSON.stringify({ models: [{ id: "keep-me", name: "Keep", url: "https://x/v1/chat/completions" }] }, null, 2));
  const wp = planWorkBuddyWrite(provider, { configPath: wb });
  check("WorkBuddy plan succeeds", wp.ok, wp.error);
  eq("WorkBuddy reports the added model", wp.models.join(","), "deepseek-v4.1-flash-1017");
  const wj = JSON.parse(wp.after);
  eq("WorkBuddy keeps the existing model", wj.models[0].id, "keep-me");
  const added = wj.models.find((m) => m.id === "deepseek-v4.1-flash-1017");
  eq("WorkBuddy uses ${ENV} for the key", added.apiKey, "${TEST_API_KEY}");
  eq("WorkBuddy URL is the full chat path", added.url, "https://api.example.com/v1/chat/completions");
  eq("WorkBuddy writes image support", added.supportsImages, true);
  eq("WorkBuddy writes reasoning support", added.supportsReasoning, true);
  check("WorkBuddy reports every model", wp.count === 1);

  // Re-planning the same provider updates in place instead of duplicating.
  const wp2 = planWorkBuddyWrite(provider, { configPath: wb });
  const wj2 = JSON.parse(wp2.after);
  eq("WorkBuddy update does not duplicate", wj2.models.filter((m) => m.id === "deepseek-v4.1-flash-1017").length, 1);

  const anth = planWorkBuddyWrite({ ...provider, apiFormat: "anthropic" }, { configPath: wb });
  check("WorkBuddy refuses Anthropic custom models", anth.ok === false, JSON.stringify(anth));

  // ------------------------------------------------------------ removal tests
  writeFileSync(kilo, kp2.after);
  const rmKilo = removeKiloProvider(["test"], { configPath: kilo });
  check("Kilo remove succeeds", rmKilo.ok === true && rmKilo.removed === true);
  const kiloAfter = parseJsonc(readFileSync(kilo, "utf8"));
  check("Kilo provider removed", !kiloAfter.value.provider?.test);
  check("Kilo second provider preserved", !!kiloAfter.value.provider?.second);
  check("Kilo default model repointed", kiloAfter.value.model.startsWith("second/"));

  writeFileSync(wb, wp.after);
  const rmWb = removeWorkBuddyProvider(["test"], { configPath: wb, vendorNames: ["Test Provider"] });
  check("WorkBuddy remove succeeds", rmWb.ok === true && rmWb.removed === true);
  const wbAfter = JSON.parse(readFileSync(wb, "utf8"));
  check("WorkBuddy models for vendor removed", !wbAfter.models.some((m) => m.vendor === "Test Provider"));
  check("WorkBuddy other models preserved", wbAfter.models.some((m) => m.id === "keep-me"));

  // ------------------------------------------------------------ path rules
  const xdg = join(dir, "xdg");
  mkdirSync(join(xdg, "kilo"), { recursive: true });
  const oldXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  writeFileSync(join(xdg, "kilo", "kilo.json"), "{}");
  eq("Kilo defaults to kilo.jsonc when only .json exists", kiloConfigPath(), join(xdg, "kilo", "kilo.json"));
  writeFileSync(join(xdg, "kilo", "kilo.jsonc"), "{}");
  eq("Kilo prefers kilo.jsonc when both exist", kiloConfigPath(), join(xdg, "kilo", "kilo.jsonc"));
  if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
  check("WorkBuddy path ends with .codebuddy/models.json", /[\\/]\.codebuddy[\\/]models\.json$/.test(workbuddyConfigPath()));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.log("FAILED: " + f);
  process.exitCode = 1;
}
