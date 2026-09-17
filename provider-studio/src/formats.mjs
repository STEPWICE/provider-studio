// src/formats.mjs
// Maps the form's "API format" dropdown onto the opencode provider block, and
// turns a provider object into a list of JSONC patch operations.
//
// Field names and types here follow https://opencode.ai/config.json
// ($defs.ProviderConfig). Two constraints from that schema drive most of the
// code below:
//   - ProviderConfig.additionalProperties is false, so an unrecognised
//     top-level provider field makes opencode reject the whole config.
//   - `limit` requires context+output together, and `cost` requires
//     input+output together. A half-filled object fails validation, so each is
//     emitted only when complete.

export const FORMATS = {
  anthropic: {
    label: "Anthropic messages (/v1/messages)",
    opencodeNpm: "@ai-sdk/anthropic",
    opencodeKind: "anthropic",
    note: "Использует совместимый Anthropic-эндпоинт. Kilo/Cline/Roo: выбери «Anthropic» или «Anthropic-compatible» в API format.",
  },
  "openai-chat": {
    label: "Chat completions (/v1/chat/completions)",
    opencodeNpm: "@ai-sdk/openai-compatible",
    opencodeKind: "openai",
    note: "OpenAI-совместимый эндпоинт. Kilo/Cline/Roo: «OpenAI Compatible» / «Chat completions». Годится для DeepSeek, Z.ai, BAI, локальных (ollama, LM Studio, vLLM).",
  },
  "openai-responses": {
    label: "Responses (/v1/responses)",
    opencodeNpm: "@ai-sdk/openai",
    opencodeKind: "openai",
    note: "OpenAI Responses API (новый формат). Kilo/Cline: «OpenAI» / «Responses». Поддерживают не все серверы — для обычных OpenAI-совместимых лучше «Chat completions».",
  },
};

// The schema's modality enum, shared by input and output.
export const MODALITIES = ["text", "image", "video", "audio", "pdf"];
export const INPUT_TYPES = MODALITIES;
export const OUTPUT_TYPES = MODALITIES;

// model.status enum.
export const MODEL_STATUSES = ["active", "beta", "alpha", "deprecated"];

/** Fields opencode accepts directly on a provider block. Anything else is rejected. */
export const PROVIDER_FIELDS = ["api", "name", "env", "id", "npm", "whitelist", "blacklist", "options", "models"];

/** Fields opencode accepts on a model entry. */
export const MODEL_FIELDS = [
  "id", "name", "family", "release_date", "attachment", "reasoning", "temperature",
  "tool_call", "interleaved", "cost", "limit", "modalities", "experimental",
  "status", "provider", "options", "headers", "variants",
];

/**
 * Which form inputs control which config key.
 *
 * A config key may only be deleted when the form actually carried its input and
 * left it empty. Deleting on "the built entry has no such key" would destroy a
 * hand-written `cost` the moment a caller submitted a model object without a
 * cost field — the form and the config are not the same shape.
 *
 * `name`, `modalities` and `attachment` are always derived, so they are always
 * managed; the rest are conditional on the form supplying the input.
 */
const MODEL_KEY_INPUTS = {
  limit: ["contextWindow", "maxOutput"],
  cost: ["costInput", "costOutput", "costCacheRead", "costCacheWrite"],
  reasoning: ["reasoning"],
  tool_call: ["toolUse"],
  temperature: ["temperature"],
  release_date: ["releaseDate"],
  family: ["family"],
  status: ["status"],
  headers: ["headers"],
};

/** Config keys under this tool's control for a given submitted model form. */
export function managedModelKeys(formModel) {
  const keys = ["name", "modalities", "attachment"];
  if (!formModel || typeof formModel !== "object") return keys;
  for (const [configKey, inputs] of Object.entries(MODEL_KEY_INPUTS)) {
    if (inputs.some((f) => Object.prototype.hasOwnProperty.call(formModel, f))) keys.push(configKey);
  }
  return keys;
}

// Cyrillic has nowhere to go in an opencode key, and dropping it turned every
// Russian-named provider into the same key "provider" — so the second one
// silently overwrote the first. Transliterate first, then apply the usual rule.
// Kept in sync with slugifyName() in public/app.js (verify-formats pins this).
const CYRILLIC_MAP = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh",
  з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts",
  ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu",
  я: "ya", ґ: "g", є: "ye", і: "i", ї: "yi",
};

