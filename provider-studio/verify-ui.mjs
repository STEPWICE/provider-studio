// Static consistency check between public/index.html and public/app.js:
// every $("#id") / $(".class") the script reaches for must exist in the markup.
import { readFileSync } from "node:fs";

const js = readFileSync("public/app.js", "utf8");
const html = readFileSync("public/index.html", "utf8");

const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const usedIds = new Set([...js.matchAll(/\$\("#([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
const usedIdsAll = new Set([...js.matchAll(/\$\$\("#([A-Za-z0-9_-]+)/g)].map((m) => m[1]));
for (const v of usedIdsAll) usedIds.add(v);

const classAttrs = [...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
const classes = new Set(classAttrs);
const usedClasses = new Set([...js.matchAll(/\$\("\.([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));

// Ids, like classes, may be emitted by the script itself (the diagnostics panel
// builds its controls from the probe results, so they cannot exist in the static
// markup). Accept those, but only when the script really does write the id, so
// a genuine typo is still caught.
const generatedIds = new Set([...js.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
const missingIds = [...usedIds].filter((x) => !ids.has(x) && !generatedIds.has(x));
// Classes may be generated at runtime by the script itself.
const generated = new Set(
  [...js.matchAll(/class="([^"$]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean)
);
const missingClasses = [...usedClasses].filter((x) => !classes.has(x) && !generated.has(x));

console.log(`ids declared in html: ${ids.size}`);
console.log(`ids referenced in js: ${usedIds.size}`);
console.log(missingIds.length ? `MISSING IDS: ${missingIds.join(", ")}` : "all referenced ids exist");
console.log(missingClasses.length ? `MISSING CLASSES: ${missingClasses.join(", ")}` : "all single-class selectors resolve");

// Guard against the earlier `$("#x").click(fn)` mistake: on a DOM element that
// dispatches a click instead of subscribing. A bare `.click()` with no argument
// is the opposite — a deliberate dispatch, used by the keyboard shortcuts — so
// only an argument-carrying call is a bug.
const badClick = [...js.matchAll(/\$\("[^"]+"\)\.click\(\s*[^)\s]/g)].map((m) => m[0]);
console.log(badClick.length ? `BAD .click() SUBSCRIPTIONS: ${badClick.join(", ")}` : "no .click(fn) misuse");

// The clipboard is the one sink that must never receive the literal key
// (`/api/test` and `/api/discover` legitimately post it to the local server).
const leaks = [];
const clipboardCalls = [...js.matchAll(/clipboard\.writeText\(([^;]*)\)/g)].map((m) => m[1]);
for (const call of clipboardCalls) {
  if (/\bprovider\s*\)/.test(call) || /\{\s*provider\s*\}/.test(call)) {
    leaks.push(`clipboard receives the raw provider: ${call.trim().slice(0, 60)}`);
  }
}
if (!/apiKey:\s*provider\.useEnvVar/.test(js)) leaks.push("copyJson does not substitute a key placeholder");
console.log(leaks.length ? `KEY LEAK RISKS: ${leaks.join("; ")}` : "clipboard payload carries no literal key");

// Routes the server exposes must actually be reachable from the UI, otherwise
// they are dead code: the whole preview/commit safety story only exists if the
// front end goes through it.
const serverJs = readFileSync("server.mjs", "utf8");
const serverRoutes = new Set(
  [...serverJs.matchAll(/url\.pathname === "(\/api\/[a-z-]+)"/g)].map((m) => m[1])
);
const clientRoutes = new Set([...js.matchAll(/"(\/api\/[a-z-]+)"/g)].map((m) => m[1]));
const unreachable = [...serverRoutes].filter((r) => !clientRoutes.has(r));
const phantom = [...clientRoutes].filter((r) => !serverRoutes.has(r));
console.log(`api routes: server ${serverRoutes.size}, used by ui ${clientRoutes.size}`);
console.log(unreachable.length ? `UNREACHABLE ROUTES: ${unreachable.join(", ")}` : "every server route is used by the ui");
console.log(phantom.length ? `ROUTES THE SERVER DOES NOT HAVE: ${phantom.join(", ")}` : "ui calls no phantom route");

// A write without the hash it was previewed against cannot be conflict-checked,
// so the guard would silently degrade to last-write-wins.
const guards = [];
for (const route of ["/api/apply", "/api/remove-provider", "/api/rename-provider"]) {
  // Grab the api(...) call for this route and check the body mentions the hash.
  const re = new RegExp(`"${route.replace(/\//g, "\\/")}"[\\s\\S]{0,400}?\\)`, "g");
  const calls = [...js.matchAll(re)].map((m) => m[0]);
  if (!calls.length) { guards.push(`${route} is never called`); continue; }
  if (!calls.some((c) => /hash/.test(c) || /requestBody\(/.test(c)))
    guards.push(`${route} posts no hash (no stale-write protection)`);
}
if (!/res\.conflict|r\.conflict/.test(js)) guards.push("a 409 conflict response is never handled");
console.log(guards.length ? `WRITE GUARD GAPS: ${guards.join("; ")}` : "all writes carry a hash and handle 409");

// The diff renderer must branch on the exact line types src/diff.mjs emits.
// Getting this wrong is silent: deleted lines fall through to the "context"
// branch and the user reviews a diff that hides the removals.
const diffJs = readFileSync("src/diff.mjs", "utf8");
const emitted = new Set([...diffJs.matchAll(/type: "([a-z]+)"/g)].map((m) => m[1]));
const renderBlock = js.slice(js.indexOf("function openDiff"), js.indexOf("function closeDiff"));
const consumed = new Set([...renderBlock.matchAll(/l\.type === "([a-z]+)"/g)].map((m) => m[1]));
const typeGaps = [];
for (const t of emitted) {
  // "context" is the fall-through branch, so it need not be named explicitly.
  if (t !== "context" && !consumed.has(t)) typeGaps.push(`diff emits "${t}" but the ui never matches it`);
}
for (const t of consumed) {
  if (!emitted.has(t)) typeGaps.push(`ui matches "${t}" which diff.mjs never emits`);
}
console.log(`diff line types: emitted ${[...emitted].join("/")}, matched ${[...consumed].join("/")}`);
console.log(typeGaps.length ? `DIFF TYPE MISMATCH: ${typeGaps.join("; ")}` : "diff line types line up");

// The preview payload fields the modal reads must exist on buildPreview output.
const previewFields = ["hunks", "identical", "added", "removed"];
const fieldGaps = previewFields.filter((f) => !new RegExp(`\\b${f}\\b`).test(diffJs));
console.log(fieldGaps.length ? `PREVIEW FIELD GAPS: ${fieldGaps.join(", ")}` : "preview fields exist server-side");

// The patcher preserves comments now; a warning claiming otherwise would push
// users away from a safe operation.
const lies = [];
if (/комментари[^"]*будут удалены/.test(js)) lies.push("app.js still warns that comments will be deleted");
console.log(lies.length ? `STALE WARNINGS: ${lies.join("; ")}` : "no stale comment warning");

// Every class that ends up in the DOM should have a rule in the stylesheet.
// This is the check that was missing when `.ren` shipped unstyled: the button
// existed, worked, and rendered as a default bordered browser control that was
// always visible — the ugliest thing on screen, and invisible to every test.
const css = readFileSync("public/style.css", "utf8");
const cssClasses = new Set([...css.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)].map((m) => m[1]));
// `${...}` blocks contain their own quotes, which would end the class attribute
// early and leak fragments of JS expressions into the token list. Strip them
// first, keeping the literal text around them.
function stripInterpolations(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const at = src.indexOf("${", i);
    if (at === -1) { out += src.slice(i); break; }
    out += src.slice(i, at);
    let depth = 1, j = at + 2;
    while (j < src.length && depth > 0) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
      j++;
    }
    // Space keeps neighbouring class names from fusing into one token.
    out += " ";
    i = j;
  }
  return out;
}

// Classes from static markup plus the ones the script builds in template
// literals, which is where most of the UI actually comes from.
const jsMarkup = stripInterpolations(js);
const domClasses = new Set([
  ...classAttrs,
  ...[...jsMarkup.matchAll(/class="([^"]*)"/g)].flatMap((m) =>
    m[1].split(/\s+/).filter(Boolean)),
]);
// Utility names that intentionally carry no styling of their own.
const unstyledOk = new Set(["app", "modal-backdrop"]);
const unstyled = [...domClasses].filter((c) => !cssClasses.has(c) && !unstyledOk.has(c));
console.log(`dom classes: ${domClasses.size}, styled by css: ${cssClasses.size}`);
console.log(unstyled.length ? `CLASSES WITH NO CSS RULE: ${unstyled.join(", ")}` : "every dom class has a css rule");

// The wizard's step panes are addressed by index, so a pane count that drifts
// from WIZ_LAST silently strands the last step: the button says "Далее" and
// nothing happens.
const wizGaps = [];
const wizLast = Number((js.match(/const WIZ_LAST\s*=\s*(\d+)/) || [])[1]);
if (!Number.isInteger(wizLast)) wizGaps.push("WIZ_LAST is not defined");
else {
  const panes = [...html.matchAll(/id="wizPane(\d+)"/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  const steps = [...html.matchAll(/data-step="(\d+)"/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  const want = Array.from({ length: wizLast + 1 }, (_, i) => i);
  if (panes.join(",") !== want.join(",")) wizGaps.push(`wizPane ids are ${panes.join(",")}, expected ${want.join(",")}`);
  if (steps.join(",") !== want.join(",")) wizGaps.push(`step indicators are ${steps.join(",")}, expected ${want.join(",")}`);
}
// The wizard must not write behind the diff: it has to go through preview().
const finish = js.slice(js.indexOf("function finishWizard"), js.indexOf("async function diagnose"));
if (finish && !/\bpreview\(\)/.test(finish)) wizGaps.push("finishWizard does not route through preview() — it would write unreviewed");
if (/finishWizard[\s\S]{0,600}?"\/api\/apply"/.test(js)) wizGaps.push("finishWizard calls /api/apply directly, bypassing the diff");
console.log(wizGaps.length ? `WIZARD WIRING GAPS: ${wizGaps.join("; ")}` : `wizard has ${wizLast + 1} consistent steps and previews before writing`);

// The client duplicates detectFormatFromURL so the picker can update without a
// round trip. Two copies of one rule drift; assert they agree.
const presetsJs = readFileSync("src/presets.mjs", "utf8");
const rulesOf = (src) => {
  const body = src.slice(src.indexOf("function detectFormatFromURL"));
  return [...body.slice(0, body.indexOf("\n}")).matchAll(/return "([a-z-]*)"/g)].map((m) => m[1]).join("|");
};
const serverRule = rulesOf(presetsJs);
const clientRule = rulesOf(js);
const ruleGap = serverRule && serverRule === clientRule
  ? "" : `detectFormatFromURL differs: server "${serverRule}" vs client "${clientRule}"`;
console.log(ruleGap ? `FORMAT DETECTION DRIFT: ${ruleGap}` : "format detection matches src/presets.mjs");

// Presets are the wizard's whole reason to exist; if the UI ignores the field
// the server sends, the grid silently renders empty.
const presetGaps = [];
if (!/state\.presets\s*=\s*asArray\(d\.presets\)/.test(js)) presetGaps.push("app.js never reads d.presets from /api/state");
if (!/presets:\s*PRESETS/.test(serverJs)) presetGaps.push("server does not send presets in /api/state");
if (!/freeTierNote\(p\)/.test(js)) presetGaps.push("the preset card never renders the free-tier note");
if (!/function freeTierNote/.test(js)) presetGaps.push("freeTierNote is missing");
// The URL line is reference detail. Showing the shared "https://" prefix cost
// 8 characters on every card and pushed the identifying part out of view.
{
  const sStart = js.indexOf("function shortURL");
  if (sStart < 0) presetGaps.push("no shortURL — preset cards waste the line on a shared https:// prefix");
  else {
    const short = new Function(`${js.slice(sStart, js.indexOf("\n}", sStart) + 2)}; return shortURL;`)();
    if (short("https://api.openai.com/v1") !== "api.openai.com/v1") presetGaps.push("shortURL does not strip https://");
    // http:// stays: for a local endpoint the scheme is the surprising part.
    if (short("http://localhost:11434/v1") !== "http://localhost:11434/v1") presetGaps.push("shortURL hides that a local preset is plain http");
    if (short("") !== "" || short(null) !== "") presetGaps.push("shortURL breaks on a missing URL");
  }
  if (!/class="purl" title="\$\{esc\(p\.baseURL\)\}"/.test(js)) presetGaps.push("the shortened URL has no tooltip with the full address");
  // A long URL must wrap, not be cut mid-word: only Google's is long enough to
  // matter, and "generativelanguage.goo…" identified nothing.
  const purl = (readFileSync("public/style.css", "utf8").match(/\.preset-card \.purl\s*{([^}]*)}/) || [])[1] || "";
  if (/white-space:\s*nowrap/.test(purl)) presetGaps.push("a long preset URL is truncated instead of wrapping");
}
console.log(presetGaps.length ? `PRESET WIRING GAPS: ${presetGaps.join("; ")}` : "presets travel from server to wizard");

// Free-tier claims rot. Cerebras removed its always-free tier and GitHub Models
// began answering 410 while both were still listed as free in third-party
// roundups, so an undated or unsourced claim here would quietly become a lie
// the tool tells with a straight face. Every claim must name where it came from
// and when it was checked, and hard numbers must not be invented.
const freeGaps = [];
{
  const P = await import("./src/presets.mjs");
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(P.FREE_TIER_CHECKED || "")) freeGaps.push("FREE_TIER_CHECKED is not a plain date");
  for (const p of P.PRESETS) {
    const f = p.freeTier;
    if (!f) continue;
    if (!f.summary) freeGaps.push(`${p.id}: freeTier without a summary`);
    if (!f.source || !/^https:\/\//.test(f.source)) freeGaps.push(`${p.id}: freeTier without an https source`);
    if (!dateRe.test(f.checked || "")) freeGaps.push(`${p.id}: freeTier without a check date`);
    if (!Array.isArray(f.limits) || !f.limits.length) freeGaps.push(`${p.id}: freeTier without limit notes`);
    // A specific allowance ("1500 запросов в сутки") is exactly the kind of
    // number that goes stale silently. If one is stated it has to be
    // attributable, so require the source to be the provider's own domain.
    const text = [f.summary, ...(f.limits || [])].join(" ");
    if (/\d[\d\s.,]*\s*(запрос|токен|млн|k\b|K\b|M\b)/.test(text)) {
      const host = (() => { try { return new URL(f.source).hostname; } catch { return ""; } })();
      const provider = String(p.baseURL || "");
      const bare = host.replace(/^(www|docs|console|api|inference-docs|cloud|build)\./, "");
      if (bare && !provider.includes(bare.split(".")[0])) {
        freeGaps.push(`${p.id}: states a number but the source is not the provider's own docs (${host})`);
      }
    }
  }
  // The dead ones must stay out: adding them back is the actual regression.
  for (const dead of ["github-models", "githubmodels"]) {
    if (P.PRESETS.some((p) => p.id === dead)) freeGaps.push(`${dead} is retired (HTTP 410) and must not be a preset`);
  }
  // Cerebras is present on purpose, to contradict the stale "free" claim.
  const cer = P.PRESETS.find((p) => p.id === "cerebras");
  if (cer && !/нет/i.test(cer.freeTier?.summary || "")) {
    freeGaps.push("cerebras must state plainly that there is no permanent free tier");
  }
}
console.log(freeGaps.length ? `FREE TIER CLAIM GAPS: ${freeGaps.join("; ")}` : "free-tier claims are dated and sourced");

// The replacement offered for a broken default model must be a provider that
// actually works. Ranking by reachability alone put a 401 provider first while
// two healthy ones sat below it, i.e. it proposed one broken default in place
// of another. This runs the real function rather than grepping for its shape,
// so a rewrite that keeps the wording and loses the ordering still fails.
const rankGaps = [];
{
  const start = js.indexOf("function rankDefaultCandidates");
  if (start < 0) rankGaps.push("rankDefaultCandidates is gone — the candidate ordering is unguarded");
  else {
    const src = js.slice(start, js.indexOf("\n}", start) + 2);
    const asArray = (v) => (Array.isArray(v) ? v : []);
    const rank = new Function("asArray", `${src}; return rankDefaultCandidates;`)(asArray);
    const providers = [
      { key: "dead", isDefault: true, reach: "down", models: ["m"] },
      { key: "baitestik", reach: "up", fault: "nokey", models: ["deepseek-v4-flash"] },
      { key: "gorouter", reach: "up", fault: "key", models: ["g1"] },
      { key: "soad", reach: "up", fault: null, models: ["s1"] },
      { key: "osnova", reach: "up", fault: null, models: ["o1"] },
      { key: "offline", reach: "down", models: ["x"] },
      { key: "packaged", reach: "unknown", models: ["p"] },
      { key: "nomodels", reach: "up", fault: null, models: [] },
    ];
    const r = rank(providers);
    const first = r.alive[0]?.key;
    if (first !== "soad") rankGaps.push(`the first offered replacement is "${first}", expected a healthy provider`);
    if (r.healthy.some((p) => p.fault)) rankGaps.push("a provider with an auth fault is counted as healthy");
    const names = r.alive.map((p) => p.key);
    if (names.indexOf("baitestik") < names.indexOf("osnova")) rankGaps.push("an auth-broken provider outranks a healthy one");
    if (!names.includes("baitestik") || !names.includes("gorouter")) rankGaps.push("auth-broken providers were dropped instead of demoted");
    if (names.includes("dead")) rankGaps.push("the broken default is offered as its own replacement");
    if (names.includes("offline")) rankGaps.push("an unreachable provider is offered");
    if (names.includes("nomodels")) rankGaps.push("a provider with no models is offered");
    if (names.includes("packaged")) rankGaps.push("an unprobed provider is offered as a known-good replacement");
    // All-broken is a real case and must still offer something, with a warning.
    const onlyBroken = rank([
      { key: "dead", isDefault: true, reach: "down", models: ["m"] },
      { key: "bad", reach: "up", fault: "key", models: ["b"] },
    ]);
    if (onlyBroken.healthy.length !== 0 || onlyBroken.alive.length !== 1) {
      rankGaps.push("with no healthy provider the fallback list is wrong");
    }
    if (!/Здоровых провайдеров нет/.test(js)) rankGaps.push("no warning is shown when every candidate has a key problem");
    if (!/ключ не принят/.test(js) || !/нет ключа/.test(js)) rankGaps.push("demoted candidates are not labelled with their fault");
  }
}
console.log(rankGaps.length ? `DEFAULT-MODEL CANDIDATE GAPS: ${rankGaps.join("; ")}` : "the offered default-model replacement prefers a working provider");

// The side column only works if the placeholder yields to real content. It is
// driven by the panels' own `hidden` flags, so assert the wiring exists and
// that every panel lives in the column rather than back in the main stack.
const layoutGaps = [];
{
  const css = readFileSync("public/style.css", "utf8");
  // An unterminated comment silently swallows the rule that follows it. That
  // happened here: the `.workspace` block was eaten, the grid fell back to
  // display:block and the side column dropped below the fold — while every
  // regex below still matched the text sitting inside the dead comment. So
  // check the file parses before checking what it says.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/\/\*/.test(stripped)) layoutGaps.push("an unterminated /* comment swallows the rules after it");
  if (stripped.split("{").length !== stripped.split("}").length) layoutGaps.push("unbalanced braces in style.css");
  // Prose that leaked out of a comment lands in selector position, where it
  // silently kills the rule that follows. It stays syntactically balanced, so
  // brace counting misses it — but a selector never contains a sentence period
  // and is never dozens of words long, while an English sentence is both.
  for (const chunk of stripped.split("}")) {
    if (!chunk.includes("{")) continue;
    const head = chunk.split("{")[0].trim();
    if (!head) continue;
    if (/\.\s/.test(head) || head.split(/\s+/).length > 20) {
      layoutGaps.push(`prose leaked into selector position (a comment is not closed) near: ${head.replace(/\s+/g, " ").slice(0, 50)}`);
      break;
    }
  }
  if (!/\.workspace\s*{[^}]*grid-template-columns/.test(stripped)) layoutGaps.push("no two-column workspace grid");
  // Without minmax(0,…) on the flexible side a long unbreakable path in the
  // results widens the track and pushes the layout sideways.
  const wsRule = (stripped.match(/\.workspace\s*{([^}]*)}/) || [])[1] || "";
  const cols = (wsRule.match(/grid-template-columns:\s*([^;]+)/) || [])[1] || "";
  if (!/minmax\(/.test(cols)) layoutGaps.push("workspace columns are not minmax()-bounded");
  // The side track needs a floor. Measured live: with `minmax(0, 1fr)` a 1264px
  // window handed it 88px, turning a two-line hint into a 195px-tall column one
  // word wide. A column too narrow for a sentence is worse than no column.
  const sideFloor = Number(((cols.match(/minmax\((\d+)px[^)]*\)\s*$/) || [])[1]) || 0);
  if (sideFloor < 260) layoutGaps.push(`the side column can shrink to ${sideFloor || 0}px — too narrow to read`);
  // And the collapse threshold must be at least as wide as the two tracks plus
  // the sidebar actually need, or the grid stays on at a width where it cannot
  // fit and the floor above just overflows instead.
  const bp = Number(((stripped.match(/@media \(max-width:\s*(\d+)px\)[\s\S]{0,200}?\.workspace\s*{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/) || [])[1]) || 0);
  if (!bp) layoutGaps.push("the two-column layout does not collapse on a narrow window");
  else {
    const mainFloor = Number(((cols.match(/minmax\((\d+)px/) || [])[1]) || 0);
    const need = 260 + 80 + mainFloor + 24 + sideFloor;   // sidebar + padding + tracks + gap
    if (bp < need) layoutGaps.push(`collapses at ${bp}px but the two columns need ${need}px`);
  }
  // A sticky column with no height bound hides the end of a long list.
  if (!/\.col-side\s*{[^}]*max-height/.test(css)) layoutGaps.push(".col-side is sticky but unbounded in height");
  // Slice from the opening tag to the *following* </aside>: the sidebar closes
  // earlier in the document, so a plain indexOf finds the wrong one and yields
  // an empty range that fails every check below for the wrong reason.
  const sideStart = html.indexOf('<aside class="col-side"');
  const side = sideStart < 0 ? "" : html.slice(sideStart, html.indexOf("</aside>", sideStart));
  if (sideStart < 0) layoutGaps.push("no .col-side column in the markup");
  for (const id of ["issues", "backups", "results", "sideEmpty", "btnDiag"]) {
    if (!side.includes(`id="${id}"`)) layoutGaps.push(`#${id} is not inside the side column`);
  }
  if (!/function syncSidePlaceholder/.test(js)) layoutGaps.push("no syncSidePlaceholder — the placeholder can outlive its results");
  // Every place that reveals a panel must re-sync, or the placeholder sits on
  // top of real output.
  const revealers = [...js.matchAll(/\$\("#(issues|results|backups)"\)[\s\S]{0,80}?hidden = false/g)].length +
    [...js.matchAll(/(resultsEl|el)\.hidden = false;\n\s*syncSidePlaceholder\(\)/g)].length;
  if (!revealers) layoutGaps.push("panels are revealed without syncing the placeholder");
}
console.log(layoutGaps.length ? `LAYOUT GAPS: ${layoutGaps.join("; ")}` : "the side column holds the result panels and the placeholder yields to them");

// Cost is the reason the free/paid work exists; if the UI drops it on the way
// into the config, the user picked a model on information the tool then threw
// away. Also guard the "unknown price must not look free" rule.
const costGaps = [];
{
  if (!/function priceTag/.test(js)) costGaps.push("no priceTag — model rows cannot show cost");
  if (/\$\{m\.free \? `<span class="tag">free<\/span>` : ""\}/.test(js)) {
    costGaps.push("a model list still renders the old bare free tag instead of priceTag()");
  }
  // Both lists (discovery and wizard) must show the price. They share one row
  // builder, so check that the builder prices the row and that both lists use it.
  if (!/function pickableModelRow[\s\S]{0,400}?\$\{priceTag\(m\)\}/.test(js)) {
    costGaps.push("the shared model row does not render a price");
  }
  const rowUses = [...js.matchAll(/pickableModelRow\(/g)].length;
  if (rowUses < 3) costGaps.push(`pickableModelRow is used ${rowUses - 1}x, expected both the discovery and wizard lists`);
  if (!/costInput: src\.costInput/.test(js)) costGaps.push("discovered pricing is not carried into the model entry");
  // The wizard and the discovery dialog pick from the same endpoint, so they
  // must build the entry the same way. When each had its own copy, the wizard's
  // dropped the price while still showing a cost column and a free-only filter.
  if (!/function modelFromDiscovered/.test(js)) {
    costGaps.push("no shared modelFromDiscovered — the wizard and discovery can drift apart");
  } else {
    const builders = [...js.matchAll(/modelFromDiscovered\(/g)].length;
    if (builders < 3) costGaps.push(`modelFromDiscovered is used ${builders - 1}x, expected both discovery and the wizard`);
    if (/state\.models = \[\.\.\.state\.wizSelected\][\s\S]{0,400}?contextWindow: src\.contextWindow/.test(js)) {
      costGaps.push("the wizard still builds its own model entry instead of the shared one");
    }
  }
  // Writing 0 for an unknown price would declare a billed model free.
  if (!/src\.costInput != null && src\.costOutput != null/.test(js)) {
    costGaps.push("cost is copied without checking it is known — an unknown price would be written as 0");
  }
  // Run the real builder: a rewrite that keeps the name and loses the price
  // would pass every check above.
  const bStart = js.indexOf("function modelFromDiscovered");
  if (bStart >= 0) {
    const src = js.slice(bStart, js.indexOf("\n}", bStart) + 2);
    const build = new Function(`${src}; return modelFromDiscovered;`)();
    const priced = build({ id: "m1", costInput: 2.5, costOutput: 10, costCacheRead: 0.25, costCacheWrite: 1 });
    if (priced.costInput !== 2.5 || priced.costOutput !== 10) costGaps.push("a known price is lost on the way into the config");
    if (priced.costCacheRead !== 0.25 || priced.costCacheWrite !== 1) costGaps.push("cache pricing is lost on the way into the config");
    const namedFree = build({ id: "deepseek-v4.1-flash:free", free: true, freeSource: "name" });
    if (namedFree.free !== true || namedFree.freeSource !== "name") costGaps.push("a name-based free hint is lost on the way into the form");
    const tierFree = build({ id: "m-free", free: true, freeSource: "tier", tier: "free" });
    if (tierFree.free !== true || tierFree.freeSource !== "tier" || tierFree.tier !== "free") costGaps.push("provider-declared free-tier metadata is lost on the way into the form");
    // Unknown must stay absent, not become 0 — 0 reads as "free" and would
    // under-report spend for a model that actually bills.
    const unpriced = build({ id: "m2" });
    for (const f of ["costInput", "costOutput", "costCacheRead", "costCacheWrite"]) {
      if (f in unpriced) costGaps.push(`an unknown ${f} is written as ${unpriced[f]} instead of being omitted`);
    }
    // A half-known price is not a price: writing one side alone would let
    // opencode compute a total from a number we never received.
    const half = build({ id: "m3", costInput: 3 });
    if ("costInput" in half || "costOutput" in half) costGaps.push("a half-known price is written as if complete");
    if (build({ id: "m4" }).toolUse !== true) costGaps.push("toolUse defaults to something other than true");
    if (build({ id: "m5", toolUse: false }).toolUse !== false) costGaps.push("an explicit toolUse:false is ignored");
  }
  if (!/state\.wizFreeOnly/.test(js)) costGaps.push("the wizard has no free-only filter");
  if (!/state\.wizFreeOnly = false/.test(js)) costGaps.push("the wizard's free-only filter is never reset between runs");
  for (const cls of ["free", "paid", "unknown"]) {
    if (!new RegExp(`\\.tag\\.${cls}\\s*{`).test(readFileSync("public/style.css", "utf8"))) {
      costGaps.push(`.tag.${cls} has no style`);
    }
  }
}
console.log(costGaps.length ? `COST DISPLAY GAPS: ${costGaps.join("; ")}` : "model rows show cost and carry it into the config");

// The batch report has to keep four verdicts apart. Measured live, collapsing
// them misleads: a model outside the plan, a gateway that refused once and
// served the next request, and a model that genuinely does not answer all need
// different actions from the user, and only the last is the user's problem.
const probeGaps = [];
{
  const mStart = js.indexOf("function probeMark");
  if (mStart < 0) probeGaps.push("no probeMark — probe results cannot be shown per model");
  else {
    const src = js.slice(mStart, js.indexOf("\n}", mStart) + 2);
    const mark = new Function(`const esc = (s) => s; ${src}; return probeMark;`)();
    const of = (p) => mark(p);
    if (of(null) !== "") probeGaps.push("an unchecked model is given a mark");
    const ok = of({ ok: true }), plan = of({ ok: false, fault: "plan" });
    const blocked = of({ ok: false, fault: "blocked" }), dead = of({ ok: false, fault: "model" });
    if (!/pmark ok/.test(ok)) probeGaps.push("a working model is not marked as working");
    if (blocked === dead) probeGaps.push("a temporary block looks identical to a dead model — the user would delete a working model");
    if (blocked === plan) probeGaps.push("a temporary block looks identical to a plan limit");
    if (/pmark bad/.test(blocked)) probeGaps.push("a temporary block is marked as a failure");
    if (!/попроб|ещё раз|врем/i.test(blocked)) probeGaps.push("the temporary-block mark does not tell the user to retry");
    for (const cls of ["ok", "bad", "plan", "wait"]) {
      if (!new RegExp(`\\.pmark\\.${cls}\\s*{`).test(readFileSync("public/style.css", "utf8"))) {
        probeGaps.push(`.pmark.${cls} has no style`);
      }
    }
  }
  // The summary line must count them apart too, or a run of transient refusals
  // reads as a wall of broken models.
  if (!/fault === "blocked"\).length/.test(js)) probeGaps.push("the batch summary does not count temporary blocks separately");
  if (!/x\.fault !== "plan" && x\.fault !== "blocked"/.test(js)) probeGaps.push("temporary blocks are counted as broken models");
  for (const [name, next] of [
    ["testAllModels", "testSingleModel"],
    ["testSingleModel", "poolKeys"],
    ["testDefaultModel", "testConnection"],
    ["testConnection", "validate"],
    ["openDiscover", "renderDiscoverList"],
  ]) {
    const start = js.indexOf(`function ${name}`);
    const body = start < 0 ? "" : js.slice(start, js.indexOf(`function ${next}`, start));
    const direct = /configPath: state\.configPath/.test(body) && /previousKey: state\.editingKey/.test(body);
    const captured = /captureProbeContext\(/.test(body)
      && /configPath: context\.configPath/.test(body) && /previousKey: context\.previousKey/.test(body);
    if (!direct && !captured) probeGaps.push(`${name} does not identify the selected config and exact provider key`);
  }
}
console.log(probeGaps.length ? `PROBE REPORT GAPS: ${probeGaps.join("; ")}` : "probe results keep working, unpaid, blocked and dead apart");

// The per-model probe button must not be swallowed by the delete handler, and
// the diagnostics report must never carry a credential into the clipboard.
const singleGaps = [];
{
  // The delete handler used to match "every .rm that is not .ed" — the day a
  // probe button with class .rm landed in the same row, every single-model
  // check would have deleted the model instead.
  if (/\.rm:not\(\.ed\)/.test(js)) {
    singleGaps.push('the delete handler still matches .rm:not(.ed) — it would catch the probe button');
  }
  if (!/\.rm\[data-i\]/.test(js)) singleGaps.push("no .rm[data-i] delete selector");
  if (!/data-test=/.test(js)) singleGaps.push("no per-model probe button in the model rows");
  if (!/function testSingleModel/.test(js)) singleGaps.push("no testSingleModel — the button would do nothing");
  if (!/"\/api\/testchat"[\s\S]{0,400}?modelId/.test(js)) {
    singleGaps.push("testSingleModel does not post a modelId to /api/testchat");
  }
  // The single check must report through the same marks as the bulk run, or
  // the two paths paint different pictures of the same model.
  const single = js.slice(js.indexOf("function testSingleModel"), js.indexOf("function plural"));
  if (!/state\.probeResults/.test(single)) singleGaps.push("a single-model check does not feed probeResults");
  if (!/renderModelList\(\)/.test(single)) singleGaps.push("a single-model check does not re-render the list");
}
console.log(singleGaps.length ? `SINGLE-MODEL PROBE GAPS: ${singleGaps.join("; ")}` : "each model row can probe itself without deleting itself");

// The report is built for pasting into chats and issues: one leaked key in a
// provider error text and the convenience becomes an incident. Run the real
// masking function rather than grepping for its shape.
const maskGaps = [];
{
  const start = js.indexOf("function maskSecretsForReport");
  if (start < 0) maskGaps.push("no maskSecretsForReport — the report goes out unmasked");
  else {
    const src = js.slice(start, js.indexOf("\n}", start) + 2);
    const mask = new Function(`${src}; return maskSecretsForReport;`)();
    const key = "sk-live-abcdef1234567890";
    if (mask(`key ${key} rest`).includes(key)) maskGaps.push("an sk-… key survives masking");
    if (!/sk-\*\*\*\*/.test(mask(`key ${key}`))) maskGaps.push("a masked key is not recognisable as masked");
    if (!mask("apiKey: {env:FOO}").includes("{env:FOO}")) {
      maskGaps.push("an {env:FOO} reference is masked — the report can no longer explain an env-missing fault");
    }
    if (/abc\.def-ghi/.test(mask("Authorization: Bearer abc.def-ghi"))) {
      maskGaps.push("a Bearer value survives masking");
    }
    if (mask("key AIzaSyD-1234567890abcdefg rest").includes("AIzaSyD-1234567890abcdefg")) {
      maskGaps.push("a Google key survives masking");
    }
    if (mask("key AKIAIOSFODNN7EXAMPLE rest").includes("AKIAIOSFODNN7EXAMPLE")) {
      maskGaps.push("an AWS key survives masking");
    }
    if (mask("token ghp_abcdef1234567890 rest").includes("ghp_abcdef1234567890")) {
      maskGaps.push("a GitHub token survives masking");
    }
    if (mask("nothing secret here") !== "nothing secret here") maskGaps.push("plain text is mangled");
    if (!/window\.maskSecretsForReport/.test(js)) maskGaps.push("the mask function is not exposed for testing");
  }
  if (!/function copyDiagReport/.test(js)) maskGaps.push("no copyDiagReport");
  else {
    const body = js.slice(js.indexOf("function copyDiagReport"), js.indexOf("function copyDiagReport") + 2000);
    if (!/state\.lastDiag/.test(body)) maskGaps.push("the report does not come from the last diagnostics run");
    if (!/maskSecretsForReport/.test(body)) maskGaps.push("the report is copied without masking");
  }
  if (!/id="diagCopyReport"/.test(js)) maskGaps.push("no copy-report button in the diagnostics panel");
}
console.log(maskGaps.length ? `REPORT MASK GAPS: ${maskGaps.join("; ")}` : "the diagnostics report is copyable and carries no secret");

// Undo and the external-edit watcher: the button must exist and be wired, the
// poll must compare hashes rather than rewrite anything on its own.
const undoGaps = [];
{
  if (!/id="btnUndo"/.test(html)) undoGaps.push("no #btnUndo in the markup");
  if (!/function doUndo/.test(js)) undoGaps.push("no doUndo — the button does nothing");
  if (!/syncUndoButton/.test(js)) undoGaps.push("nothing syncs the undo button state");
  if (!/"\/api\/undo"/.test(js)) undoGaps.push('the ui never calls "/api/undo"');
  if (!/pollExternalChanges/.test(js)) undoGaps.push("no external-change poll");
  if (!/setInterval\(pollExternalChanges/.test(js)) undoGaps.push("the poll is never scheduled");
  if (!/id="extChange"/.test(html)) undoGaps.push("no #extChange banner in the markup");
  // The poll must never write: its job is to compare hashes and warn.
  const poll = js.slice(js.indexOf("function pollExternalChanges"), js.indexOf("function isFormDirty"));
  if (/\/api\/(apply|autofix-apply|refresh-models|set-default-model|remove-provider|rename-provider|restore|undo)/.test(poll)) {
    undoGaps.push("the poll calls a mutating route — it must only read");
  }
  if (!/document\.hidden/.test(poll)) undoGaps.push("the poll runs in hidden tabs too");
}
console.log(undoGaps.length ? `UNDO/WATCHER GAPS: ${undoGaps.join("; ")}` : "undo and the external-edit watcher are wired");

// Deleting a provider must delete it for real: from the opencode config and
// from the list. A list-only delete left the provider alive in opencode,
// which is the exact confusion this check pins down.
const deleteGaps = [];
{
  if (/class="wipe"/.test(js)) deleteGaps.push("a split list-only/config-only delete still exists");
  if (!/function deleteEverywhere/.test(js)) deleteGaps.push("no deleteEverywhere - rows cannot fully delete");
  const start = js.indexOf("async function deleteEverywhere");
  const del = start < 0 ? "" : js.slice(start, start + 5000);
  if (!/preview-remove/.test(del)) deleteGaps.push("full delete skips the diff preview");
  if (!/remove-provider/.test(del)) deleteGaps.push("full delete never removes from the config");
  if (!/"\/api\/delete"/.test(del)) deleteGaps.push("store-only rows have no delete path");
  if (!/notFound/.test(del)) deleteGaps.push("the config/store split is not distinguished");

  // The regression that made deleting impossible: the row buttons contain an
  // <svg><use>, so e.target is the icon, not the button. Matching on
  // e.target.classList let the click fall through to open() and the provider
  // was "undeletable" while every static check stayed green.
  const renderAt = js.indexOf("function renderProviderList");
  const rows = renderAt < 0 ? "" : js.slice(renderAt, renderAt + 4500);
  if (!/e\.target\.closest\("\.del"\)/.test(rows)) {
    deleteGaps.push("the delete click does not use closest('.del') — clicking the icon opens the provider");
  }
  if (!/e\.target\.closest\("\.ren"\)/.test(rows)) {
    deleteGaps.push("the rename click does not use closest('.ren')");
  }
  if (/e\.target\.classList\.contains\("(?:del|ren)"\)/.test(js)) {
    deleteGaps.push("a row action still matches e.target.classList — an icon click would miss it");
  }
  if (!/data-key="\$\{esc\(key\)\}"/.test(rows)) deleteGaps.push("the row carries no exact config key");
  if (!/deleteEverywhere\(row\.dataset\.name, row\.dataset\.key\)/.test(rows)) {
    deleteGaps.push("deleteEverywhere does not receive the exact key");
  }
  if (!/renameInConfig\(row\.dataset\.name, row\.dataset\.key\)/.test(rows)) {
    deleteGaps.push("renameInConfig does not receive the exact key");
  }
  if (!/e\.target !== row/.test(rows)) deleteGaps.push("Enter/Space on a row button activates the row instead of the button");
  // The form must not keep a deleted provider loaded: the next Apply would
  // recreate it from stale fields without the user asking.
  if (!/state\.editingKey && gone\.has\(state\.editingKey\)\) resetForm\(\)/.test(del)
    && !/gone\.has\(state\.editingKey\)/.test(del)) {
    deleteGaps.push("the form is not reset after deleting the provider it shows");
  }
  const actionIconRule = (css.match(/\.provider-row \.ren \.ico[^{]*\{[^}]*\}/) || [""])[0];
  if (!/pointer-events:\s*none/.test(actionIconRule)) {
    deleteGaps.push("row action icons can swallow the click (no pointer-events:none)");
  }
}
console.log(deleteGaps.length ? `DELETE GAPS: ${deleteGaps.join("; ")}` : "delete removes the provider everywhere");

// The smart audit rides along inside /api/diagnostics: a score, cross-provider
// findings, and a one-click fix where the fix is unambiguous.
const smartGaps = [];
{
  if (!/r\.smart/.test(js)) smartGaps.push("the ui never reads the smart audit");
  if (!/data-smart-model/.test(js)) smartGaps.push("no one-click fix for the smart audit findings");
  const wireAt = js.indexOf('querySelectorAll("[data-smart-model]")');
  const wire = wireAt < 0 ? "" : js.slice(wireAt, wireAt + 2000);
  if (!/set-default-model/.test(wire) || !/refreshConfigState/.test(wire)) {
    smartGaps.push("the smart fix does not repoint the default model through the guarded write");
  }
}
console.log(smartGaps.length ? `SMART AUDIT GAPS: ${smartGaps.join("; ")}` : "the smart audit renders with its fix");

// Enrich backfill: the preview flag, the checkbox, and the server plumbing.
const enrichGaps = [];
{
  // The checkbox is rendered by diagnose() into the panel, not static markup.
  if (!/id="diagEnrich"/.test(js)) enrichGaps.push("no enrich checkbox in diagnostics");
  const body = js.slice(js.indexOf("async function doRefreshModels"), js.indexOf("async function doRefreshModels") + 1500);
  if (!/enrich/.test(body)) enrichGaps.push("the refresh preview ignores the enrich flag");
  if (!/body\.enrich/.test(serverJs)) enrichGaps.push("the server never reads the enrich flag");
  if (!/buildRefreshChanges\(plan, \{[^}]*enrich/.test(serverJs)) {
    enrichGaps.push("the server never applies enrichments on write");
  }
}
console.log(enrichGaps.length ? `ENRICH GAPS: ${enrichGaps.join("; ")}` : "enrich backfill is wired end to end");

// Frontend polish: the live key preview, the preset filter, dialog roles,
// and no leftover styles for removed controls.
const polishGaps = [];
{
  if (!/id="nameKeyHint"/.test(html)) polishGaps.push("no key preview under the name field");
  else {
    if (!/function renderKeyPreview/.test(js)) polishGaps.push("no renderKeyPreview");
    if (!/configKeys/.test(js)) polishGaps.push("the key preview has no config keys to compare against");
    if (!/уже есть в конфиге/.test(js)) polishGaps.push("the key preview never warns about a taken key");
  }
  if (!/id="presetSearch"/.test(html)) polishGaps.push("no preset filter in the wizard");
  else if (!/state\.presetSearch/.test(js)) polishGaps.push("the preset filter is not wired");
  const dialogs = (html.match(/role="dialog"/g) || []).length;
  if (dialogs < 4) polishGaps.push(`only ${dialogs}/4 modals expose role=dialog`);
  const css = readFileSync("public/style.css", "utf8");
  if (/\.wipe/.test(css)) polishGaps.push("dead .wipe styles for a removed button");
  if (!/@media \(max-width:\s*\d+px\)[\s\S]{0,200}?\.workspace\s*{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(css)) {
    polishGaps.push("no narrow-window stacking");
  }
  if (!/model-row:focus-within \.rm/.test(css)) polishGaps.push("model actions stay invisible to keyboard users");
}
console.log(polishGaps.length ? `POLISH GAPS: ${polishGaps.join("; ")}` : "key preview, preset filter, dialogs and small screens are covered");

// Execute the shipped functions, with only browser/network boundaries stubbed.
function appFunctionSource(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(js);
  if (!match) throw new Error(`Missing app function: ${name}`);
  const end = js.indexOf("\n}", match.index);
  if (end < 0) throw new Error(`Unclosed app function: ${name}`);
  return js.slice(match.index, end + 2);
}

function appFunctions(names, dependencies) {
  return new Function(...Object.keys(dependencies),
    `${names.map(appFunctionSource).join("\n")}\nreturn {${names.join(",")}};`)(...Object.values(dependencies));
}

const routeGaps = [];
{
  const check = (ok, message) => { if (!ok) routeGaps.push(message); };
  try {
    const now = Date.UTC(2026, 10, 10, 12);
    class Clock extends Date { static now() { return now; } }
    const fresh = (ok, fault = null, age = 1000) => ({ ok, fault, reach: "up", transient: false,
      checkedAt: now - age, expiresAt: now + 300000 });
    const state = { providers: [], health: {}, modelHealth: {}, healthWarning: "", currentModel: "unchanged/model" };
    const panel = { hidden: true, innerHTML: "" };
    const f = appFunctions(["asArray", "esc", "fmtNum", "money", "isFreshModelHealth", "healthCheckedTime",
      "modelCost", "modelFaultLabel", "routeHealth", "routeCandidates", "routeQuality", "routeScore",
      "routeWhy", "routeState", "routeRank", "pickRoute", "renderRoutes", "priceTag"], {
      state, Date: Clock, $: (id) => id === "#routesPanel" ? panel : null,
      slugifyName: (s) => String(s).toLowerCase(), icon: () => "", syncSidePlaceholder: () => {},
    });
    const weak = { id: "working", inputTypes: ["text", "image"], toolUse: false, contextWindow: 1000, costInput: 40, costOutput: 80 };
    const strong = { id: "unchecked", inputTypes: ["text", "image"], toolUse: true, reasoning: true,
      contextWindow: 2000000, costInput: 0, costOutput: 0 };
    const provider = (models) => ({ key: "exact_key", name: "Different label", models });
    state.providers = [provider([strong, weak])];
    state.modelHealth = { "exact_key/working": fresh(true) };
    for (const kind of ["code", "fast", "vision"]) {
      check(f.pickRoute(kind, new Set())?.id === "working", `${kind}: unchecked metadata outranks a verified completion`);
    }
    const sibling = f.routeCandidates().find((c) => c.id === "unchecked");
    check(!sibling.health.verified && f.routeState(sibling).cls === "unknown", "completion health bleeds onto a sibling model");
    state.providers.push({ key: "other", name: "Different label", models: [weak] });
    check(!f.routeCandidates().find((c) => c.key === "other").health.verified, "completion health is matched by display name, not exact key");

    for (const fault of ["quota", "plan", "region", "blocked", "model", "auth", "endpoint", "key", "nokey", "network", null]) {
      state.providers = [provider([{ ...strong, id: "failed" }, { ...weak, id: "unchecked" }])];
      state.modelHealth = { "exact_key/failed": fresh(false, fault) };
      // Even a newer successful /models call cannot erase a refused completion.
      state.health = { exact_key: { reach: "up", ok: true, fault: null, checkedAt: now - 500 } };
      for (const kind of ["code", "fast", "vision"]) {
        check(f.pickRoute(kind, new Set())?.id === "unchecked", `${fault}/${kind}: failed completion outranks unchecked`);
      }
      const failed = f.routeCandidates().find((c) => c.id === "failed");
      check(f.routeRank(failed) === 0 && f.routeState(failed).cls !== "ok", `${fault}: reach=up is treated as a working model`);
      const fallback = f.pickRoute("code", new Set(["exact_key/unchecked"]));
      check(fallback?.id === "failed" && /крайний вариант/.test(f.routeState(fallback).text), `${fault}: no labelled last-resort fallback`);
    }

    state.providers = [provider([{ ...weak, id: "stale" }, { ...weak, id: "unknown" }])];
    state.health = {};
    for (const ok of [true, false]) {
      state.modelHealth = { "exact_key/stale": { ...fresh(ok, ok ? null : "plan"), checkedAt: now - 7200000, expiresAt: now - 1 } };
      const [stale, unknown] = f.routeCandidates();
      check(f.routeRank(stale) === f.routeRank(unknown) && f.routeScore(stale, "code") === f.routeScore(unknown, "code"),
        `expired ${ok ? "success" : "failure"} changes ranking`);
      check(f.routeState(stale).text === "проверка устарела" && !!f.routeState(stale).title, "stale completion lacks its label/check-time tooltip");
    }
    state.modelHealth = {};
    state.health = { exact_key: { reach: "up", ok: true, fault: null, checkedAt: now - 500 } };
    const connected = f.routeCandidates()[0];
    check(f.routeRank(connected) === 1 && f.routeState(connected).cls === "unknown"
      && f.routeState(connected).text === "сервер доступен", "/models 200 is incorrectly proof that a model works");

    state.providers = [provider([weak, strong])];
    state.modelHealth = { "exact_key/working": fresh(true) };
    state.health = { exact_key: { reach: "down", fault: "endpoint", checkedAt: now - 2000 } };
    check(f.routeCandidates()[0].health.verified, "older diagnostics override a newer completion");
    state.health.exact_key.checkedAt = now - 500;
    check(f.routeCandidates()[0].bad && !f.routeCandidates()[0].health.verified, "new broken endpoint cannot demote an older successful completion");
    state.health.exact_key.checkedAt = now - 7200000;
    check(f.routeCandidates()[0].health.verified, "expired diagnostics demote a fresh completion");
    state.providers = [provider([{ ...weak, inputTypes: ["text"] }])];
    check(f.pickRoute("vision", new Set()) === null, "verification bypasses vision capability filtering");

    const unknownPrices = [{}, { costInput: "", costOutput: "" }, { costInput: " ", costOutput: 0 },
      { costInput: 0 }, { costOutput: 0 }, { costInput: NaN, costOutput: 0 }, { costInput: Infinity, costOutput: 0 },
      { costInput: "Infinity", costOutput: 0 }, { costInput: -1, costOutput: 1 }, { costInput: false, costOutput: false },
      { costInput: Number.MAX_VALUE, costOutput: Number.MAX_VALUE }];
    for (const m of unknownPrices) {
      check(f.modelCost(m) === null && /цена \?/.test(f.priceTag(m)), `unknown/nonfinite/half price is not unknown: ${JSON.stringify(m)}`);
    }
    for (const m of [{ costInput: 0, costOutput: 0 }, { costInput: "0", costOutput: "0" }, { free: true, freeSource: "tier", tier: "free" }]) {
      check(f.modelCost(m) === 0 && />free</.test(f.priceTag(m)), "declared zero price/free tier is not supported");
    }
    const hint = { id: "vendor/model:free", free: true, freeSource: "name" };
    check(f.modelCost(hint) === null && /free\?/.test(f.priceTag(hint)), "name-only free hint is declared free");
    state.providers = [provider([hint])];
    const hintWhy = f.routeWhy(f.routeCandidates()[0], "code");
    check(/free\?/.test(hintWhy) && !/бесплатная/.test(hintWhy), "route claims name-only free as confirmed free");
    check(f.modelCost({ ...hint, costInput: 2, costOutput: 3 }) === 5, "a free-name hint overrides actual billed prices");

    // Four verified candidates are weaker than the remaining unchecked/failed
    // ones. All four cards, including reserve, must use the same ordering.
    state.providers = [provider([0, 1, 2, 3].map((i) => ({ ...weak, id: `good${i}` })).concat(strong, { ...strong, id: "bad" }))];
    state.health = {};
    state.modelHealth = Object.fromEntries([0, 1, 2, 3].map((i) => [`exact_key/good${i}`, fresh(true)]));
    state.modelHealth["exact_key/bad"] = fresh(false, "quota");
    state.healthWarning = "history <read-only>";
    const before = JSON.stringify(state.providers);
    f.renderRoutes();
    check(state.routes.length === 4 && state.routes.every((r) => r.c.health.verified), "reserve bypasses evidence ranking");
    check(state.routes[3]?.kind === "Резерв", "reserve card is missing");
    check(/1 ч/.test(panel.innerHTML) && /5 мин/.test(panel.innerHTML) && /7 дней/.test(panel.innerHTML), "route note does not explain freshness/history limits");
    check(panel.innerHTML.includes("history &lt;read-only&gt;"), "healthWarning is hidden or not HTML-escaped");
    check(JSON.stringify(state.providers) === before && state.currentModel === "unchanged/model", "rendering routes mutates the live model/config");
  } catch (e) { routeGaps.push(e.stack || String(e)); }
}
console.log(routeGaps.length ? `ROUTE HEALTH GAPS: ${routeGaps.join("; ")}` : "routes rank exact-model completions, expiry, connectivity and honest prices consistently");

const healthAsyncGaps = [];
{
  const check = (ok, message) => { if (!ok) healthAsyncGaps.push(message); };
  const now = Date.now();
  const record = (ok) => ({ ok, reach: "up", fault: ok ? null : "plan", transient: false, checkedAt: now, expiresAt: now + 3600000 });
  function harness() {
    const state = { configPath: "config-A", configHash: "hash-A", configEpoch: 0, formProbeEpoch: 0,
      editingKey: "", models: [], health: {}, modelHealth: {}, probeResults: {}, formHeaders: {},
      providers: [
        { key: "alpha_key", name: "Alpha", baseURL: "https://alpha.test/v1", apiFormat: "openai-chat", useEnvVar: true, envVarName: "ALPHA_KEY", models: [{ id: "vendor/shared" }, { id: "stale" }] },
        { key: "beta_key", name: "Beta", baseURL: "https://beta.test/v1", apiFormat: "openai-chat", useEnvVar: true, envVarName: "BETA_KEY", models: [{ id: "vendor/shared" }] },
      ],
    };
    const nodes = new Map(), calls = [], toasts = [];
    let routeRenders = 0;
    const $ = (id) => {
      if (!nodes.has(id)) nodes.set(id, { value: "", checked: false, hidden: true, dataset: {}, innerHTML: "", textContent: "" });
      return nodes.get(id);
    };
    const api = (path, options) => new Promise((resolve) => calls.push({ path, body: options?.body ? JSON.parse(options.body) : null, resolve }));
    const noop = () => {};
    const f = appFunctions(["asArray", "esc", "plural", "mergeProviderLists", "suggestEnvName", "collectProvider", "configIdentity", "isCurrentConfig", "selectConfig",
      "isFreshModelHealth", "healthCheckedTime", "adoptModelHealth", "invalidateProbeResults", "probeConnection", "captureProbeContext", "isCurrentProbe",
      "completionVerdict", "updateProbeVerdict", "hydrateProbeResults", "probeMark", "probeNote", "modelFaultLabel", "loadProviderIntoForm", "testSingleModel", "testAllModels", "testDefaultModel",
      "refreshConfigState", "refreshProviders"], {
      state, $, api, apiSafe: api, slugifyName: (s) => String(s || "").toLowerCase(),
      renderRoutes: () => { routeRenders++; }, renderProviderList: noop, renderModelList: noop,
      scheduleHealthRefresh: noop, setBtnLoading: (b, on) => { b.disabled = on; },
      toast: (...args) => toasts.push(args), confirm: () => true, setInterval: () => 1, clearInterval: noop,
      stashPoolDraft: noop, clearPoolBox: noop, restorePoolDraft: noop, updateFormatNote: noop,
      setEnvMode: (on) => { $("#f-env").checked = on; }, setKeyFieldState: noop, renderKeyHint: noop,
      syncAdvancedDisclosure: noop, formSnapshot: () => "snapshot", renderKeyPreview: noop,
      updateConfigChip: noop, syncUndoButton: noop,
    });
    f.loadProviderIntoForm("Alpha");
    return { state, $, calls, toasts, f, renders: () => routeRenders };
  }
  try {
    const h = harness();
    h.state.modelHealth = { "alpha_key/vendor/shared": record(true), "beta_key/vendor/shared": record(false),
      "alpha_key/stale": { ...record(true), checkedAt: now - 7200000, expiresAt: now - 1 } };
    h.f.loadProviderIntoForm("Alpha");
    check(h.state.probeResults["vendor/shared"]?.ok && !h.state.probeResults.stale, "configured form does not hydrate only fresh model evidence");
    check(h.f.probeMark(h.state.modelHealth["alpha_key/stale"]) === ""
      && /проверка устарела/.test(h.f.probeNote(h.state.modelHealth["alpha_key/stale"])), "expired rows can retain a green mark");
    const btn = {};
    const pending = h.f.testSingleModel(0, btn);
    check(h.calls[0].body.configPath === "config-A" && h.calls[0].body.previousKey === "alpha_key"
      && h.calls[0].body.modelId === "vendor/shared", "single probe does not capture exact config/key/model identity");
    h.f.loadProviderIntoForm("Beta");
    h.calls[0].resolve({ ok: true, result: { ok: true }, modelHealth: { "alpha_key/vendor/shared": record(true) } });
    await pending;
    check(h.state.probeResults["vendor/shared"]?.ok === false, "old response paints another provider's same-id row");
    check(h.state.modelHealth["alpha_key/vendor/shared"]?.ok && h.renders() > 0, "form switching discards same-config route evidence");
    check(btn.disabled === false, "probe button remains loading after a discarded response");

    for (const id of ["#f-baseurl", "#f-apikey", "#f-envname", "#f-env", "#f-format"]) {
      const h = harness();
      const pending = h.f.testSingleModel(0);
      if (id === "#f-env") h.$(id).checked = !h.$(id).checked;
      else h.$(id).value += "-edited";
      // The identity guard must work even before an input listener has run.
      h.calls[0].resolve({ ok: true, result: { ok: true }, modelHealth: { "alpha_key/vendor/shared": record(true) } });
      await pending;
      check(!h.state.probeResults["vendor/shared"], `${id}: old completion marks an edited connection`);
      check(h.state.modelHealth["alpha_key/vendor/shared"]?.ok, `${id}: unsaved form edit discards valid configured route health`);
    }
    {
      const h = harness();
      const pending = h.f.testSingleModel(0);
      h.f.invalidateProbeResults(); // Edit and undo back to identical field values.
      h.calls[0].resolve({ ok: true, result: { ok: true }, modelHealth: {} });
      await pending;
      check(!h.state.probeResults["vendor/shared"], "edit-then-undo accepts an old in-flight row verdict");
    }
    for (const change of ["replace-row", "change-id"]) {
      const h = harness();
      const pending = h.f.testSingleModel(0);
      if (change === "replace-row") h.state.models[0] = { id: "vendor/shared" };
      else h.state.models[0].id = "other-model";
      h.calls[0].resolve({ ok: true, result: { ok: true }, modelHealth: {} });
      await pending;
      check(!Object.keys(h.state.probeResults).length, `${change}: old response marks a different/re-added model`);
    }
    for (const back of [false, true]) {
      const h = harness();
      const pending = h.f.testSingleModel(0);
      h.f.selectConfig("config-B");
      if (back) h.f.selectConfig("config-A");
      h.calls[0].resolve({ ok: true, result: { ok: true }, modelHealth: { "alpha_key/vendor/shared": record(true) }, healthWarning: "old warning" });
      await pending;
      check(!Object.keys(h.state.modelHealth).length && !Object.keys(h.state.probeResults).length && !h.state.healthWarning,
        `config switch${back ? " and back" : ""}: old response leaks health/warnings/row marks`);
    }
    {
      const h = harness();
      const pending = h.f.testAllModels();
      check(h.calls[0].body.configPath === "config-A" && h.calls[0].body.previousKey === "alpha_key", "batch probe loses config/key identity");
      h.f.loadProviderIntoForm("Beta");
      h.calls[0].resolve({ ok: true, result: { results: [{ id: "vendor/shared", ok: true }] }, modelHealth: { "alpha_key/vendor/shared": record(true) } });
      await pending;
      check(!Object.keys(h.state.probeResults).length && h.$("#batchStatus").hidden, "old batch response replaces another form's rows/status");
      check(h.state.modelHealth["alpha_key/vendor/shared"]?.ok, "batch does not refresh same-config routes independently of the form");
    }
    {
      const h = harness();
      const pending = h.f.testAllModels();
      h.calls[0].resolve({ ok: true, result: { tested: 2, passed: 1, results: [{ id: "vendor/shared", ok: true }, { id: "stale", ok: false, fault: "quota" }] },
        modelHealth: { "alpha_key/vendor/shared": record(true) }, healthWarning: "history unavailable" });
      await pending;
      check(h.state.probeResults["vendor/shared"]?.ok && h.state.probeResults.stale?.ok === false, "batch persistence warning replaces actual probe verdicts");
      check(h.state.probeResults.stale.expiresAt - h.state.probeResults.stale.checkedAt === 300000, "quota row does not expire in five minutes");
      check(h.state.probeResults["vendor/shared"].expiresAt - h.state.probeResults["vendor/shared"].checkedAt === 3600000, "successful row does not expire in one hour");
    }
    {
      const h = harness();
      const pending = h.f.testSingleModel(0);
      h.calls[0].resolve({ ok: true, result: { ok: true, message: "completed" }, modelHealth: {}, healthWarning: "read-only history" });
      await pending;
      check(h.state.probeResults["vendor/shared"]?.ok && h.toasts.at(-1)?.[1] === "ok", "failed persistence replaces a successful live verdict");
      check(!Object.keys(h.state.modelHealth).length && h.state.healthWarning === "read-only history", "client invents persistence for an excluded/unconfigured model");
    }
    {
      const h = harness();
      const older = h.f.testSingleModel(0);
      const newer = h.f.testAllModels();
      h.calls[1].resolve({ ok: true, result: { results: [{ id: "vendor/shared", ok: false, fault: "key", startedAt: now + 1, startedOrder: 2, checkedAt: now + 2, expiresAt: now + 3600002 }] } });
      await newer;
      h.calls[0].resolve({ ok: true, result: { ok: true, startedAt: now, startedOrder: 1, checkedAt: now + 3, expiresAt: now + 3600003 } });
      await older;
      check(h.state.probeResults["vendor/shared"]?.fault === "key", "a late single success overwrites a newer batch failure in the row");
      h.f.updateProbeVerdict(h.f.completionVerdict({ id: "vendor/shared", ok: true, startedAt: now + 1, startedOrder: 1 }));
      check(h.state.probeResults["vendor/shared"]?.fault === "key", "same-millisecond probe ordering is not respected");
      const timed = h.f.completionVerdict({ ok: false, transient: true, checkedAt: now - 60000, expiresAt: now + 240000 });
      check(timed.checkedAt === now - 60000 && timed.expiresAt === now + 240000, "receiving a delayed response extends its validity");
    }
    {
      const h = harness();
      h.f.loadProviderIntoForm("Beta");
      const pending = h.f.testDefaultModel("alpha_key/vendor/shared", {});
      check(h.calls[0].body.provider.name === "Alpha" && h.calls[0].body.previousKey === "alpha_key"
        && h.calls[0].body.configPath === "config-A" && h.calls[0].body.modelId === "vendor/shared", "old apply card tests the currently selected provider instead of its own");
      h.calls[0].resolve({ ok: true, result: { ok: true }, modelHealth: { "alpha_key/vendor/shared": record(true) } });
      await pending;
      check(!Object.keys(h.state.probeResults).length && h.state.modelHealth["alpha_key/vendor/shared"]?.ok, "default-model response bleeds row marks or loses route evidence");
    }
    for (const method of ["refreshConfigState", "refreshProviders"]) {
      const h = harness();
      const pending = h.f[method]();
      check(h.calls[0].path.includes("configPath=config-A"), `${method}: read is not scoped`);
      h.f.selectConfig("config-B");
      h.calls[0].resolve({ providers: [{ key: "old", name: "old" }], modelHealth: { "alpha_key/vendor/shared": record(true) }, opencode: { hash: "old-hash", providers: [] } });
      await pending;
      check(!h.state.providers.length && !Object.keys(h.state.modelHealth).length, `${method}: an old config response overwrites the selected config`);
      const next = h.f[method]();
      h.calls[1].resolve({ providers: [{ key: "new", name: "new" }], modelHealth: { "new/m": record(true) }, opencode: { hash: "new-hash", providers: [] } });
      await next;
      check(h.state.providers[0]?.key === "new" && h.state.modelHealth["new/m"]?.ok, `${method}: does not hydrate selected-config model history`);
    }
    {
      const h = harness();
      const context = h.f.configIdentity();
      const latest = { ...record(false), checkedAt: now + 1000 };
      h.state.modelHealth = { "alpha_key/vendor/shared": latest, "removed/m": record(true) };
      h.f.adoptModelHealth({ modelHealth: { "alpha_key/vendor/shared": record(true) } }, context, true);
      check(h.state.modelHealth["alpha_key/vendor/shared"].ok === false && !h.state.modelHealth["removed/m"], "state refresh resurrects older evidence or ignores server-side filtering");
    }
    check(/adoptModelHealth\(d, initialContext/.test(appFunctionSource("init")), "initial state does not hydrate model history");
    for (const name of ["testConnection", "openDiscover"]) {
      check(!/adoptModelHealth|completionVerdict|state\.modelHealth/.test(appFunctionSource(name)), `${name} counts connectivity/discovery as completion`);
    }
    const init = appFunctionSource("init");
    check(/\["#f-name", "#f-baseurl", "#f-apikey", "#f-envname"\][\s\S]{0,100}invalidateProbeResults/.test(init)
      && /\["#f-env", "#f-format"\][\s\S]{0,100}invalidateProbeResults/.test(init), "connection fields do not invalidate row verdicts on input/change");
    check(/checkedAt: context\.startedAt/.test(appFunctionSource("diagnose")) && /isCurrentConfig\(context\)/.test(appFunctionSource("diagnose")), "diagnostics lack timestamp/config guards");
  } catch (e) { healthAsyncGaps.push(e.stack || String(e)); }
}
console.log(healthAsyncGaps.length ? `ASYNC HEALTH GAPS: ${healthAsyncGaps.join("; ")}` : "history hydration and live probe responses respect form/model/config identities");

const failed = missingIds.length + missingClasses.length + badClick.length + leaks.length +
  unreachable.length + phantom.length + guards.length + lies.length +
  typeGaps.length + fieldGaps.length + unstyled.length + wizGaps.length +
  (ruleGap ? 1 : 0) + presetGaps.length + rankGaps.length + layoutGaps.length + costGaps.length +
  freeGaps.length + probeGaps.length + singleGaps.length + maskGaps.length + undoGaps.length + deleteGaps.length +
  smartGaps.length + polishGaps.length + enrichGaps.length + routeGaps.length + healthAsyncGaps.length;
console.log(`\n${failed ? "FAIL" : "OK"} — ${failed} issue(s)`);
if (failed) process.exitCode = 1;
