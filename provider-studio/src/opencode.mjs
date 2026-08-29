// src/opencode.mjs
// Reads and edits the opencode config.
//
// The previous implementation parsed the file, rebuilt the provider block from
// scratch and rewrote the whole document with JSON.stringify. That destroyed
// comments, key order, formatting and every field the tool did not know about.
// Everything here now goes through a text-level patch instead: the file is
// modified in place, byte for byte, outside the spans actually being changed.
//
// Writes are guarded and atomic:
//   - the caller passes back the hash it read, and a mismatch is a 409 rather
//     than a silent overwrite of someone else's edit;
//   - the patched text is re-parsed and each change re-verified before it is
//     allowed to touch the disk;
//   - the write goes to a temp file and is renamed into place.

import { existsSync, readFileSync } from "node:fs";

import {
  parseJsonc, hasComments, applyChangesVerified, getPath,
} from "./jsonc-edit.mjs";
import {
  resolveOpencodeConfigPath, listOpencodeConfigs, defaultOpencodeConfigPath,
  fileStamp, sha256, writeFileAtomic,
} from "./paths.mjs";
import {
  slugify, buildOpencodeProvider, buildProviderChanges, buildRemovalChanges,
  FORMATS, decodeApiKey, detectApiFormat, isCustomProviderBlock, looksLikePackage,
  modelEntryToForm,
} from "./formats.mjs";

export const SCHEMA_URL = "https://opencode.ai/config.json";

// Kept for compatibility with existing callers/tests that import it.
export const CONFIG_PATH = process.env.OPENCODE_CONFIG || "";

export { listOpencodeConfigs, resolveOpencodeConfigPath };

/** Reads a config file and reports enough state for a guarded write later. */
export function readConfigAtPath(p) {
  const path = p;
  if (!existsSync(path)) {
    return {
      path, config: null, raw: null, missing: true, comments: false,
      hash: "", stamp: { exists: false, size: 0, mtime: 0, hash: "" },
    };
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return {
      path, config: null, raw: null, missing: false, comments: false,
      error: "не удалось прочитать файл: " + e.message,
      hash: "", stamp: { exists: true, size: 0, mtime: 0, hash: "" },
    };
  }
  const parsed = parseJsonc(raw);
  const base = {
    path, raw, missing: false,
    comments: hasComments(raw),
    hash: sha256(raw),
    stamp: fileStamp(path),
  };
  if (!parsed.ok) return { ...base, config: null, error: parsed.error };
  // A JSONC file whose root is not an object cannot hold providers.
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { ...base, config: null, error: "корень конфига должен быть объектом" };
  }
  return { ...base, config: parsed.value };
}

export function readConfig(configPath) {
  return readConfigAtPath(resolveOpencodeConfigPath(configPath));
}

/** Text used when the config file does not exist yet. */
function emptyConfigText() {
  return `{\n  "$schema": "${SCHEMA_URL}"\n}\n`;
}

/**
 * Loads the text to patch. A missing file yields a fresh skeleton; a malformed
 * one is refused, because patching text we could not parse would corrupt it.
 */
function loadForEdit(configPath) {
  const path = resolveOpencodeConfigPath(configPath);
  const cur = readConfigAtPath(path);
  if (cur.missing) {
    return { ok: true, path, text: emptyConfigText(), config: { $schema: SCHEMA_URL }, created: true, current: cur };
  }
  if (!cur.config) {
    return {
      ok: false, path,
      error: "opencode config не разобран: " + (cur.error || "неизвестная ошибка"),
    };
  }
  return { ok: true, path, text: cur.raw, config: cur.config, created: false, current: cur };
}

/**
 * Rejects a write when the file changed since the caller read it.
 * Without this, two tabs or an editor open in the background silently clobber
 * each other's changes.
 */
function checkConflict(current, expectedHash) {
  if (!expectedHash) return null; // caller opted out
  const actual = current?.missing ? "" : current?.hash || "";
  if (actual === expectedHash) return null;
  return {
    ok: false,
    conflict: true,
    error: "Файл изменился с момента чтения. Обнови конфиг и повтори.",
    currentHash: actual,
  };
}

/** Ensures `$schema` is present so editors validate the file. */
function withSchema(text, config) {
  if (config && Object.prototype.hasOwnProperty.call(config, "$schema")) return null;
  return { op: "set", path: ["$schema"], value: SCHEMA_URL };
}

