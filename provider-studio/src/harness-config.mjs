// src/harness-config.mjs
// Writers for harnesses that keep a plain config file we can patch safely.
//
// Kilo Code uses an opencode-shaped `kilo.json(c)`; WorkBuddy uses a small
// `models.json`. Both are patched in place (comments and unrelated fields
// survive), and both are planned first so a broken result never reaches disk.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configHome, home, writeFileAtomic, ensureDir } from "./paths.mjs";
import { parseJsonc, applyChangesVerified } from "./jsonc-edit.mjs";
import { FORMATS, slugify, decodeApiKey, normaliseHeaders, buildModelEntry } from "./formats.mjs";

const text = (v) => (typeof v === "string" ? v.trim() : "");
const num = (v) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** Kilo reads `~/.config/kilo/kilo.json(c)`; prefer the JSONC file when both exist. */
export function kiloConfigPath() {
  const dir = join(configHome(), "kilo");
  const jsonc = join(dir, "kilo.jsonc");
  if (existsSync(jsonc)) return jsonc;
  const json = join(dir, "kilo.json");
  return existsSync(json) ? json : jsonc;
}

export function workbuddyConfigPath() {
  return join(home(), ".codebuddy", "models.json");
}

function providerKey(provider) {
  return text(provider?.key) || slugify(provider?.name || "");
}

function keyReference(provider) {
  const decoded = decodeApiKey(provider?.apiKey || "");
  if (provider?.useEnvVar && text(provider?.envVarName)) {
    return { envVar: text(provider.envVarName), value: `{env:${text(provider.envVarName)}}` };
  }
  if (decoded.useEnvVar) return { envVar: decoded.envVarName, value: `{env:${decoded.envVarName}}` };
  return { envVar: "", value: decoded.apiKey };
}

/** Kilo's model entry is close to opencode's, but does not need tool_call. */
function kiloModelEntry(m) {
  const built = buildModelEntry(m);
  if (!built) return null;
  const entry = built.entry;
  delete entry.tool_call;
  delete entry.temperature;
  delete entry.output;
  return { id: built.id, entry };
}

export function buildKiloProvider(provider) {
  const fmt = FORMATS[provider.apiFormat] || FORMATS["openai-chat"];
  const block = { name: text(provider.displayName) || text(provider.name), npm: fmt.opencodeNpm };
  const options = {};
  if (text(provider.baseURL)) options.baseURL = text(provider.baseURL);
  const key = keyReference(provider);
  if (key.envVar) {
    block.env = [key.envVar];
    options.apiKey = key.value;
  } else if (key.value) options.apiKey = key.value;
  const headers = normaliseHeaders(provider.headers);
  if (Object.keys(headers).length) options.headers = headers;
  if (provider.timeout === false) options.timeout = false;
  else if (num(provider.timeout) > 0) options.timeout = num(provider.timeout);
  if (Object.keys(options).length) block.options = options;

  const models = {};
  for (const m of provider.models || []) {
    const built = kiloModelEntry(m);
    if (built) Object.defineProperty(models, built.id, {
      value: built.entry, enumerable: true, writable: true, configurable: true,
    });
  }
  block.models = models;
  return block;
}

/**
 * Plans a Kilo config write. Returns before/after text so the caller can take a
 * backup and write atomically; nothing here touches the disk.
 */
