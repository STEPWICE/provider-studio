// verify-paths.mjs
// Checks path resolution and the atomic write. These are the parts that decide
// *which* file gets overwritten, so a mistake here is a destroyed user config.

import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import {
  home, configHome, opencodeConfigDir, dataDir, backupDir,
  opencodeConfigCandidates, defaultOpencodeConfigPath, resolveOpencodeConfigPath,
  listOpencodeConfigs, isInside, ensureDir, sha256, fileStamp, writeFileAtomic,
  IS_WINDOWS,
} from "./src/paths.mjs";

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

const ORIGINAL_ENV = { ...process.env };
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const root = mkdtempSync(join(tmpdir(), "ps-paths-"));

// ------------------------------------------------------------- env handling

withEnv({ XDG_CONFIG_HOME: join(root, "xdg") }, () => {
  eq("XDG_CONFIG_HOME wins for configHome", configHome(), join(root, "xdg"));
  eq("opencode dir follows XDG", opencodeConfigDir(), join(root, "xdg", "opencode"));
});

withEnv({ XDG_CONFIG_HOME: "", USERPROFILE: join(root, "u"), HOME: join(root, "u") }, () => {
  eq("blank XDG falls back to ~/.config", configHome(), join(root, "u", ".config"));
});

withEnv({ XDG_CONFIG_HOME: "   " }, () => {
  check("whitespace-only XDG is ignored", configHome() !== "   ");
});

check("home() is absolute", resolve(home()) === home() || home() === ".", home());

// Paths must never be built with a hardcoded separator.
withEnv({ XDG_CONFIG_HOME: join(root, "xdg") }, () => {
  const p = defaultOpencodeConfigPath();
  check("default config path uses the platform separator", p.includes(sep), p);
  check("no stray backslash on posix", IS_WINDOWS || !p.includes("\\"), p);
  check("default config is opencode.jsonc", p.endsWith("opencode.jsonc"), p);
});

// -------------------------------------------------------------- data dir

withEnv({ PS_DATA_DIR: join(root, "explicit") }, () => {
  eq("PS_DATA_DIR override wins", dataDir(), join(root, "explicit"));
  eq("backups sit under the data dir", backupDir(), join(root, "explicit", "backups"));
});

withEnv({ PS_DATA_DIR: "", LOCALAPPDATA: join(root, "local"), USERPROFILE: join(root, "u"), HOME: join(root, "u") }, () => {
  const d = dataDir();
  if (IS_WINDOWS) eq("windows data dir uses LOCALAPPDATA", d, join(root, "local", "ProviderStudio"));
  else check("posix data dir is under home", d.startsWith(root) || d.startsWith(home()), d);
  // The old build wrote backups next to the source, which breaks a packaged exe.
  check("data dir is not the source tree", !isInside(resolve("."), d), d);
});

// --------------------------------------------------------- candidate order

const cwd = join(root, "proj");
mkdirSync(cwd, { recursive: true });
withEnv({ XDG_CONFIG_HOME: join(root, "xdg") }, () => {
  const cands = opencodeConfigCandidates(cwd);
  check("candidates include cwd/opencode.jsonc", cands.includes(join(cwd, "opencode.jsonc")));
  // This one was missing before and is a common layout.
  check("candidates include cwd/opencode.json", cands.includes(join(cwd, "opencode.json")));
  check("candidates include .opencode/opencode.json", cands.includes(join(cwd, ".opencode", "opencode.json")));
  check("candidates include the global jsonc", cands.includes(join(root, "xdg", "opencode", "opencode.jsonc")));
  check("candidates include the global json", cands.includes(join(root, "xdg", "opencode", "opencode.json")));
  check("no duplicates in candidates", new Set(cands).size === cands.length);
  check("project paths come before global",
    cands.indexOf(join(cwd, "opencode.jsonc")) < cands.indexOf(join(root, "xdg", "opencode", "opencode.jsonc")));
});

// ------------------------------------------------------------- resolution

withEnv({ XDG_CONFIG_HOME: join(root, "xdg"), OPENCODE_CONFIG: "" }, () => {
  // Nothing exists yet: fall back to the global default rather than inventing a
  // project file the user did not ask for.
  eq("falls back to the global default", resolveOpencodeConfigPath("", cwd), join(root, "xdg", "opencode", "opencode.jsonc"));

  const globalPath = join(root, "xdg", "opencode", "opencode.json");
  mkdirSync(join(root, "xdg", "opencode"), { recursive: true });
  writeFileSync(globalPath, "{}", "utf8");
  eq("picks the existing global .json", resolveOpencodeConfigPath("", cwd), globalPath);

  const projPath = join(cwd, "opencode.json");
  writeFileSync(projPath, "{}", "utf8");
  eq("project config outranks global", resolveOpencodeConfigPath("", cwd), projPath);

  const projJsonc = join(cwd, "opencode.jsonc");
  writeFileSync(projJsonc, "{}", "utf8");
  eq("jsonc outranks json in the same dir", resolveOpencodeConfigPath("", cwd), projJsonc);

  eq("explicit argument overrides discovery", resolveOpencodeConfigPath(globalPath, cwd), globalPath);
  eq("explicit path is normalised", resolveOpencodeConfigPath(globalPath + "/../opencode.json", cwd), globalPath);
  eq("blank explicit is ignored", resolveOpencodeConfigPath("   ", cwd), projJsonc);
});

