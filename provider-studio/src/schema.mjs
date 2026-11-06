// Two config schemas live side by side in the wild.
//
//   V1: { "provider": { "<key>": { npm, options: { apiKey, baseURL }, models } } }
//   V2: { "providers": { "<key>": { package, settings: { apiKey, baseURL }, models } } }
//
// The rest of this tool is written against the V1 shape: provider blocks are
// read as `npm` + `options`, model flags as `attachment`/`reasoning`/`tool_call`.
// Rather than duplicating every reader, a V2 file is presented to them through a
// read-only V1 view (`toLegacyBlock`), and the patch operations they produce are
// translated back into V2 when the file is written (`adaptChanges`).
//
// Why this matters: opencode V2 *ignores* `capabilities` inside a `provider`
// block (it treats that block as legacy and drops `reasoning`/`attachment` with
// "omitted unsupported legacy setting"). Vision and tools still work there
// because they are derived from `modalities`, but reasoning-effort cannot be
// declared at all — it exists only in the native `providers` shape. Keeping the
// tool able to write both is what lets a V2 config declare it.

import { applyChangesVerified } from "./jsonc-edit.mjs";

/** True for a non-null, non-array object. */
export function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export const SCHEMA_V1 = "v1";
export const SCHEMA_V2 = "v2";

/**
 * Which schema the document uses.
 *
 * When both keys are present opencode prefers `providers` and keeps the legacy
 * values only as a fallback, so the tool must follow the same precedence —
 * otherwise an edit would land in a block the running process ignores.
 */
export function detectSchema(config) {
  if (!isPlainObject(config)) return SCHEMA_V1;
  if (!isPlainObject(config.providers)) return SCHEMA_V1;
  // A non-empty `providers` map decides on its own: V2 ignores the legacy
  // `provider` key when both exist.
  if (Object.keys(config.providers).length) return SCHEMA_V2;
  // An empty `providers` map is still V2 when it is the only provider map left.
  // Deleting the last V2 provider leaves exactly that behind, and treating it as
  // V1 made the next save write a legacy block V2 never reads.
  const legacy = isPlainObject(config.provider) ? config.provider : null;
  if (!legacy || !Object.keys(legacy).length) return SCHEMA_V2;
  // Both keys exist and only the legacy one has content. Files written by older
  // versions of this tool look like that; reading them as V1 keeps those
  // providers visible instead of presenting an empty config.
  return SCHEMA_V1;
}

/** The provider map of the document, in its own schema. */
export function providerMap(config, schema = detectSchema(config)) {
  if (!isPlainObject(config)) return {};
  if (schema === SCHEMA_V2) return isPlainObject(config.providers) ? config.providers : {};
  return isPlainObject(config.provider) ? config.provider : {};
}

/** The top-level key writes must target ("providers" for V2, "provider" for V1). */
export function providerRoot(schema) {
  return schema === SCHEMA_V2 ? "providers" : "provider";
}

function listOrNull(v) {
  return Array.isArray(v) ? v : null;
}

/**
 * Deep copy for JSON values.
 *
 * The V1 view is edited in place by adaptChanges. A shallow copy would leave
 * `limit`, `cost` and friends shared with the parsed document, so a patch would
 * silently mutate the "before" state it is compared against — and the change
 * would look like a no-op.
 */
function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone);
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = deepClone(x);
    return out;
  }
  return v;
}

/**
 * V2 model entry → the V1 flags the tool reads.
 *
 * `capabilities` is kept untouched: it carries `reasoning.effort`, which the
 * form has no input for and must therefore survive a round-trip.
 */