/**
 * Computes the patched text for a provider without writing anything.
 * Used both by the preview endpoint and by the apply path, so what the user
 * sees in the diff is exactly what gets written.
 */
export function planProviderChange(provider, opts = {}) {
  const { configPath, setAsDefault = true, defaultModelId = "", previousKey = "" } = opts;
  const loaded = loadForEdit(configPath);
  if (!loaded.ok) return { ok: false, error: loaded.error, configPath: loaded.path };

  const built = buildProviderChanges(provider, {
    existingConfig: loaded.config,
    previousKey,
    setAsDefault,
    defaultModelId,
  });
  if (!built.ok) return { ok: false, error: built.error, configPath: loaded.path };

  const changes = [...built.changes];
  const schemaChange = withSchema(loaded.text, loaded.config);
  if (schemaChange) changes.unshift(schemaChange);

  const applied = applyChangesVerified(loaded.text, changes);
  if (!applied.ok) return { ok: false, error: applied.error, configPath: loaded.path };

  return {
    ok: true,
    configPath: loaded.path,
    before: loaded.text,
    after: applied.text,
    changes,
    providerKey: built.providerKey,
    previousKey: built.previousKey,
    defaultModel: built.defaultModel,
    created: loaded.created,
    hash: loaded.created ? "" : loaded.current.hash,
    // The patcher preserves comments, so this is informational only now.
    comments: !!loaded.current?.comments,
  };
}

/** Same as planProviderChange, for a removal. */
export function planProviderRemoval(key, opts = {}) {
  const { configPath } = opts;
  const loaded = loadForEdit(configPath);
  if (!loaded.ok) return { ok: false, error: loaded.error, configPath: loaded.path };
  if (loaded.created) return { ok: false, error: "Конфиг не найден", configPath: loaded.path };

  const built = buildRemovalChanges(key, loaded.config);
  if (!built.ok) return { ok: false, error: built.error, configPath: loaded.path };

  const applied = applyChangesVerified(loaded.text, built.changes);
  if (!applied.ok) return { ok: false, error: applied.error, configPath: loaded.path };

  return {
    ok: true,
    configPath: loaded.path,
    before: loaded.text,
    after: applied.text,
    changes: built.changes,
    providerKey: built.providerKey,
    orphaned: built.orphaned,
    hash: loaded.current.hash,
  };
}

/**
 * Plans a change to the top-level `model` only, leaving provider blocks alone.
 *
 * Exists because the common failure is a config that is otherwise correct while
 * `model` points at a provider that is down: opencode then fails on startup
 * even though a working provider is sitting right there in the same file.
 * Reusing upsertProviderAsDefault for this would mean rewriting the provider
 * block as a side effect of what the user asked to be a one-line change.
 */
export function planDefaultModelChange(modelId, opts = {}) {
  const { configPath } = opts;
  const target = String(modelId || "").trim();
  if (!target) return { ok: false, error: "Не указана модель" };
  // `provider/model`: the slash is what opencode splits on, and a value without
  // it silently resolves to nothing.
  const slash = target.indexOf("/");
  if (slash <= 0 || slash === target.length - 1) {
    return { ok: false, error: `Модель должна быть в форме provider/model, а не «${target}»` };
  }

  const loaded = loadForEdit(configPath);
  if (!loaded.ok) return { ok: false, error: loaded.error, configPath: loaded.path };
  if (loaded.created) return { ok: false, error: "Конфиг не найден", configPath: loaded.path };

  const providerKey = target.slice(0, slash);
  const modelName = target.slice(slash + 1);
  const block = loaded.config?.provider?.[providerKey];
  if (!block) {
    return { ok: false, error: `Провайдера «${providerKey}» нет в конфиге`, configPath: loaded.path };
  }
  // Only warn: a provider may serve models it does not list, and refusing the
  // write would block a legitimate fix.
  const listed = Object.keys(block.models || {});
  const unlisted = listed.length > 0 && !listed.includes(modelName);

  const previous = typeof loaded.config?.model === "string" ? loaded.config.model : "";
  if (previous === target) {
    return { ok: false, error: `«${target}» уже стоит моделью по умолчанию`, noop: true, configPath: loaded.path };
  }

  const changes = [{ op: "set", path: ["model"], value: target }];
  const schemaChange = withSchema(loaded.text, loaded.config);
  if (schemaChange) changes.unshift(schemaChange);

  const applied = applyChangesVerified(loaded.text, changes);
  if (!applied.ok) return { ok: false, error: applied.error, configPath: loaded.path };

  return {
    ok: true,
    configPath: loaded.path,
    before: loaded.text,
    after: applied.text,
    changes,
    modelId: target,
    previousModel: previous,
    providerKey,
    unlisted,
    hash: loaded.current.hash,
  };
}

