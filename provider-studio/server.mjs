import http from "node:http";
import path from "node:path";
import { existsSync, readFileSync, renameSync, unlinkSync, statSync, rmSync } from "node:fs";
import { exec, execFile } from "node:child_process";
import {
  readConfig, readConfigAtPath, setDefaultModel,
  planProviderChange, planProvidersRemoval, removeProviders, renameProvider,
  listOpencodeConfigs, writeConfigText, commitPlan, SCHEMA_URL,
} from "./src/opencode.mjs";
import { buildPreview } from "./src/diff.mjs";
import { parseJsonc } from "./src/jsonc-edit.mjs";
import { applySchemaChanges } from "./src/schema.mjs";
import { buildAutoFixChanges, planRefresh, runSelfCheck, isFreeEntry, buildRefreshChanges } from "./src/doctor.mjs";
import { smartAudit } from "./src/smart-audit.mjs";
import { loadDigest } from "./src/digest.mjs";
import { buildManifest, buildGuide, TARGETS } from "./src/targets.mjs";
import { planKiloWrite, planWorkBuddyWrite, writeHarnessPlan, removeKiloProvider, removeWorkBuddyProvider } from "./src/harness-config.mjs";
import { FORMATS, slugify, decodeApiKey, detectApiFormat, isCustomProviderBlock, looksLikePackage, modelEntryToForm, buildProviderChanges } from "./src/formats.mjs";
import {
  parseKeyPool, maskKey, poolEnvNames, poolEnvBaseFor, validateKeyPool, fetchKeyBalance,
  buildPoolShards, buildKeypoolPlugin, poolPluginFileName, poolPluginDirName, mergePluginEntry,
  MAX_POOL_KEYS,
} from "./src/keypool.mjs";
import { PRESETS } from "./src/presets.mjs";
import {
  backupConfig, listBackups, restoreBackup, validateConfig, testConnection,
  fetchModels, testCompletion, introducedErrors,
} from "./src/rescue.mjs";
import { loadCatalog, enrichModels } from "./src/catalog.mjs";
import { runBatch } from "./src/batch.mjs";
import { dataDir, ensureDir, writeFileAtomic, sha256 } from "./src/paths.mjs";
import { readAsset, normaliseRel, isPackaged, publicDir } from "./src/assets.mjs";
import {
  lookupEnv, resolveKeyRef, keyRefProblem, setEnvCommand, clearEnvCache,
  ENV_NAME_RE, SETX_MAX_LENGTH, setUserEnvVar, listUserEnvNames,
  removeUserEnvVar, KEY_LIKE_RE, opencodeRestartHint, OPENCODE_RESTART_COMMAND,
  isProtectedEnvVar, cleanGhostEnvVars,
} from "./src/env.mjs";
import { proxyForUrl, describeProxy } from "./src/proxy.mjs";

// The store lives in the per-user data dir, not next to the source: a packaged
// exe sits in a read-only directory.
const STORE = () => path.join(dataDir(), "providers.json");
const PORT_VALUE = process.env.PORT;
// An empty PORT is a common shell accident; treat it like "not set" rather
// than crashing on Number("") being 0 and thus "not an integer in range".
const WANTED = !PORT_VALUE ? 5173 : Number(PORT_VALUE);
if (!Number.isInteger(WANTED) || WANTED < 1 || WANTED > 65535) {
  throw new Error("PORT должен быть целым числом от 1 до 65535");
}
// Bind to loopback by default: the API is unauthenticated and can read the
// opencode config, so exposing it on the LAN would leak credentials.
const HOST = process.env.PS_HOST || "127.0.0.1";
const MAX_BODY = 1024 * 1024; // 1 MB
let PORT_ACTIVE = WANTED;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

// ---------- provider store ----------
// The on-disk file has historically held a bare object instead of an array;
// normalise so a legacy file can't take the whole server down.
function loadStore() {
  const file = STORE();
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw Object.assign(new Error(`Не удалось прочитать store провайдеров: ${e?.message || e}`), { statusCode: 500 });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw Object.assign(new Error(`Store провайдеров повреждён: ${e?.message || e}`), { statusCode: 500 });
  }
  if (Array.isArray(parsed)) {
    if (parsed.some((p) => !p || typeof p !== "object" || Array.isArray(p))) {
      throw Object.assign(new Error("Store провайдеров повреждён: массив содержит невалидную запись"), { statusCode: 500 });
    }
    return parsed;
  }
  if (parsed && typeof parsed === "object") return [parsed];
  throw Object.assign(new Error("Store провайдеров повреждён: ожидался массив или legacy-объект"), { statusCode: 500 });
}

// API keys are never persisted here: the file sits inside the repo and would be
// trivially committed. Only the env-var reference is kept. Pool raw keys
// (poolKeys/poolRaw) are stripped for the same reason — only pool metadata
// (env base + size, no secrets) is kept.
function stripSecrets(provider) {
  const { apiKey, poolKeys, poolRaw, ...rest } = provider || {};
  return { ...rest, apiKey: "" };
}

function saveStore(list) {
  loadStore();
  ensureDir(dataDir());
  const safe = (Array.isArray(list) ? list : []).map(stripSecrets);
  // Atomic: a crash mid-write would otherwise leave a truncated store that
  // loadStore() silently reads as "no providers".
  writeFileAtomic(STORE(), JSON.stringify(safe, null, 2));
}

// Providers are identified by their opencode key so that Apply followed by
// Import doesn't create a near-duplicate entry for the same provider.
// The explicit key wins: an imported provider keeps `key` distinct from the
// display `name`, and slugifying only the name would miss it and duplicate.
function providerKeyOf(p) {
  // Exact key first: a config key may legally be `my_provider` or `dot.name`,
  // and slugifying it here made store lookups miss the block the config has.
  if (p && typeof p.key === "string" && p.key.trim()) return p.key.trim();
  return slugify(p && p.name);
}

const PROBE_HISTORY = () => path.join(dataDir(), "model-health.json");
const PROBE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PROBE_FAULTS = new Set(["key", "nokey", "quota", "plan", "region", "blocked", "model", "endpoint", "proxy", "client"]);
let probeOrder = 0;

function loadProbeHistory() {
  let text;
  try { text = readFileSync(PROBE_HISTORY(), "utf8"); }
  catch (e) { if (e?.code === "ENOENT") return []; throw e; }
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error("Некорректная история проверок");
  const now = Date.now();
  return rows.filter((r) => r && /^[a-f0-9]{64}$/.test(r.context)
    && typeof r.id === "string" && r.id.length > 0 && r.id.length <= 2048
    && typeof r.ok === "boolean" && Number.isFinite(r.checkedAt) && Number.isFinite(r.startedAt)
    && r.startedAt <= r.checkedAt && r.checkedAt <= now && r.checkedAt > now - PROBE_RETENTION_MS)
    .map((r) => ({
      context: r.context, id: r.id, startedAt: r.startedAt, startedOrder: Number.isSafeInteger(r.startedOrder) ? r.startedOrder : 0, checkedAt: r.checkedAt,
      ok: r.ok, reach: r.reach === "up" || r.reach === "down" ? r.reach : null,
      fault: PROBE_FAULTS.has(r.fault) ? r.fault : null, transient: r.transient === true,
    }));
}

function probeFingerprint(configPath, key, provider, apiKey) {
  return sha256(JSON.stringify([
    configPath, key, String(provider.baseURL || "").trim().replace(/\/+$/, ""),
    provider.apiFormat || "openai-chat", apiKey, proxyForUrl(provider.baseURL) || "",
  ]));
}

function configuredProbeContext(cfg, key) {
  const p = cfg.config?.provider?.[key];
  if (!p || typeof p !== "object") return null;
  const provider = {
    baseURL: p.options?.baseURL || p.baseURL || "",
    apiFormat: detectApiFormat(p),
    apiKey: p.options?.apiKey ?? p.apiKey ?? "",
  };
  if (!provider.baseURL) return null;
  const creds = probeCredentials(provider, cfg.path, key);
  if (creds.blocker) return null;
  return probeFingerprint(cfg.path, key, provider, creds.apiKey);
}

function modelHealthState(cfg) {
  try {
    const history = loadProbeHistory();
    const modelHealth = {};
    if (!history.length) return { modelHealth, healthWarning: "" };
    for (const [key, p] of Object.entries(cfg.config?.provider || {})) {
      const context = configuredProbeContext(cfg, key);
      if (!context) continue;
      for (const r of history) {
        if (r.context !== context || !Object.hasOwn(p.models || {}, r.id)) continue;
        const ttl = r.transient || r.fault === "quota" ? 5 * 60 * 1000 : 60 * 60 * 1000;
        modelHealth[`${key}/${r.id}`] = {
          ok: r.ok, reach: r.reach, fault: r.fault, transient: r.transient,
          checkedAt: r.checkedAt, expiresAt: r.checkedAt + ttl,
        };
      }
    }
    return { modelHealth, healthWarning: "" };
  } catch {
    return { modelHealth: {}, healthWarning: "История проверок недоступна; маршруты не считают модели проверенными." };
  }
}

function modelProbeIdentity(body, apiKey) {
  const configPath = readConfig(body.configPath).path;
  const key = String(body.previousKey || providerKeyOf(body.provider));
  return { configPath, key, context: probeFingerprint(configPath, key, body.provider || {}, apiKey), startedAt: Date.now(), startedOrder: ++probeOrder };
}

function modelProbeResult(result, identity) {
  const checkedAt = result.checkedAt || Date.now();
  const transient = result.transient === true || (!result.ok && (result.status >= 500 || result.reach === "down" || result.kind === "timeout" || result.kind === "network"));
  return {
    ...result, startedAt: result.startedAt ?? identity.startedAt, startedOrder: result.startedOrder ?? identity.startedOrder,
    checkedAt, transient, expiresAt: checkedAt + (transient || result.fault === "quota" ? 300000 : 3600000),
  };
}

function recordModelProbes(identity, results) {
  const { configPath, key, context } = identity;
  const cfg = readConfig(configPath);
  try {
    // A probe of an unsaved connection must not certify the on-disk route.
    if (context === configuredProbeContext(cfg, key)) {
      const history = loadProbeHistory();
      let changed = false;
      for (const r of results) {
        if (!r.id || typeof r.ok !== "boolean" || !Object.hasOwn(cfg.config.provider[key].models || {}, r.id)) continue;
        const startedAt = r.startedAt ?? identity.startedAt;
        const startedOrder = r.startedOrder ?? identity.startedOrder;
        const index = history.findIndex((x) => x.context === context && x.id === r.id);
        const previous = history[index];
        if (previous && (previous.startedAt > startedAt || (previous.startedAt === startedAt && previous.startedOrder > startedOrder))) continue;
        const entry = {
          context, id: r.id, startedAt, startedOrder, checkedAt: r.checkedAt || Date.now(),
          ok: r.ok, reach: r.reach === "up" || r.reach === "down" ? r.reach : null,
          fault: PROBE_FAULTS.has(r.fault) ? r.fault : null,
          transient: r.transient === true,
        };
        if (index >= 0) history[index] = entry; else history.push(entry);
        changed = true;
      }
      if (changed) writeFileAtomic(PROBE_HISTORY(), JSON.stringify(history.sort((a, b) => b.checkedAt - a.checkedAt).slice(0, 5000)));
    }
    return modelHealthState(cfg);
  } catch {
    return { ...modelHealthState(cfg), healthWarning: "Результат получен, но историю проверок сохранить не удалось." };
  }
}