export function slugify(name) {
  const s = String(name || "provider")
    .trim()
    .toLowerCase()
    .replace(/[а-яёґєії]/g, (c) => CYRILLIC_MAP[c] ?? "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "provider";
}

/** Modalities that require `attachment: true` before opencode allows file input. */
const ATTACHMENT_MODALITIES = new Set(["image", "video", "audio", "pdf"]);
const VALID_MODALITIES = new Set(MODALITIES);

function dedupe(arr) {
  return [...new Set(arr)];
}

function trimmed(v) {
  return typeof v === "string" ? v.trim() : "";
}

/** Positive finite number or 0. Guards against NaN reaching the config. */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Normalises the free-form headers input into a string→string map. */
export function normaliseHeaders(input) {
  const out = {};
  if (!input) return out;
  if (typeof input === "string") {
    // Accept "Key: value" per line, which is how users paste from curl.
    for (const line of input.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*:\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  }
  if (Array.isArray(input)) {
    for (const h of input) {
      const k = trimmed(h?.key ?? h?.name);
      if (k) out[k] = String(h?.value ?? "");
    }
    return out;
  }
  if (typeof input === "object") {
    for (const [k, v] of Object.entries(input)) {
      const key = trimmed(k);
      if (key) out[key] = String(v ?? "");
    }
  }
  return out;
}

/** Builds a single model entry. Returns null when the model has no usable id. */
export function buildModelEntry(m) {
  const id = trimmed(m?.id);
  if (!id) return null;
  const entry = { name: trimmed(m.name) || id };

  const input = dedupe((m.inputTypes || ["text"]).filter((t) => VALID_MODALITIES.has(t)));
  const output = dedupe((m.outputTypes || ["text"]).filter((t) => VALID_MODALITIES.has(t)));
  if (!input.length) input.push("text");
  if (!output.length) output.push("text");
  entry.modalities = { input, output };

  // Both halves are required together, so a partial limit is dropped entirely.
  const context = num(m.contextWindow);
  const maxOutput = num(m.maxOutput);
  if (context > 0 && maxOutput > 0) entry.limit = { context, output: maxOutput };

  // Same rule for cost: input and output are both required by the schema.
  const costIn = m.costInput;
  const costOut = m.costOutput;
  if (costIn !== "" && costIn != null && costOut !== "" && costOut != null) {
    const cost = { input: num(costIn), output: num(costOut) };
    if (m.costCacheRead !== "" && m.costCacheRead != null) cost.cache_read = num(m.costCacheRead);
    if (m.costCacheWrite !== "" && m.costCacheWrite != null) cost.cache_write = num(m.costCacheWrite);
    entry.cost = cost;
  }

  if (input.some((t) => ATTACHMENT_MODALITIES.has(t))) entry.attachment = true;
  if (m.reasoning) entry.reasoning = true;
  entry.tool_call = m.toolUse !== false;

  // `temperature` is a capability flag in this schema, not a sampling value.
  if (m.temperature === true || m.temperature === false) entry.temperature = m.temperature;

  const releaseDate = trimmed(m.releaseDate);
  if (releaseDate) entry.release_date = releaseDate;
  const family = trimmed(m.family);
  if (family) entry.family = family;
  const status = trimmed(m.status);
  if (status && MODEL_STATUSES.includes(status)) entry.status = status;

  const headers = normaliseHeaders(m.headers);
  if (Object.keys(headers).length) entry.headers = headers;

  return { id, entry };
}

/**
 * Builds the opencode provider block from scratch.
 * Used for previews and for creating a provider that does not exist yet; an
 * update goes through buildProviderChanges so existing fields survive.
 */
export function buildOpencodeProvider(provider) {
  const fmt = FORMATS[provider.apiFormat] || FORMATS["openai-chat"];
  const models = {};
  for (const m of provider.models || []) {
    const built = buildModelEntry(m);
    if (built) models[built.id] = built.entry;
  }

  const block = { npm: fmt.opencodeNpm };
  const displayName = trimmed(provider.displayName) || trimmed(provider.name);
  if (displayName) block.name = displayName;

  const options = {};
  const baseURL = trimmed(provider.baseURL);
  if (baseURL) options.baseURL = baseURL;
  if (provider.useEnvVar && trimmed(provider.envVarName)) {
    // opencode substitutes {env:VAR}; a bare $VAR would be sent as the literal key.
    block.env = [trimmed(provider.envVarName)];
    options.apiKey = `{env:${trimmed(provider.envVarName)}}`;
  } else if (trimmed(provider.apiKey)) {
    options.apiKey = trimmed(provider.apiKey);
  }
  // Not declared in the schema's options block, but not forbidden either, and
  // it is how the AI SDK passes extra headers per provider.
  const headers = normaliseHeaders(provider.headers);
  if (Object.keys(headers).length) options.headers = headers;
  const timeout = num(provider.timeout);
  if (timeout > 0) options.timeout = timeout;
  if (Object.keys(options).length) block.options = options;

  block.models = models;
  return block;
}

/**
 * Translates a provider into patch operations for jsonc-edit.
 *
 * `merge` is used for the provider and each model so that fields this tool does
 * not manage — comments, `variants`, `interleaved`, hand-tuned `cost` — survive
 * an edit. Fields the user cleared are removed explicitly instead of being left
 * behind with a stale value.
 *
 * @returns {{ok: boolean, error?: string, providerKey?: string, changes?: object[]}}
 */
export function buildProviderChanges(provider, opts = {}) {
  const {
    existingConfig = null,
    previousKey = "",
    setAsDefault = false,
    defaultModelId = "",
  } = opts;

  const displayName = trimmed(provider?.displayName) || trimmed(provider?.name);
  // The key is independent of the label: renaming "BAI" to "BAI (eu)" must not
  // silently create a second provider.
  const keySource = trimmed(provider?.key) || trimmed(provider?.name) || displayName;
  if (!keySource) return { ok: false, error: "Поле Name обязательно" };
  const providerKey = slugify(keySource);

  const fmt = FORMATS[provider.apiFormat] || FORMATS["openai-chat"];
  const changes = [];

  const oldKey = slugify(previousKey || "");
  const renaming = !!previousKey && oldKey !== providerKey;
  const existingProviders = existingConfig?.provider || {};
  if (renaming) {
    if (!existingProviders[oldKey]) {
      return { ok: false, error: `Провайдер «${oldKey}» не найден для переименования` };
    }
    if (existingProviders[providerKey]) {
      return { ok: false, error: `Провайдер «${providerKey}» уже существует` };
    }
    // Rename first so the merges below land on the new key.
    changes.push({ op: "rename", path: ["provider", oldKey], key: providerKey });
  }

  const base = ["provider", providerKey];
  const prior = existingProviders[renaming ? oldKey : providerKey] || null;

  // ---- provider-level fields
  const merge = { npm: fmt.opencodeNpm };
  if (displayName) merge.name = displayName;

  const options = {};
  const baseURL = trimmed(provider.baseURL);
  if (baseURL) options.baseURL = baseURL;

  const envVarName = trimmed(provider.envVarName);
  if (provider.useEnvVar && envVarName) {
    merge.env = [envVarName];
    options.apiKey = `{env:${envVarName}}`;
  } else if (trimmed(provider.apiKey)) {
    options.apiKey = trimmed(provider.apiKey);
  }

  // "Never submitted" and "submitted empty" must stay distinguishable.
  // The form has no headers input, so `provider.headers` is undefined on every
  // ordinary save. Treating that as "cleared" deleted hand-written
  // `options.headers` — an anthropic-version pin, a proxy token — as soon as the
  // user re-saved a provider imported from the config. Only an explicitly
  // emptied value clears them now.
  const headersSubmitted = provider.headers !== undefined && provider.headers !== null;
  const headers = headersSubmitted ? normaliseHeaders(provider.headers) : {};
  if (Object.keys(headers).length) options.headers = headers;
  const timeout = num(provider.timeout);
  if (timeout > 0) options.timeout = timeout;

  if (Object.keys(options).length) merge.options = options;
  changes.push({ op: "merge", path: base, value: merge });

  // Drop what is no longer configured, so a cleared field does not linger.
  if (!(provider.useEnvVar && envVarName) && prior?.env) {
    changes.push({ op: "delete", path: [...base, "env"] });
  }
  if (!options.apiKey && prior?.options?.apiKey !== undefined) {
    changes.push({ op: "delete", path: [...base, "options", "apiKey"] });
  }
  // A merge only sets the leaves it carries, so a field the user cleared would
  // otherwise linger with its stale value and the form would lie about what a
  // save does. Mirror the apiKey rule above for the other scalar options.
  if (!options.baseURL && prior?.options?.baseURL !== undefined) {
    changes.push({ op: "delete", path: [...base, "options", "baseURL"] });
  }
  if (!(timeout > 0) && prior?.options?.timeout !== undefined) {
    changes.push({ op: "delete", path: [...base, "options", "timeout"] });
  }
  if (headersSubmitted && !options.headers && prior?.options?.headers !== undefined) {
    changes.push({ op: "delete", path: [...base, "options", "headers"] });
  }
  // `apiKey` directly on the provider block is not in the schema and makes
  // opencode reject the file. Move it into options instead of leaving both.
  if (prior && Object.prototype.hasOwnProperty.call(prior, "apiKey")) {
    changes.push({ op: "delete", path: [...base, "apiKey"] });
  }

  // ---- models
  const wanted = new Map();
  for (const m of provider.models || []) {
    const built = buildModelEntry(m);
    if (built) wanted.set(built.id, { entry: built.entry, form: m });
  }
  if (!wanted.size) {
    return { ok: false, error: "Нужна хотя бы одна модель с непустым id" };
  }

  for (const [id, { entry, form }] of wanted) {
    changes.push({ op: "merge", path: [...base, "models", id], value: entry });
    // Clear only the keys whose inputs the form actually submitted. Anything the
    // form never touched — including hand-written `cost` or `variants` — stays.
    const priorModel = prior?.models?.[id];
    if (priorModel) {
      for (const k of managedModelKeys(form)) {
        if (entry[k] === undefined && priorModel[k] !== undefined) {
          changes.push({ op: "delete", path: [...base, "models", id, k] });
        }
      }
    }
  }

  // Models the user removed from the form are deleted from the config.
  for (const id of Object.keys(prior?.models || {})) {
    if (!wanted.has(id)) {
      changes.push({ op: "delete", path: [...base, "models", id] });
    }
  }

  // ---- default model
  const chosen = trimmed(defaultModelId);
  const defaultModel = chosen && wanted.has(chosen) ? chosen : [...wanted.keys()][0];
  if (setAsDefault && defaultModel) {
    changes.push({ op: "set", path: ["model"], value: `${providerKey}/${defaultModel}` });
  } else if (renaming) {
    // A rename must follow through to the pointer, or the default model breaks.
    const current = trimmed(existingConfig?.model);
    if (current.startsWith(oldKey + "/")) {
      changes.push({ op: "set", path: ["model"], value: providerKey + "/" + current.slice(oldKey.length + 1) });
    }
    const small = trimmed(existingConfig?.small_model);
    if (small.startsWith(oldKey + "/")) {
      changes.push({ op: "set", path: ["small_model"], value: providerKey + "/" + small.slice(oldKey.length + 1) });
    }
  }

  return { ok: true, providerKey, previousKey: renaming ? oldKey : "", defaultModel, changes };
}

/**
 * Patch operations that remove a provider, plus the cleanup its removal implies.
 * Leaving `model` pointing at a deleted provider would break opencode on start.
 */
export function buildRemovalChanges(key, existingConfig) {
  const providerKey = slugify(key || "");
  if (!providerKey) return { ok: false, error: "Не указан провайдер" };
  if (!existingConfig?.provider?.[providerKey]) {
    return { ok: false, error: `Провайдер «${providerKey}» не найден` };
  }
  const changes = [{ op: "delete", path: ["provider", providerKey] }];
  const orphaned = [];

  const others = Object.keys(existingConfig.provider).filter((k) => k !== providerKey);
  const fallbackFrom = (list) => {
    for (const k of list) {
      const first = Object.keys(existingConfig.provider[k]?.models || {})[0];
      if (first) return `${k}/${first}`;
    }
    return "";
  };

  for (const field of ["model", "small_model"]) {
    const cur = trimmed(existingConfig[field]);
    if (!cur.startsWith(providerKey + "/")) continue;
    const replacement = fallbackFrom(others);
    if (replacement) changes.push({ op: "set", path: [field], value: replacement });
    else changes.push({ op: "delete", path: [field] });
    orphaned.push(field);
  }

  return { ok: true, providerKey, orphaned, changes };
}

/** Recognises both the current {env:VAR} form and the legacy $VAR one. */
export function decodeApiKey(apiKey) {
  const raw = typeof apiKey === "string" ? apiKey.trim() : "";
  const curly = raw.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (curly) return { useEnvVar: true, envVarName: curly[1], apiKey: "" };
  const dollar = raw.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (dollar) return { useEnvVar: true, envVarName: dollar[1], apiKey: "" };
  const braced = raw.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (braced) return { useEnvVar: true, envVarName: braced[1], apiKey: "" };
  return { useEnvVar: false, envVarName: "", apiKey: raw };
}

/** True when the value looks like a plaintext secret rather than an env reference. */
export function isPlaintextKey(apiKey) {
  const decoded = decodeApiKey(apiKey);
  return !decoded.useEnvVar && decoded.apiKey.length > 0;
}

/** Suggests an env var name for a provider key: `baitestik` -> `BAITESTIK_API_KEY`. */
export function suggestEnvVarName(providerKey) {
  const base = String(providerKey || "provider")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "PROVIDER";
  const prefixed = /^[0-9]/.test(base) ? "P_" + base : base;
  return prefixed.endsWith("_API_KEY") ? prefixed : prefixed + "_API_KEY";
}

// Earlier versions of this tool wrote the AI SDK package into `name` instead of
// `npm`. Such blocks must still be recognised so they can be imported and fixed.
export function looksLikePackage(value) {
  const s = String(value || "").trim();
  return /^@[a-z0-9-]+\/[a-z0-9._-]+$/i.test(s) || /^@ai-sdk\//i.test(s);
}

// A provider block is "custom" when it names an AI SDK package. Blocks with
// none of these fields merely override a built-in provider.
export function isCustomProviderBlock(p) {
  if (!p || typeof p !== "object") return false;
  return !!(p.npm || p.api || looksLikePackage(p.name));
}

// Maps an opencode provider block back to the form's "API format" dropdown.
export function detectApiFormat(block) {
  const candidates = [block?.npm, looksLikePackage(block?.name) ? block.name : ""];
  for (const raw of candidates) {
    const npm = String(raw || "").toLowerCase();
    if (!npm) continue;
    for (const [id, f] of Object.entries(FORMATS)) {
      if (f.opencodeNpm.toLowerCase() === npm) return id;
    }
    if (npm.includes("anthropic")) return "anthropic";
    if (npm.includes("openai-compatible")) return "openai-chat";
    if (npm.includes("openai")) return "openai-responses";
  }
  const api = String(block?.api || "").toLowerCase();
  if (api.includes("anthropic")) return "anthropic";
  return "openai-chat";
}

/** Turns a stored model entry back into the shape the form edits. */
export function modelEntryToForm(id, entry) {
  const e = entry && typeof entry === "object" ? entry : {};
  const out = {
    id,
    name: typeof e.name === "string" ? e.name : id,
    inputTypes: Array.isArray(e.modalities?.input) ? e.modalities.input.filter((t) => VALID_MODALITIES.has(t)) : ["text"],
    outputTypes: Array.isArray(e.modalities?.output) ? e.modalities.output.filter((t) => VALID_MODALITIES.has(t)) : ["text"],
    contextWindow: num(e.limit?.context) || "",
    maxOutput: num(e.limit?.output) || "",
    reasoning: e.reasoning === true,
    toolUse: e.tool_call !== false,
  };
  if (!out.inputTypes.length) out.inputTypes = ["text"];
  if (!out.outputTypes.length) out.outputTypes = ["text"];
  if (e.cost && typeof e.cost === "object") {
    out.costInput = e.cost.input ?? "";
    out.costOutput = e.cost.output ?? "";
    if (e.cost.cache_read != null) out.costCacheRead = e.cost.cache_read;
    if (e.cost.cache_write != null) out.costCacheWrite = e.cost.cache_write;
  }
  if (typeof e.release_date === "string") out.releaseDate = e.release_date;
  if (typeof e.family === "string") out.family = e.family;
  if (typeof e.status === "string") out.status = e.status;
  if (typeof e.temperature === "boolean") out.temperature = e.temperature;
  if (e.headers && typeof e.headers === "object") out.headers = { ...e.headers };
  return out;
}
