// Tests for src/jsonc-edit.mjs — the surgical JSONC patcher.
// This module is the one place where a bug means a corrupted user config, so it
// gets its own suite, including randomised round-trip checks.
// Usage: node verify-jsonc.mjs

import {
  parseJsonc, toValue, setPath, mergePath, deletePath, renameKey,
  applyChanges, applyChangesVerified, getPath, serialize, detectStyle,
} from "./src/jsonc-edit.mjs";

const results = [];
let failed = 0;
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? "" : String(detail ?? "") });
  if (!cond) failed++;
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  check(name, a === e, `got ${a} want ${e}`);
}

// ------------------------------------------------------------------ parsing

const WITH_COMMENTS = `{
  // leading comment
  "$schema": "https://opencode.ai/config.json",
  /* block
     comment */
  "provider": {
    "bai": {
      "npm": "@ai-sdk/openai-compatible", // inline note
      "name": "BAI",
      "options": { "baseURL": "https://api.b.ai/v1" },
      "models": {
        "m1": { "name": "M1", "cost": { "input": 0, "output": 0 } }
      }
    }
  },
  "model": "bai/m1"
}
`;

const doc = parseJsonc(WITH_COMMENTS);
check("parses a commented config", doc.ok, doc.error);
check("reports comments", doc.comments === true, doc.comments);
eq("value matches JSON semantics", doc.value.model, "bai/m1");
eq("nested value read", getPath(WITH_COMMENTS, ["provider", "bai", "options", "baseURL"]), "https://api.b.ai/v1");

// Trailing commas were documented as supported but were not; a config with one
// used to be unrecoverable through the UI.
const TRAILING = `{
  "a": 1,
  "list": [1, 2, 3,],
  "obj": { "x": true, },
}`;
const tdoc = parseJsonc(TRAILING);
check("parses trailing commas", tdoc.ok, tdoc.error);
eq("trailing comma array intact", tdoc.value.list, [1, 2, 3]);
eq("trailing comma object intact", tdoc.value.obj, { x: true });

check("rejects garbage", parseJsonc("{ nope").ok === false, "should not parse");
check("rejects trailing junk", parseJsonc('{"a":1} extra').ok === false, "should not parse");
eq("single quotes tolerated", parseJsonc(`{'a':'b'}`).value, { a: "b" });
eq("bare keys tolerated", parseJsonc(`{a:1}`).value, { a: 1 });
eq("escapes decoded", parseJsonc('{"a":"x\\ny\\u0041"}').value, { a: "x\nyA" });
eq("duplicate key: last wins", parseJsonc('{"a":1,"a":2}').value, { a: 2 });

// --------------------------------------------------------- style detection

eq("detects 2-space indent", detectStyle(WITH_COMMENTS).indent, "  ");
eq("detects tab indent", detectStyle('{\n\t"a": 1\n}').indent, "\t");
eq("detects 4-space indent", detectStyle('{\n    "a": 1\n}').indent, "    ");
eq("detects CRLF", detectStyle('{\r\n  "a": 1\r\n}').eol, "\r\n");

// -------------------------------------------------------- comment survival

let out = setPath(WITH_COMMENTS, ["provider", "bai", "options", "baseURL"], "https://new.example/v1");
check("edit keeps line comment", out.includes("// leading comment"), out.slice(0, 80));
check("edit keeps block comment", out.includes("/* block"), "block comment lost");
check("edit keeps inline comment", out.includes("// inline note"), "inline comment lost");
eq("edit applied", getPath(out, ["provider", "bai", "options", "baseURL"]), "https://new.example/v1");

// The exact regression that motivated this module: Apply used to wipe every
// field the tool did not model.
check("unknown field `cost` survives", !!getPath(out, ["provider", "bai", "models", "m1", "cost"]), "cost lost");
eq("cost value intact", getPath(out, ["provider", "bai", "models", "m1", "cost"]), { input: 0, output: 0 });