// Every `{env:VAR}` / `$VAR` / `${VAR}` reference plus every `env: [...]`
// entry in the config. Used by /api/env-audit and as the guard for
// /api/env-remove so cleanup can never delete a variable the config needs.
function collectReferencedEnv(config) {
  const names = new Map(); // lower -> original case
  const providers = (config && typeof config === "object" ? config.provider : null) || {};
  for (const p of Object.values(providers)) {
    if (!p || typeof p !== "object") continue;
    const raw = p.options?.apiKey ?? p.apiKey;
    if (typeof raw === "string" && raw.trim()) {
      const d = decodeApiKey(raw.trim());
      if (d.useEnvVar && d.envVarName && !names.has(d.envVarName.toLowerCase())) {
        names.set(d.envVarName.toLowerCase(), d.envVarName);
      }
    }
    if (Array.isArray(p.env)) {
      for (const n of p.env) {
        const clean = String(n || "").trim();
        if (ENV_NAME_RE.test(clean) && !names.has(clean.toLowerCase())) {
          names.set(clean.toLowerCase(), clean);
        }
      }
    }
  }
  try {
    const store = loadStore();
    for (const p of store) {
      if (!p || typeof p !== "object") continue;
      const envName = String(p.envVarName || "").trim();
      if (envName && ENV_NAME_RE.test(envName) && !names.has(envName.toLowerCase())) {
        names.set(envName.toLowerCase(), envName);
      }
      if (Array.isArray(p.envNames)) {
        for (const n of p.envNames) {
          const clean = String(n || "").trim();
          if (ENV_NAME_RE.test(clean) && !names.has(clean.toLowerCase())) {
            names.set(clean.toLowerCase(), clean);
          }
        }
      }
      if (Array.isArray(p?.pool?.shards)) {
        for (const s of p.pool.shards) {
          const sEnv = String(s?.envVarName || s?.env || s || "").trim();
          if (sEnv && ENV_NAME_RE.test(sEnv) && !names.has(sEnv.toLowerCase())) {
            names.set(sEnv.toLowerCase(), sEnv);
          }
        }
      }
    }
  } catch {}
  return [...names.values()];
}

/**
 * Expands a removal request to every config key it really owns. A pool head
 * owns its shards (recorded in the store at pool-apply time); a plain provider
 * owns just itself. Also resolves the rotation plugin file, if the pool had
 * one. Deleting via a shard key ("slug-2") still resolves the whole pool.
 */
function resolveRemoval(wanted) {
  const raw = String(wanted || "").trim();
  const slug = slugify(raw);
  // Exact matching first. `my_provider` must resolve to itself, not to the
  // slugified `my-provider` that the file never contained.
  const same = (v) => {
    const x = String(v || "");
    if (!x) return false;
    return x === raw || x === slug || x.toLowerCase() === raw.toLowerCase();
  };
  // A corrupt store must not block the removal itself: fall back to the single
  // key and let the endpoints report the store problem where they always did.
  let store = null;
  try { store = loadStore(); } catch { store = null; }
  const record = (store || []).find((p) => {
    if (same(providerKeyOf(p))) return true;
    const shards = p && p.pool && Array.isArray(p.pool.shards) ? p.pool.shards : null;
    return !!(shards && shards.some((s) => same(s)));
  });
  const shards = record && record.pool && Array.isArray(record.pool.shards) && record.pool.shards.length
    ? record.pool.shards.map((s) => String(s)).filter(Boolean)
    : [(record ? providerKeyOf(record) : (raw || slug))].filter(Boolean);
  const pluginFile = record && record.pool && typeof record.pool.pluginFile === "string"
    ? record.pool.pluginFile : "";
  return { keys: shards, pluginFile, pluginFileName: pluginFile ? pluginFile.split(/[\\/]/).pop() : "" };
}

/**
 * Removes the generated rotation plugin next to the config by moving it into
 * the data dir, so undo can put it back. Guarded to our own file shape inside
 * the config directory: never an arbitrary path, even if the store record was
 * hand-edited. Returns { stash, target } or null when there was nothing to do.
 */
function stashPoolPluginFile(configPath, pluginFile) {
  if (!pluginFile) return null;
  const base = String(pluginFile).split(/[\\/]/).pop() || "";
  if (!/^keypool-[a-z0-9-]+(\.mjs)?$/.test(base)) return null;
  try {
    const dir = path.dirname(path.resolve(configPath));
    let target = path.resolve(pluginFile);
    if (!existsSync(target)) {
      target = path.resolve(dir, "plugins", base);
      if (!existsSync(target)) {
        target = path.resolve(dir, base);
      }
    }
    if (!existsSync(target)) return null;
    const stashDir = path.join(dataDir(), "plugin-trash");
    ensureDir(stashDir);
    const stash = path.join(stashDir, `${Date.now()}-${base}`);
    renameSync(target, stash);
    return { stash, target };
  } catch { return null; }
}

/** Puts a stashed rotation plugin back where the removal took it from. */
function restoreStashedPlugin(entry) {
  if (!entry || typeof entry.pluginStash !== "string" || typeof entry.pluginTarget !== "string") return false;
  try {
    if (!existsSync(entry.pluginStash) || existsSync(entry.pluginTarget)) return false;
    ensureDir(path.dirname(entry.pluginTarget));
    renameSync(entry.pluginStash, entry.pluginTarget);
    return true;
  } catch { return false; }
}

/** Drops the stash belonging to an undo record that is about to be replaced. */
function discardStashedPlugin(entry) {
  if (!entry || typeof entry.pluginStash !== "string") return;
  try {
    if (existsSync(entry.pluginStash) && statSync(entry.pluginStash).isDirectory()) {
      rmSync(entry.pluginStash, { recursive: true, force: true });
    } else {
      unlinkSync(entry.pluginStash);
    }
  } catch { /* already gone */ }
}

// ---------- undo (single-level rollback of the last write) ----------
// Every successful config mutation records how to revert itself: the snapshot
// taken immediately before the write. The record survives restarts (it lives
// in the data dir next to backups), but it is deliberately single-level — a
// history UI would suggest safety this file-level rollback cannot promise
// once external edits land in between.
const LAST_WRITE_FILE = () => path.join(dataDir(), "last-write.json");

function readUndo() {
  try {
    const v = JSON.parse(readFileSync(LAST_WRITE_FILE(), "utf8"));
    if (!v || typeof v !== "object") return null;
    if (typeof v.configPath !== "string" || !v.configPath) return null;
    if (typeof v.label !== "string") return null;
    return v;
  } catch { return null; }
}

function clearUndo() {
  try { unlinkSync(LAST_WRITE_FILE()); } catch { /* already gone */ }
}

// What the UI may offer to revert. Scoped to the file currently being viewed:
// an undo entry for another config would revert the wrong file.
function currentUndo(configPath) {
  const u = readUndo();
  if (!u || u.configPath !== configPath) return null;
  return { label: u.label, time: u.time || 0 };
}

// Remembers how to revert the write that just landed. preFile is the snapshot
// taken immediately before the write (null when the file was created from
// scratch); afterHash lets an undo-of-creation refuse when the file has since
// moved on. Never throws: undo is a convenience, and a write must not fail
// because the convenience bookkeeping did.
function recordUndo(configPath, preFile, label, afterHash = "", extra = {}) {
  try {
    ensureDir(dataDir());
    // Undo is single-level: the stash of the record being replaced is dead.
    const previous = readUndo();
    if (previous) discardStashedPlugin(previous);
    writeFileAtomic(LAST_WRITE_FILE(), JSON.stringify({
      configPath,
      file: preFile ? path.basename(String(preFile)) : null,
      label, afterHash: afterHash || "",
      created: !preFile, time: Date.now(),
      ...(extra.pluginStash && extra.pluginTarget
        ? { pluginStash: extra.pluginStash, pluginTarget: extra.pluginTarget }
        : {}),
    }));
  } catch { /* ignore */ }
}

/**
 * Works out which key a probe should actually send for a form payload.
 *
 * Two cases the UI cannot resolve on its own:
 *  1. The provider was imported from the opencode config, so the key field is
 *     empty and the real value lives behind `{env:VAR}`. Probing with "" would
 *     report a 401 the user cannot act on.
 *  2. The form is in $ENV mode. The literal key typed into the field is
 *     discarded on write, so probing with it would report success for a config
 *     that is going to fail. The variable is what must be probed.
 *
 * Returns { apiKey, blocker }. A non-empty `blocker` means the probe is
 * pointless and the message explains why in terms the user can fix.
 */
/**
 * /api/state hands the UI a mask (••••xxxx) instead of a plaintext key. When a
 * write or a probe comes back carrying that exact mask, the user never touched
 * the field: resolve it to the real key from the config. A mask that matches
 * nothing means the config moved on — refusing is safer than writing the mask
 * as the key or silently deleting a key that changed behind the form.
 */
function unmaskApiKey(provider, configPath, previousKey = "") {
  const p = provider && typeof provider === "object" ? provider : {};
  const masked = String(p.apiKey || "").trim();
  if (!masked.startsWith("••••")) return { provider: p, error: "" };
  const cfg = readConfig(configPath || "");
  // The block may sit under the form's key or under the pre-rename key. The
  // exact key comes first: slugifying it would miss `my_provider`.
  const keys = [...new Set([
    providerKeyOf(p),
    String(previousKey || "").trim(),
    slugify(previousKey || ""),
  ].filter(Boolean))];
  for (const k of keys) {
    const block = cfg.config?.provider?.[k];
    const raw = String(block?.options?.apiKey ?? block?.apiKey ?? "");
    if (raw && maskKey(raw) === masked) return { provider: { ...p, apiKey: raw }, error: "" };
  }
  return {
    provider: p,
    error: "Ключ в конфиге изменился с момента загрузки формы — кликни провайдера в списке заново и повтори.",
  };
}

function probeCredentials(p, configPath = "", previousKey = "") {
  const provider = p || {};
  // In $ENV mode the variable wins over the field, mirroring what gets written.
  const ref = provider.useEnvVar && provider.envVarName
    ? `{env:${String(provider.envVarName).trim()}}`
    : String(provider.apiKey || "").trim();
  // A masked field holds no key at all — resolve it first, or the probe would
  // send "••••abcd" as the credential and report a misleading 401.
  if (!provider.useEnvVar && ref.startsWith("••••")) {
    const unmasked = unmaskApiKey(provider, configPath, previousKey);
    if (unmasked.error) return { apiKey: "", blocker: unmasked.error };
    return { apiKey: String(unmasked.provider.apiKey || ""), blocker: "" };
  }
  const resolved = resolveKeyRef(ref);
  if (resolved.isRef && !resolved.resolved) {
    return { apiKey: "", blocker: keyRefProblem(ref) };
  }
  return { apiKey: resolved.value, blocker: "" };
}

/**
 * Last line of defence before a write: refuses text that would ADD
 * schema errors opencode rejects the whole file for. Pre-existing problems
 * never block — fixing the file is the doctor's job, not the price of a save.
 * Returns an error string, or "" when the write may proceed.
 */
function refuseIntroduced(beforeText, afterText) {
  const before = parseJsonc(beforeText);
  const after = parseJsonc(afterText);
  if (!before.ok || !after.ok) return "";
  const added = introducedErrors(before.value, after.value);
  if (!added.length) return "";
  const shown = added.slice(0, 3).map((i) => i.message).join(" | ");
  return `Запись отклонена: она добавляет ошибки схемы (${added.length}): ${shown}`;
}

/**
 * Normalises a pool payload from the UI into raw keys + env base.
 * Accepts either an explicit array or multiline text. Never throws:
 * validation problems come back as { ok:false }.
 */
function readPoolInput(body) {
  const b = body && typeof body === "object" ? body : {};
  let parsed;
  if (Array.isArray(b.keys)) {
    const keys = b.keys.map((k) => String(k ?? "").trim()).filter(Boolean);
    const seen = new Set();
    const deduped = [];
    let droppedDuplicates = 0;
    for (const k of keys) {
      if (seen.has(k)) { droppedDuplicates++; continue; }
      seen.add(k);
      deduped.push(k);
    }
    parsed = {
      keys: deduped.slice(0, MAX_POOL_KEYS),
      emptyLines: 0,
      droppedDuplicates,
      truncated: Math.max(0, deduped.length - MAX_POOL_KEYS),
    };
  } else {
    parsed = parseKeyPool(b.keysText ?? b.poolKeys ?? b.poolRaw ?? "");
  }
  const provider = b.provider && typeof b.provider === "object" ? b.provider : {};
  const envBase = String(
    b.envBase || b.envVarName || provider.envVarName || poolEnvBaseFor(provider.name),
  ).trim();
  return { provider, envBase, ...parsed };
}

/**
 * Computes the patched text for a whole key pool without writing anything.
 * The first shard keeps the provider's own key (so an existing
 * `model: slug/...` keeps working); shards 2..N become `slug-2..N`.
 * With withPlugin a fetch-patching opencode plugin is staged next to the
 * config and registered in top-level `plugin`.
 */
