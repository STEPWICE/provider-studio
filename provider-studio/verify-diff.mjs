// verify-diff.mjs
// Checks the diff shown before a write. Two things must hold: the diff has to
// describe the real change (or the preview is a lie), and it must never print a
// plaintext credential, since the whole config is full of them.

import { diffLines, toHunks, toUnifiedText, maskSecretsInLine, maskDiff, buildPreview, splitLines } from "./src/diff.mjs";
import { applyChangesVerified } from "./src/jsonc-edit.mjs";

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

// A diff is only trustworthy if replaying it reproduces the target exactly.
function replay(diff) {
  return diff.lines.filter((l) => l.type !== "remove").map((l) => l.text).join("\n");
}
function replayBefore(diff) {
  return diff.lines.filter((l) => l.type !== "add").map((l) => l.text).join("\n");
}

// ------------------------------------------------------------- splitLines

eq("splitLines on empty text", splitLines(""), []);
eq("splitLines on a single line", splitLines("a"), ["a"]);
eq("splitLines on LF", splitLines("a\nb"), ["a", "b"]);
eq("splitLines on CRLF", splitLines("a\r\nb"), ["a", "b"]);
eq("splitLines on a bare CR", splitLines("a\rb"), ["a", "b"]);
eq("splitLines keeps a trailing blank line", splitLines("a\n"), ["a", ""]);
eq("splitLines tolerates null", splitLines(null), []);

// --------------------------------------------------------------- diffLines

const same = diffLines("a\nb\nc", "a\nb\nc");
eq("identical text has no changes", [same.added, same.removed], [0, 0]);
eq("identical text is all context", same.lines.every((l) => l.type === "context"), true);

const oneAdd = diffLines("a\nc", "a\nb\nc");
eq("single insertion counted", [oneAdd.added, oneAdd.removed], [1, 0]);
eq("insertion replays to the target", replay(oneAdd), "a\nb\nc");
eq("insertion replays back to the source", replayBefore(oneAdd), "a\nc");
eq("inserted line carries its new number", oneAdd.lines.find((l) => l.type === "add").afterLine, 2);
check("inserted line has no old number", oneAdd.lines.find((l) => l.type === "add").beforeLine === null);

const oneRemove = diffLines("a\nb\nc", "a\nc");
eq("single deletion counted", [oneRemove.added, oneRemove.removed], [0, 1]);
eq("deletion replays to the target", replay(oneRemove), "a\nc");
eq("removed line carries its old number", oneRemove.lines.find((l) => l.type === "remove").beforeLine, 2);

const changed = diffLines("a\nOLD\nc", "a\nNEW\nc");
eq("a modification is one add and one remove", [changed.added, changed.removed], [1, 1]);
eq("modification replays to the target", replay(changed), "a\nNEW\nc");

eq("from empty to content", diffLines("", "a\nb").added, 2);
eq("from content to empty", diffLines("a\nb", "").removed, 2);
eq("both empty", [diffLines("", "").added, diffLines("", "").removed], [0, 0]);

// Reordering must be reported, not silently treated as equal.
const reordered = diffLines("a\nb", "b\na");
check("reordering is reported as a change", reordered.added > 0 || reordered.removed > 0);
eq("reordering replays to the target", replay(reordered), "b\na");

// Repeated lines are where a naive diff goes wrong.
const dupes = diffLines("x\nx\nx", "x\nx\nx\nx");
eq("repeated lines: one addition", [dupes.added, dupes.removed], [1, 0]);
eq("repeated lines replay", replay(dupes), "x\nx\nx\nx");
const dupesDown = diffLines("x\nx\nx\nx", "x\nx");
eq("repeated lines: two deletions", [dupesDown.added, dupesDown.removed], [0, 2]);
eq("repeated lines replay down", replay(dupesDown), "x\nx");

// Whitespace-only differences are real for a config file's formatting.
const ws = diffLines('  "a": 1', '    "a": 1');
check("indentation change is detected", ws.added === 1 && ws.removed === 1);

// A realistic config edit: only the touched line should move.
const beforeCfg = [
  "{", '  "$schema": "x",', '  "provider": {', '    "a": {', '      "npm": "p",',
  '      "options": { "baseURL": "https://a.dev" }', "    }", "  }", "}",
].join("\n");
const afterCfg = beforeCfg.replace("https://a.dev", "https://b.dev");
const cfgDiff = diffLines(beforeCfg, afterCfg);
eq("config edit touches exactly one line", [cfgDiff.added, cfgDiff.removed], [1, 1]);
eq("config edit replays exactly", replay(cfgDiff), afterCfg);
eq("config edit leaves the rest as context", cfgDiff.unchanged, 8);

