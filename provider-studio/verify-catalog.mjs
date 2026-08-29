/**
 * Tests for the models.dev reference.
 *
 * The module's whole value is knowing when *not* to answer, so most of this
 * file drives disagreement rather than agreement.
 */
import * as C from "./src/catalog.mjs";

let passed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failures.push(`${name}${detail ? " <- " + detail : ""}`); console.log(`FAIL  ${name}${detail ? "  <- " + detail : ""}`); }
}
const eq = (name, got, want) => check(name, Object.is(got, want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ---------------------------------------------------------------- agreement
eq("identical numbers agree", C.agree([100, 100]), true);
eq("a 1M window written two ways agrees", C.agree([1000000, 1048576]), true);
eq("an 8x spread does not agree", C.agree([131072, 1050000]), false);
eq("a 2x spread does not agree", C.agree([64000, 128000]), false);
// Zero is the dangerous value: "free" must never be averaged with a real price.
eq("zero and a price never agree", C.agree([0, 5]), false);
eq("zero agrees only with zero", C.agree([0, 0]), true);
eq("a single value is agreement", C.agree([42]), true);
eq("nothing to compare is not agreement", C.agree([]), false);

// The consensus pick is the minimum, not an average nobody publishes.
eq("consensus takes the conservative value", C.consensusNumber([1000000, 1048576]), 1000000);
eq("conflicting numbers yield nothing", C.consensusNumber([128000, 1048576]), null);
eq("consensus ignores zeros and blanks", C.consensusNumber([0, null, undefined, 200000]), 200000);

eq("unanimous true", C.consensusBool([true, true]), true);
eq("unanimous false", C.consensusBool([false, false]), false);
// A disputed flag is the attachment case: 441 all-true vs 421 all-false vs 212
// disputed. Guessing "true" would break uploads on gateways that lack vision.
eq("a disputed flag yields nothing", C.consensusBool([true, false]), null);
eq("non-booleans are ignored", C.consensusBool([null, undefined]), null);

eq("modality order is not a disagreement",
  JSON.stringify(C.consensusList([["text", "image"], ["image", "text"]])), JSON.stringify(["image", "text"]));
eq("different modalities yield nothing", C.consensusList([["text"], ["text", "image"]]), null);

// ------------------------------------------------------------------ lookups
const fakeDb = {
  alpha: {
    name: "Alpha", npm: "@x/a", api: "https://a/v1", env: ["ALPHA_KEY"],
    models: {
      "vendor/shared-model": { name: "Shared", limit: { context: 1000000, output: 64000 }, cost: { input: 1, output: 2 }, reasoning: true, tool_call: true, attachment: true, modalities: { input: ["text", "image"] } },
      "solo-model": { name: "Solo", limit: { context: 8192, output: 1024 }, cost: { input: 0, output: 0 }, reasoning: false, tool_call: true, attachment: false, modalities: { input: ["text"] } },
    },
  },
  beta: {
    name: "Beta", npm: "@x/b", models: {
      // Same id, and this is where gateways diverge in the real data: same
      // context, wildly different output cap, opposite attachment, free.
      "vendor/shared-model": { name: "Shared", limit: { context: 1048576, output: 1048576 }, cost: { input: 0, output: 0 }, reasoning: true, tool_call: false, attachment: false, modalities: { input: ["text", "image"] } },
    },
  },
};
const cat = await C.loadCatalog({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(fakeDb) }) });
check("the catalogue loads", cat.ok === true, JSON.stringify(cat.error));
eq("it indexes distinct model ids", cat.count, 2);
eq("it keeps provider records", cat.providers.get("alpha").env[0], "ALPHA_KEY");

eq("an exact id matches", C.lookupModel(cat, "vendor/shared-model").matchedBy, "exact");
eq("both providers are returned", C.lookupModel(cat, "vendor/shared-model").entries.length, 2);
// A gateway usually drops the vendor prefix, so "shared-model" must still find it.
eq("a bare name matches", C.lookupModel(cat, "shared-model").matchedBy, "name");
// ":free" marks a tier, not a different model.
eq("a :free suffix still matches", C.lookupModel(cat, "shared-model:free").matchedBy, "name");
eq("an unknown id matches nothing", C.lookupModel(cat, "no-such-model").matchedBy, null);

// ---------------------------------------------------------------- suggestions
const s = C.suggestSpecs(cat, "vendor/shared-model");
check("a known model is found", s.found === true && s.sources === 2, JSON.stringify(s.sources));
// Context agrees within rounding, so it is offered — conservatively.
eq("agreeing context is suggested", s.fields.contextWindow, 1000000);
// Output differs 16x, so nothing is offered and the conflict is reported.
eq("conflicting output is withheld", s.fields.maxOutput, undefined);
check("the output conflict is reported",
  s.conflicts.some((c) => c.field === "maxOutput" && c.max / c.min > 2), JSON.stringify(s.conflicts));
eq("a unanimous flag is suggested", s.fields.reasoning, true);
eq("a disputed flag is withheld", s.fields.toolUse, undefined);
eq("a disputed attachment is withheld", s.fields.attachment, undefined);
eq("agreeing modalities are suggested", JSON.stringify(s.fields.inputTypes), JSON.stringify(["image", "text"]));

// The rule the whole module exists to keep. One of these two says the model is
// free and the other charges $1 — exactly the case that must never be resolved.
check("no price is ever suggested",
  !("costInput" in s.fields) && !("costOutput" in s.fields) && !("cost" in s.fields),
  JSON.stringify(Object.keys(s.fields)));