function planPoolChange({ provider, envBase, keys, configPath, setAsDefault = true, defaultModelId = "", previousKey = "", withPlugin = true }) {
  const cfg = readConfig(configPath);
  if (!cfg.config && !cfg.missing) {
    return { ok: false, error: "opencode config не разобран: " + (cfg.error || "неизвестная ошибка"), configPath: cfg.path };
  }
  const err = validateKeyPool(keys);
  if (err) return { ok: false, error: err, configPath: cfg.path };
  if (!ENV_NAME_RE.test(envBase)) {
    return { ok: false, error: `Недопустимое имя переменной пула: «${envBase || "(пусто)"}»`, configPath: cfg.path };
  }
  const baseText = cfg.missing ? `{\n  "$schema": "${SCHEMA_URL}"\n}\n` : cfg.raw;
  const existingConfig = cfg.config || { $schema: SCHEMA_URL };
  const shards = buildPoolShards(provider, envBase, keys);
  if (!shards.length) return { ok: false, error: "Пустой пул — нечего применять", configPath: cfg.path };

  const changes = [];
  if (!Object.prototype.hasOwnProperty.call(existingConfig, "$schema")) {
    changes.push({ op: "set", path: ["$schema"], value: SCHEMA_URL });
  }
  const shardKeys = [];
  // Shards 2..N are named by suffixing the head key. When the head key is exact
  // (`my_pool`), the suffix must be exact too: slugifying it would write
  // `my-pool-2` next to `my_pool` and leave the old shard behind on the next
  // save. `buildProviderChanges` collapses each shard back onto this exact key.
  const prevRaw = String(previousKey || "").trim();
  const providerSlug = slugify(provider?.key || provider?.name || "");
  const exactBase = prevRaw && providerSlug && slugify(prevRaw) === providerSlug ? prevRaw : "";
  for (let i = 0; i < shards.length; i++) {
    const built = buildProviderChanges(shards[i], {
      existingConfig,
      previousKey: i === 0 ? previousKey : (exactBase ? `${exactBase}-${i + 1}` : ""),
      setAsDefault: false,
      defaultModelId: "",
    });
    if (!built.ok) return { ok: false, error: built.error, configPath: cfg.path };
    shardKeys.push(built.providerKey);
    changes.push(...built.changes);
  }
  // One default pointer for the whole pool: the explicitly chosen model when
  // it belongs to the first shard, otherwise the first shard's first model.
  const firstModels = (Array.isArray(provider.models) ? provider.models : [])
    .map((m) => (typeof m === "string" ? m : m?.id)).map((s) => String(s || "").trim()).filter(Boolean);
  const wanted = String(defaultModelId || "").trim();
  const fallback = firstModels[0] || "";
  const chosenModel = (wanted && firstModels.includes(wanted)) ? wanted : fallback;
  let defaultModel = "";
  if (setAsDefault && shardKeys[0] && chosenModel) {
    defaultModel = `${shardKeys[0]}/${chosenModel}`;
    changes.push({ op: "set", path: ["model"], value: defaultModel });
  }

  let plugin = null;
  if (withPlugin) {
    const envNames = poolEnvNames(envBase, keys.length);
    const built = buildKeypoolPlugin({
      providerKey: shardKeys[0],
      displayName: shards[0].displayName,
      baseURL: shards[0].baseURL,
      apiFormat: provider.apiFormat || "openai-chat",
      envNames,
    });
    const dir = path.dirname(cfg.path);
    const pluginDir = path.resolve(dir, "plugins", built.dirName || poolPluginDirName(shardKeys[0]));
    const merged = mergePluginEntry(cfg.config?.plugin, pluginDir);
    changes.push({ op: "set", path: ["plugin"], value: merged });
    plugin = {
      dirName: built.dirName || poolPluginDirName(shardKeys[0]),
      pluginDir,
      path: pluginDir,
      entry: pluginDir,
      fileName: built.fileName,
      packageJsonText: built.packageJsonText,
      indexSource: built.indexSource || built.source,
      source: built.source,
      envNames,
    };
  }

  const pluginWarning = "";

  const applied = applySchemaChanges(baseText, existingConfig, changes);
  if (!applied.ok) return { ok: false, error: applied.error, configPath: cfg.path };
  return {
    ok: true,
    configPath: cfg.path,
    before: baseText,
    after: applied.text,
    changes: applied.changes,
    shardKeys,
    shards: shards.map((s, i) => ({ key: shardKeys[i], envVar: i === 0 ? envBase : `${envBase}_${i + 1}` })),
    envNames: poolEnvNames(envBase, keys.length),
    defaultModel,
    plugin,
    pluginWarning,
    created: !!cfg.missing,
    hash: cfg.missing ? "" : cfg.hash || "",
  };
}

/**
 * Candidate OpenCode CLIs, best first.
 *
 * The `service` subcommand (`service restart|start|stop|status`) exists only in
 * the CLI shipped with OpenCode Desktop. An older global install on PATH prints
 * its whole help page instead — which is how "перезапусти службу" silently
 * turned into a wall of help text. So the bundled CLI is tried first and the
 * PATH one is only a fallback.
 */
function opencodeCliCandidates() {
  const out = [];
  const local = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || "";
  if (local) {
    out.push(path.join(local, "Programs", "@opencodedesktop", "resources", "opencode-cli.exe"));
    out.push(path.join(local, "Programs", "@openchamberelectron", "resources", "opencode-cli", "opencode.exe"));
  }
  out.push("opencode");
  return out;
}

/** Runs one fixed command and resolves with its streams; never rejects. */
function runFixedCommand(cli, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    // execFile, not exec: the CLI path can contain characters a shell would
    // reinterpret, and there is nothing here that needs a shell.
    execFile(cli, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, out: String(stdout || "").trim(), errOut: String(stderr || "").trim() });
    });
  });
}

/** Does this output look like a CLI printing its help page? */
function looksLikeHelp(text) {
  return /Commands:[\s\S]{0,400}opencode\s+serve/.test(String(text || ""));
}

/**
 * Runs `opencode service <action>` and returns its output.
 *
 * Deliberately narrow: only "restart"/"status" against a fixed list of CLIs,
 * never a caller-supplied command, so this endpoint cannot become a shell for
 * anything that can reach the loopback port. Bounded by a timeout because a
 * wedged service must not hang the UI request.
 *
 * Why it exists: a variable written with `setx` reaches the registry, but the
 * OpenCode background service (`opencode serve --service`) keeps the
 * environment it was started with. Closing and reopening the window does not
 * replace that process, so the new key stays invisible — the exact cause of
 * "Provide your ... API key" right after a successful setup.
 */
async function runOpencodeService(action) {
  const verb = action === "status" ? "status" : "restart";
  const tried = [];
  for (const cli of opencodeCliCandidates()) {
    const command = `${cli} service ${verb}`;
    const { err, out, errOut } = await runFixedCommand(cli, ["service", verb]);
    const text = errOut || out;
    // An older CLI answers with its help page instead of a one-line error.
    // That means "this build has no `service` command", not "the service is
    // broken" — so move on to the next candidate instead of failing.
    if (looksLikeHelp(text)) { tried.push({ cli, unsupported: true }); continue; }
    // A candidate that is not installed is not a failure of the operation —
    // the next one may work.
    if (err && (err.code === "ENOENT" || err.code === "EACCES")) {
      tried.push({ cli, missing: true });
      continue;
    }
    tried.push({ cli, unsupported: false });
    if (err) {
      return {
        ok: false, action: verb, command, tried,
        error: text || err.message || "opencode не ответил",
        hint: `Перезапусти приложение OpenCode целиком (трей → Quit) или компьютер. Вручную: ${command}`,
      };
    }
    return { ok: true, action: verb, command, output: text, tried };
  }
  return {
    ok: false, action: verb, tried,
    error: "Ни один найденный CLI opencode не знает команду `service` — её понимает только сборка, идущая с OpenCode Desktop.",
    hint: "Перезапусти приложение OpenCode целиком (трей → Quit) или компьютер. Либо обнови CLI из PATH: opencode upgrade",
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    // Buffers are collected and decoded once at the end. Concatenating chunks as
    // strings splits multi-byte UTF-8 sequences across chunk boundaries, which
    // corrupted any non-ASCII provider name that happened to straddle one.
    const chunks = [];
    let size = 0;
    let done = false;
    let overflow = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        // Drain, don't destroy: the client is still uploading, and a torn-down
        // socket turns the 413 below into an ECONNRESET the client cannot read.
        // Buffered chunks are dropped so a huge body is not held in memory.
        // Past 10x the limit patience ends — that is abuse, not a big form.
        overflow = true;
        chunks.length = 0;
        if (size > MAX_BODY * 10) {
          done = true;
          reject(Object.assign(new Error("Тело запроса слишком большое"), { statusCode: 413 }));
          req.destroy();
        }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      if (overflow) {
        // Carries its own status: the generic catch below answers 500, but a
        // client that sent megabytes of JSON has a request problem, not our bug.
        reject(Object.assign(new Error("Тело запроса слишком большое"), { statusCode: 413 }));
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        const value = text ? JSON.parse(text) : {};
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          reject(Object.assign(new Error("JSON body должен быть объектом"), { statusCode: 400 }));
          return;
        }
        resolve(value);
      } catch (e) {
        // A malformed body is the client's mistake, not a server crash:
        // without a status the generic catch below would answer 500.
        reject(Object.assign(new Error("Некорректный JSON в теле запроса"), { statusCode: 400 }));
      }
    });
    req.on("error", (e) => { if (!done) { done = true; reject(e); } });
  });
}

function json(res, code, obj) {
  // The client may be long gone (a closed tab mid pool-check): writing to a
  // destroyed socket throws ERR_STREAM_DESTROYED, and throwing again from the
  // catch-all handler would take the whole process down.
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(obj, null, 2);
  try {
    res.writeHead(code, { "Content-Type": MIME[".json"], "Content-Length": Buffer.byteLength(body) });
    res.end(res.req?.method === "HEAD" ? undefined : body);
  } catch { /* the socket died between the check and the write */ }
}

// ---------- request guards ----------
const ALLOWED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const LOOPBACK_ONLY = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";

// Blocks DNS rebinding: a hostile domain resolving to 127.0.0.1 would otherwise
// let a remote page talk to this API. Skipped when the operator deliberately
// bound to a non-loopback interface, since then any Host is legitimate.
function hostAllowed(req) {
  if (!LOOPBACK_ONLY) return true;
  const raw = String(req.headers.host || "");
  const hostname = raw.replace(/:\d+$/, "").toLowerCase();
  return ALLOWED_HOSTNAMES.has(hostname);
}

// Blocks CSRF: any page the user has open could otherwise POST to localhost and
// rewrite the opencode config. Same-origin requests carry the server's own host.
function originAllowed(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl) send no Origin
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();
    if (ALLOWED_HOSTNAMES.has(host)) {
      // Loopback alone is not enough: the UI is only ever served from this
      // server, so http://localhost:9999 is a *different* local application
      // and must not get write access to the config.
      return u.host.toLowerCase() === String(req.headers.host || "").toLowerCase();
    }
    // When bound beyond loopback, accept the host the page was actually served from.
    return !LOOPBACK_ONLY && host === String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
  } catch { return false; }
}