// Property check: a diff must always replay to the target, for random inputs.
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let replayFails = 0;
let countFails = 0;
for (let s = 0; s < 600; s++) {
  const rnd = mulberry(s + 1);
  const alphabet = ["a", "b", "c", "d", "", "  x", "}"];
  const mk = () => Array.from({ length: Math.floor(rnd() * 12) }, () => alphabet[Math.floor(rnd() * alphabet.length)]);
  const A = mk().join("\n");
  const B = mk().join("\n");
  const d = diffLines(A, B);
  if (replay(d) !== B) replayFails++;
  if (replayBefore(d) !== A) countFails++;
}
check("randomised: every diff replays to the target", replayFails === 0, `${replayFails} failures`);
check("randomised: every diff replays back to the source", countFails === 0, `${countFails} failures`);

// ------------------------------------------------------------------ hunks

const longFile = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
const longEdited = longFile.replace("line 30", "line 30 CHANGED");
const longDiff = diffLines(longFile, longEdited);
const hunks = toHunks(longDiff, 3);
eq("a single edit yields one hunk", hunks.length, 1);
check("the hunk is small, not the whole file", hunks[0].lines.length <= 9, String(hunks[0].lines.length));
check("the hunk contains the change", hunks[0].lines.some((l) => l.text.includes("CHANGED")));
check("the hunk carries surrounding context", hunks[0].lines.some((l) => l.type === "context"));
eq("hunk start lines are 1-based", hunks[0].beforeStart, 28);

const twoEdits = longFile.replace("line 5", "FIVE").replace("line 50", "FIFTY");
const twoHunks = toHunks(diffLines(longFile, twoEdits), 3);
eq("distant edits yield two hunks", twoHunks.length, 2);
const nearEdits = longFile.replace("line 20", "TWENTY").replace("line 22", "TWENTYTWO");
eq("nearby edits merge into one hunk", toHunks(diffLines(longFile, nearEdits), 3).length, 1);
eq("no change means no hunks", toHunks(diffLines(longFile, longFile), 3).length, 0);
eq("zero context still yields a hunk", toHunks(diffLines("a\nb", "a\nX"), 0).length, 1);

// ----------------------------------------------------------------- unified

const unified = toUnifiedText(diffLines("a\nb\nc", "a\nX\nc"), 1);
check("unified output has a header", unified.includes("@@"), unified);
check("unified marks additions with +", unified.split("\n").some((l) => l.startsWith("+X")), unified);
check("unified marks removals with -", unified.split("\n").some((l) => l.startsWith("-b")), unified);
check("unified marks context with a space", unified.split("\n").some((l) => l.startsWith(" a")), unified);
eq("unified of no change is empty", toUnifiedText(diffLines("a", "a"), 3), "");

// ------------------------------------------------------------- secret masking

const secretLine = '        "apiKey": "gsk-eyJjb2dlbl9pZCI6IjNiYzgzNzg1LWViYzUtNGNjNi05ZmFj",';
const maskedLine = maskSecretsInLine(secretLine);
check("a plaintext key is masked", !maskedLine.includes("eyJjb2dlbl9pZCI"), maskedLine);
check("masking keeps the field name", maskedLine.includes('"apiKey"'), maskedLine);
check("masking keeps the line structure", maskedLine.trim().endsWith('",') || maskedLine.trim().endsWith('"'), maskedLine);
check("masking keeps a recognisable prefix", maskedLine.includes("gsk-"), maskedLine);

// An env reference is the thing we want the user to verify, so it stays visible.
eq("an env reference is not masked",
  maskSecretsInLine('  "apiKey": "{env:MY_KEY}"'), '  "apiKey": "{env:MY_KEY}"');
eq("a legacy $VAR reference is not masked",
  maskSecretsInLine('  "apiKey": "$MY_KEY"'), '  "apiKey": "$MY_KEY"');
eq("an empty key is left alone", maskSecretsInLine('  "apiKey": ""'), '  "apiKey": ""');
eq("an unrelated line is untouched", maskSecretsInLine('  "baseURL": "https://a.dev/v1"'), '  "baseURL": "https://a.dev/v1"');
check("a token field is masked", !maskSecretsInLine('"token": "abcdefghijklmnop"').includes("abcdefghijklmnop"));
check("a password field is masked", !maskSecretsInLine('"password": "hunter2hunter2"').includes("hunter2hunter2"));
check("an authorization field is masked", !maskSecretsInLine('"authorization": "Bearer sk-abcdefgh"').includes("sk-abcdefgh"));
check("api_key snake case is masked", !maskSecretsInLine('"api_key": "sk-abcdefghijkl"').includes("sk-abcdefghijkl"));
check("masking is case-insensitive on the field", !maskSecretsInLine('"ApiKey": "sk-abcdefghijkl"').includes("sk-abcdefghijkl"));
eq("masking tolerates null", maskSecretsInLine(null), "");
check("a short key is fully masked", !/abc/.test(maskSecretsInLine('"apiKey": "abc"')), maskSecretsInLine('"apiKey": "abc"'));

