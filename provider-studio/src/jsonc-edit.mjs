// src/jsonc-edit.mjs
// Span-aware JSONC reader/patcher.
//
// Why this exists: the previous implementation parsed the opencode config into a
// plain object and re-serialised the whole file with JSON.stringify. That threw
// away comments, key order, indentation *and every field the tool did not know
// about* (cost, api, type, options.headers, variants...). Applying a provider was
// therefore lossy.
//
// Here every node keeps its byte span in the original text, so an edit is a
// surgical splice: untouched bytes stay untouched. Trailing commas are tolerated
// (a config with one used to be unrecoverable through the UI).

// ---------------------------------------------------------------- tokenising

function isWs(c) {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v" || c === "\uFEFF" || c === "\u00A0";
}

// Skips whitespace and comments. `state.comments` is set when a comment is seen
// so callers can warn that a full rewrite would lose them.
function skipTrivia(text, i, state) {
  for (;;) {
    while (i < text.length && isWs(text[i])) i++;
    if (text[i] === "/" && text[i + 1] === "/") {
      if (state) state.comments = true;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      if (state) state.comments = true;
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    return i;
  }
}

class ParseError extends Error {
  constructor(message, pos) {
    super(message);
    this.pos = pos;
  }
}

function parseString(text, i) {
  const quote = text[i];
  if (quote !== '"' && quote !== "'") throw new ParseError("ожидалась строка", i);
  const start = i;
  i++;
  let out = "";
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      const n = text[i + 1];
      i += 2;
      switch (n) {
        case "n": out += "\n"; break;
        case "t": out += "\t"; break;
        case "r": out += "\r"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "/": out += "/"; break;
        case "\\": out += "\\"; break;
        case '"': out += '"'; break;
        case "'": out += "'"; break;
        case "u": {
          const hex = text.slice(i, i + 4);
          out += String.fromCharCode(parseInt(hex, 16) || 0);
          i += 4;
          break;
        }
        case "\n": break; // line continuation
        default: out += n === undefined ? "" : n;
      }
      continue;
    }
    if (c === quote) {
      i++;
      return { value: out, start, end: i };
    }
    out += c;
    i++;
  }
  throw new ParseError("незакрытая строка", start);
}

// Bare identifiers are not valid JSON but appear in hand-edited files; accepting
// them means such a config can still be repaired through the UI.
function parseBareKey(text, i) {
  const start = i;
  while (i < text.length && /[A-Za-z0-9_$.\-]/.test(text[i])) i++;
  if (i === start) throw new ParseError("ожидалось имя ключа", i);
  return { value: text.slice(start, i), start, end: i };
}

function parseLiteral(text, i) {
  const start = i;
  if (text.startsWith("true", i)) return { node: { type: "literal", value: true, start, end: i + 4 }, i: i + 4 };
  if (text.startsWith("false", i)) return { node: { type: "literal", value: false, start, end: i + 5 }, i: i + 5 };
  if (text.startsWith("null", i)) return { node: { type: "literal", value: null, start, end: i + 4 }, i: i + 4 };
  const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
  if (m) {
    const end = i + m[0].length;
    return { node: { type: "literal", value: Number(m[0]), start, end }, i: end };
  }
  throw new ParseError("непонятное значение", i);
}

function parseValue(text, i, state) {
  i = skipTrivia(text, i, state);
  const c = text[i];
  if (c === "{") return parseObject(text, i, state);
  if (c === "[") return parseArray(text, i, state);
  if (c === '"' || c === "'") {
    const s = parseString(text, i);
    return { node: { type: "literal", value: s.value, start: s.start, end: s.end }, i: s.end };
  }
  return parseLiteral(text, i);
}

function parseObject(text, i, state) {
  const start = i;
  i++; // '{'
  const openEnd = i;
  const members = [];
  let trailingComma = false;
  let closeStart = -1;

  for (;;) {
    i = skipTrivia(text, i, state);
    if (i >= text.length) throw new ParseError("незакрытый объект", start);
    if (text[i] === "}") { closeStart = i; i++; break; }
    if (text[i] === ",") { i++; trailingComma = true; continue; } // extra/leading comma

    const keyStart = i;
    const key = (text[i] === '"' || text[i] === "'") ? parseString(text, i) : parseBareKey(text, i);
    i = key.end;
    const keyEnd = i;

    i = skipTrivia(text, i, state);
    if (text[i] !== ":") throw new ParseError("ожидалось «:» после ключа", i);
    i++;

    i = skipTrivia(text, i, state);
    const valueStart = i;
    const parsed = parseValue(text, i, state);
    i = parsed.i;

    members.push({
      key: key.value,
      keyStart, keyEnd,
      valueStart, valueEnd: i,
      value: parsed.node,
      start: keyStart, end: i,
    });
    trailingComma = false;

    const after = skipTrivia(text, i, state);
    if (text[after] === ",") { i = after + 1; trailingComma = true; continue; }
    i = after;
    if (text[i] === "}") { closeStart = i; i++; break; }
    if (i >= text.length) throw new ParseError("незакрытый объект", start);
    throw new ParseError("ожидалась «,» или «}»", i);
  }

  return { node: { type: "object", members, start, end: i, openEnd, closeStart, trailingComma }, i };
}