// Static files come from src/assets.mjs, which hides whether they live in
// ./public or are embedded in a single-executable build. `path.join` alone was
// never enough here: on Windows a percent-encoded backslash (%5c) survives URL
// parsing and acts as a separator, so `/..%5c..%5cserver.mjs` escapes the
// directory. normaliseRel() rejects those outright.
function serveStatic(res, urlPath, req) {
  const rel = normaliseRel(urlPath);
  if (rel === null) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }
  const body = readAsset(rel);
  if (body) {
    const ext = path.extname(rel).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      // The UI and the server ship together: a cached app.js from the previous
      // version talking to a new server is a class of bug reports, not a perf win.
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

const server = http.createServer(async (req, res) => {
  // A client that disconnects mid-request must not crash the process:
  // without a listener, an error on the dead socket is raised as an
  // uncaught exception (e.g. from a long pool-check still writing back).
  res.on("error", () => {});
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    return json(res, 400, { ok: false, error: "Некорректный URL запроса" });
  }
  try {
    if (!hostAllowed(req)) {
      return json(res, 403, { ok: false, error: "Недопустимый Host — открой интерфейс по адресу http://localhost:" + PORT_ACTIVE });
    }
    if (req.method !== "GET" && req.method !== "HEAD" && !originAllowed(req)) {
      return json(res, 403, { ok: false, error: "Запрос отклонён: посторонний Origin" });
    }

    if (url.pathname === "/api/state" && req.method === "GET") {
      // Scoped to the file the UI is viewing: hash, undo entry and provider
      // list all belong to it. Without this every read showed the default file
      // while writes went to the picked one.
      const cfg = readConfig(url.searchParams.get("configPath") || "");
      return json(res, 200, {
        providers: loadStore(),
        ...modelHealthState(cfg),
        targets: TARGETS,
        formats: Object.entries(FORMATS).map(([id, f]) => ({ id, label: f.label })),
        // Ready-made endpoints for the wizard: the base URL is the one field a
        // newcomer cannot guess, and a wrong guess only fails much later.
        presets: PRESETS,
        // Key-pool ceiling so the UI and the server cannot drift apart.
        poolMax: MAX_POOL_KEYS,
        port: PORT_ACTIVE,
        backups: listBackups(),
        undo: currentUndo(cfg.path),
        opencode: {
          path: cfg.path,
          exists: !!cfg.config,
          error: cfg.error || null,
          comments: !!cfg.comments,
          // The client echoes this back on write so a file that changed in the
          // meantime is refused instead of silently overwritten.
          hash: cfg.hash || "",
          providers: cfg.config ? openCodeProviderList(cfg.config) : [],
        },
      });
    }

    if (url.pathname === "/api/watch" && req.method === "GET") {
      // Lightweight poll for the external-edit watcher and the undo button.
      // The full /api/state carries presets, formats, targets and the backup
      // listing on every call — kilobytes of immutable data every 5 seconds
      // for a hash that fits in 64 chars. This answers in one file read.
      const cfg = readConfig(url.searchParams.get("configPath") || "");
      return json(res, 200, { ok: true, path: cfg.path, hash: cfg.hash || "", undo: currentUndo(cfg.path) });
    }

    if (url.pathname === "/api/apply" && req.method === "POST") {
      const body = await readBody(req);
      const unmasked = unmaskApiKey(body.provider, body.configPath, body.previousKey);
      if (unmasked.error) return json(res, 409, { ok: false, error: unmasked.error });
      const provider = unmasked.provider;
      const targets = Array.isArray(body.targets) && body.targets.length ? body.targets : ["opencode"];
      const knownTargets = new Set(["opencode", ...TARGETS.map((x) => x.id)]);
      const badTarget = targets.find((t) => !knownTargets.has(String(t)));
      // An unknown target would otherwise get a cheerful ok:true with a
      // meaningless manifest — silent success for a write that did nothing.
      if (badTarget !== undefined) {
        return json(res, 400, { ok: false, error: `Неизвестная цель записи: «${badTarget}»` });
      }
      const setAsDefault = provider.setAsDefault !== false;
      const results = {};
      let backupFile = null;

      if (!slugify(provider.name) || !String(provider.name || "").trim()) {
        return json(res, 400, { ok: false, error: "Поле Name обязательно" });
      }

      const store = loadStore();
      // The key the config block already uses wins over the slug of the display
      // name: editing `my_provider` must update that entry, not add a twin.
      const previousKeyRaw = String(body.previousKey || "").trim();
      const namedKey = providerKeyOf(provider);
      const key = previousKeyRaw && slugify(previousKeyRaw) === namedKey ? previousKeyRaw : namedKey;
      const existingIdx = store.findIndex((p) => {
        const k = providerKeyOf(p);
        return k === key
          || (previousKeyRaw && (k === previousKeyRaw || k === slugify(previousKeyRaw)));
      });
      // Spread first so a falsy id from the form ("" / 0 / missing) cannot
      // overwrite the generated one: the old order put the default first and
      // let the spread clobber it back to empty.
      const record = { ...provider, key, id: provider.id || Date.now() };
      if (existingIdx >= 0) store[existingIdx] = record; else store.push(record);

      // Apply to each target.
      let opencodeKey = "";
      for (const t of targets) {
        if (t === "opencode") {
          // The backup is taken by the writer, immediately before the write, so
          // there is no window where a snapshot is missing or already stale.
          // Planned first (not via upsertProviderAsDefault) so the schema gate
          // below can compare before/after before anything touches the disk.
          const pre = planProviderChange(provider, {
            configPath: body.configPath,
            setAsDefault,
            defaultModelId: body.defaultModelId || provider.defaultModelId || "",
            previousKey: body.previousKey || "",
          });
          if (!pre.ok) {
            return json(res, 400, { ok: false, error: pre.error, path: pre.configPath });
          }
          const blocked = refuseIntroduced(pre.before, pre.after);
          if (blocked) {
            return json(res, 400, { ok: false, error: blocked, path: pre.configPath });
          }
          const committed = commitPlan(pre, {
            expectedHash: body.hash,
            backup: (p) => backupConfig(p, "before-" + (provider.name || "apply")),
          });
          if (!committed.ok) {
            return json(res, committed.conflict ? 409 : 400, committed);
          }
          const r = { ...committed, modelId: pre.defaultModel, commentsLost: false };
          opencodeKey = r.providerKey || pre.providerKey || "";
          if (r.backupFile) backupFile = r.backupFile;
          results.opencode = {
            ok: r.ok,
            error: r.error || null,
            path: r.configPath,
            model: pre.defaultModel || null,
            created: !!r.created,
            commentsLost: false,
            hash: r.hash || "",
            previousKey: r.previousKey || "",
            providerKey: r.providerKey || pre.providerKey || "",
            // The block was listed as disabled and the plan drops that entry;
            // without the notice the UI would claim a silent success.
            reenabled: pre.reenabled === true,
          };
        } else if (t === "kilo" || t === "workbuddy") {
          // Both harnesses keep a plain config file, so they get a real write
          // (with a backup and an atomic replace) instead of a manifest.
          const plan = t === "kilo"
            ? planKiloWrite(provider, { configPath: body.kiloConfigPath, setAsDefault })
            : planWorkBuddyWrite(provider, { configPath: body.workbuddyConfigPath });
          if (!plan.ok) {
            results[t] = { ok: false, error: plan.error, path: plan.path || "" };
            continue;
          }
          const fileBackup = backupConfig(plan.path, "before-" + t);
          writeHarnessPlan(plan);
          results[t] = {
            ok: true,
            written: true,
            path: plan.path,
            backupFile: fileBackup,
            key: plan.key || "",
            model: plan.model || "",
            models: plan.models || [],
            count: plan.count || 0,
            formatLabel: (FORMATS[provider.apiFormat] || FORMATS["openai-chat"]).label,
            guide: buildGuide(provider, TARGETS.find((x) => x.id === t) || { id: t, label: t }),
          };
        } else {
          // Manifest + guide for the other harnesses.
          const target = TARGETS.find((x) => x.id === t) || { label: t, id: t };
          results[t] = {
            ok: true,
            manifest: buildManifest(provider),
            guide: buildGuide(provider, target),
            formatLabel: (FORMATS[provider.apiFormat] || FORMATS["openai-chat"]).label,
          };
        }
      }
      const oc = results.opencode;
      if (oc && oc.ok) {
        // On a rename the plan decides the final key; the store must follow it
        // or the sidebar keeps a record the config no longer has.
        if (opencodeKey) record.key = opencodeKey;
        recordUndo(oc.path || "", backupFile, `Применение провайдера «${provider.name || ""}»`, oc.hash || "");
      }
      // The config write above is the real result; the sidebar store is a
      // convenience. A store failure (disk, permissions) must not turn a
      // completed write into a 500 — the UI updates optimistically instead.
      let storeSynced = true;
      try {
        saveStore(store);
      } catch { storeSynced = false; }
      return json(res, 200, {
        ok: true,
        results,
        backupFile,
        storeSynced,
        providers: storeSynced ? loadStore() : store.map(stripSecrets),
      });
    }

    // Shows what a save would change, without touching the file. The plan is
    // recomputed on commit rather than stored, so a stale preview can never be
    // replayed against a file that has since moved on.
    if (url.pathname === "/api/preview" && req.method === "POST") {
      const body = await readBody(req);
      const unmasked = unmaskApiKey(body.provider, body.configPath, body.previousKey);
      if (unmasked.error) return json(res, 409, { ok: false, error: unmasked.error });
      const provider = unmasked.provider;
      const plan = planProviderChange(provider, {
        configPath: body.configPath,
        setAsDefault: provider.setAsDefault !== false,
        defaultModelId: body.defaultModelId || provider.defaultModelId || "",
        previousKey: body.previousKey || "",
      });
      if (!plan.ok) return json(res, 400, { ok: false, error: plan.error, path: plan.configPath });
      return json(res, 200, {
        ok: true,
        path: plan.configPath,
        providerKey: plan.providerKey,
        previousKey: plan.previousKey || "",
        defaultModel: plan.defaultModel,
        reenabled: plan.reenabled === true,
        created: plan.created,
        hash: plan.hash,
        diff: buildPreview(plan.before, plan.after),
      });
    }

    // Preview of a removal, so the user sees the block disappear plus whatever
    // repointing that forces on `model` / `small_model`. A pool head expands
    // to all its shards, or the diff would promise a removal it does not do.
    if (url.pathname === "/api/preview-remove" && req.method === "POST") {
      const body = await readBody(req);
      const target = resolveRemoval(body.key || body.name);
      const plan = planProvidersRemoval(target.keys, {
        configPath: body.configPath,
        pluginFileName: target.pluginFileName,
      });
      if (!plan.ok) {
        return json(res, 400, {
          ok: false, error: plan.error, path: plan.configPath,
          notFound: plan.notFound === true,
        });
      }
      return json(res, 200, {
        ok: true,
        path: plan.configPath,
        providerKey: plan.providerKeys[0],
        removedKeys: plan.providerKeys,
        missingKeys: plan.missing,
        pluginEntry: plan.pluginEntry,
        orphaned: plan.orphaned,
        envOrphans: plan.envOrphans,
        hash: plan.hash,
        diff: buildPreview(plan.before, plan.after),
      });
    }

    // Removes a provider from the opencode config, not just from our own store.
    // A pool head takes its shards, the rotation plugin entry and the plugin
    // file with it — otherwise every pool removal orphaned N-1 blocks.
    if (url.pathname === "/api/remove-provider" && req.method === "POST") {
      const body = await readBody(req);
      const target = resolveRemoval(body.key || body.name);
      const r = removeProviders(target.keys, {
        configPath: body.configPath,
        expectedHash: body.hash,
        pluginFileName: target.pluginFileName,
        backup: (p) => backupConfig(p, "before-remove"),
      });
      if (!r.ok) return json(res, r.conflict ? 409 : 400, r);
      const removedKeys = r.providerKeys || [r.providerKey].filter(Boolean);
      const head = removedKeys[0] || "";
      // Moved, not deleted: undo has to be able to bring the rotation plugin
      // back, otherwise reverting a pool removal leaves dead shard references.
      const stashed = stashPoolPluginFile(r.configPath, target.pluginFile);
      const pluginRemoved = !!stashed;
      recordUndo(r.configPath || "", r.backupFile,
        removedKeys.length > 1 ? `Удаление пула «${head}» (${removedKeys.length} шардов)` : `Удаление провайдера «${head}»`,
        r.hash || "",
        stashed ? { pluginStash: stashed.stash, pluginTarget: stashed.target } : {});
      // Keep our store in step so the UI does not show a provider that is gone.
      // Matched by head or by any shard, so deleting via "slug-2" still drops
      // the whole pool record. A corrupt store must not turn a completed config
      // removal into a 500: the write already landed, sync is best-effort here.
      let storeSynced = true;
      try {
        const store = loadStore().filter((p) => {
          const k = providerKeyOf(p);
          if (removedKeys.includes(k)) return false;
          const shards = Array.isArray(p?.pool?.shards) ? p.pool.shards : null;
          return !(shards && removedKeys.some((x) => shards.includes(x)));
        });
        saveStore(store);
      } catch { storeSynced = false; }
      // Очистка зомби-конфигов между клиентами: Kilo и WorkBuddy
      let kiloCleaned = false;
      let wbCleaned = false;
      try {
        const kRes = removeKiloProvider(removedKeys);
        kiloCleaned = Boolean(kRes?.removed);
      } catch {}
      try {
        const wbRes = removeWorkBuddyProvider(removedKeys, {
          vendorNames: [head, target.name, ...removedKeys],
        });
        wbCleaned = Boolean(wbRes?.removed);
      } catch {}
      return json(res, 200, {
        ...r, providerKey: head, removedKeys, pluginRemoved, storeSynced,
        kiloCleaned, wbCleaned,
        providers: storeSynced ? loadStore() : [],
        backups: listBackups(),
      });
    }

    if (url.pathname === "/api/set-default-model" && req.method === "POST") {
      // Repoints the top-level `model` without touching provider blocks. The
      // diagnostics panel offers this when the default points at a dead
      // provider while a working one is already configured.
      const body = await readBody(req);
      const r = setDefaultModel(body.model || body.modelId, {
        configPath: body.configPath,
        expectedHash: body.hash,
        backup: (p) => backupConfig(p, "before-default-model"),
      });
      if (!r.ok) return json(res, r.conflict ? 409 : 400, r);
      recordUndo(r.configPath || "", r.backupFile, `Модель по умолчанию: ${r.modelId || ""}`, r.hash || "");
      return json(res, 200, { ...r, backups: listBackups() });
    }

    if (url.pathname === "/api/rename-provider" && req.method === "POST") {
      const body = await readBody(req);
      const r = renameProvider(body.from, body.to, {
        configPath: body.configPath,
        expectedHash: body.hash,
        backup: (p) => backupConfig(p, "before-rename"),
      });
      if (!r.ok) return json(res, r.conflict ? 409 : 400, r);
      recordUndo(r.configPath || "", r.backupFile, `Переименование: ${r.previousKey || ""} → ${r.providerKey || ""}`, r.hash || "");
      return json(res, 200, { ...r, backups: listBackups() });
    }

    // Which config files exist, so the user can choose which one to edit.
    if (url.pathname === "/api/configs" && req.method === "GET") {
      return json(res, 200, { ok: true, configs: listOpencodeConfigs() });
    }

    // Does the environment variable the config will point at actually exist?
    // Writing `{env:FOO}` while FOO is unset is the most common way to end up
    // with a config that looks right and authenticates with an empty string.
    // Only presence and length are reported — never the value.
    if (url.pathname === "/api/envcheck" && req.method === "POST") {
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      if (!ENV_NAME_RE.test(name)) {
        return json(res, 200, { ok: false, error: "Недопустимое имя переменной" });
      }
      // Bypass the cache on an explicit check: the user may have just run setx
      // in another window and pressed the button to see the result.
      clearEnvCache();
      const info = lookupEnv(name, { useCache: false });
      // `value` must not cross the HTTP boundary — only presence, scope and
      // length. Length alone cannot reconstruct a secret but does catch a
      // truncated paste or a variable holding only whitespace.
      let note = "";
      if (!info.set) {
        note = `Переменная не найдена ни в текущем процессе, ни в постоянных настройках Windows. Создай её: ${setEnvCommand(name)} — затем перезапусти службу OpenCode: ${OPENCODE_RESTART_COMMAND}`;
      } else if (!info.inherited) {
        // Found in the registry but not inherited here: any program started
        // from a new shell will see it, already-running ones will not.
        note = "Переменная задана в системе, но появилась после запуска уже открытых терминалов — opencode нужно запускать из нового окна терминала.";
      } else if (info.length > SETX_MAX_LENGTH) {
        note = `Длина ${info.length} символов — setx обрезает значение на ${SETX_MAX_LENGTH}, ключ может быть неполным.`;
      }
      return json(res, 200, {
        ok: true,
        name,
        set: info.set,
        length: info.length,
        scope: info.scope,
        scopes: info.scopes,
        // inherited — a process started now would see the value; durable — it
        // survives a reboot. A running OpenCode service sees neither until it
        // is restarted, which is why restartCommand travels with every answer.
        inherited: info.inherited,
        durable: info.durable,
        restartCommand: OPENCODE_RESTART_COMMAND,
        restartHint: opencodeRestartHint(),
        note,
      });
    }

    // Creates the variable the config points at. Without this the tool writes a
    // config referencing {env:KEY}, says "готово", and leaves the step that
    // actually makes it work to the user.
    if (url.pathname === "/api/setenv" && req.method === "POST") {
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      if (isProtectedEnvVar(name)) {
        return json(res, 200, { ok: false, error: "Переменная защищена от изменения" });
      }
      const value = String(body.value ?? "");
      const r = setUserEnvVar(name, value);
      // The value is never echoed back, not even on success.
      if (!r.ok) {
        return json(res, 200, { ok: false, error: r.error, command: r.command || null, manual: !!r.manual });
      }
      return json(res, 200, {
        ok: true, name: r.name, length: r.length, scope: r.scope,
        restartCommand: OPENCODE_RESTART_COMMAND,
        note: `Переменная задана для текущего пользователя. Уже открытые терминалы её не увидят, ` +
          `а фоновая служба OpenCode — тем более: ${OPENCODE_RESTART_COMMAND}`,
      });
    }

    // Bulk-write of a key pool: one env var per key (BASE, BASE_2, ...).
    // Values cross loopback once and are never echoed back, not even on success.
    if (url.pathname === "/api/setenv-pool" && req.method === "POST") {
      const body = await readBody(req);
      // The env base must be stated explicitly here. readPoolInput's fallback
      // (PROVIDER_API_KEY when nothing matches) is fine for planning a pool,
      // but writing real keys to a default name the user never saw is how a
      // pool ends up split across the wrong variables.
      const explicitBase = String(body.envBase || body.envVarName || body.provider?.envVarName || "").trim();
      if (!explicitBase) {
        return json(res, 200, { ok: false, error: "Не указано имя переменной окружения для пула (envBase)" });
      }
      if (isProtectedEnvVar(explicitBase)) {
        return json(res, 200, { ok: false, error: "Переменная защищена от изменения" });
      }
      const { envBase, keys } = readPoolInput(body);
      const err = validateKeyPool(keys);
      if (err) return json(res, 200, { ok: false, error: err });
      if (!ENV_NAME_RE.test(envBase)) {
        return json(res, 200, { ok: false, error: `Недопустимое имя переменной пула: «${envBase || "(пусто)"}»` });
      }
      const names = poolEnvNames(envBase, keys.length);
      const results = [];
      for (let i = 0; i < keys.length; i++) {
        const r = setUserEnvVar(names[i], keys[i]);
        results.push(r.ok
          ? { name: r.name, ok: true, length: r.length, scope: r.scope }
          : { name: names[i], ok: false, error: r.error, command: r.command || null, manual: !!r.manual });
      }
      clearEnvCache();
      const failed = results.filter((x) => !x.ok);
      return json(res, 200, {
        ok: failed.length === 0,
        results,
        restartCommand: OPENCODE_RESTART_COMMAND,
        note: failed.length
          ? `Записано ${results.length - failed.length} из ${results.length}. Затем перезапусти службу OpenCode: ${OPENCODE_RESTART_COMMAND}`
          : `Пул записан для текущего пользователя. Фоновая служба OpenCode не увидит ключи, пока её не перезапустить: ${OPENCODE_RESTART_COMMAND}`,
      });
    }

    // Restart (or inspect) the OpenCode background service so it picks up
    // variables written after it started. This is the step that was missing
    // between "ключ записан" and "opencode всё равно просит ключ".
    if (url.pathname === "/api/opencode-service" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const r = await runOpencodeService(body && body.action);
      return json(res, 200, r);
    }

    // Env audit: which variables the config references and whether each exists,
    // plus key-like user variables nothing references (cleanup candidates).
    // Values never cross the HTTP boundary — only presence, length and scope.
    // An existing variable never blocks a write: /api/apply always commits the
    // provider block; use this endpoint to check, not to gate.
    if (url.pathname === "/api/env-audit" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const cfg = readConfig((body && body.configPath) || "");
      if (!cfg.config) return json(res, 400, { ok: false, error: "opencode config не прочитан", path: cfg.path });
      clearEnvCache();
      const referenced = collectReferencedEnv(cfg.config);
      const refSet = new Set(referenced.map((n) => n.toLowerCase()));
      const vars = referenced.map((name) => {
        const info = lookupEnv(name, { useCache: false });
        return { name, set: info.set, length: info.length, scope: info.scope, scopes: info.scopes };
      });
      const orphaned = listUserEnvNames().filter(
        (n) => KEY_LIKE_RE.test(n) && !refSet.has(String(n).toLowerCase()) && !isProtectedEnvVar(n),
      );
      return json(res, 200, {
        ok: true,
        path: cfg.path,
        vars,
        orphaned,
        missing: vars.filter((v) => !v.set).map((v) => v.name),
      });
    }

    // Deletes one user-scope variable. Refuses names the config still
    // references, so cleanup cannot break a working provider.
    if (url.pathname === "/api/env-remove" && req.method === "POST") {
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      if (isProtectedEnvVar(name)) {
        return json(res, 200, { ok: false, error: "Переменная защищена от изменения" });
      }
      const cfg = readConfig(body.configPath || "");
      const referenced = cfg.config ? collectReferencedEnv(cfg.config) : [];
      const r = removeUserEnvVar(name, { referenced });
      if (!r.ok) {
        return json(res, 200, { ok: false, error: r.error, command: r.command || null, manual: !!r.manual });
      }
      return json(res, 200, { ok: true, name: r.name, note: "Переменная удалена из окружения пользователя." });
    }

    // Очистка всех переменных-призраков (orphan/ghost keys)
    if (url.pathname === "/api/env-clean-orphans" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const cfg = readConfig((body && body.configPath) || "");
      const referenced = cfg.config ? collectReferencedEnv(cfg.config) : [];
      const r = cleanGhostEnvVars({ referenced });
      return json(res, 200, r);
    }

    // Live check of every key in a pool: one cheap probe per key (completion
    // when a model id is given, otherwise a connection check) plus a
    // best-effort balance lookup. Keys are never echoed back — only masks.
    // Deliberately NOT runBatch: one dead key must not abort the rest.
    if (url.pathname === "/api/pool-check" && req.method === "POST") {
      const body = await readBody(req);
      const { provider, keys } = readPoolInput(body);
      const err = validateKeyPool(keys);
      if (err) return json(res, 200, { ok: false, error: err });
      const baseURL = String(body.baseURL || provider.baseURL || "").trim();
      if (!baseURL) return json(res, 200, { ok: false, error: "Укажи Base URL" });
      const apiFormat = String(body.apiFormat || provider.apiFormat || "openai-chat");
      const modelId = String(body.modelId || body.model || "").trim()
        || (Array.isArray(provider.models) && provider.models.length
          ? String(provider.models[0].id || provider.models[0] || "").trim() : "");
      const CONC = 3;
      const results = new Array(keys.length);
      let next = 0;
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (i >= keys.length) return;
          const key = keys[i];
          let probe;
          try {
            probe = modelId
              ? await testCompletion({ baseURL, apiKey: key, apiFormat, modelId })
              : await testConnection({ baseURL, apiFormat, apiKey: key });
          } catch (e) {
            probe = { ok: false, message: String(e?.message || e) };
          }
          let balance;
          try {
            balance = await fetchKeyBalance({ baseURL, apiKey: key });
          } catch (e) {
            balance = { supported: false, ok: false, note: String(e?.message || e) };
          }
          results[i] = {
            index: i,
            mask: maskKey(key),
            // A reachable endpoint with a refused key (fault key/nokey) used to
            // arrive as ok:true from testConnection, so a broken key was counted
            // as passed. A fault of any kind means the key did not produce an answer.
            ok: !!probe.ok && !probe.fault,
            fault: probe.fault || null,
            status: probe.status ?? null,
            message: probe.message || "",
            balance,
          };
          await new Promise((r) => setTimeout(r, 150));
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONC, keys.length) }, worker));
      const passed = results.filter((x) => x.ok).length;
      return json(res, 200, { ok: true, results, passed, failed: results.length - passed, total: results.length });
    }

    // Preview of a pool write: N provider shards + optional runtime plugin,
    // without touching the disk.
    if (url.pathname === "/api/pool-preview" && req.method === "POST") {
      const body = await readBody(req);
      const { provider, envBase, keys } = readPoolInput(body);
      const plan = planPoolChange({
        provider,
        envBase,
        keys,
        configPath: body.configPath,
        setAsDefault: provider.setAsDefault !== false,
        defaultModelId: body.defaultModelId || provider.defaultModelId || "",
        previousKey: body.previousKey || "",
        withPlugin: body.withPlugin !== false,
      });
      if (!plan.ok) return json(res, 400, { ok: false, error: plan.error, path: plan.configPath });
      return json(res, 200, {
        ok: true,
        path: plan.configPath,
        shardKeys: plan.shardKeys,
        shards: plan.shards,
        envNames: plan.envNames,
        defaultModel: plan.defaultModel,
        created: plan.created,
        hash: plan.hash,
        plugin: plan.plugin ? {
          fileName: plan.plugin.fileName, path: plan.plugin.path,
          entry: plan.plugin.entry, envNames: plan.plugin.envNames,
        } : null,
        diff: buildPreview(plan.before, plan.after),
      });
    }

    // Commits a pool planned above: shards + plugin registration in one write
    // (single backup, single undo entry), then the plugin file next to it.
    if (url.pathname === "/api/pool-apply" && req.method === "POST") {
      const body = await readBody(req);
      const { provider, envBase, keys } = readPoolInput(body);
      const withPlugin = body.withPlugin !== false;
      const plan = planPoolChange({
        provider,
        envBase,
        keys,
        configPath: body.configPath,
        setAsDefault: provider.setAsDefault !== false,
        defaultModelId: body.defaultModelId || provider.defaultModelId || "",
        previousKey: body.previousKey || "",
        withPlugin,
      });
      if (!plan.ok) return json(res, 400, { ok: false, error: plan.error, path: plan.configPath });
      const poolBlocked = refuseIntroduced(plan.before, plan.after);
      if (poolBlocked) return json(res, 400, { ok: false, error: poolBlocked, path: plan.configPath });
      const committed = commitPlan(plan, {
        expectedHash: body.hash,
        backup: (p) => backupConfig(p, "before-pool-" + (slugify(provider.name) || "pool")),
      });
      if (!committed.ok) return json(res, committed.conflict ? 409 : 400, committed);
      let pluginFile = null;
      let pluginError = null;
      if (withPlugin && plan.plugin) {
        try {
          const pluginDir = plan.plugin.pluginDir || plan.plugin.path;
          ensureDir(pluginDir);
          const pkgPath = path.join(pluginDir, "package.json");
          const indexPath = path.join(pluginDir, "index.mjs");
          const pkgContent = plan.plugin.packageJsonText || (JSON.stringify({
            name: plan.plugin.dirName || path.basename(pluginDir),
            version: "1.0.0",
            type: "module",
            main: "index.mjs",
          }, null, 2) + "\n");
          writeFileAtomic(pkgPath, pkgContent);
          writeFileAtomic(indexPath, plan.plugin.indexSource || plan.plugin.source);
          pluginFile = pluginDir;
        } catch (e) {
          pluginError = String(e?.message || e);
        }
      }
      recordUndo(committed.configPath || "", committed.backupFile, `Пул ключей «${provider.name || ""}» (${keys.length})`, committed.hash || "");
      // Best-effort like /api/apply: the shards are already in the config,
      // a store failure must not rewrite that success as a 500.
      let storeSynced = true;
      try {
        const store = loadStore();      const record = {
          ...provider,
          id: provider.id || Date.now(),
          apiKey: "",
          poolKeys: undefined,
          poolRaw: undefined,
          pool: { envBase, size: keys.length, shards: plan.shardKeys, pluginFile },
        };
        delete record.poolKeys;
        delete record.poolRaw;
        const key = providerKeyOf(record);
        const existingIdx = store.findIndex((p) => providerKeyOf(p) === key);
        if (existingIdx >= 0) store[existingIdx] = record; else store.push(record);
        saveStore(store);
      } catch { storeSynced = false; }
      // Which pool variables still have no value: opencode would substitute ""
      // for them, so the UI must say so instead of reporting a silent success.
      clearEnvCache();
      const missingEnv = plan.envNames.filter((n) => !lookupEnv(n, { useCache: false }).set);
      return json(res, 200, {
        ok: true,
        path: committed.configPath,
        shardKeys: plan.shardKeys,
        shards: plan.shards,
        envNames: plan.envNames,
        missingEnv,
        defaultModel: plan.defaultModel,
        hash: committed.hash || "",
        backupFile: committed.backupFile || null,
        pluginFile,
        pluginError,
        pluginWarning: plan.pluginWarning || "",
        storeSynced,
        providers: storeSynced ? loadStore() : [],
      });
    }

    // The real check: one minimal completion. "Применено" only means the file
    // was written; this is what proves the provider actually answers.
    if (url.pathname === "/api/testchat" && req.method === "POST") {
      const body = await readBody(req);
      const p = body.provider || {};
      const creds = probeCredentials(p, body.configPath, body.previousKey);
      if (creds.blocker) return json(res, 200, { ok: true, result: { ok: false, fault: "key", message: creds.blocker }, ...modelHealthState(readConfig(body.configPath)) });
      const identity = modelProbeIdentity(body, creds.apiKey);
      const modelId = String(body.modelId || body.model || "").trim()
        || (Array.isArray(p.models) && p.models.length ? (p.models[0].id || p.models[0]) : "");
      const result = modelProbeResult(await testCompletion({
        baseURL: p.baseURL,
        apiKey: creds.apiKey,
        apiFormat: p.apiFormat || "openai-chat",
        modelId,
      }), identity);
      return json(res, 200, { ok: true, result, ...recordModelProbes(identity, [{ ...result, id: modelId }]) });
    }

    // Bulk live check. Same probe as /api/testchat, run across many models with
    // pacing — see src/batch.mjs for why it throttles and when it gives up.
    if (url.pathname === "/api/testchat-batch" && req.method === "POST") {
      const body = await readBody(req);
      const p = body.provider || {};
      const creds = probeCredentials(p, body.configPath, body.previousKey);
      if (creds.blocker) {
        return json(res, 200, { ok: true, result: { ok: false, stopped: { reason: "auth", message: creds.blocker }, results: [], tested: 0, total: 0 }, ...modelHealthState(readConfig(body.configPath)) });
      }
      // Sanitise before the limit check: junk entries (missing ids, whitespace)
      // would otherwise consume slots and then run as probes of nothing.
      const ids = (Array.isArray(body.modelIds) && body.modelIds.length
        ? body.modelIds
        : (Array.isArray(p.models) ? p.models : []))
        .map((m) => String(typeof m === "string" ? m : m?.id ?? "").trim())
        .filter(Boolean);
      // A live request per model costs the user money and time; refuse an
      // unbounded list rather than quietly running for ten minutes.
      if (ids.length > 200) {
        return json(res, 200, { ok: true, result: { ok: false, stopped: { reason: "too-many", message: `Слишком много моделей за раз: ${ids.length}. Максимум 200.` }, results: [], tested: 0, total: ids.length } });
      }
      const identity = modelProbeIdentity(body, creds.apiKey);
      const result = await runBatch(ids, async (modelId) => {
        const startedAt = Date.now();
        const startedOrder = ++probeOrder;
        const probe = await testCompletion({
          baseURL: p.baseURL,
          apiKey: creds.apiKey,
          apiFormat: p.apiFormat || "openai-chat",
          modelId,
        });
        return { ...probe, startedAt, startedOrder, checkedAt: Date.now() };
      }, { concurrency: Number(body.concurrency) || undefined, gapMs: Number(body.gapMs) || undefined });
      result.results = result.results.map((r) => modelProbeResult(r, identity));
      return json(res, 200, { ok: true, result, ...recordModelProbes(identity, result.results) });
    }

    if (url.pathname === "/api/validate" && req.method === "GET") {
      const cfg = readConfig(url.searchParams.get("configPath") || "");
      const issues = cfg.config ? validateConfig(cfg.config) : [{ severity: "error", id: "parse", message: cfg.error || "Не удалось прочитать конфиг" }];
      return json(res, 200, { ok: true, path: cfg.path, issues, backups: listBackups() });
    }

    if (url.pathname === "/api/test" && req.method === "POST") {
      const body = await readBody(req);
      const p = body.provider || body;
      const probe = probeCredentials(p, body.configPath, body.previousKey);
      // A reference to a variable that does not exist cannot succeed: opencode
      // would send an empty bearer token. Report that directly instead of
      // returning a provider 401 the user then has to interpret.
      if (probe.blocker) return json(res, 200, { ok: true, result: { ok: false, message: probe.blocker } });
      const result = await testConnection({ ...p, apiKey: probe.apiKey });
      return json(res, 200, { ok: true, result });
    }

    if (url.pathname === "/api/discover" && req.method === "POST") {
      const body = await readBody(req);
      const p = body.provider || body;
      const probe = probeCredentials(p, body.configPath, body.previousKey);
      if (probe.blocker) return json(res, 200, { ok: true, result: { ok: false, message: probe.blocker } });
      // apiFormat has to be forwarded: an anthropic-style endpoint authenticates
      // with `x-api-key`, and sending `Authorization: Bearer` instead produced a
      // 401 that looked like a bad key.
      const result = await fetchModels({
        baseURL: p.baseURL,
        apiKey: probe.apiKey,
        apiFormat: p.apiFormat || "openai-chat",
      });
      // Some gateways answer with nothing but an id. Fill the blanks from the
      // models.dev catalogue where its sources agree, so the user is not left
      // hand-typing context windows for dozens of models. Never fills a price,
      // and never overwrites what this provider reported about itself.
      if (result.ok && Array.isArray(result.models) && result.models.length && body.enrich !== false) {
        const cat = await loadCatalog();
        if (cat.ok) {
          const e = enrichModels(cat, result.models);
          result.models = e.models;
          result.enriched = { matched: e.matched, filled: e.filled, source: "models.dev" };
        } else {
          // Say why rather than silently returning bare ids; the catalogue being
          // down is not the same as the models having no specs.
          result.enriched = { matched: 0, filled: 0, error: cat.error };
        }
      }
      return json(res, 200, { ok: true, result });
    }

    if (url.pathname === "/api/diagnostics" && req.method === "GET") {
      // Full health check: config issues + connectivity of every provider.
      const cfg = readConfig(url.searchParams.get("configPath") || "");
      const issues = cfg.config ? validateConfig(cfg.config) : [{ severity: "error", id: "parse", message: cfg.error || "не удалось прочитать конфиг" }];
      // Probed with a bounded worker pool: each endpoint can take up to 8s, so
      // a serial loop over a dozen providers meant a two-minute request that
      // usually timed out in the browser — but unbounded parallelism at 30+
      // providers exhausts local ports and hammers the network. Order of the
      // result follows the config, not finish order.
      const entries = Object.entries(cfg.config?.provider || {})
        .filter(([, p]) => p && typeof p === "object" && p.type !== "local");
      const probeOne = async ([key, p]) => {
        // One broken provider (a DNS hiccup, a thrown resolver) must not sink
        // the whole report: an exception here rejected Promise.all and the
        // user got a bare 500 instead of one red line among the healthy ones.
        try {
        const base = p.options?.baseURL || p.baseURL || "";
        // An unresolved {env:VAR} would be sent as the literal key; resolve it
        // so the probe reflects what opencode itself would send.
        const decoded = decodeApiKey(p.options?.apiKey);
        // lookupEnv, not process.env: a variable set with setx after this
        // process started is invisible to process.env, and reporting "key not
        // sent" in that case blames the wrong thing.
        const envHit = decoded.useEnvVar ? lookupEnv(decoded.envVarName) : null;
        const apiKey = decoded.useEnvVar ? (envHit?.value || "") : decoded.apiKey;
        // A provider without its own baseURL (opencode zen, a plain @ai-sdk/*
        // package) talks to the endpoint baked into the package. There is
        // nothing here to probe, and calling that "недоступен" is a false alarm
        // about a provider that works fine.
        const conn = base
          ? await testConnection({ baseURL: base, apiKey, apiFormat: detectApiFormat(p) })
          : {
              ok: true, reach: "unknown",
              message: "Проба невозможна: у провайдера нет своего Base URL — адрес берётся из npm-пакета",
            };
        return {
          key,
          baseURL: base,
          nModels: Object.keys(p.models || {}).length,
          isDefault: String(cfg.config?.model || "").startsWith(key + "/"),
          ok: conn.ok,
          conn: conn.message,
          // reach/fault let the UI separate "their server is down" from "your
          // key is wrong" instead of showing one undifferentiated red line.
          reach: conn.reach || null,
          fault: conn.fault || null,
          kind: conn.kind || null,
          ms: typeof conn.ms === "number" ? conn.ms : null,
          viaProxy: Boolean(conn.viaProxy),
          models: Object.keys(p.models || {}),
        };
        } catch (e) {
          return {
            key,
            baseURL: p?.options?.baseURL || p?.baseURL || "",
            nModels: Object.keys(p?.models || {}).length,
            isDefault: String(cfg.config?.model || "").startsWith(key + "/"),
            ok: false,
            conn: `Проба завершилась ошибкой: ${e?.message || e}`,
            reach: null, fault: "endpoint", kind: null, ms: null,
            viaProxy: false,
            models: Object.keys(p?.models || {}),
          };
        }
      };
      const DIAG_CONCURRENCY = 5;
      const queue = entries.slice();
      const byKey = new Map();
      await Promise.all(Array.from({ length: Math.min(DIAG_CONCURRENCY, Math.max(queue.length, 1)) }, async () => {
        for (;;) {
          const next = queue.shift();
          if (!next) return;
          byKey.set(next[0], await probeOne(next));
        }
      }));
      const providers = entries.map(([key]) => byKey.get(key));
      // Naming the proxy once, at the top level, saves the user from guessing
      // whether the probes went out directly or through a tunnel.
      const proxyUsed = describeProxy(proxyForUrl("https://example.com"));
      // Умный аудит — чистая статика, считается миллисекунды, поэтому едет
      // в том же ответе: свеж при каждой диагностике без отдельного запроса.
      return json(res, 200, {
        ok: true, path: cfg.path, issues, providers,
        model: cfg.config?.model || null, backups: listBackups(),
        proxy: proxyUsed || null,
        smart: smartAudit(cfg.config),
      });
    }

    // Автоисправление: что именно будет поправлено — сначала diff, потом запись.
    // Ничего не пишется без подтверждения: preview только считает, apply пишет.
    if (url.pathname === "/api/autofix-preview" && req.method === "POST") {
      const body = await readBody(req);
      const cfg = readConfig(body.configPath);
      if (!cfg.config) {
        return json(res, 400, { ok: false, error: "opencode config не разобран: " + (cfg.error || "неизвестная ошибка"), path: cfg.path });
      }
      const { changes, fixes, skipped } = buildAutoFixChanges(cfg.config);
      if (!changes.length) {
        return json(res, 200, {
          ok: true, path: cfg.path, fixes, skipped, hash: cfg.hash || "",
          diff: buildPreview(cfg.raw, cfg.raw), remaining: validateConfig(cfg.config),
        });
      }
      const applied = applySchemaChanges(cfg.raw, cfg.config, changes);
      if (!applied.ok) return json(res, 400, { ok: false, error: applied.error, path: cfg.path });
      return json(res, 200, {
        ok: true, path: cfg.path, fixes, skipped, hash: cfg.hash || "",
        diff: buildPreview(cfg.raw, applied.text), remaining: validateConfig(applied.value),
      });
    }

    if (url.pathname === "/api/autofix-apply" && req.method === "POST") {
      const body = await readBody(req);
      const cfg = readConfig(body.configPath);
      if (!cfg.config) {
        return json(res, 400, { ok: false, error: "opencode config не разобран: " + (cfg.error || "неизвестная ошибка"), path: cfg.path });
      }
      const { changes, fixes, skipped } = buildAutoFixChanges(cfg.config);
      if (!changes.length) {
        return json(res, 200, { ok: true, noop: true, path: cfg.path, fixed: fixes, skipped, hash: cfg.hash || "", backups: listBackups() });
      }
      const applied = applySchemaChanges(cfg.raw, cfg.config, changes);
      if (!applied.ok) return json(res, 400, { ok: false, error: applied.error, path: cfg.path });
      const remaining = validateConfig(applied.value);
      const committed = commitPlan(
        { ok: true, configPath: cfg.path, before: cfg.raw, after: applied.text, changes: applied.changes, hash: cfg.hash || "" },
        { expectedHash: body.hash, backup: (p) => backupConfig(p, "before-autofix") },
      );
      if (!committed.ok) return json(res, committed.conflict ? 409 : 400, committed);
      recordUndo(committed.configPath || "", committed.backupFile, "Автоисправление конфига", committed.hash || "");
      // A plaintext key just removed from the file must not become a lost key:
      // the fix names the env var it moved to, and the value is still in the
      // pre-fix config read above — write it to the user's environment now
      // rather than send the user fishing through backups for it.
      const envWrites = [];
      for (const f of fixes) {
        if (!f || f.id !== "plaintext-key" || !f.envVar) continue;
        const rawKey = String(
          cfg.config?.provider?.[f.provider]?.options?.apiKey
          ?? cfg.config?.provider?.[f.provider]?.apiKey
          ?? "",
        ).trim();
        if (!rawKey || rawKey.startsWith("{")) continue;
        const w = setUserEnvVar(f.envVar, rawKey);
        envWrites.push({
          envVar: f.envVar, provider: f.provider,
          ok: !!w.ok, scope: w.scope || null,
          error: w.error || null, command: w.command || null, manual: !!w.manual,
        });
      }
      if (envWrites.length) clearEnvCache();
      return json(res, 200, {
        ok: true, path: committed.configPath, fixed: fixes, skipped, remaining,
        hash: committed.hash || "", backupFile: committed.backupFile || null,
        backups: listBackups(), diff: buildPreview(cfg.raw, applied.text),
        envWrites: envWrites.length ? envWrites : undefined,
      });
    }

    // Обновление моделей: сверяет конфиг с живым /models каждого провайдера.
    // По умолчанию только план (apply:false). С apply:true добавляет недостающие
    // модели, а с prune:true ещё и удаляет те, что сервер больше не отдаёт.
    // Существующие записи не перезаписываются — ручные правки сохраняются.
    if (url.pathname === "/api/refresh-models" && req.method === "POST") {
      const body = await readBody(req);
      const cfg = readConfig(body.configPath);
      if (!cfg.config) {
        return json(res, 400, { ok: false, error: "opencode config не разобран: " + (cfg.error || "неизвестная ошибка"), path: cfg.path });
      }
      const keys = Array.isArray(body.providers) && body.providers.length ? body.providers : null;
      const prune = body.prune === true;
      const enrich = body.enrich === true;
      const plan = await planRefresh(cfg.config, { providerKeys: keys, prune, enrich });
      // В превью pending раскрывается с free-меткой, чтобы интерфейс мог
      // предложить «только бесплатные» без повторного опроса серверов.
      const withFree = plan.map((p) => ({
        ...p,
        added: (p.pending || []).map((x) => ({
          id: x.id,
          free: isFreeEntry(x.entry),
          ...(x.entry?.cost ? { cost: x.entry.cost } : {}),
        })),
      }));
      if (!body.apply) {
        return json(res, 200, {
          ok: true, path: cfg.path, hash: cfg.hash || "",
          providers: withFree.map(({ pending, ...rest }) => ({
            ...rest, addedCount: (rest.added || []).length,
            removedCount: (rest.removed || []).length,
          })),
        });
      }
      // Белый список моделей из превью: так «только бесплатные» применяется
      // ровно к тому, что пользователь видел, а не к свежему опросу.
      const changes = buildRefreshChanges(plan, { only: body.models ?? null, prune, enrich });
      if (!changes.length) {
        return json(res, 200, {
          ok: true, noop: true, path: cfg.path, hash: cfg.hash || "",
          providers: plan, backups: listBackups(),
        });
      }
      const applied = applySchemaChanges(cfg.raw, cfg.config, changes);
      if (!applied.ok) return json(res, 400, { ok: false, error: applied.error, path: cfg.path });
      const refreshBlocked = refuseIntroduced(cfg.raw, applied.text);
      if (refreshBlocked) return json(res, 400, { ok: false, error: refreshBlocked, path: cfg.path });
      const committed = commitPlan(
        { ok: true, configPath: cfg.path, before: cfg.raw, after: applied.text, changes, hash: cfg.hash || "" },
        { expectedHash: body.hash, backup: (p) => backupConfig(p, "before-refresh-models") },
      );
      if (!committed.ok) return json(res, committed.conflict ? 409 : 400, committed);
      recordUndo(committed.configPath || "", committed.backupFile, "Обновление моделей", committed.hash || "");
      return json(res, 200, {
        ok: true, path: committed.configPath, providers: plan,
        hash: committed.hash || "", backupFile: committed.backupFile || null,
        backups: listBackups(), diff: buildPreview(cfg.raw, applied.text),
      });
    }

    // Самодиагностика инструмента: Node, каталоги, конфиг, прокси, каталог.
    if (url.pathname === "/api/selfcheck" && req.method === "GET") {
      const result = await runSelfCheck({ configPath: url.searchParams.get("configPath") || "" });
      return json(res, 200, { ok: true, ...result, backups: listBackups() });
    }

    // Reverts the last write recorded by recordUndo. The current file is
    // snapshotted first ("before-undo"), so even a mistaken undo is recoverable
    // from the backup list. Single-level by design: after reverting there is
    // nothing left to revert to.
    if (url.pathname === "/api/undo" && req.method === "POST") {
      const body = await readBody(req);
      const cfg = readConfig(body.configPath);
      const entry = readUndo();
      if (!entry || entry.configPath !== cfg.path) {
        return json(res, 200, { ok: false, error: "Откатывать нечего" });
      }
      if (entry.created) {
        // Undoing a creation removes the file — but only if it is still exactly
        // what the write produced. Otherwise the file holds someone else's
        // edits and deleting it would destroy them.
        if (!cfg.config || (cfg.hash || "") !== (entry.afterHash || "")) {
          clearUndo();
          return json(res, 200, { ok: false, error: "Файл изменился после записи — откат небезопасен, восстанови из бэкапа вручную" });
        }
        backupConfig(cfg.path, "before-undo");
        try { unlinkSync(cfg.path); } catch (e) {
          return json(res, 200, { ok: false, error: "Не удалось удалить файл: " + (e?.message || e) });
        }
        const pluginRestored = restoreStashedPlugin(entry);
        clearUndo();
        return json(res, 200, { ok: true, label: entry.label, removed: true, pluginRestored, hash: "", backups: listBackups(), undo: null });
      }
      const snap = restoreBackup(entry.file);
      if (!snap.ok) {
        clearUndo();
        return json(res, 200, { ok: false, error: "Снапшот потерян (" + snap.error + ") — откат невозможен" });
      }
      // The file must still be what the reverted write produced. Otherwise an
      // external edit landed in between, and restoring the snapshot would
      // silently destroy it — the same loss the hash guard prevents on every
      // other write path. Old records (before afterHash existed) carry "" and
      // skip the check: refusing them all would strand previously valid undos.
      if (entry.afterHash && !cfg.missing && (cfg.hash || "") !== entry.afterHash) {
        return json(res, 200, {
          ok: false,
          error: "Файл изменился после записи — откат затёр бы чужие правки. Восстанови из бэкапа вручную",
        });
      }
      let preFile = null;
      if (!cfg.missing) preFile = backupConfig(cfg.path, "before-undo");
      writeConfigText(snap.raw, cfg.path);
      // The plugin file belongs to the same write: putting the config back
      // without it leaves `plugin: ["keypool-x.mjs"]` pointing at nothing.
      const pluginRestored = restoreStashedPlugin(entry);
      clearUndo();
      const after = readConfig(cfg.path);
      return json(res, 200, {
        ok: true, label: entry.label, file: snap.file, preFile, pluginRestored,
        hash: after.hash || "", backups: listBackups(), undo: null,
      });
    }

    // Ежедневный дайджест халявы и новостей (борд Ailyre, публичные JSON-фиды).
    // Только чтение: кэш на 6 часов лежит в dataDir, при недоступности сети
    // отдаётся протухший кэш с пометкой, а refresh=1 дёргает сеть принудительно.
    if (url.pathname === "/api/digest" && req.method === "GET") {
      try {
        const digest = await loadDigest({ refresh: url.searchParams.get("refresh") === "1" });
        return json(res, 200, { ok: true, ...digest });
      } catch (e) {
        return json(res, 200, { ok: false, error: `Дайджест недоступен: ${e?.message || e}`, perks: [], news: [] });
      }
    }

    if (url.pathname === "/api/backup" && req.method === "POST") {
      const body = await readBody(req);
      const cfg = readConfig(body.configPath);
      const file = cfg.config ? backupConfig(cfg.path, "manual") : null;
      return json(res, 200, { ok: true, file, backups: listBackups() });
    }

    if (url.pathname === "/api/restore" && req.method === "POST") {
      const body = await readBody(req);
      const r = restoreBackup(body.file);
      if (!r.ok) return json(res, 400, { ok: false, error: r.error });
      // A backup belongs to the file it was taken from, not to the file the UI
      // happens to be viewing: restoring B's snapshot into A is a silent
      // cross-file overwrite. Snapshots that predate the origin index have no
      // origin recorded and fall back to the requested file, as before.
      const cfg = r.origin ? readConfigAtPath(r.origin) : readConfig(body.configPath);
      // Safety: snapshot current config before overwriting.
      let preFile = null;
      if (!cfg.missing) preFile = backupConfig(cfg.path, "before-restore");
      // Restores the exact bytes of the snapshot. Re-serialising the parsed
      // object instead would silently strip the comments the backup preserved.
      const written = writeConfigText(r.raw, cfg.path);
      if (!written.ok) return json(res, 400, { ok: false, error: written.error, path: cfg.path });
      recordUndo(cfg.path, preFile, "Восстановление из бэкапа", written.hash || "");
      return json(res, 200, {
        ok: true, file: r.file, path: cfg.path, origin: r.origin || null,
        preFile, hash: written.hash || "", backups: listBackups(),
      });
    }

    if (url.pathname === "/api/import" && req.method === "POST") {
      // Load providers already present in the opencode config into our store so they can be edited.
      const body = await readBody(req);
      const cfg = readConfig(body.configPath);
      if (!cfg.config) return json(res, 400, { ok: false, error: "opencode config не прочитан" });
      const store = loadStore();
      const imported = [];
      for (const [key, p] of Object.entries(cfg.config.provider || {})) {
        if (!isCustomProviderBlock(p)) continue; // built-in providers need no manual block
        if (store.some((s) => providerKeyOf(s) === key)) continue;
        store.push(decodeOpenProvider(key, p));
        imported.push(key);
      }
      saveStore(store);
      return json(res, 200, { ok: true, imported, providers: loadStore() });
    }

    if (url.pathname === "/api/delete" && req.method === "POST") {
      const body = await readBody(req);
      // Accept the real config key as well as the display name: an imported
      // provider keeps `key` distinct from `name`, and deleting by name alone
      // slugified to a different string silently deleted nothing. The exact key
      // wins, so `my_provider` / `dot.name` are removed rather than their slug.
      const wanted = String(body.key || "").trim();
      const rawName = String(body.name || "").trim();
      const matches = new Set([wanted]);
      if (rawName) matches.add(slugify(rawName));
      if (wanted) matches.add(slugify(wanted));
      matches.delete("");
      const store = loadStore().filter((p) => !matches.has(providerKeyOf(p)));
      saveStore(store);
      return json(res, 200, { ok: true, providers: loadStore() });
    }

    if (url.pathname.startsWith("/api/")) {
      // An unknown API route answers in JSON, not with the static handler's
      // text/plain — and a body left unread on a POST would tear down the
      // keep-alive socket before the client could read the 404.
      if (req.method !== "GET" && req.method !== "HEAD") await readBody(req).catch(() => {});
      return json(res, 404, { ok: false, error: `Неизвестный эндпоинт: ${url.pathname}` });
    }

    return serveStatic(res, url.pathname, req);
  } catch (e) {
    const code = Number(e?.statusCode) >= 400 && Number(e?.statusCode) < 600 ? Number(e.statusCode) : 500;
    return json(res, code, { ok: false, error: String(e && e.message || e) });
  }
});