export function modelToLegacy(m) {
  if (!isPlainObject(m)) return m;
  const out = deepClone(m);
  const caps = isPlainObject(m.capabilities) ? m.capabilities : null;
  const input = listOrNull(caps?.input) || listOrNull(m.modalities?.input);
  const output = listOrNull(caps?.output) || listOrNull(m.modalities?.output);
  if (input || output) {
    out.modalities = {
      input: input && input.length ? input : ["text"],
      output: output && output.length ? output : ["text"],
    };
  }
  if (input && input.some((t) => t !== "text")) out.attachment = true;
  if (caps && caps.reasoning !== undefined) {
    out.reasoning = caps.reasoning === true
      || (isPlainObject(caps.reasoning) && caps.reasoning.supported !== false);
  }
  if (caps && typeof caps.tools === "boolean") out.tool_call = caps.tools;
  if (caps && typeof caps.temperature === "boolean") out.temperature = caps.temperature;
  return out;
}

/** V2 provider block → the V1 shape (`npm`, `options`, legacy model flags). */
export function toLegacyBlock(block) {
  if (!isPlainObject(block)) return block;
  const out = deepClone(block);
  delete out.package;
  delete out.settings;
  if (typeof block.package === "string" && block.package) out.npm = block.package;
  const options = isPlainObject(block.settings) ? deepClone(block.settings) : {};
  // V2 moved per-provider headers to the top level; the rest of the tool looks
  // for them in options.headers (that is where the V1 AI SDK expects them).
  if (isPlainObject(block.headers)) options.headers = deepClone(block.headers);
  if (Object.keys(options).length) out.options = options;
  if (isPlainObject(block.models)) {
    out.models = {};
    for (const [id, m] of Object.entries(block.models)) out.models[id] = modelToLegacy(m);
  }
  return out;
}

/** The whole V2 provider map in V1 shape. */
export function toLegacyProviders(config) {
  const out = {};
  for (const [k, block] of Object.entries(providerMap(config, SCHEMA_V2))) out[k] = toLegacyBlock(block);
  return out;
}

/**
 * Non-enumerable slot holding the file's real legacy `provider` block when a V2
 * document also has one. Kept off `config.provider` (which every reader uses as
 * the active map) so a stale block can be reported without being mistaken for a
 * live provider.
 */
export const LEGACY_PROVIDERS_SLOT = "__legacyProviders";

/** The legacy `provider` block of a shadowed V2 document, if the file had one. */
export function legacyProvidersOf(config) {
  const legacy = config && config[LEGACY_PROVIDERS_SLOT];
  return isPlainObject(legacy) ? legacy : null;
}

/**
 * Hides the V1 view behind a non-enumerable `provider` key.
 *
 * Non-enumerable on purpose: the parsed document is also serialized (digests,
 * previews, tests), and a visible copy would duplicate every provider under two
 * names. `config.provider` keeps working for all existing readers, while the
 * file on disk is never touched.
 *
 * A document that carries BOTH keys used to be left alone, so readers saw the
 * legacy map while writes went to `providers` — a delete reported success and
 * left the block it was asked to remove. The V2 map is the active one, so it
 * always wins here; the legacy block is preserved for diagnostics.
 */