const UNKNOWN = `{
  "provider": {
    "p": {
      "npm": "@ai-sdk/openai-compatible",
      "api": "openai",
      "type": "custom",
      "zzzUnknown": { "deep": [1, 2] },
      "options": { "baseURL": "https://x/v1", "headers": { "HTTP-Referer": "https://me" } },
      "models": { "m": { "name": "M", "variants": ["a"], "release_date": "2026-01-01" } }
    }
  }
}`;
let u = setPath(UNKNOWN, ["provider", "p", "models", "m", "name"], "M2");
eq("api survives", getPath(u, ["provider", "p", "api"]), "openai");
eq("type survives", getPath(u, ["provider", "p", "type"]), "custom");
eq("zzzUnknown survives", getPath(u, ["provider", "p", "zzzUnknown"]), { deep: [1, 2] });
eq("options.headers survives", getPath(u, ["provider", "p", "options", "headers"]), { "HTTP-Referer": "https://me" });
eq("variants survives", getPath(u, ["provider", "p", "models", "m", "variants"]), ["a"]);
eq("release_date survives", getPath(u, ["provider", "p", "models", "m", "release_date"]), "2026-01-01");

// Bytes outside the edited span must be identical, not merely equivalent.
const idx = UNKNOWN.indexOf('"zzzUnknown"');
eq("bytes before the edit are untouched", u.slice(0, idx), UNKNOWN.slice(0, idx));

// ------------------------------------------------------------- setPath cases

eq("creates a missing leaf", getPath(setPath('{"a":1}', ["b"], 2), ["b"]), 2);
eq("creates a missing branch",
  getPath(setPath('{"a":1}', ["x", "y", "z"], "v"), ["x", "y", "z"]), "v");
eq("branch creation keeps siblings", getPath(setPath('{"a":1}', ["x", "y"], 1), ["a"]), 1);
eq("fills an empty object", getPath(setPath('{"p":{}}', ["p", "k"], 5), ["p", "k"]), 5);
eq("fills an empty root", getPath(setPath("{}", ["k"], 5), ["k"]), 5);
eq("replaces an object with a scalar", getPath(setPath('{"a":{"b":1}}', ["a"], 3), ["a"]), 3);
eq("appends after a trailing comma", getPath(setPath('{"a":1,}', ["b"], 2), ["b"]), 2);
check("trailing-comma append still parses", parseJsonc(setPath('{"a":1,}', ["b"], 2)).ok, "broken");
eq("writes into an empty object that holds a comment",
  getPath(setPath('{"p":{ /* keep */ }}', ["p", "k"], 1), ["p", "k"]), 1);
check("comment inside empty object survives",
  setPath('{"p":{ /* keep */ }}', ["p", "k"], 1).includes("/* keep */"), "comment lost");
check("setPath refuses to overwrite a scalar parent",
  (() => { try { setPath('{"a":1}', ["a", "b"], 2); return false; } catch { return true; } })(), "should throw");

// ----------------------------------------------------------- mergePath

// `set` on an object replaces the subtree and takes its comments and unknown
// fields with it. Applying a provider must merge leaves instead.
const NESTED_COMMENT = `{
  "outer": {
    // inner comment
    "keepMe": 1,
    "cost": { "input": 0 }
  },
  "sibling": 2
}`;
const merged = mergePath(NESTED_COMMENT, ["outer"], { added: true, keepMe: 9 });
check("merge keeps an inner comment", merged.includes("// inner comment"), merged);
eq("merge preserves unknown sibling field", getPath(merged, ["outer", "cost"]), { input: 0 });
eq("merge overwrites the targeted leaf", getPath(merged, ["outer", "keepMe"]), 9);
eq("merge adds the new leaf", getPath(merged, ["outer", "added"]), true);
eq("merge leaves outer siblings alone", getPath(merged, ["sibling"]), 2);

// Contrast: set is destructive by design.
check("set over an object drops its comment (expected)",
  !setPath(NESTED_COMMENT, ["outer"], { added: true }).includes("// inner comment"), "should drop");

eq("merge creates a missing branch", getPath(mergePath('{"a":1}', ["x", "y"], { z: 1 }), ["x", "y", "z"]), 1);
eq("merge into a missing target writes the whole branch",
  getPath(mergePath("{}", ["p"], { a: 1, b: 2 }), ["p"]), { a: 1, b: 2 });
eq("merge over a scalar replaces it", getPath(mergePath('{"a":1}', ["a"], { b: 2 }), ["a"]), { b: 2 });
eq("merge treats arrays as leaves", getPath(mergePath('{"a":{"l":[1,2,3]}}', ["a"], { l: [9] }), ["a", "l"]), [9]);
eq("merge with an empty object is a no-op on content",
  parseJsonc(mergePath('{"a":{"b":1}}', ["a"], {})).value, { a: { b: 1 } });