function parseArray(text, i, state) {
  const start = i;
  i++; // '['
  const openEnd = i;
  const elements = [];
  let trailingComma = false;
  let closeStart = -1;

  for (;;) {
    i = skipTrivia(text, i, state);
    if (i >= text.length) throw new ParseError("незакрытый массив", start);
    if (text[i] === "]") { closeStart = i; i++; break; }
    if (text[i] === ",") { i++; trailingComma = true; continue; }

    const parsed = parseValue(text, i, state);
    elements.push(parsed.node);
    i = parsed.i;
    trailingComma = false;

    const after = skipTrivia(text, i, state);
    if (text[after] === ",") { i = after + 1; trailingComma = true; continue; }
    i = after;
    if (text[i] === "]") { closeStart = i; i++; break; }
    if (i >= text.length) throw new ParseError("незакрытый массив", start);
    throw new ParseError("ожидалась «,» или «]»", i);
  }

  return { node: { type: "array", elements, start, end: i, openEnd, closeStart, trailingComma }, i };
}

// ---------------------------------------------------------------- public read

export function toValue(node) {
  if (!node) return undefined;
  if (node.type === "literal") return node.value;
  if (node.type === "array") return node.elements.map(toValue);
  const out = {};
  // Later duplicate keys win, matching JSON.parse.
  for (const m of node.members) out[m.key] = toValue(m.value);
  return out;
}

export function detectStyle(text) {
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  let indent = null;
  for (const m of text.matchAll(/\n([ \t]+)[^\s]/g)) {
    const w = m[1];
    if (w.includes("\t")) { indent = "\t"; break; }
    if (indent === null || w.length < indent.length) indent = w;
  }
  if (!indent) indent = "  ";
  if (indent !== "\t" && indent.length > 8) indent = "  ";
  return { eol, indent };
}

// `ok:false` carries the reason so callers can refuse to write rather than guess.
export function parseJsonc(text) {
  const state = { comments: false };
  try {
    const src = String(text ?? "");
    let i = skipTrivia(src, 0, state);
    const parsed = parseValue(src, i, state);
    const rest = skipTrivia(src, parsed.i, state);
    if (rest < src.length) throw new ParseError("лишние данные после конца документа", rest);
    return {
      ok: true, text: src, ast: parsed.node, value: toValue(parsed.node),
      comments: state.comments, style: detectStyle(src),
    };
  } catch (e) {
    return {
      ok: false, text: String(text ?? ""), ast: null, value: null,
      comments: state.comments, style: detectStyle(String(text ?? "")),
      error: e instanceof ParseError ? `${e.message} (позиция ${e.pos})` : String(e && e.message || e),
      pos: e instanceof ParseError ? e.pos : null,
    };
  }
}

export function hasComments(text) {
  const doc = parseJsonc(text);
  return !!doc.comments;
}

function memberOf(node, key) {
  if (!node || node.type !== "object") return null;
  // Search backwards: with duplicate keys the last one is the effective value.
  for (let i = node.members.length - 1; i >= 0; i--) {
    if (node.members[i].key === key) return node.members[i];
  }
  return null;
}

export function nodeAtPath(ast, path) {
  let node = ast;
  for (const seg of path) {
    if (!node) return null;
    if (node.type === "object") {
      const m = memberOf(node, String(seg));
      if (!m) return null;
      node = m.value;
      continue;
    }
    if (node.type === "array") {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.elements.length) return null;
      node = node.elements[idx];
      continue;
    }
    return null;
  }
  return node;
}

export function getPath(text, path) {
  const doc = parseJsonc(text);
  if (!doc.ok) return undefined;
  return toValue(nodeAtPath(doc.ast, path));
}

