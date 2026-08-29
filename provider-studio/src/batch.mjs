/**
 * Runs many live probes without getting the user rate-limited or banned.
 *
 * Testing models one at a time is unusable at 100+ models; firing them all at
 * once gets the key throttled and produces a screen of false "dead" verdicts
 * that are really just 429s. So: a small fixed number of workers, a pause
 * between requests, and — the part that matters — a rate limit is treated as a
 * signal about the *account*, not about the model. One 429 slows everything
 * down; a run of them stops the batch, because continuing would only convert
 * the remaining models into wrong answers.
 *
 * Kept free of HTTP and of rescue.mjs so the pacing rules can be tested with a
 * fake clock and a fake prober.
 */

export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_GAP_MS = 250;
// Consecutive rate limits after which continuing is pointless. Two is not
// enough (a single slow moment can produce two), and waiting for ten wastes a
// minute of the user's time to learn what three already said.
export const RATE_LIMIT_STREAK = 3;
// How much to slow down after each 429. Multiplicative, because a provider that
// is throttling wants substantially less traffic, not marginally less.
export const BACKOFF_FACTOR = 2;
export const MAX_GAP_MS = 8000;
// Retries for a probe that never reached the provider. One is enough: the
// observed failure rate was about half, so a second attempt takes the odds of a
// false "dead" verdict from ~50% to ~25%, and a third would double the time
// spent on a genuinely unreachable endpoint for much less gain.
export const RETRY_TRANSPORT = 1;
export const RETRY_DELAY_MS = 800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A 429, or a message that plainly says the same thing. */
export function isRateLimited(result) {
  if (!result || typeof result !== "object") return false;
  if (result.status === 429) return true;
  if (result.fault === "rate") return true;
  const m = String(result.message || "");
  return /\b429\b|rate.?limit|too many requests|слишком часто|превышен лимит/i.test(m);
}

/**
 * A failure that never reached the provider, so it says nothing at all.
 *
 * Measured live: two models on one gateway timed out on roughly every other
 * 20-second probe and answered in ~4.6s the rest of the time. A single attempt
 * therefore labels a working model dead about half the time. Retried once, both
 * came back healthy. Only transport failures qualify — an HTTP status is an
 * answer, and repeating a request that already got one just burns quota.
 */
export function isTransportFailure(result) {
  if (!result || typeof result !== "object") return false;
  // An explicitly transient refusal is worth retrying even though it carries a
  // status: an empty-bodied 403 from a gateway that answers 200 to the same
  // request moments later is noise, not an answer about the model.
  if (result.transient === true) return true;
  if (Number.isFinite(result.status)) return false;
  if (result.fault === "proxy") return false;   // retrying will not fix the proxy
  return result.reach === "down" || result.kind === "timeout" || result.kind === "network";
}

/**
 * A failure that says nothing about this particular model.
 *
 * A bad key or an unreachable host produces the same error for every model in
 * the list. Reporting 100 models as broken hides the one real cause, so the
 * batch stops and names it instead.
 */
export function isAccountWideFailure(result) {
  if (!result || typeof result !== "object") return false;
  // "This model is not on your plan" is per-model, even though it arrives as a
  // 403: verified live against a gateway that refused one model with "deposit
  // required" while serving another on the same key. Treating it as
  // account-wide aborted the run and hid the models that did work.
  if (result.fault === "plan") return false;
  if (result.fault === "key" || result.fault === "proxy") return true;
  // A bare 403 with no classification is ambiguous. Only 401 is unambiguous
  // enough to stop everything on the first occurrence.
  return result.status === 401;
}

/**
 * @param {string[]} ids            models to probe
 * @param {(id:string)=>Promise<object>} probe  runs one live request
 * @param {object} [opts]
 * @param {number} [opts.concurrency]
 * @param {number} [opts.gapMs]     pause between starts, per worker
 * @param {(p:object)=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @param {(ms:number)=>Promise<void>} [opts.wait]  injectable for tests
 */