// Node's defaults leave a slow-drip request open for minutes; a local tool
// neither needs nor survives that gracefully. The request budget stays wide
// because a 20-key pool check is legitimately slow.
server.requestTimeout = 600_000;
server.headersTimeout = 30_000;

server.on("error", (err) => {
  // In selftest the port walk would race the one-shot runSelfTest listener and
  // could even open a browser window while the build is trying to exit.
  if (err.code === "EADDRINUSE" && process.env.PS_SELFTEST !== "1") {
    const next = PORT_ACTIVE + 1;
    if (next > WANTED + 20) {
      console.error("\n  Все порты с " + WANTED + " по " + (WANTED + 20) + " заняты.\n");
      process.exit(1);
    }
    PORT_ACTIVE = next;
    server.listen(next, HOST, () => announce(next));
  } else {
    console.error("\n  Сервер не смог запуститься:", err.message, "\n");
    process.exit(1);
  }
});

function announce(port) {
  PORT_ACTIVE = port;
  const url = `http://localhost:${port}`;
  console.log(`\n  Provider Studio running:  ${url}\n`);
  console.log(`  opencode config: ${readConfig().path}`);
  if (HOST !== "127.0.0.1" && HOST !== "localhost") {
    console.log(`\n  ВНИМАНИЕ: сервер слушает ${HOST} — API без авторизации и отдаёт конфиг с ключами.`);
  }
  // Both spellings are honoured: NO_OPEN was the original, PS_NO_OPEN matches
  // the PS_ prefix used by every other switch.
  if (process.env.NO_OPEN !== "1" && process.env.PS_NO_OPEN !== "1") {
    const cmd = process.platform === "win32" ? `start "" "${url}"` : `open "${url}"`;
    exec(cmd, () => {});
  }
}