// ------------------------------------------------------------- serialisation

const INLINE_ARRAY_LIMIT = 76;

export function serialize(value, baseIndent, style) {
  const { indent, eol } = style;
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "boolean") return String(value);
  if (t === "number") return Number.isFinite(value) ? String(value) : "null";
  if (t === "string") return JSON.stringify(value);

  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const primitive = value.every((v) => v === null || ["boolean", "number", "string"].includes(typeof v));
    if (primitive) {
      const inline = "[" + value.map((v) => serialize(v, "", style)).join(", ") + "]";
      // Matches the hand-written style of these configs: short lists stay on one line.
      if (baseIndent.length + inline.length <= INLINE_ARRAY_LIMIT) return inline;
    }
    const inner = baseIndent + indent;
    return "[" + eol + value.map((v) => inner + serialize(v, inner, style)).join("," + eol) + eol + baseIndent + "]";
  }

  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  if (!keys.length) return "{}";
  const inner = baseIndent + indent;
  return "{" + eol +
    keys.map((k) => inner + JSON.stringify(k) + ": " + serialize(value[k], inner, style)).join("," + eol) +
    eol + baseIndent + "}";
}

/**
 * Single-line rendering, used when the surrounding object is itself written on
 * one line. Emitting a multi-line block inside an inline object produces text
 * that parses but is visually wrecked, e.g.
 *   "models": { "m1": { "name": "m1",
 *   "tool_call": true } },
 * which is what a naive insert did to hand-written configs.
 */
export function serializeInline(value) {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "boolean") return String(value);
  if (t === "number") return Number.isFinite(value) ? String(value) : "null";
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return "[" + value.map(serializeInline).join(", ") + "]";
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  if (!keys.length) return "{}";
  return "{ " + keys.map((k) => JSON.stringify(k) + ": " + serializeInline(value[k])).join(", ") + " }";
}

/** True when a node occupies a single line in the source text. */
function isInlineNode(text, node) {
  if (!node) return false;
  return !/[\r\n]/.test(text.slice(node.start, node.end));
}

/**
 * Chooses the rendering that matches the surrounding code.
 * Preserving the author's layout is the whole point of patching text in place.
 */
function serializeFor(text, containerNode, value, baseIndent, style) {
  return isInlineNode(text, containerNode)
    ? serializeInline(value)
    : serialize(value, baseIndent, style);
}

function lineIndentAt(text, pos) {
  const ls = text.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  let i = ls;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  return text.slice(ls, i);
}

function splice(text, start, end, insert) {
  return text.slice(0, start) + insert + text.slice(end);
}

// --------------------------------------------------------------- mutations

// Every mutation re-parses. Configs are a few KB, and the alternative (span
// bookkeeping across edits) is where this kind of code goes wrong.
function requireDoc(text) {
  const doc = parseJsonc(text);
  if (!doc.ok) throw new Error("конфиг не разобран: " + doc.error);
  return doc;
}

function insertMember(text, objNode, key, value, style) {
  // An object written on one line keeps its layout: the new member is appended
  // inline rather than breaking the line and leaving the rest misaligned.
  if (isInlineNode(text, objNode)) {
    const entry = JSON.stringify(key) + ": " + serializeInline(value);
    if (!objNode.members.length) {
      const interior = text.slice(objNode.openEnd, objNode.closeStart);
      if (!interior.trim()) return splice(text, objNode.openEnd, objNode.closeStart, " " + entry + " ");
      // Comments inside an empty inline object are rare; fall through to the
      // multi-line path rather than commenting out the new member.
    } else {
      const last = objNode.members[objNode.members.length - 1];
      if (objNode.trailingComma) {
        const commaPos = text.indexOf(",", last.end);
        const at = commaPos >= 0 && commaPos < objNode.closeStart ? commaPos + 1 : last.end;
        return splice(text, at, at, " " + entry);
      }
      return splice(text, last.end, last.end, ", " + entry);
    }
  }

  const entryIndent = objNode.members.length
    ? lineIndentAt(text, objNode.members[objNode.members.length - 1].start)
    : lineIndentAt(text, objNode.start) + style.indent;
  const entry = JSON.stringify(key) + ": " + serialize(value, entryIndent, style);

  if (objNode.members.length) {
    const last = objNode.members[objNode.members.length - 1];
    if (objNode.trailingComma) {
      // A trailing comma is already there; reuse it instead of adding a second.
      const commaPos = text.indexOf(",", last.end);
      const at = commaPos >= 0 && commaPos < objNode.closeStart ? commaPos + 1 : last.end;
      return splice(text, at, at, style.eol + entryIndent + entry);
    }
    return splice(text, last.end, last.end, "," + style.eol + entryIndent + entry);
  }

  // Empty object: keep any comments that live inside it.
  const interior = text.slice(objNode.openEnd, objNode.closeStart);
  const closeIndent = lineIndentAt(text, objNode.start);
  if (!interior.trim()) {
    return splice(text, objNode.openEnd, objNode.closeStart,
      style.eol + entryIndent + entry + style.eol + closeIndent);
  }
  const trimmedEnd = objNode.openEnd + interior.replace(/\s+$/, "").length;
  return splice(text, trimmedEnd, objNode.closeStart,
    style.eol + entryIndent + entry + style.eol + closeIndent);
}