const secretDiff = maskDiff(diffLines('{"apiKey": "sk-oldsecretvalue"}', '{"apiKey": "sk-newsecretvalue"}'));
check("masking applies across a whole diff",
  !JSON.stringify(secretDiff).includes("oldsecretvalue") && !JSON.stringify(secretDiff).includes("newsecretvalue"),
  JSON.stringify(secretDiff.lines.map((l) => l.text)));

// ----------------------------------------------------------------- preview

const prev = buildPreview("a\nb\nc", "a\nX\nc");
eq("preview counts additions", prev.added, 1);
eq("preview counts removals", prev.removed, 1);
eq("preview is not identical", prev.identical, false);
check("preview carries hunks", prev.hunks.length === 1);
check("preview carries unified text", prev.unified.includes("@@"));
eq("preview of no change is identical", buildPreview("a", "a").identical, true);
eq("identical preview has no hunks", buildPreview("a", "a").hunks.length, 0);

const secretPreview = buildPreview('{"apiKey": "sk-verysecretvalue1"}', '{"apiKey": "{env:K}"}');
check("preview masks secrets by default",
  !JSON.stringify(secretPreview).includes("verysecretvalue1"), JSON.stringify(secretPreview).slice(0, 300));
check("preview shows the env reference it replaced it with",
  JSON.stringify(secretPreview).includes("{env:K}"));
check("preview can be told not to mask",
  JSON.stringify(buildPreview('{"apiKey": "sk-verysecretvalue1"}', "{}", { mask: false })).includes("verysecretvalue1"));

// ------------------------------------------- end to end against the patcher

// The preview must describe the patcher's real output, or it is worthless.
const REAL = `{
  // keep me
  "$schema": "https://opencode.ai/config.json",
  "model": "bai/m1",
  "provider": {
    "bai": {
      "name": "BAI",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://api.b.ai/v1",
        "apiKey": "gsk-plaintextsecretthatmustnotleak"
      },
      "models": { "m1": { "name": "m1" } }
    }
  }
}`;
const patched = applyChangesVerified(REAL, [
  { op: "merge", path: ["provider", "bai"], value: { env: ["BAI_API_KEY"], options: { apiKey: "{env:BAI_API_KEY}" } } },
]);
check("end to end: patch applied", patched.ok, patched.error);

const e2e = buildPreview(REAL, patched.text);
check("end to end: the diff is minimal", e2e.added + e2e.removed <= 6, `${e2e.added}+${e2e.removed}`);
check("end to end: the old secret never appears", !JSON.stringify(e2e).includes("plaintextsecretthatmustnotleak"),
  JSON.stringify(e2e.hunks).slice(0, 400));
check("end to end: the env reference is shown", JSON.stringify(e2e).includes("{env:BAI_API_KEY}"));
check("end to end: the comment is not reported as changed",
  !e2e.hunks.some((h) => h.lines.some((l) => l.type !== "context" && l.text.includes("keep me"))));

// An unmasked replay must reconstruct the patcher's output byte for byte.
const rawE2E = diffLines(REAL, patched.text);
eq("end to end: unmasked diff replays to the patched text", replay(rawE2E), patched.text);

// ------------------------------------------------------- big file, small change
// Regression: the size guard used to measure the whole file, so any file over
// ~2000 lines reported the entire content as added+removed with no hunks —
// which also disabled the diff confirm button downstream.
{
  const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
  const changed = [...big];
  changed.splice(1500, 0, "inserted line");
  const d = diffLines(big.join("\n"), changed.join("\n"));
  check("a one-line change in a 3000-line file is not truncated",
    d.truncated === false && d.added === 1 && d.removed === 0, JSON.stringify({ added: d.added, removed: d.removed, truncated: d.truncated }));
  check("the big diff replays exactly", replay(d) === changed.join("\n"));
  check("the big diff yields hunks", toHunks(d).length === 1, String(toHunks(d).length));
  // Two completely different big files must still refuse, not hang the tab.
  const other = Array.from({ length: 3000 }, (_, i) => `other ${i}`);
  const refused = diffLines(big.join("\n"), other.join("\n"));
  check("fully different big files still refuse", refused.truncated === true && refused.lines.length === 0);
}

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.log("failed:\n  " + fails.join("\n  "));
  process.exit(1);
}
