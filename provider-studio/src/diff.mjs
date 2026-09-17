// src/diff.mjs
// Line diff between the current config and what a plan would write.
//
// The point is trust: the tool edits a file the user cares about, so it must be
// able to show exactly what changes before anything is written. The diff is
// computed from the same `before`/`after` text the writer uses, so what is shown
// cannot drift from what lands on disk.
//
// Myers' algorithm over an LCS matrix is overkill for a config file, but a plain
// LCS is O(n*m) in memory and these files are small (a few hundred lines), so
// the simple version is used with a guard for pathological input.

const MAX_LCS_CELLS = 4_000_000; // ~2000x2000 lines before falling back

/** Splits text into lines, keeping the information needed to rejoin exactly. */
export function splitLines(text) {
  const s = String(text ?? "");
  if (s === "") return [];
  return s.split(/\r\n|\n|\r/);
}

/**
 * Longest common subsequence of two line arrays, as a list of {ai, bi} pairs.
 * Returns null when the input is too large to do this safely.
 */
function lcs(a, b) {
  const n = a.length;
  const m = b.length;

  // Trim the common prefix and suffix BEFORE the size guard: for a config edit
  // this collapses almost the whole file, and only the changed middle needs
  // the matrix. Guarding the untrimmed size instead refused every file over
  // ~2000 lines outright — a one-line change in a big config reported the
  // whole file as added+removed with no hunks, which also disabled the diff
  // confirm button downstream.
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  if ((endA - start + 1) * (endB - start + 1) > MAX_LCS_CELLS) return null;

  const pairs = [];
  for (let i = 0; i < start; i++) pairs.push({ ai: i, bi: i });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length && midB.length) {
    const rows = midA.length + 1;
    const cols = midB.length + 1;
    // Int32Array keeps this compact; lengths never exceed the line count.
    const table = new Int32Array(rows * cols);
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        table[i * cols + j] = midA[i] === midB[j]
          ? table[(i + 1) * cols + (j + 1)] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + (j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        pairs.push({ ai: start + i, bi: start + j });
        i++; j++;
      } else if (table[(i + 1) * cols + j] >= table[i * cols + (j + 1)]) {
        i++;
      } else {
        j++;
      }
    }
  }

  for (let k = 0; k < n - endA; k++) pairs.push({ ai: endA + k, bi: endB + k });
  return pairs;
}

/**
 * Builds a line-level diff.
 * @returns {{lines: Array, added: number, removed: number, truncated: boolean}}
 *   Each line is { type: "context"|"add"|"remove", text, beforeLine, afterLine }.
 */
export function diffLines(beforeText, afterText) {
  const a = splitLines(beforeText);
  const b = splitLines(afterText);
  const out = [];
  let added = 0;
  let removed = 0;

  const pairs = lcs(a, b);
  if (!pairs) {
    // Too big to diff precisely; report it honestly rather than lying with a
    // partial result the user might mistake for the whole change.
    return {
      lines: [],
      added: b.length,
      removed: a.length,
      truncated: true,
      unchanged: 0,
    };
  }

  let ai = 0;
  let bi = 0;
  const emitRemove = (upto) => {
    while (ai < upto) {
      out.push({ type: "remove", text: a[ai], beforeLine: ai + 1, afterLine: null });
      removed++;
      ai++;
    }
  };
  const emitAdd = (upto) => {
    while (bi < upto) {
      out.push({ type: "add", text: b[bi], beforeLine: null, afterLine: bi + 1 });
      added++;
      bi++;
    }
  };

  for (const { ai: pa, bi: pb } of pairs) {
    emitRemove(pa);
    emitAdd(pb);
    out.push({ type: "context", text: a[pa], beforeLine: pa + 1, afterLine: pb + 1 });
    ai = pa + 1;
    bi = pb + 1;
  }
  emitRemove(a.length);
  emitAdd(b.length);

  return {
    lines: out,
    added,
    removed,
    truncated: false,
    unchanged: out.length - added - removed,
  };
}