export function shadowLegacyProviders(config) {
  if (detectSchema(config) !== SCHEMA_V2) return config;
  // Already shadowed: the own `provider` descriptor is the synthesized view, and
  // re-reading it as "the file's legacy block" would corrupt the warning.
  const desc = Object.getOwnPropertyDescriptor(config, "provider");
  if (desc && desc.enumerable === false && isPlainObject(desc.value)) return config;
  if (!config[LEGACY_PROVIDERS_SLOT] && desc && desc.enumerable && isPlainObject(desc.value)) {
    Object.defineProperty(config, LEGACY_PROVIDERS_SLOT, {
      value: desc.value,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  Object.defineProperty(config, "provider", {
    value: toLegacyProviders(config),
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return config;
}

/**
 * Which V2 model capabilities the V1 flags imply.
 *
 * `effort` is carried over from the block being edited: the form cannot set it,
 * so dropping it here would silently downgrade a hand-tuned model to "no effort
 * options" on every save.
 */
export function capabilitiesFromLegacy(m) {
  const prev = isPlainObject(m?.capabilities) ? m.capabilities : {};
  const input = listOrNull(m?.modalities?.input) || listOrNull(prev.input) || ["text"];
  const output = listOrNull(m?.modalities?.output) || listOrNull(prev.output) || ["text"];
  const caps = {
    tools: m?.tool_call !== false,
    input: input.length ? input : ["text"],
    output: output.length ? output : ["text"],
  };
  const prevReasoning = isPlainObject(prev.reasoning) ? prev.reasoning : null;
  const supported = m?.reasoning === true;
  if (supported) {
    const reasoning = { supported: true };
    // effort/toggle/budget are not form fields — keep whatever was there.
    if (Array.isArray(prevReasoning?.effort) && prevReasoning.effort.length) reasoning.effort = deepClone(prevReasoning.effort);
    if (typeof prevReasoning?.toggle === "boolean") reasoning.toggle = prevReasoning.toggle;
    if (isPlainObject(prevReasoning?.budget)) reasoning.budget = deepClone(prevReasoning.budget);
    caps.reasoning = reasoning;
  }
  if (typeof m?.temperature === "boolean") caps.temperature = m.temperature;
  return caps;
}

const V2_SCALAR_MODEL_FIELDS = ["modelID", "family", "releaseDate", "package", "compatibility", "body", "cost", "disabled", "variants", "headers", "settings"];

/** V1 model entry → V2 model entry. */
export function modelToV2(m) {
  if (!isPlainObject(m)) return m;
  const out = {};
  if (typeof m.name === "string" && m.name) out.name = m.name;
  for (const f of V2_SCALAR_MODEL_FIELDS) {
    if (m[f] !== undefined) out[f] = m[f];
  }
  out.capabilities = capabilitiesFromLegacy(m);
  if (isPlainObject(m.limit)) out.limit = { ...m.limit };
  return out;
}

/** V1 provider block → V2 provider block. */
export function toV2Block(block) {
  if (!isPlainObject(block)) return block;
  const out = {};
  if (typeof block.name === "string" && block.name) out.name = block.name;
  if (Array.isArray(block.env)) out.env = [...block.env];
  out.package = typeof block.package === "string" && block.package
    ? block.package
    : (typeof block.npm === "string" && block.npm ? block.npm : "@ai-sdk/openai-compatible");
  for (const f of ["canonical", "compatibility", "body"]) {
    if (block[f] !== undefined) out[f] = block[f];
  }
  const settings = isPlainObject(block.settings) ? deepClone(block.settings) : (isPlainObject(block.options) ? deepClone(block.options) : {});
  if (isPlainObject(settings.headers)) {
    out.headers = settings.headers;
    delete settings.headers;
  } else if (isPlainObject(block.headers)) {
    out.headers = deepClone(block.headers);
  }
  if (Object.keys(settings).length) out.settings = settings;
  if (isPlainObject(block.models)) {
    out.models = {};
    for (const [id, m] of Object.entries(block.models)) out.models[id] = modelToV2(m);
  }
  return out;
}

// ------------------------------------------------------- object-level patching
// The same four operations jsonc-edit applies to text, applied to the in-memory
// document. Only used to compute the final V1 block before converting it to V2.

function getAt(obj, path) {
  let cur = obj;
  for (const p of path) {
    if (!isPlainObject(cur) && !Array.isArray(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function setAt(obj, path, value) {
  if (!path.length) return value;
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const p = path[i];
    if (!isPlainObject(cur[p]) && !Array.isArray(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[path[path.length - 1]] = value;
  return obj;
}

function mergeAt(obj, path, value) {
  const current = getAt(obj, path);
  if (isPlainObject(current) && isPlainObject(value)) {
    for (const k of Object.keys(value)) mergeAt(current, [k], value[k]);
    return obj;
  }
  return setAt(obj, path, value);
}

function deleteAt(obj, path) {
  if (!path.length) return obj;
  const parent = getAt(obj, path.slice(0, -1));
  if (isPlainObject(parent)) delete parent[path[path.length - 1]];
  return obj;
}

function applyOne(target, ch) {
  const rest = ch.path;
  switch (ch.op) {
    case "set": setAt(target, rest, ch.value); break;
    case "merge": mergeAt(target, rest, ch.value); break;
    case "delete": deleteAt(target, rest); break;
    case "rename": {
      const parent = getAt(target, rest.slice(0, -1));
      const leaf = rest[rest.length - 1];
      if (isPlainObject(parent) && leaf in parent) {
        parent[ch.key] = parent[leaf];
        delete parent[leaf];
      }
      break;
    }
    default: break;
  }
}

/**
 * Translates V1 patch operations into the document's own schema.
 *
 * V1 configs pass through untouched. For V2, every `provider`-scoped operation
 * is applied to an in-memory V1 view and the resulting block is written back as
 * one `providers.<key>` replacement: field-level patches against a shape that
 * does not exist would either fail or create a shadow legacy block that
 * opencode then ignores.
 *
 * Top-level operations (`model`, `disabled_providers`, `$schema`, …) are
 * schema-neutral and keep their place in the list.
 */
export function adaptChanges(changes, config) {
  if (!Array.isArray(changes)) return changes;
  const schema = detectSchema(config);
  if (schema !== SCHEMA_V2) return changes;

  const original = providerMap(config, SCHEMA_V2);
  const working = toLegacyProviders(config);
  const renamed = new Set();
  const out = [];
  const touched = [];
  const touchedSet = new Set();
  const mark = (key) => {
    if (!touchedSet.has(key)) { touchedSet.add(key); touched.push(key); }
  };

  for (const ch of changes) {
    if (!ch || !Array.isArray(ch.path) || ch.path[0] !== "provider") { out.push(ch); continue; }
    const key = String(ch.path[1] ?? "");
    const rest = ch.path.slice(2);
    if (ch.op === "rename") {
      if (isPlainObject(working[key])) {
        working[ch.key] = working[key];
        delete working[key];
      }
      // Renaming is enough on its own: rewriting the block as well would
      // reformat it and drop comments for no reason. Later operations that
      // actually edit the renamed block mark it themselves.
      out.push({ op: "rename", path: ["providers", key], key: ch.key });
      renamed.add(ch.key);
      continue;
    }
    if (!rest.length && ch.op === "delete") {
      delete working[key];
      out.push({ op: "delete", path: ["providers", key] });
      touchedSet.delete(key);
      continue;
    }
    if (!isPlainObject(working[key])) {
      // A merge on a provider that does not exist yet starts from the value
      // itself; anything else has nothing to patch.
      if (ch.op === "merge" || ch.op === "set") working[key] = {};
      else continue;
    }
    applyOne(working[key], { ...ch, path: rest });
    mark(key);
  }

  for (const key of touched) {
    if (!isPlainObject(working[key])) continue;
    const next = toV2Block(working[key]);
    // Saving a provider without changing anything must not rewrite its block:
    // a redundant `set` reformats it (arrays collapse onto one line) and turns
    // every no-op save into a diff.
    if (!renamed.has(key) && deepEqual(original[key], next)) continue;
    out.push({ op: "set", path: ["providers", key], value: next });
  }
  return out;
}

/** Structural equality for JSON values. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a !== "object") return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

/**
 * Applies a change list to config text in the document's own schema.
 *
 * Every write path must go through this instead of calling jsonc-edit directly:
 * a V1-shaped operation list aimed at a V2 file would either throw ("путь не
 * найден") or create a legacy `provider` block that opencode silently ignores in
 * favour of `providers`.
 *
 * Returns the same shape as applyChangesVerified plus the operations as they were
 * actually applied, so a preview can show the real diff.
 */
export function applySchemaChanges(text, config, changes) {
  const adapted = adaptChanges(changes, config);
  const res = applyChangesVerified(text, adapted);
  return { ...res, changes: adapted };
}