/**
 * Sets `path` to `value`, creating intermediate objects when missing.
 * Only the affected span is rewritten.
 */
export function setPath(text, path, value) {
  if (!Array.isArray(path) || !path.length) throw new Error("setPath: пустой путь");
  const doc = requireDoc(text);
  const style = doc.style;

  let node = doc.ast;
  for (let i = 0; i < path.length - 1; i++) {
    const key = String(path[i]);
    if (node.type !== "object") throw new Error(`setPath: «${path.slice(0, i).join(".")}» не объект`);
    const m = memberOf(node, key);
    if (!m) {
      // Nothing below this point exists yet: build the whole remaining branch.
      let nested = value;
      for (let j = path.length - 1; j > i; j--) nested = { [String(path[j])]: nested };
      return insertMember(text, node, key, nested, style);
    }
    if (m.value.type !== "object") {
      throw new Error(`setPath: «${path.slice(0, i + 1).join(".")}» уже не объект — правка отменена`);
    }
    node = m.value;
  }

  const leaf = String(path[path.length - 1]);
  if (node.type !== "object") throw new Error("setPath: родитель не объект");
  const existing = memberOf(node, leaf);
  if (existing) {
    const baseIndent = lineIndentAt(text, existing.start);
    // Replacing a value inside a one-line object must stay on one line.
    return splice(text, existing.valueStart, existing.valueEnd,
      serializeFor(text, node, value, baseIndent, style));
  }
  return insertMember(text, node, leaf, value, style);
}

/**
 * Recursively sets the leaves of `value` under `path` instead of replacing the
 * subtree. This is what applying a provider needs: `set` on an object would
 * discard everything inside it (comments *and* unknown fields like `cost`),
 * whereas merging touches only the specific leaves the tool actually manages.
 *
 * Arrays are treated as leaves — a partial array merge has no sane meaning here.
 */
export function mergePath(text, path, value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return setPath(text, path, value);
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  if (!keys.length) {
    // Nothing to merge; make sure the container at least exists.
    const doc = requireDoc(text);
    return nodeAtPath(doc.ast, path) ? text : setPath(text, path, {});
  }

  let out = text;
  const doc = parseJsonc(out);
  // If the target is absent or not an object there is nothing to preserve, so a
  // single write of the whole branch is both correct and cheaper.
  const target = doc.ok ? nodeAtPath(doc.ast, path) : null;
  if (!target || target.type !== "object") return setPath(out, path, value);

  for (const k of keys) out = mergePath(out, [...path, k], value[k]);
  return out;
}

/** Removes `path`. Cleans up the separating comma and any line left blank. */
export function deletePath(text, path) {
  if (!Array.isArray(path) || !path.length) throw new Error("deletePath: пустой путь");
  const doc = requireDoc(text);

  const parentPath = path.slice(0, -1);
  const leaf = String(path[path.length - 1]);
  const parent = nodeAtPath(doc.ast, parentPath);
  if (!parent || parent.type !== "object") return text;

  const idx = parent.members.map((m) => m.key).lastIndexOf(leaf);
  if (idx < 0) return text;
  const member = parent.members[idx];

  let delStart = member.start;
  let delEnd = member.end;

  const next = parent.members[idx + 1];
  if (next) {
    // Consume the comma that separates this member from the next one.
    const comma = text.indexOf(",", member.end);
    if (comma >= 0 && comma < next.start) delEnd = comma + 1;
  } else if (idx > 0) {
    // Last member: swallow the comma that precedes it.
    delStart = parent.members[idx - 1].end;
  } else if (parent.trailingComma) {
    const comma = text.indexOf(",", member.end);
    if (comma >= 0 && comma < parent.closeStart) delEnd = comma + 1;
  }

  // If the removal empties its line, drop the line rather than leave whitespace.
  const lineStart = text.lastIndexOf("\n", Math.max(0, delStart - 1)) + 1;
  if (!text.slice(lineStart, delStart).trim()) {
    let after = delEnd;
    while (after < text.length && (text[after] === " " || text[after] === "\t")) after++;
    if (text[after] === "\r") after++;
    if (text[after] === "\n") {
      delStart = lineStart;
      delEnd = after + 1;
    }
  }
  return splice(text, delStart, delEnd, "");
}