/**
 * Groups a diff into hunks with `context` lines of surrounding context, so the
 * UI shows the change rather than the entire file.
 */
export function toHunks(diff, context = 3) {
  const lines = diff?.lines || [];
  if (!lines.length) return [];

  const interesting = new Set();
  lines.forEach((l, i) => {
    if (l.type === "context") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
      interesting.add(k);
    }
  });
  if (!interesting.size) return [];

  const indices = [...interesting].sort((x, y) => x - y);
  const hunks = [];
  let run = [indices[0]];
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === indices[i - 1] + 1) run.push(indices[i]);
    else { hunks.push(run); run = [indices[i]]; }
  }
  hunks.push(run);

  return hunks.map((run) => {
    const slice = run.map((i) => lines[i]);
    const firstBefore = slice.find((l) => l.beforeLine != null)?.beforeLine ?? 0;
    const firstAfter = slice.find((l) => l.afterLine != null)?.afterLine ?? 0;
    return {
      beforeStart: firstBefore,
      afterStart: firstAfter,
      beforeCount: slice.filter((l) => l.type !== "add").length,
      afterCount: slice.filter((l) => l.type !== "remove").length,
      lines: slice,
    };
  });
}

/** Renders hunks as unified-diff text, for logs and for copying out. */
export function toUnifiedText(diff, context = 3) {
  const hunks = toHunks(diff, context);
  const out = [];
  for (const h of hunks) {
    out.push(`@@ -${h.beforeStart},${h.beforeCount} +${h.afterStart},${h.afterCount} @@`);
    for (const l of h.lines) {
      const sign = l.type === "add" ? "+" : l.type === "remove" ? "-" : " ";
      out.push(sign + l.text);
    }
  }
  return out.join("\n");
}

// Anything that looks like a credential is masked before a diff reaches the
// browser or a log. The diff of a config full of keys is otherwise a neat way to
// leak every one of them at once.
const SECRET_KEYS = /"(apiKey|api_key|token|secret|password|authorization)"\s*:\s*"/i;

/** Masks secret values in a single line, keeping enough to recognise the key. */
export function maskSecretsInLine(line) {
  const s = String(line ?? "");
  const m = s.match(SECRET_KEYS);
  if (!m) return s;
  const valueStart = s.indexOf('"', s.indexOf(":", s.indexOf(m[1]))) + 1;
  if (valueStart <= 0) return s;
  const valueEnd = s.indexOf('"', valueStart);
  if (valueEnd < 0) return s;
  const value = s.slice(valueStart, valueEnd);
  // An env reference is not a secret and is the thing we want the user to see.
  if (/^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(value) || /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value)) return s;
  if (!value) return s;
  const keep = value.length > 12 ? 4 : 0;
  const masked = keep
    ? value.slice(0, keep) + "…" + "*".repeat(6)
    : "*".repeat(Math.min(8, value.length));
  return s.slice(0, valueStart) + masked + s.slice(valueEnd);
}

/** Applies secret masking across a whole diff. */
export function maskDiff(diff) {
  if (!diff?.lines) return diff;
  return {
    ...diff,
    lines: diff.lines.map((l) => ({ ...l, text: maskSecretsInLine(l.text) })),
  };
}

/**
 * The full payload the preview endpoint returns: a masked, hunked diff plus
 * counts, so the UI can say "3 added, 1 removed" without recomputing anything.
 */
export function buildPreview(beforeText, afterText, { context = 3, mask = true } = {}) {
  const raw = diffLines(beforeText, afterText);
  const diff = mask ? maskDiff(raw) : raw;
  return {
    added: diff.added,
    removed: diff.removed,
    unchanged: diff.unchanged ?? 0,
    truncated: !!diff.truncated,
    identical: diff.added === 0 && diff.removed === 0,
    hunks: toHunks(diff, context),
    unified: toUnifiedText(diff, context),
  };
}