eq("merge deep nesting", getPath(mergePath('{"p":{"q":{"r":1}}}', ["p"], { q: { s: 2 } }), ["p", "q"]), { r: 1, s: 2 });

const mv = applyChangesVerified(NESTED_COMMENT, [{ op: "merge", path: ["outer"], value: { added: 1 } }]);
check("verified merge succeeds", mv.ok, mv.error);
check("verified merge keeps the comment", mv.text.includes("// inner comment"), "comment lost");

// --------------------------------------------------- inline layout is kept

// A hand-written config often puts short objects on one line. Inserting a
// multi-line block into such an object parses but wrecks the layout, leaving
// members hanging at the wrong indentation.
const INLINE_OBJ = '{\n  "cfg": { "a": 1, "b": 2 },\n  "next": 3\n}';
const inlineAdd = setPath(INLINE_OBJ, ["cfg", "c"], 3);
check("inline object stays on one line after an insert",
  inlineAdd.includes('"cfg": { "a": 1, "b": 2, "c": 3 }'), inlineAdd);
eq("inline insert keeps the document line count", inlineAdd.split("\n").length, INLINE_OBJ.split("\n").length);
eq("inline insert parses to the right value", parseJsonc(inlineAdd).value, { cfg: { a: 1, b: 2, c: 3 }, next: 3 });

const inlineNested = setPath('{\n  "m": { "x": { "y": 1 } }\n}', ["m", "x", "z"], 2);
check("nested inline object stays inline", inlineNested.includes('{ "y": 1, "z": 2 }'), inlineNested);
eq("nested inline insert has no stray newline", inlineNested.split("\n").length, 3);

// Replacing a value inside a one-line object must not break the line either.
const inlineReplace = setPath('{\n  "cfg": { "a": 1, "b": 2 }\n}', ["cfg", "a"], { deep: true });
check("inline replacement stays inline", inlineReplace.includes('"a": { "deep": true }'), inlineReplace);
eq("inline replacement keeps the line count", inlineReplace.split("\n").length, 3);

// An object of objects written inline is the shape used by `modalities`.
const inlineObjValue = setPath('{\n  "m1": { "name": "m1" }\n}', ["m1", "modalities"], { input: ["text"], output: ["text"] });
check("an inline object receives an inline sub-object",
  inlineObjValue.includes('"modalities": { "input": ["text"], "output": ["text"] }'), inlineObjValue);
eq("inline sub-object keeps the line count", inlineObjValue.split("\n").length, 3);

// A multi-line object must keep expanding multi-line.
const multiAdd = setPath('{\n  "cfg": {\n    "a": 1\n  }\n}', ["cfg", "b"], 2);
check("multi-line object still expands multi-line", /"a": 1,\r?\n\s+"b": 2/.test(multiAdd), multiAdd);

// Empty inline objects and arrays.
check("empty inline object receives an inline member",
  setPath('{\n  "e": {}\n}', ["e", "k"], 1).includes('"e": { "k": 1 }'), setPath('{\n  "e": {}\n}', ["e", "k"], 1));
eq("inline insert into a trailing-comma object parses",
  parseJsonc(setPath('{\n  "cfg": { "a": 1, }\n}', ["cfg", "b"], 2)).value, { cfg: { a: 1, b: 2 } });

// The root itself can be a single line.
const inlineRoot = setPath('{ "a": 1 }', ["b"], 2);
eq("inline root stays on one line", inlineRoot, '{ "a": 1, "b": 2 }');
eq("inline root parses", parseJsonc(inlineRoot).value, { a: 1, b: 2 });
eq("empty inline root", setPath("{}", ["a"], 1), '{ "a": 1 }');

// merge must respect the layout too, since that is the op used for a save.
const inlineMerge = mergePath('{\n  "p": { "npm": "x", "models": { "m": { "name": "m" } } }\n}',
  ["p", "models", "m"], { tool_call: true, modalities: { input: ["text"] } });
check("merge into an inline object stays inline", inlineMerge.split("\n").length === 3, inlineMerge);
eq("merge into an inline object is correct",
  parseJsonc(inlineMerge).value.p.models.m,
  { name: "m", tool_call: true, modalities: { input: ["text"] } });

// Long inline content is still allowed to stay inline; the author chose that.
const longInline = setPath('{\n  "a": { "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6 }\n}', ["a", "seven"], 7);
eq("a long inline object is not reflowed", longInline.split("\n").length, 3);