/** Renames the key at `path`, keeping its position and value untouched. */
export function renameKey(text, path, newKey) {
  if (!Array.isArray(path) || !path.length) throw new Error("renameKey: пустой путь");
  const doc = requireDoc(text);
  const parent = nodeAtPath(doc.ast, path.slice(0, -1));
  const leaf = String(path[path.length - 1]);
  if (!parent || parent.type !== "object") throw new Error("renameKey: родитель не объект");
  const idx = parent.members.map((m) => m.key).lastIndexOf(leaf);
  if (idx < 0) throw new Error(`renameKey: ключ «${leaf}» не найден`);
  if (String(newKey) === leaf) return text;
  if (memberOf(parent, String(newKey))) throw new Error(`renameKey: ключ «${newKey}» уже существует`);
  const member = parent.members[idx];
  return splice(text, member.keyStart, member.keyEnd, JSON.stringify(String(newKey)));
}

// ------------------------------------------------------------- change lists

/**
 * Applies a list of `{ op, path, value|key }` changes in order.
 * ops: set | merge | delete | rename
 */
export function applyChanges(text, changes) {
  let out = String(text ?? "");
  for (const ch of changes || []) {
    if (!ch) continue;
    switch (ch.op) {
      case "set": out = setPath(out, ch.path, ch.value); break;
      case "merge": out = mergePath(out, ch.path, ch.value); break;
      case "delete": out = deletePath(out, ch.path); break;
      case "rename": out = renameKey(out, ch.path, ch.key); break;
      default: throw new Error("неизвестная операция: " + ch.op);
    }
  }
  return out;
}

// True when every leaf of `expected` is present with that value in `actual`.
// A merge deliberately leaves unrelated keys alone, so equality is the wrong
// check for it.
function containsLeaves(actual, expected) {
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    return deepEqual(actual, expected);
  }
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  for (const k of Object.keys(expected)) {
    if (expected[k] === undefined) continue;
    if (!containsLeaves(actual[k], expected[k])) return false;
  }
  return true;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== "object") return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

/**
 * Applies changes and refuses to hand back text that does not re-parse or does
 * not actually contain what was asked for. A patcher bug must not be able to
 * corrupt a user's config, so nothing reaches the disk unverified.
 */
export function applyChangesVerified(text, changes) {
  const before = parseJsonc(text);
  if (!before.ok) return { ok: false, error: "исходный конфиг не разобран: " + before.error };

  let out;
  try {
    out = applyChanges(text, changes);
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }

  const after = parseJsonc(out);
  if (!after.ok) return { ok: false, error: "результат правки не разбирается: " + after.error };

  for (const ch of changes || []) {
    if (ch.op === "set") {
      if (!deepEqual(toValue(nodeAtPath(after.ast, ch.path)), ch.value)) {
        return { ok: false, error: `правка «${ch.path.join(".")}» не подтвердилась` };
      }
    } else if (ch.op === "merge") {
      if (!containsLeaves(toValue(nodeAtPath(after.ast, ch.path)), ch.value)) {
        return { ok: false, error: `слияние «${ch.path.join(".")}» не подтвердилось` };
      }
    } else if (ch.op === "delete") {
      if (nodeAtPath(after.ast, ch.path) !== null) {
        return { ok: false, error: `удаление «${ch.path.join(".")}» не подтвердилось` };
      }
    } else if (ch.op === "rename") {
      const parent = ch.path.slice(0, -1);
      if (nodeAtPath(after.ast, [...parent, ch.key]) === null) {
        return { ok: false, error: `переименование в «${ch.key}» не подтвердилось` };
      }
      if (nodeAtPath(after.ast, ch.path) !== null) {
        return { ok: false, error: `старый ключ «${ch.path.join(".")}» остался после переименования` };
      }
    }
  }
  return { ok: true, text: out, value: after.value, comments: after.comments };
}