export function planKiloWrite(provider, { configPath, setAsDefault = true } = {}) {
  const path = text(configPath) || kiloConfigPath();
  const key = providerKey(provider);
  if (!key) return { ok: false, error: "Нужно имя провайдера для Kilo" };

  let before = "";
  let textValue = `{\n  "$schema": "https://app.kilo.ai/config.json"\n}\n`;
  if (existsSync(path)) {
    try { before = readFileSync(path, "utf8"); } catch (e) { return { ok: false, error: e.message || String(e) }; }
    const parsed = parseJsonc(before);
    if (!parsed.ok) return { ok: false, error: `kilo.json(c) не разбирается: ${parsed.error}` };
    if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
      return { ok: false, error: "корень kilo.json(c) должен быть объектом" };
    }
    textValue = before;
  }

  const changes = [{ op: "set", path: ["provider", key], value: buildKiloProvider(provider) }];
  const modelIds = (provider.models || []).map((m) => text(m?.id)).filter(Boolean);
  const firstModel = modelIds[0];
  let model = "";
  if (setAsDefault && firstModel) {
    model = `${key}/${firstModel}`;
    changes.push({ op: "set", path: ["model"], value: model });
  }
  const applied = applyChangesVerified(textValue, changes);
  if (!applied.ok) return { ok: false, error: applied.error };
  return { ok: true, path, before, after: applied.text, key, model, models: modelIds, count: modelIds.length, changes };
}

function chatCompletionsUrl(baseURL) {
  const base = text(baseURL).replace(/\/+$/, "");
  if (!base) return "";
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

function workbuddyModel(provider, m) {
  const id = text(m?.id);
  if (!id) return null;
  const input = Array.isArray(m.inputTypes) ? m.inputTypes : ["text"];
  const key = keyReference(provider);
  const apiKey = key.envVar ? `\${${key.envVar}}` : key.value;
  const out = {
    id,
    name: text(m.name) || id,
    vendor: text(provider.displayName) || text(provider.name) || id,
    apiKey,
    maxInputTokens: num(m.contextWindow) || 128000,
    maxOutputTokens: num(m.maxOutput) || 4096,
    url: chatCompletionsUrl(provider.baseURL),
    supportsToolCall: m.toolUse !== false,
    supportsImages: input.includes("image"),
    supportsReasoning: !!m.reasoning,
  };
  if (String(provider.apiFormat || "") === "openai-responses") out.api = "openai-responses";
  return out;
}

/**
 * Plans a merge into `~/.codebuddy/models.json`.
 *
 * WorkBuddy resolves `${VAR}` in apiKey, so an env-backed provider leaves the
 * secret in the user's environment instead of the file. Existing models are
 * preserved; entries with the same id are updated in place.
 */
export function planWorkBuddyWrite(provider, { configPath } = {}) {
  const path = text(configPath) || workbuddyConfigPath();
  if (String(provider.apiFormat || "") === "anthropic") {
    return { ok: false, error: "WorkBuddy custom models принимает OpenAI Chat/Responses, не Anthropic" };
  }
  let before = "";
  let root = { models: [] };
  if (existsSync(path)) {
    try { before = readFileSync(path, "utf8"); } catch (e) { return { ok: false, error: e.message || String(e) }; }
    let parsed;
    try { parsed = JSON.parse(before.replace(/^\uFEFF/, "")); } catch (e) {
      return { ok: false, error: `models.json не разбирается: ${e.message || e}` };
    }
    root = Array.isArray(parsed) ? { models: parsed } : (parsed && typeof parsed === "object" ? parsed : { models: [] });
    if (!Array.isArray(root.models)) root.models = [];
  }

  const added = [];
  for (const m of provider.models || []) {
    const entry = workbuddyModel(provider, m);
    if (!entry) continue;
    const idx = root.models.findIndex((x) => x && x.id === entry.id);
    if (idx >= 0) root.models[idx] = { ...root.models[idx], ...entry };
    else root.models.push(entry);
    added.push(entry.id);
  }
  if (!added.length) return { ok: false, error: "Нет моделей для записи в WorkBuddy" };

  const after = JSON.stringify(root, null, 2) + "\n";
  return { ok: true, path, before, after, models: added, count: added.length };
}

export function writeHarnessPlan(plan) {
  if (!plan?.ok) return plan;
  ensureDir(dirname(plan.path));
  writeFileAtomic(plan.path, plan.after);
  return plan;
}

/**
 * Удаляет провайдера из Kilo (~/.config/kilo/kilo.json(c)), если файл существует.
 */
export function removeKiloProvider(providerKeys, { configPath } = {}) {
  const path = text(configPath) || kiloConfigPath();
  if (!existsSync(path)) return { ok: true, removed: false, reason: "not_found" };
  const keys = (Array.isArray(providerKeys) ? providerKeys : [providerKeys]).map(text).filter(Boolean);
  if (!keys.length) return { ok: true, removed: false };

  let raw = "";
  try { raw = readFileSync(path, "utf8"); } catch (e) { return { ok: false, error: e.message || String(e) }; }
  const parsed = parseJsonc(raw);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { ok: false, error: "kilo.json(c) повреждён или не является объектом" };
  }

  const existingProviders = parsed.value.provider && typeof parsed.value.provider === "object" ? parsed.value.provider : {};
  const matchedKeys = keys.filter((k) => Object.prototype.hasOwnProperty.call(existingProviders, k));
  if (!matchedKeys.length) return { ok: true, removed: false, path };

  const changes = matchedKeys.map((k) => ({ op: "delete", path: ["provider", k] }));

  const currentModel = typeof parsed.value.model === "string" ? parsed.value.model : "";
  if (currentModel && matchedKeys.some((k) => currentModel.startsWith(`${k}/`))) {
    const remainingKeys = Object.keys(existingProviders).filter((k) => !matchedKeys.includes(k));
    let nextModel = "";
    for (const remKey of remainingKeys) {
      const remP = existingProviders[remKey];
      const mIds = Object.keys(remP?.models || {});
      if (mIds.length) {
        nextModel = `${remKey}/${mIds[0]}`;
        break;
      }
    }
    if (nextModel) {
      changes.push({ op: "set", path: ["model"], value: nextModel });
    } else {
      changes.push({ op: "delete", path: ["model"] });
    }
  }

  const applied = applyChangesVerified(raw, changes);
  if (!applied.ok) return { ok: false, error: applied.error };
  writeFileAtomic(path, applied.text);
  return { ok: true, removed: true, path, removedKeys: matchedKeys };
}