// -------------------------------------------------------- delete and rename

const THREE = `{
  "a": 1,
  "b": 2,
  "c": 3
}`;
eq("delete middle", parseJsonc(deletePath(THREE, ["b"])).value, { a: 1, c: 3 });
eq("delete last", parseJsonc(deletePath(THREE, ["c"])).value, { a: 1, b: 2 });
eq("delete first", parseJsonc(deletePath(THREE, ["a"])).value, { b: 2, c: 3 });
eq("delete only member", parseJsonc(deletePath('{"a":1}', ["a"])).value, {});
eq("delete nested", parseJsonc(deletePath('{"p":{"x":1,"y":2}}', ["p", "y"])).value, { p: { x: 1 } });
eq("delete missing key is a no-op", parseJsonc(deletePath(THREE, ["zz"])).value, { a: 1, b: 2, c: 3 });
check("delete leaves no blank line", !/\n\s*\n/.test(deletePath(THREE, ["b"])), JSON.stringify(deletePath(THREE, ["b"])));
check("delete keeps comments", deletePath(WITH_COMMENTS, ["model"]).includes("// leading comment"), "comment lost");

const ren = renameKey(WITH_COMMENTS, ["provider", "bai"], "bai2");
check("rename parses", parseJsonc(ren).ok, "broken");
check("new key present", !!getPath(ren, ["provider", "bai2"]), "missing");
check("old key gone", getPath(ren, ["provider", "bai"]) === undefined, "still there");
eq("renamed block keeps its contents", getPath(ren, ["provider", "bai2", "options", "baseURL"]), "https://api.b.ai/v1");
eq("renamed block keeps unknown fields", getPath(ren, ["provider", "bai2", "models", "m1", "cost"]), { input: 0, output: 0 });
check("rename keeps comments", ren.includes("// inline note"), "comment lost");
check("rename to an existing key is refused",
  (() => { try { renameKey('{"a":1,"b":2}', ["a"], "b"); return false; } catch { return true; } })(), "should throw");
eq("rename to the same key is a no-op", renameKey('{"a":1}', ["a"], "a"), '{"a":1}');

// ------------------------------------------------------------ applyChanges

const changed = applyChanges(WITH_COMMENTS, [
  { op: "set", path: ["provider", "bai", "models", "m2"], value: { name: "M2" } },
  { op: "rename", path: ["provider", "bai"], key: "bai-new" },
  { op: "set", path: ["model"], value: "bai-new/m2" },
  { op: "delete", path: ["$schema"] },
]);
const cdoc = parseJsonc(changed);
check("change list parses", cdoc.ok, cdoc.error);
eq("change list: model set", cdoc.value.model, "bai-new/m2");
eq("change list: renamed", Object.keys(cdoc.value.provider), ["bai-new"]);
eq("change list: model added", cdoc.value.provider["bai-new"].models.m2, { name: "M2" });
check("change list: schema deleted", cdoc.value.$schema === undefined, "still there");
check("change list keeps comments", changed.includes("// leading comment"), "comment lost");

// -------------------------------------------------- verified apply (safety)

const v1 = applyChangesVerified(WITH_COMMENTS, [{ op: "set", path: ["model"], value: "x/y" }]);
check("verified apply succeeds", v1.ok, v1.error);
eq("verified apply result", getPath(v1.text, ["model"]), "x/y");

const v2 = applyChangesVerified("{ broken", [{ op: "set", path: ["a"], value: 1 }]);
check("verified apply rejects unparsable input", v2.ok === false, JSON.stringify(v2));

const v3 = applyChangesVerified('{"a":1}', [{ op: "set", path: ["a", "b"], value: 1 }]);
check("verified apply reports a failed edit instead of writing", v3.ok === false, JSON.stringify(v3));

const v4 = applyChangesVerified('{"a":{"b":1}}', [{ op: "delete", path: ["a", "b"] }]);
check("verified delete confirmed", v4.ok && getPath(v4.text, ["a", "b"]) === undefined, JSON.stringify(v4));

// ---------------------------------------------------------- serialisation

const style = { indent: "  ", eol: "\n" };
eq("short arrays stay inline", serialize(["text", "image"], "", style), '["text", "image"]');
eq("empty array", serialize([], "", style), "[]");
eq("empty object", serialize({}, "", style), "{}");
check("object arrays go multiline", serialize([{ a: 1 }], "", style).includes("\n"), "should be multiline");
check("long arrays go multiline",
  serialize(Array.from({ length: 30 }, (_, i) => "item-number-" + i), "", style).includes("\n"), "should wrap");