/** Commits a default-model change planned above. */
export function setDefaultModel(modelId, opts = {}) {
  const { configPath, expectedHash, backup } = opts;
  const plan = planDefaultModelChange(modelId, { configPath });
  if (!plan.ok) return plan;
  const res = commitPlan(plan, { expectedHash, backup });
  if (!res.ok) return res;
  return { ...res, modelId: plan.modelId, previousModel: plan.previousModel, unlisted: plan.unlisted };
}

/**
 * Writes a plan produced above. Split from planning so the UI can show a diff
 * and only then commit, and so the apply path cannot diverge from the preview.
 */
export function commitPlan(plan, { expectedHash, backup } = {}) {
  if (!plan?.ok) return { ok: false, error: plan?.error || "нечего применять" };
  const current = readConfigAtPath(plan.configPath);
  const conflict = checkConflict(current, expectedHash);
  if (conflict) return { ...conflict, configPath: plan.configPath };

  // Re-verify against the file as it is right now, not as it was at plan time.
  if (!current.missing && current.raw !== plan.before) {
    return {
      ok: false, conflict: true, configPath: plan.configPath,
      error: "Файл изменился с момента предпросмотра. Обнови конфиг и повтори.",
    };
  }

  let backupFile = null;
  if (typeof backup === "function" && !current.missing) {
    try { backupFile = backup(plan.configPath); } catch { backupFile = null; }
  }

  // Final safety net: never write something that does not parse.
  const check = parseJsonc(plan.after);
  if (!check.ok) return { ok: false, error: "результат не парсится: " + check.error, configPath: plan.configPath };

  writeFileAtomic(plan.configPath, plan.after);

  return {
    ok: true,
    configPath: plan.configPath,
    providerKey: plan.providerKey,
    previousKey: plan.previousKey || "",
    defaultModel: plan.defaultModel,
    created: !!plan.created,
    backupFile,
    hash: sha256(plan.after),
    orphaned: plan.orphaned || [],
  };
}

/** Adds or updates a provider, optionally making its model the default. */
export function upsertProviderAsDefault(provider, opts = {}) {
  const { setAsDefault = true, configPath, defaultModelId = "", previousKey = "", expectedHash, backup } = opts;
  const plan = planProviderChange(provider, { configPath, setAsDefault, defaultModelId, previousKey });
  if (!plan.ok) return plan;
  const res = commitPlan(plan, { expectedHash, backup });
  if (!res.ok) return res;
  return {
    ...res,
    modelId: plan.defaultModel,
    // Comments used to be destroyed by a save; the patcher keeps them.
    commentsLost: false,
  };
}

/** Removes a provider and repoints anything that referenced it. */
export function removeProvider(key, opts = {}) {
  const { configPath, expectedHash, backup } = opts;
  const plan = planProviderRemoval(key, { configPath });
  if (!plan.ok) return plan;
  return commitPlan(plan, { expectedHash, backup });
}