/**
 * Удаляет модели провайдера из WorkBuddy (~/.codebuddy/models.json), если файл существует.
 */
export function removeWorkBuddyProvider(providerKeys, { configPath, vendorNames = [] } = {}) {
  const path = text(configPath) || workbuddyConfigPath();
  if (!existsSync(path)) return { ok: true, removed: false, reason: "not_found" };
  const keys = (Array.isArray(providerKeys) ? providerKeys : [providerKeys]).map((k) => text(k).toLowerCase()).filter(Boolean);
  const vendors = (Array.isArray(vendorNames) ? vendorNames : [vendorNames]).map((v) => text(v).toLowerCase()).filter(Boolean);
  const targets = new Set([...keys, ...vendors]);
  if (!targets.size) return { ok: true, removed: false };

  let raw = "";
  try { raw = readFileSync(path, "utf8"); } catch (e) { return { ok: false, error: e.message || String(e) }; }
  let parsed;
  try { parsed = JSON.parse(raw.replace(/^\uFEFF/, "")); } catch (e) {
    return { ok: false, error: `models.json не разбирается: ${e.message || e}` };
  }

  const isArr = Array.isArray(parsed);
  let models = isArr ? parsed : (Array.isArray(parsed?.models) ? parsed.models : []);
  const initialCount = models.length;

  models = models.filter((m) => {
    if (!m || typeof m !== "object") return true;
    const v = text(m.vendor).toLowerCase();
    if (v && targets.has(v)) return false;
    const id = text(m.id).toLowerCase();
    const idPrefix = id.split("/")[0];
    if (idPrefix && targets.has(idPrefix)) return false;
    return true;
  });

  if (models.length === initialCount) return { ok: true, removed: false, path };

  const out = isArr ? models : { ...parsed, models };
  const after = JSON.stringify(out, null, 2) + "\n";
  writeFileAtomic(path, after);
  return { ok: true, removed: true, path, removedCount: initialCount - models.length };
}