eq("undefined members dropped", serialize({ a: 1, b: undefined }, "", style), '{\n  "a": 1\n}');
eq("non-finite numbers become null", serialize(NaN, "", style), "null");
eq("unicode keys and values quoted properly",
  JSON.parse(serialize({ "ключ": "значение" }, "", style))["ключ"], "значение");

// CRLF files must not gain stray LF-only lines.
const CRLF = '{\r\n  "a": 1\r\n}';
const crlfOut = setPath(CRLF, ["b"], { x: 1 });
check("CRLF file stays CRLF-only", !/(?<!\r)\n/.test(crlfOut), JSON.stringify(crlfOut));
check("CRLF result parses", parseJsonc(crlfOut).ok, "broken");

// Tab-indented files keep tabs.
const TABS = '{\n\t"a": 1\n}';
check("tab file keeps tabs", setPath(TABS, ["b"], { x: 1 }).includes('\t"b"'), JSON.stringify(setPath(TABS, ["b"], { x: 1 })));

// ------------------------------------------- randomised round-trip property

// Generates nested documents with comments in random places, applies a random
// edit, and asserts: it still parses, the edit took effect, every untouched key
// kept its value, and no comment was lost.
function mulberry(seed) {
  return function rnd() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let propFails = 0;
let commentFails = 0;
for (let s = 0; s < 300; s++) {
  const rnd = mulberry(s + 1);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  function gen(depth) {
    const r = rnd();
    if (depth <= 0 || r < 0.35) {
      return pick([1, 0, -5, 3.5, "s", "", true, false, null, ["a", "b"], []]);
    }
    const n = 1 + Math.floor(rnd() * 3);
    const o = {};
    for (let i = 0; i < n; i++) o["k" + i + "_" + depth] = gen(depth - 1);
    return o;
  }
  const value = gen(3);
  const base = typeof value === "object" && value && !Array.isArray(value) ? value : { root: value };

  // Serialise with comments sprinkled between members.
  function emit(v, ind) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return serialize(v, ind, style);
    const keys = Object.keys(v);
    if (!keys.length) return "{}";
    const inner = ind + "  ";
    const parts = keys.map((k, i) => {
      const lead = rnd() < 0.4 ? inner + "// c" + i + "\n" : "";
      const trail = rnd() < 0.2 ? " /* t" + i + " */" : "";
      return lead + inner + JSON.stringify(k) + ": " + emit(v[k], inner) + trail;
    });
    return "{\n" + parts.join(",\n") + "\n" + ind + "}";
  }
  const text = emit(base, "");
  const parsed = parseJsonc(text);
  if (!parsed.ok) { propFails++; continue; }

  const commentsBefore = (text.match(/\/\/ c\d+|\/\* t\d+ \*\//g) || []).length;

  // Collect object paths, then edit a random one.
  const paths = [];
  (function walk(v, p) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const k of Object.keys(v)) { paths.push([...p, k]); walk(v[k], [...p, k]); }
    }
  })(base, []);
  if (!paths.length) continue;

  const target = pick(paths);
  const op = pick(["merge", "set", "delete", "new"]);
  let res;
  if (op === "merge") res = applyChangesVerified(text, [{ op: "merge", path: target, value: { patched: true } }]);
  else if (op === "set") res = applyChangesVerified(text, [{ op: "set", path: target, value: { patched: true } }]);
  else if (op === "delete") res = applyChangesVerified(text, [{ op: "delete", path: target }]);
  else res = applyChangesVerified(text, [{ op: "set", path: [...target.slice(0, -1), "brandNew"], value: 42 }]);

  if (!res.ok) { propFails++; continue; }

  const after = parseJsonc(res.text);
  if (!after.ok) { propFails++; continue; }

  const commentsAfter = (res.text.match(/\/\/ c\d+|\/\* t\d+ \*\//g) || []).length;
  // `delete` legitimately removes the comments attached to the member it drops,
  // and `set` on an object legitimately replaces the whole subtree. Only `merge`
  // and pure insertion are required to be comment-preserving.
  if ((op === "merge" || op === "new") && commentsAfter !== commentsBefore) commentFails++;

  // Compare against an expectation computed independently of the patcher: the
  // whole document must match, which catches both a botched edit and collateral
  // damage to unrelated keys.
  const expected = JSON.parse(JSON.stringify(base));
  const container = target.slice(0, -1).reduce((o, k) => o[k], expected);
  const leaf = target[target.length - 1];
  if (op === "delete") {
    delete container[leaf];
  } else if (op === "new") {
    container.brandNew = 42;
  } else if (op === "set") {
    container[leaf] = { patched: true };
  } else {
    // merge: object targets keep their other keys, anything else is replaced
    const cur = container[leaf];
    container[leaf] = (cur && typeof cur === "object" && !Array.isArray(cur))
      ? { ...cur, patched: true }
      : { patched: true };
  }
  if (JSON.stringify(after.value) !== JSON.stringify(expected)) propFails++;
}
check("randomised round-trip: 300 documents patched cleanly", propFails === 0, `${propFails} failures`);
check("randomised round-trip: no comments lost", commentFails === 0, `${commentFails} documents lost comments`);

// ------------------------------------------------ the user's real config shape

const REAL = `{
  "$schema": "https://opencode.ai/config.json",
  "model": "baitestik/deepseek-v4-flash-vision-exp",
  "provider": {
    "opencode": {
      "name": "OpenCode",
      "apiKey": "$OPENCODE_API_KEY"
    },
    "gensparksoad": {
      "name": "GenSparkSOAD",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://www.genspark.ai/api/llm_proxy/v1",
        "apiKey": "gsk-secret-value"
      },
      "models": {
        "claude-opus-5": {
          "name": "claude-opus-5",
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "attachment": true,
          "reasoning": true,
          "tool_call": true,
          "limit": { "context": 200000, "output": 32000 }
        }
      }
    }
  },
  "mcp": {
    "godot-ai": { "type": "remote", "url": "http://127.0.0.1:8000/mcp", "enabled": true }
  },
  "disabled_providers": []
}
`;

// Key migration to an env reference is a Phase 5 feature; verify the mechanism.
const mig = applyChangesVerified(REAL, [
  { op: "set", path: ["provider", "gensparksoad", "options", "apiKey"], value: "{env:GENSPARKSOAD_API_KEY}" },
  { op: "set", path: ["provider", "gensparksoad", "env"], value: ["GENSPARKSOAD_API_KEY"] },
]);
check("real config: key migration applies", mig.ok, mig.error);
check("real config: plaintext key removed", !mig.text.includes("gsk-secret-value"), "key still present");
eq("real config: env ref written", getPath(mig.text, ["provider", "gensparksoad", "options", "apiKey"]), "{env:GENSPARKSOAD_API_KEY}");
eq("real config: mcp block untouched", getPath(mig.text, ["mcp", "godot-ai", "url"]), "http://127.0.0.1:8000/mcp");
eq("real config: limit untouched", getPath(mig.text, ["provider", "gensparksoad", "models", "claude-opus-5", "limit"]), { context: 200000, output: 32000 });
check("real config: inline modalities style preserved",
  mig.text.includes('"modalities": { "input": ["text", "image"], "output": ["text"] }'), "reformatted");

// Renaming a provider must move the block and fix the default model reference.
const renamed = applyChangesVerified(REAL, [
  { op: "rename", path: ["provider", "gensparksoad"], key: "genspark" },
  { op: "set", path: ["model"], value: "genspark/claude-opus-5" },
]);
check("real config: rename applies", renamed.ok, renamed.error);
check("real config: old provider key gone", getPath(renamed.text, ["provider", "gensparksoad"]) === undefined, "still there");
eq("real config: default model updated", getPath(renamed.text, ["model"]), "genspark/claude-opus-5");

// Deleting a provider must not disturb neighbours.
const del = applyChangesVerified(REAL, [{ op: "delete", path: ["provider", "gensparksoad"] }]);
check("real config: delete applies", del.ok, del.error);
check("real config: deleted provider gone", getPath(del.text, ["provider", "gensparksoad"]) === undefined, "still there");
eq("real config: sibling provider intact", getPath(del.text, ["provider", "opencode", "name"]), "OpenCode");
eq("real config: mcp intact after delete", getPath(del.text, ["mcp", "godot-ai", "enabled"]), true);

// ---------------------------------------------------------------- reporting

const pad = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(pad)}${r.ok ? "" : "  <- " + r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exitCode = 1;