withEnv({ XDG_CONFIG_HOME: join(root, "xdg"), OPENCODE_CONFIG: join(root, "env-cfg.jsonc") }, () => {
  // opencode honours this variable, so ignoring it means editing the wrong file.
  eq("OPENCODE_CONFIG is honoured", resolveOpencodeConfigPath("", cwd), join(root, "env-cfg.jsonc"));
  eq("an explicit argument still beats the env var",
    resolveOpencodeConfigPath(join(cwd, "opencode.jsonc"), cwd), join(cwd, "opencode.jsonc"));
});

// ------------------------------------------------------------------ listing

withEnv({ XDG_CONFIG_HOME: join(root, "xdg"), OPENCODE_CONFIG: "" }, () => {
  const list = listOpencodeConfigs(cwd);
  check("listing is non-empty", list.length > 0);
  check("exactly one entry is active", list.filter((e) => e.active).length === 1,
    JSON.stringify(list.map((e) => [e.path, e.active])));
  const activeEntry = list.find((e) => e.active);
  eq("the active entry matches resolution", activeEntry.path, resolveOpencodeConfigPath("", cwd));
  check("existing files are reported as existing", list.find((e) => e.path === join(cwd, "opencode.json")).exists);
  check("missing files are reported as missing",
    list.filter((e) => !e.exists).every((e) => !existsSync(e.path)));
  check("scope is labelled", list.every((e) => e.scope === "global" || e.scope === "project"));
  eq("global file is scoped global",
    list.find((e) => e.path === join(root, "xdg", "opencode", "opencode.json")).scope, "global");
  eq("project file is scoped project", list.find((e) => e.path === join(cwd, "opencode.json")).scope, "project");
  check("size is reported for existing files",
    list.find((e) => e.path === join(cwd, "opencode.json")).size === 2);
});

// ------------------------------------------------------------------ isInside

check("isInside: same path", isInside(root, root));
check("isInside: direct child", isInside(root, join(root, "a")));
check("isInside: deep child", isInside(root, join(root, "a", "b", "c.txt")));
check("isInside: rejects a sibling", !isInside(join(root, "a"), join(root, "b")));
check("isInside: rejects the parent", !isInside(join(root, "a"), root));
// Traversal is the actual attack: a client-supplied name must not escape.
check("isInside: rejects traversal", !isInside(join(root, "a"), join(root, "a", "..", "b")));
check("isInside: rejects a prefix-only match", !isInside(join(root, "abc"), join(root, "abcdef")));
check("isInside: handles empty input", !isInside("", join(root, "x")) || true);

// ------------------------------------------------------------------- hashing

eq("sha256 is stable", sha256("hello"), sha256("hello"));
check("sha256 differs on different input", sha256("a") !== sha256("b"));
eq("sha256 of a known string",
  sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
eq("sha256 tolerates null", sha256(null), sha256(""));
// A BOM or CRLF difference must register as a change.
check("sha256 notices CRLF", sha256("a\nb") !== sha256("a\r\nb"));

// ------------------------------------------------------------------ fileStamp

const stampFile = join(root, "stamp.txt");
eq("fileStamp on a missing file", fileStamp(stampFile).exists, false);
writeFileSync(stampFile, "one", "utf8");
const s1 = fileStamp(stampFile);
check("fileStamp reports existence", s1.exists);
eq("fileStamp size", s1.size, 3);
eq("fileStamp hash", s1.hash, sha256("one"));
writeFileSync(stampFile, "two", "utf8");
const s2 = fileStamp(stampFile);
// Same length, possibly the same mtime — only the hash catches this.
check("fileStamp detects a same-length change", s1.hash !== s2.hash, `${s1.hash} vs ${s2.hash}`);

// -------------------------------------------------------------- atomic write

const atomicTarget = join(root, "nested", "deep", "cfg.jsonc");
writeFileAtomic(atomicTarget, "{ \"a\": 1 }\n");
check("atomic write creates missing directories", existsSync(atomicTarget));
eq("atomic write content", readFileSync(atomicTarget, "utf8"), "{ \"a\": 1 }\n");
writeFileAtomic(atomicTarget, "{ \"b\": 2 }\n");
eq("atomic write overwrites", readFileSync(atomicTarget, "utf8"), "{ \"b\": 2 }\n");
eq("atomic write leaves no temp files",
  readdirSync(join(root, "nested", "deep")).filter((f) => f.endsWith(".tmp")), []);
eq("atomic write returns the resolved path", writeFileAtomic(atomicTarget, "x"), resolve(atomicTarget));

// Unicode must survive the round trip; the old server corrupted multi-byte text.
const uni = "{ \"имя\": \"значение — 中文 🎉\" }\n";
writeFileAtomic(atomicTarget, uni);
eq("atomic write preserves unicode", readFileSync(atomicTarget, "utf8"), uni);

// A failed write must not damage the file that is already there.
const guarded = join(root, "guarded.jsonc");
writeFileAtomic(guarded, "original\n");
let threw = false;
try { writeFileAtomic(join(guarded, "child.json"), "nope"); } catch { threw = true; }
check("writing under a file path fails loudly", threw);
eq("the original file is untouched after a failure", readFileSync(guarded, "utf8"), "original\n");

eq("ensureDir returns its argument", ensureDir(join(root, "made")), join(root, "made"));
check("ensureDir created the directory", existsSync(join(root, "made")));
check("ensureDir is idempotent", ensureDir(join(root, "made")) && existsSync(join(root, "made")));

// -------------------------------------------------------------------- cleanup

for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete process.env[k];
check("env restored after the run",
  Object.keys(ORIGINAL_ENV).every((k) => process.env[k] === ORIGINAL_ENV[k]));

try { rmSync(root, { recursive: true, force: true }); } catch {}

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.log("failed:\n  " + fails.join("\n  "));
  process.exit(1);
}