// The packaged build needs to prove the embedded UI is actually reachable, and
// importing the bundle needs to be possible without binding a port. Both are
// opt-in so the normal path is untouched.
if (process.env.PS_NO_LISTEN === "1") {
  // Loaded for inspection only (used by the build to catch top-level crashes).
} else if (process.env.PS_SELFTEST === "1") {
  runSelfTest();
} else {
  // The EADDRINUSE handler registered above walks to the next free port, so no
  // extra error handling belongs here: a second one would pre-empt it and turn
  // "port busy" back into a hard failure.
  server.listen(WANTED, HOST, () => announce(WANTED));
}

// Starts the server, fetches the pages the UI cannot work without, and exits
// non-zero if anything is missing. This is what makes "the exe built" mean "the
// exe works" rather than just "postject did not complain".
async function runSelfTest() {
  const failures = [];
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(WANTED, HOST, resolve);
  }).catch((err) => {
    console.error(`selftest: could not listen on ${HOST}:${WANTED} — ${err.message}`);
    process.exit(1);
  });
  PORT_ACTIVE = WANTED;
  const base = `http://127.0.0.1:${WANTED}`;
  console.log(`selftest: listening on ${base}`);
  console.log(`selftest: packaged=${isPackaged()} publicDir=${publicDir() || "(embedded)"}`);

  const expect = async (label, urlPath, check) => {
    try {
      const r = await fetch(base + urlPath, { headers: { Host: `localhost:${WANTED}` } });
      const body = await r.text();
      const bad = check(r, body);
      if (bad) failures.push(`${label}: ${bad}`);
      else console.log(`selftest: ${label} ok (${body.length} bytes)`);
    } catch (err) {
      failures.push(`${label}: request failed — ${err.message}`);
    }
  };

  await expect("GET /", "/", (r, b) =>
    r.status !== 200 ? `status ${r.status}` : !b.includes("Provider Studio") ? "index.html has no title" : "");
  await expect("GET /app.js", "/app.js", (r, b) =>
    r.status !== 200 ? `status ${r.status}` : !b.includes("/api/preview") ? "app.js looks truncated" : "");
  await expect("GET /style.css", "/style.css", (r, b) =>
    r.status !== 200 ? `status ${r.status}` : b.length < 100 ? "style.css looks empty" : "");
  await expect("GET /api/state", "/api/state", (r, b) => {
    if (r.status !== 200) return `status ${r.status}`;
    try {
      const j = JSON.parse(b);
      // Without these the front end cannot render its form at all.
      if (!Array.isArray(j.formats) || !j.formats.length) return "no formats";
      if (!Array.isArray(j.targets) || !j.targets.length) return "no targets";
      if (!j.opencode || typeof j.opencode.path !== "string") return "no opencode summary";
      return "";
    } catch { return "response is not JSON"; }
  });
  // The traversal guard must survive bundling: in a SEA build there is no
  // filesystem to fall back on, so a regression here fails open.
  await expect("traversal blocked", "/..%5c..%5cserver.mjs", (r) =>
    r.status === 200 ? "escaped the asset root" : "");
  await expect("missing asset 404s", "/nope.txt", (r) =>
    r.status !== 404 ? `status ${r.status}` : "");

  // Calling process.exit() while the handle is still closing trips a libuv
  // assertion on Windows ("!(handle->flags & UV_HANDLE_CLOSING)"), which the
  // build would report as a failed self-test even though every check passed.
  // Wait for the close callback and let the event loop drain on its own.
  await new Promise((resolve) => server.close(resolve));

  if (failures.length) {
    console.error("\nselftest FAILED:");
    for (const f of failures) console.error("  - " + f);
    process.exitCode = 1;
    return;
  }
  console.log("selftest: all checks passed");
  process.exitCode = 0;
}