const solo = C.suggestSpecs(cat, "solo-model");
check("no price is suggested even from a single unambiguous source",
  !("costInput" in solo.fields) && !("costOutput" in solo.fields),
  JSON.stringify(Object.keys(solo.fields)));
// A single source cannot disagree with itself, so its specs are usable.
eq("a lone source still yields specs", solo.fields.contextWindow, 8192);
eq("an unknown model yields nothing", C.suggestSpecs(cat, "nope").found, false);

// ------------------------------------------------------------------ enriching
{
  // The real case: a gateway that returns ids and nothing else.
  const bare = [{ id: "solo-model" }, { id: "vendor/shared-model" }, { id: "unknown-model" }];
  const r = C.enrichModels(cat, bare);
  eq("known models are matched", r.matched, 2);
  eq("blanks are filled", r.models[0].contextWindow, 8192);
  eq("the source is recorded", r.models[0].specSource, "catalog");
  check("the filled fields are named", (r.models[0].specFields || []).includes("contextWindow"),
    JSON.stringify(r.models[0].specFields));
  eq("an unknown model is passed through untouched", r.models[2].specSource, undefined);
  check("no price is written during enrichment",
    r.models.every((m) => m.costInput == null && m.costOutput == null),
    JSON.stringify(r.models.map((m) => m.costInput)));

  // What the provider itself said outranks the catalogue: it describes the
  // endpoint being configured, the catalogue describes other people's.
  const reported = [{ id: "solo-model", contextWindow: 4096, maxOutput: 512, inputTypes: ["text", "image"] }];
  const kept = C.enrichModels(cat, reported);
  eq("a provider-reported context is not overwritten", kept.models[0].contextWindow, 4096);
  eq("provider-reported modalities are not overwritten",
    JSON.stringify(kept.models[0].inputTypes), JSON.stringify(["text", "image"]));
  // A lone ["text"] is what our parser defaults to when nothing was said, so it
  // counts as blank and may be improved.
  const defaulted = C.enrichModels(cat, [{ id: "vendor/shared-model", inputTypes: ["text"] }]);
  eq("a defaulted text-only list is treated as blank",
    JSON.stringify(defaulted.models[0].inputTypes), JSON.stringify(["image", "text"]));
  // Provenance, not the value, decides what may be replaced. Our parser infers
  // `reasoning` from the model id when the provider says nothing; that guess
  // must not outrank the catalogue. Without this, "no 'thinking' in the name,
  // so reasoning: false" froze the field and enrichment did nothing.
  {
    const guessed = [{ id: "vendor/shared-model", reasoning: false, toolUse: true, declaredFields: [] }];
    const g = C.enrichModels(cat, guessed);
    eq("a guessed flag is replaced by the catalogue", g.models[0].reasoning, true);

    const stated = [{ id: "vendor/shared-model", reasoning: false, declaredFields: ["reasoning"] }];
    const st = C.enrichModels(cat, stated);
    eq("a provider-stated flag outranks the catalogue", st.models[0].reasoning, false);

    // A stated zero is still a statement: some endpoints really do report 0.
    const zero = [{ id: "solo-model", contextWindow: 0, declaredFields: ["contextWindow"] }];
    eq("a stated zero is not treated as blank", C.enrichModels(cat, zero).models[0].contextWindow, 0);

    // Entries with no provenance at all (hand-written, or from an older
    // payload) must still enrich sensibly rather than being skipped.
    const legacy = [{ id: "solo-model", contextWindow: 0 }];
    eq("an entry without provenance still gets filled",
      C.enrichModels(cat, legacy).models[0].contextWindow, 8192);
    const legacyStated = [{ id: "solo-model", contextWindow: 4096 }];
    eq("an entry without provenance keeps a real value",
      C.enrichModels(cat, legacyStated).models[0].contextWindow, 4096);
  }
  eq("nothing to enrich is not an error", C.enrichModels(cat, []).matched, 0);
  eq("a non-array is tolerated", C.enrichModels(cat, null).models.length, 0);
}

// -------------------------------------------------------------------- failure
{
  C.clearCatalogCache();
  const dead = await C.loadCatalog({ fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); } });
  check("an unreachable catalogue fails softly",
    dead.ok === false && /недоступен/.test(dead.error || ""), JSON.stringify(dead.error));
  eq("a failed load still exposes an empty index", dead.byId.size, 0);
  // Callers must be able to run the same code path with no catalogue.
  eq("suggestions against a failed load are empty", C.suggestSpecs(dead, "anything").found, false);

  C.clearCatalogCache();
  const http500 = await C.loadCatalog({ fetchImpl: async () => ({ ok: false, status: 503, text: async () => "" }) });
  check("an HTTP error is reported, not thrown", http500.ok === false && /503/.test(http500.error || ""), http500.error);

  C.clearCatalogCache();
  const garbage = await C.loadCatalog({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html>not json" }) });
  check("malformed JSON fails softly", garbage.ok === false, JSON.stringify(garbage.error));
}

// ---------------------------------------------------------------------- cache
{
  C.clearCatalogCache();
  let calls = 0;
  const counting = async () => { calls++; return { ok: true, status: 200, text: async () => JSON.stringify(fakeDb) }; };
  await C.loadCatalog({ fetchImpl: counting });
  await C.loadCatalog({ fetchImpl: counting });
  // 4.4 MB per lookup would be indefensible.
  eq("a second load is served from cache", calls, 1);
  C.clearCatalogCache();
  await C.loadCatalog({ fetchImpl: counting });
  eq("clearing the cache forces a refetch", calls, 2);
}

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length) {
  console.log("Failed:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