export async function runBatch(ids, probe, opts = {}) {
  const list = (Array.isArray(ids) ? ids : []).map((x) => String(x || "").trim()).filter(Boolean);
  const concurrency = Math.max(1, Math.min(8, Number(opts.concurrency) || DEFAULT_CONCURRENCY));
  const wait = opts.wait || sleep;
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;

  const results = [];
  let next = 0;
  let gap = Math.max(0, Number.isFinite(Number(opts.gapMs)) ? Number(opts.gapMs) : DEFAULT_GAP_MS);
  let streak = 0;
  let stopped = null;          // reason the run ended early, if it did
  let rateLimited = 0;

  const state = () => ({
    done: results.length, total: list.length,
    ok: results.filter((r) => r.ok).length,
    rateLimited, gapMs: gap, stopped,
  });

  async function worker() {
    for (;;) {
      if (stopped) return;
      if (opts.signal?.aborted) { stopped = stopped || { reason: "aborted", message: "Проверка остановлена" }; return; }
      const i = next++;
      if (i >= list.length) return;
      const id = list[i];

      let r;
      let attempts = 0;
      for (;;) {
        attempts++;
        try {
          r = await probe(id);
        } catch (e) {
          r = { ok: false, message: e?.message || String(e) };
        }
        if (!r || typeof r !== "object") r = { ok: false, message: "Пустой ответ проверки" };
        // One retry, and only when nothing came back at all. Flaky gateways
        // otherwise get reported as broken; see isTransportFailure.
        if (r.ok || attempts > RETRY_TRANSPORT || !isTransportFailure(r)) break;
        await wait(RETRY_DELAY_MS);
      }
      if (attempts > 1) r = { ...r, attempts };

      const limited = isRateLimited(r);
      if (limited) {
        rateLimited++;
        streak++;
        // Slow every worker down, not just this one: the limit is on the key.
        gap = Math.min(MAX_GAP_MS, Math.max(gap, 1) * BACKOFF_FACTOR);
        if (streak >= RATE_LIMIT_STREAK) {
          stopped = {
            reason: "rate-limited",
            message: `Провайдер ограничивает частоту запросов (${streak} отказа подряд). ` +
              `Проверено ${results.length + 1} из ${list.length}; остальные не проверялись, ` +
              `чтобы не выдать рабочие модели за нерабочие.`,
          };
        }
      } else if (r.ok) {
        streak = 0;
      } else if (isAccountWideFailure(r) && !results.some((x) => x.ok)) {
        // The run's own evidence outranks the status code. Observed live: a
        // gateway served three models on a key and then answered 403 with an
        // empty body for a fourth. Classified from the response alone that
        // looks like a rejected key, but a key that just worked three times is
        // not rejected — the fourth model is simply not available. So a
        // credential verdict is only allowed to stop everything while nothing
        // has succeeded yet.
        stopped = {
          reason: r.fault === "proxy" ? "proxy" : "auth",
          message: `${r.message || "Отказ доступа"} — это относится ко всему провайдеру, а не к модели ` +
            `«${id}». Остальные модели не проверялись.`,
        };
      }

      results.push({ id, ok: !!r.ok, rateLimited: limited, ...r });
      if (onProgress) onProgress({ ...state(), last: { id, ok: !!r.ok, rateLimited: limited } });
      if (stopped) return;
      if (gap) await wait(gap);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, worker));

  // Order follows the input, not the order replies happened to arrive: the user
  // is looking at the same list they started from.
  const byId = new Map(results.map((r) => [r.id, r]));
  const ordered = list.map((id) => byId.get(id)).filter(Boolean);
  return {
    ok: !stopped,
    results: ordered,
    tested: ordered.length,
    total: list.length,
    passed: ordered.filter((r) => r.ok).length,
    failed: ordered.filter((r) => !r.ok).length,
    rateLimited,
    skipped: list.length - ordered.length,
    stopped,
    gapMs: gap,
  };
}