/** Renames a provider key, keeping its block and fixing model pointers. */
export function renameProvider(fromKey, toKey, opts = {}) {
  const { configPath, expectedHash, backup } = opts;
  const loaded = loadForEdit(configPath);
  if (!loaded.ok) return { ok: false, error: loaded.error, configPath: loaded.path };

  const from = slugify(fromKey || "");
  const to = slugify(toKey || "");
  if (!from || !to) return { ok: false, error: "Нужны оба ключа", configPath: loaded.path };
  if (from === to) return { ok: false, error: "Ключи совпадают", configPath: loaded.path };
  if (!loaded.config?.provider?.[from]) {
    return { ok: false, error: `Провайдер «${from}» не найден`, configPath: loaded.path };
  }
  if (loaded.config.provider[to]) {
    return { ok: false, error: `Провайдер «${to}» уже существует`, configPath: loaded.path };
  }

  const changes = [{ op: "rename", path: ["provider", from], key: to }];
  for (const field of ["model", "small_model"]) {
    const cur = typeof loaded.config[field] === "string" ? loaded.config[field] : "";
    if (cur.startsWith(from + "/")) {
      changes.push({ op: "set", path: [field], value: to + "/" + cur.slice(from.length + 1) });
    }
  }
  const disabled = loaded.config.disabled_providers;
  if (Array.isArray(disabled) && disabled.includes(from)) {
    changes.push({ op: "set", path: ["disabled_providers"], value: disabled.map((d) => (d === from ? to : d)) });
  }

  const applied = applyChangesVerified(loaded.text, changes);
  if (!applied.ok) return { ok: false, error: applied.error, configPath: loaded.path };

  return commitPlan({
    ok: true, configPath: loaded.path, before: loaded.text, after: applied.text,
    changes, providerKey: to, previousKey: from, hash: loaded.current.hash,
  }, { expectedHash, backup });
}

/**
 * Writes a whole config object. Only used by the restore path, where replacing
 * the file wholesale is the point. Everything else must go through the patcher.
 */
export function writeConfig(config, path) {
  const target = resolveOpencodeConfigPath(path);
  let out = config;
  if (out && typeof out === "object" && !Array.isArray(out) && !out.$schema) {
    out = { $schema: SCHEMA_URL, ...out };
  }
  writeFileAtomic(target, JSON.stringify(out, null, 2) + "\n");
  return target;
}

/** Writes raw text, e.g. restoring a backup verbatim. Refuses invalid JSONC. */
export function writeConfigText(text, path) {
  const target = resolveOpencodeConfigPath(path);
  const parsed = parseJsonc(text);
  if (!parsed.ok) return { ok: false, error: "текст не парсится: " + parsed.error };
  writeFileAtomic(target, text);
  return { ok: true, configPath: target, hash: sha256(text) };
}

/** Turns a stored provider block back into the shape the form edits. */
export function providerBlockToForm(key, block) {
  const p = block && typeof block === "object" ? block : {};
  const { useEnvVar, envVarName, apiKey } = decodeApiKey(
    // A schema-invalid top-level apiKey still needs to be surfaced so it can be fixed.
    p.options?.apiKey !== undefined ? p.options.apiKey : p.apiKey,
  );
  const displayName = !looksLikePackage(p.name) && typeof p.name === "string" ? p.name : "";
  return {
    key,
    name: displayName || key,
    displayName: displayName || key,
    baseURL: typeof p.options?.baseURL === "string" ? p.options.baseURL : "",
    apiFormat: detectApiFormat(p),
    useEnvVar,
    envVarName,
    apiKey,
    headers: p.options?.headers && typeof p.options.headers === "object" ? { ...p.options.headers } : {},
    timeout: typeof p.options?.timeout === "number" ? p.options.timeout : "",
    models: Object.entries(p.models || {}).map(([id, m]) => modelEntryToForm(id, m)),
  };
}

/** Lists the providers in a config, for the UI's manage view. */
export function openCodeProviderList(config) {
  const out = [];
  const defaultModel = typeof config?.model === "string" ? config.model : "";
  for (const [key, p] of Object.entries(config?.provider || {})) {
    const models = Object.keys(p?.models || {});
    out.push({
      key,
      name: !looksLikePackage(p?.name) && typeof p?.name === "string" ? p.name : key,
      npm: typeof p?.npm === "string" ? p.npm : "",
      baseURL: typeof p?.options?.baseURL === "string" ? p.options.baseURL : "",
      models,
      modelCount: models.length,
      custom: isCustomProviderBlock(p),
      isDefault: defaultModel.startsWith(key + "/"),
      hasKey: p?.options?.apiKey !== undefined || p?.apiKey !== undefined,
    });
  }
  return out;
}

/** Describes what would be written, for the UI summary panel. */
export function opencodeSummary(provider) {
  const fmt = FORMATS[provider?.apiFormat] || FORMATS["openai-chat"];
  return {
    providerKey: slugify(provider?.key || provider?.name),
    npm: fmt.opencodeNpm,
    baseURL: provider?.baseURL || "",
    block: buildOpencodeProvider(provider || {}),
  };
}

export { getPath, defaultOpencodeConfigPath };