// ---------- opencode -> form provider mapping ----------
// Monotonic suffix for generated ids: Date.now()+random collided when two
// imports landed inside the same millisecond.
let decodeIdCounter = 0;

// Reconstruct an editable provider object from an opencode config block.
function decodeOpenProvider(key, p) {
  const base = p.options?.baseURL || p.baseURL || "";
  // Earlier versions of this tool (and hand-edited configs) put the key on the
  // provider root, where opencode never reads it. Fall back to it so importing
  // such a block does not lose the key that is plainly written in the file.
  const { useEnvVar, envVarName, apiKey } = decodeApiKey(p.options?.apiKey ?? p.apiKey);
  // One canonical translator, shared with the manage view: the inline copy
  // used 0 for unknown limits, and 0 counts as "submitted" for managed keys —
  // so re-saving an imported provider silently deleted every limit it had.
  const models = Object.entries(p.models || {}).map(([id, m]) => modelEntryToForm(id, m));
  return {
    id: Date.now() * 1000 + (decodeIdCounter++ % 1000),
    fromOpenCode: true,
    // The real config key, so the UI can preview which key a name maps to and
    // warn before an accidental overwrite of a different provider.
    key,
    // `name` doubles as the display label and the source of the opencode key.
    // Ignore it when it actually holds a package (a bug in earlier versions).
    name: !looksLikePackage(p.name) && slugify(p.name) === key ? p.name : key,
    baseURL: base,
    // The plaintext key never leaves the process: /api/state is an
    // unauthenticated GET polled every few seconds, and anything running as
    // another local user could read every key in the file through it. The
    // form gets the mask to display and echo back; the server resolves the
    // mask against the config on write (see unmaskApiKey).
    apiKey: apiKey ? maskKey(apiKey) : "",
    apiKeyMasked: Boolean(apiKey),
    useEnvVar,
    envVarName,
    apiFormat: detectApiFormat(p),
    // Carried through the round trip so a re-save preserves them. They are only
    // set when the config actually has them: an undefined `headers` means "the
    // form never submitted one", which is what stops buildProviderChanges from
    // treating an ordinary save as a request to delete them.
    ...(p.options?.headers ? { headers: p.options.headers } : {}),
    // timeout:false — валидное «без таймаута», а не отсутствие значения.
    ...(p.options?.timeout === false ? { timeout: false } : (p.options?.timeout ? { timeout: p.options.timeout } : {})),
    models,
  };
}

function openCodeProviderList(config) {
  return Object.entries(config.provider || {})
    .filter(([, p]) => isCustomProviderBlock(p))
    .map(([key, p]) => decodeOpenProvider(key, p));
}
