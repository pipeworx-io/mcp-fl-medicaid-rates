interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * Florida Medicaid rate schedules (Florida AHCA, Medicaid cost reimbursement).
 *
 * Proxy-shaped: every call reads the agency's public rate pages and the small
 * spreadsheets they publish, then answers from the sheet. Nothing is bundled.
 */

import { parseXlsx } from './xlsx.js';

const UA = 'pipeworx-mcp-fl-medicaid-rates/1.0 (+https://pipeworx.io)';
const HOST = 'https://ahca.myflorida.com';
const SOURCE = 'Florida AHCA, Medicaid cost reimbursement rate schedules';

async function pwFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithTimeout(url, { ...init, headers: { 'User-Agent': UA, ...(init.headers as Record<string, string> | undefined) } }, 'Florida AHCA');
}

// ---------------------------------------------------------------------------
// Reading the agency, politely and honestly (fleet #3518).
//
// The agency fronts its site with Cloudflare, and its firewall refuses a Worker
// whose egress leaves from some Cloudflare data centres. Measured 2026-10-23: the
// same request, same User-Agent, from a Worker placed in the US was served 5 of 5
// and from one placed in Hong Kong was refused 5 of 5 with Cloudflare's
// "Attention Required" block page (HTTP 403). The gateway runs a call near its
// caller, so a caller in Asia is refused while a caller in the US is served.
//
// Three things follow, and none is a change to what the pack answers:
//   1. Every file (the listing page and each workbook) is cached in the Cloudflare
//      cache for a day. The agency republishes about twice a year; re-reading it on
//      every call was wasted load and gave the firewall more chances to refuse.
//   2. When a live read fails and an earlier copy of the same file exists, the
//      earlier copy answers and the response SAYS so (`upstream_refused`,
//      `retrieved_at`, `from_cache`). It is never silent.
//   3. When there is no copy to fall back on, the call fails with a message that
//      names the cause. A firewall block page is reported as a firewall block,
//      not as a bare "HTTP 403".
// The cache is per data centre, so a data centre the agency refuses has nothing
// to fall back on until the egress relay (_proxyUrl) is allowed to read this host.
// ---------------------------------------------------------------------------

const FRESH_MS = 24 * 60 * 60 * 1000;
const KEEP_SEC = 30 * 24 * 60 * 60;
const FETCHED_AT = 'x-pw-fetched-at';

let PROXY: { url: string; token: string } | null = null;

function cacheRequest(url: string): Request {
  return new Request(`https://fl-medicaid-rates.pipeworx.invalid/${encodeURIComponent(url)}`);
}

async function cacheGet(url: string): Promise<{ bytes: Uint8Array; at: number } | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const hit = await caches.default.match(cacheRequest(url));
    if (!hit) return null;
    const at = Number(hit.headers.get(FETCHED_AT) ?? 0);
    if (!at) return null;
    return { bytes: new Uint8Array(await hit.arrayBuffer()), at };
  } catch {
    return null;
  }
}

async function cachePut(url: string, bytes: Uint8Array): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    await caches.default.put(
      cacheRequest(url),
      new Response(bytes, { headers: { 'Cache-Control': `s-maxage=${KEEP_SEC}`, [FETCHED_AT]: String(Date.now()) } }),
    );
  } catch {
    /* a failed cache write only costs the next call a live read */
  }
}

function refusalMessage(what: string, status: number, body: string, ray: string | null, relayNote: string): string {
  const colo = ray && ray.includes('-') ? ray.split('-').pop() : null;
  if (/attention required|cloudflare/i.test(body)) {
    return (
      `Florida AHCA ${what} answered HTTP ${status} with a Cloudflare firewall block page` +
      (colo ? ` (served from Cloudflare data centre ${colo})` : '') +
      `. The agency's firewall refuses requests that leave from some Cloudflare data centres; on 2026-10-23 the same request from a US data centre was served and one from Hong Kong was refused. ` +
      `${relayNote.trim()} A retry from the same region is unlikely to change it.`.trim()
    );
  }
  return `Florida AHCA ${what} answered HTTP ${status}${body ? `: ${summarizeErrorBody(body)}` : ''}${relayNote}`;
}

async function liveBytes(url: string, what: string): Promise<Uint8Array> {
  const res = await pwFetch(url);
  if (res.ok) return new Uint8Array(await res.arrayBuffer());
  const body = (await res.text().catch(() => '')).slice(0, 4000);
  let relayNote = '';
  if (res.status === 403 && PROXY) {
    try {
      const via = await pwFetch(PROXY.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${PROXY.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, userAgent: UA, accept: '*/*' }),
      });
      if (via.ok) return new Uint8Array(await via.arrayBuffer());
      relayNote = ` The egress relay was tried and answered HTTP ${via.status}.`;
    } catch {
      relayNote = ' The egress relay was tried and did not answer.';
    }
  }
  throw new Error(refusalMessage(what, res.status, body, res.headers.get('cf-ray'), relayNote));
}

type Read<T> = { value: T; fetchedAt: number; refused?: string };

/**
 * Cache first (a day), then the agency, then any earlier copy. A copy is only
 * cached after it parsed, so a layout change or partial read is never pinned for a
 * day. A parse failure on a live read stays loud: only a failure to REACH the
 * agency falls back to an earlier copy.
 */
async function readThrough<T>(url: string, what: string, parse: (b: Uint8Array) => Promise<T> | T): Promise<Read<T>> {
  const cached = await cacheGet(url);
  if (cached && Date.now() - cached.at < FRESH_MS) {
    try {
      return { value: await parse(cached.bytes), fetchedAt: cached.at };
    } catch {
      /* an unreadable stored copy is re-read live below */
    }
  }
  let bytes: Uint8Array;
  try {
    bytes = await liveBytes(url, what);
  } catch (err) {
    if (cached) {
      try {
        const value = await parse(cached.bytes);
        return { value, fetchedAt: cached.at, refused: (err as Error).message };
      } catch {
        /* fall through to the live failure */
      }
    }
    throw new Error(`${(err as Error).message} No earlier copy of this file is stored for this region, so there is nothing to answer from.`);
  }
  const value = await parse(bytes);
  await cachePut(url, bytes);
  return { value, fetchedAt: Date.now() };
}

type Schedule = {
  page: string;
  label: string;
  file: RegExp;
  exclude?: RegExp;
  /** Floor for the LATEST file's provider rows. Below it the read is treated as partial and refused. */
  minRows: number;
  /** What the published table covers, when that is narrower than its heading suggests. */
  scope?: string;
};

const SCHEDULES: Record<string, Schedule> = {
  fqhc: { page: 'fqhc-rhc-rates', label: 'Federally Qualified Health Center (FQHC) per-visit PPS encounter rate', file: /^FQHC[_ ]Rates/i, minRows: 300 },
  rhc: { page: 'fqhc-rhc-rates', label: 'Rural Health Clinic (RHC) per-visit PPS encounter rate', file: /^RHC[_ ]Rates/i, minRows: 80 },
  pb_rhc: { page: 'fqhc-rhc-rates', label: 'Provider-based Rural Health Clinic per-visit rate', file: /^PB-RHC[_ ]Rates/i, minRows: 8 },
  snu: { page: 'skilled-nursing-unit-snu-rates', label: 'Skilled nursing unit per diem rate', file: /SNU[_ ]Rates/i, minRows: 2,
    scope: 'The agency posts per diem rates for the hospital-based skilled nursing units it lists in this table (3 units in the October 2026 table); it is the complete published table, not a sample, and it is not a list of every nursing facility -- see the nursing_home schedule for those.' },
  swing_bed: { page: 'swing-bed-rates', label: 'Swing bed per diem rate', file: /SB[_ ]Rates/i, minRows: 4 },
  hospice_level_of_care: { page: 'hospice-care-services-per-diem-rates', label: 'Hospice level-of-care per diem rates', file: /Hospice[_ ]LOC[_ ]Rates/i, minRows: 40 },
  hospice_room_board: { page: 'hospice-room-board-rates', label: 'Hospice nursing home room and board rate', file: /Hospice[_ ]R-B[_ ]Rates/i, minRows: 40 },
  nursing_home: { page: 'nursing-home-rates', label: 'Nursing home final per diem rate', file: /NH[_ ]Final[_ ]Rates/i, exclude: /detail/i, minRows: 400 },
  hospital: {
    page: 'hospital-rates-ambulatory-surgical-centers',
    label: 'State mental health hospital per diem rates',
    file: /Hospital[_ ]Rates/i,
    minRows: 3,
    scope:
      'STATE MENTAL HEALTH HOSPITALS ONLY. Since July 2013 the agency pays community-hospital inpatient stays by diagnosis-related group, and since July 2017 outpatient by enhanced ambulatory patient group; it posts no per diem for those hospitals. The only hospitals still paid a per diem, and so the only rows in this table, are the state mental health hospitals (3 in the July 2026 table). A community hospital is not missing from the data -- it is not in this schedule. Per diem columns that read 0 mean no per diem is paid for that service (null here).',
  },
};
const SCHEDULE_IDS = Object.keys(SCHEDULES);

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_NAMES = MONTHS.map((m) => m[0].toUpperCase() + m.slice(1));

function iso(y: number, m: number, d = 1): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Effective date implied by a published file's name (first day of the semester). */
function effectiveFromName(name: string): string | null {
  let m = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[_ ]+(\d{4})/i.exec(name);
  if (m) return iso(+m[2], MONTHS.findIndex((x) => x.startsWith(m![1].toLowerCase())) + 1);
  m = /(\d{4})-(\d{2})-(\d{2})/.exec(name);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /(?<!\d)(\d{1,2})-(\d{1,2})-(\d{4})/.exec(name);
  if (m) return iso(+m[3], +m[1], +m[2]);
  m = /(\d{4})-(\d{2})(?!\d)/.exec(name);
  if (m) return iso(+m[1], +m[2]);
  m = /(?<!\d)(20\d{2})(\d{2})(?!\d)/.exec(name);
  if (m) return iso(+m[1], +m[2]);
  m = /(?<!\d)(\d{1,2})-(20\d{2})(?!\d)/.exec(name);
  if (m) return iso(+m[2], +m[1]);
  return null;
}

function periodLabel(effective: string | null): string | null {
  if (!effective) return null;
  const [y, mo] = effective.split('-');
  return `${MONTH_NAMES[+mo - 1]} ${y}`;
}

type FileRef = { url: string; effective: string | null };
type Meta = { fetchedAt: number; refused?: string };

const TTL = 10 * 60 * 1000;
const pageCache = new Map<string, { at: number; files: FileRef[]; meta: Meta }>();

function parsePage(html: string): FileRef[] {
  const files: FileRef[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/href="([^"]+\.xlsx)"/gi)) {
    let url: string;
    try { url = new URL(m[1].replace(/ /g, '%20'), `${HOST}/medicaid/cost-reimbursement/`).toString(); } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    files.push({ url, effective: effectiveFromName(decodeURIComponent(url.split('/').pop() ?? '')) });
  }
  if (!files.length) throw new Error('Florida AHCA rate page listed no workbooks -- the page layout may have changed');
  return files;
}

async function listFiles(id: string): Promise<{ files: FileRef[]; meta: Meta }> {
  const sch = SCHEDULES[id];
  const hit = pageCache.get(sch.page);
  let all: FileRef[];
  let meta: Meta;
  if (hit && Date.now() - hit.at < TTL) {
    all = hit.files;
    meta = hit.meta;
  } else {
    const r = await readThrough(`${HOST}/medicaid/cost-reimbursement/${sch.page}.html`, `rate page for "${id}"`, (b) => parsePage(new TextDecoder().decode(b)));
    all = r.value;
    meta = { fetchedAt: r.fetchedAt, refused: r.refused };
    pageCache.set(sch.page, { at: Date.now(), files: all, meta });
  }
  const files = all
    .filter((f) => {
      const n = decodeURIComponent(f.url.split('/').pop() ?? '');
      return sch.file.test(n) && !(sch.exclude && sch.exclude.test(n));
    })
    .sort((a, b) => (b.effective ?? '').localeCompare(a.effective ?? ''));
  return { files, meta };
}

function normPeriod(p: string): { prefix: string } | null {
  const s = p.trim();
  if (!s || /^latest$/i.test(s)) return null;
  let m = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(?:\d{1,2},?\s*)?(\d{4})/i.exec(s);
  if (m) return { prefix: `${m[2]}-${String(MONTHS.findIndex((x) => x.startsWith(m![1].toLowerCase())) + 1).padStart(2, '0')}` };
  m = /^(\d{4})-(\d{1,2})/.exec(s);
  if (m) return { prefix: `${m[1]}-${m[2].padStart(2, '0')}` };
  m = /^(\d{1,2})\/\d{1,2}\/(\d{4})/.exec(s);
  if (m) return { prefix: `${m[2]}-${m[1].padStart(2, '0')}` };
  m = /^(\d{4})$/.exec(s);
  if (m) return { prefix: m[1] };
  throw new Error(`Unrecognised period "${p}". Use "latest", a year ("2025"), a month ("2025-10") or "October 2025".`);
}

type Table = { columns: string[]; rows: Record<string, string | number | null>[]; zeroCells: Record<string, number> };

const bookCache = new Map<string, { at: number; table: Table; meta: Meta }>();

function clean(v: string | number | undefined): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

async function loadTable(url: string): Promise<{ table: Table; meta: Meta }> {
  const hit = bookCache.get(url);
  if (hit && Date.now() - hit.at < TTL) return { table: hit.table, meta: hit.meta };
  const r = await readThrough(url, 'rate file', parseTable);
  const meta = { fetchedAt: r.fetchedAt, refused: r.refused };
  bookCache.set(url, { at: Date.now(), table: r.value, meta });
  return { table: r.value, meta };
}

async function parseTable(bytes: Uint8Array): Promise<Table> {
  const wb = await parseXlsx(bytes);
  // Refuse a partial read rather than answer from whatever rows survived.
  if (wb.unreadSheets.length) throw new Error(`Florida AHCA rate file has sheet(s) this reader could not open (${wb.unreadSheets.join(', ')}) -- refusing to answer from a partial read`);
  for (const sh of wb.sheets) {
    if (sh.cellsRead !== sh.cellsDeclared) throw new Error(`Florida AHCA rate file sheet "${sh.name}" is incompletely read (${sh.cellsRead} of ${sh.cellsDeclared} cells) -- refusing to answer from a partial read`);
  }
  const columns: string[] = [];
  const rows: Record<string, string | number | null>[] = [];
  const multi = wb.sheets.length > 1;
  for (const sh of wb.sheets) {
    const rowNums = [...sh.rows.keys()].sort((a, b) => a - b);
    let headerRow = -1;
    for (const rn of rowNums.slice(0, 12)) {
      const cells = [...sh.rows.get(rn)!.values()];
      if (cells.length >= 3 && cells.every((c) => typeof c === 'string')) { headerRow = rn; break; }
    }
    if (headerRow < 0) {
      if (sh.cellsRead > 0) throw new Error(`Florida AHCA rate file sheet "${sh.name}" has data but no recognisable header row -- layout may have changed; refusing to answer from a partial read`);
      continue;
    }
    const hdr = sh.rows.get(headerRow)!;
    const letters = [...hdr.keys()];
    const names = new Map<string, string>();
    for (const L of letters) {
      let n = clean(hdr.get(L));
      if (!n) continue;
      let k = n, i = 2;
      while (names.has(k) && names.get(k) !== L) k = `${n} (${i++})`;
      names.set(L, k);
      if (!columns.includes(k)) columns.push(k);
    }
    for (const rn of rowNums) {
      if (rn <= headerRow) continue;
      const r = sh.rows.get(rn)!;
      const rec: Record<string, string | number> = {};
      let numeric = 0;
      for (const L of letters) {
        const v = r.get(L);
        if (v === undefined) continue;
        const name = names.get(L);
        if (!name) continue;
        rec[name] = typeof v === 'string' ? clean(v) : v;
        if (typeof v === 'number') numeric++;
      }
      if (numeric === 0 && Object.keys(rec).length < 2) continue;
      if (multi) rec['Sheet'] = sh.name;
      rows.push(rec);
    }
  }
  if (multi && !columns.includes('Sheet')) columns.push('Sheet');
  // Excel serial dates in an "effective date" column -> ISO.
  for (const c of columns) {
    if (!/date/i.test(c)) continue;
    for (const r of rows) {
      const v = r[c];
      if (typeof v === 'number' && v > 30000 && v < 80000) r[c] = new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    }
  }
  if (!rows.length) throw new Error('Florida AHCA rate file parsed to zero rows -- layout may have changed');
  // The agency states money to the cent; some workbooks store float noise (159.18499999999997).
  // Round half-up to cents at this one boundary, in every rate column of every schedule.
  // A 0 in a rate column is the agency's "no rate for this service", not a price: null it.
  const zeroCells: Record<string, number> = {};
  for (const c of columns) {
    if (isIdColumn(c)) continue;
    for (const r of rows) {
      const v = r[c];
      if (typeof v !== 'number') continue;
      if (v === 0) { (r as Record<string, string | number | null>)[c] = null; zeroCells[c] = (zeroCells[c] ?? 0) + 1; continue; }
      r[c] = Math.round(v * 100 + 1e-6) / 100;
    }
  }
  return { columns, rows, zeroCells };
}

function isIdColumn(name: string): boolean {
  return /number|^id$|npi|provider|medicaid no|name|sheet|date|^#$/i.test(name);
}

function stats(vals: number[]) {
  const s = [...vals].sort((a, b) => a - b);
  const n = s.length;
  const med = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  const r = (x: number) => Math.round(x * 100) / 100;
  return { count: n, min: r(s[0]), median: r(med), max: r(s[n - 1]), mean: r(s.reduce((a, b) => a + b, 0) / n) };
}

async function resolveFile(id: string, period: unknown): Promise<{ file: FileRef; available: string[]; latest: FileRef; meta: Meta }> {
  const { files, meta } = await listFiles(id);
  if (!files.length) throw new Error(`No published ${id} rate files found on the Florida AHCA page -- the page layout may have changed`);
  const labels = [...new Set(files.map((f) => periodLabel(f.effective) ?? 'undated'))];
  const want = typeof period === 'string' ? normPeriod(period) : null;
  if (!want) return { file: files[0], available: labels, latest: files[0], meta };
  const hit = files.find((f) => f.effective?.startsWith(want.prefix));
  if (!hit) throw new Error(`No ${id} rate schedule for period "${period}". Published periods: ${labels.join(', ')}`);
  return { file: hit, available: labels, latest: files[0], meta };
}

/** When the agency was last actually read, and whether an earlier copy answered because the agency refused. */
function provenance(...metas: Meta[]): Record<string, unknown> {
  const oldest = Math.min(...metas.map((m) => m.fetchedAt));
  const refused = metas.find((m) => m.refused)?.refused;
  const fromCache = Date.now() - oldest > 60 * 1000;
  return {
    retrieved_at: new Date(oldest).toISOString(),
    from_cache: fromCache,
    ...(refused
      ? { upstream_refused: refused, upstream_refused_note: 'The agency refused a fresh read just now, so this answer comes from the last copy read successfully (retrieved_at). The rates are the agency\'s published figures for data_as_of; they are not updated for later revisions.' }
      : {}),
  };
}

async function rates(id: string, args: Record<string, unknown>) {
  if (!SCHEDULES[id]) throw new Error(`Unknown schedule "${id}". Valid: ${SCHEDULE_IDS.join(', ')}`);
  const { file, available, latest, meta: pageMeta } = await resolveFile(id, args.period);
  const { table, meta: fileMeta } = await loadTable(file.url);
  const source = provenance(pageMeta, fileMeta);
  const isLatest = file === latest;
  const floor = SCHEDULES[id].minRows;
  if (isLatest && table.rows.length < floor) {
    throw new Error(`Florida AHCA ${id} schedule read ${table.rows.length} provider rows, below the ${floor} expected for the latest table -- treating it as a partial read and refusing to answer from it. Retry; if it persists the agency's table layout has changed.`);
  }
  const nullCols = Object.entries(table.zeroCells).filter(([c, n]) => n === table.rows.length && !isIdColumn(c)).map(([c]) => c);
  const rateCols = table.columns.filter((c) => !isIdColumn(c) && table.rows.some((r) => typeof r[c] === 'number'));
  const statewide: Record<string, ReturnType<typeof stats>> = {};
  for (const c of rateCols) {
    const v = table.rows.map((r) => r[c]).filter((x): x is number => typeof x === 'number');
    if (v.length) statewide[c] = stats(v);
  }
  const q = typeof args.provider === 'string' ? args.provider.trim().toLowerCase() : '';
  const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 200);
  let matched = table.rows;
  if (q) {
    const digits = q.replace(/\D/g, '');
    matched = table.rows.filter((r) =>
      Object.entries(r).some(([k, v]) => {
        const s = String(v).toLowerCase();
        if (/name/i.test(k)) return s.includes(q);
        if (/number|npi/i.test(k) && digits.length >= 4) return s.replace(/\D/g, '').includes(digits) || s.includes(q);
        return false;
      }),
    );
    if (!matched.length) throw new Error(`No ${id} provider matching "${args.provider}" in the ${periodLabel(file.effective)} schedule (${table.rows.length} providers listed). Try a shorter name fragment or the provider number.`);
  }
  const out: Record<string, unknown> = {
    schedule: id,
    description: SCHEDULES[id].label,
    period: periodLabel(file.effective),
    effective_date: file.effective,
    available_periods: available,
    provider_count: table.rows.length,
    rate_columns: rateCols,
    statewide,
    returned: Math.min(matched.length, limit),
    matched: matched.length,
    rows: matched.slice(0, limit),
    source: SOURCE,
    data_as_of: file.effective,
    ...source,
    ...(SCHEDULES[id].scope ? { scope: SCHEDULES[id].scope } : {}),
    ...(Object.keys(table.zeroCells).length
      ? {
          null_rate_cells: table.zeroCells,
          null_rate_note: `The agency's table shows 0 in these cells, meaning no rate is paid for that service (not a price of zero). They are returned as null and left out of the statewide figures.${nullCols.length ? ` Columns with no rate for any provider: ${nullCols.join(', ')}.` : ''}`,
        }
      : {}),
    precision: 'US dollars, rounded to the cent (the agency states rates to the cent).',
    note: 'Rates are those published as of the first day of the rate semester; the agency does not update the page for later revisions of an individual rate.',
  };
  if (matched.length > limit) out.truncated = true;
  return out;
}

const scheduleEnum = SCHEDULE_IDS;

const tools: McpToolExport['tools'] = [
  {
    name: 'fl_fqhc_rates',
    description:
      'Florida MEDICAID (not Medicare) FQHC per-visit PPS encounter rates by provider, from the Florida Agency for Health Care Administration. Returns each clinic\'s encounter rate for a semester (default latest; earlier semesters back to 2019 via period, e.g. "2024-10" or "October 2024") plus the statewide min/median/max/mean and the effective date. Filter by clinic name or Medicaid provider number.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        period: { type: 'string', description: '"latest" (default), a year ("2025"), a month ("2025-10") or "October 2024".' },
        provider: { type: 'string', description: 'Clinic name fragment or Medicaid provider number.' },
        limit: { type: 'number', description: 'Max provider rows returned (default 25, max 200). Statewide stats always cover all providers.' },
      },
    },
  },
  {
    name: 'fl_medicaid_rates',
    description:
      'Florida Medicaid reimbursement rate schedules from the Florida Agency for Health Care Administration: FQHC, rural health clinic (RHC), provider-based RHC, nursing home per diem, skilled nursing unit, swing bed, hospice (level of care and room and board), and state mental health hospital per diem rates (community hospitals are paid by DRG/EAPG and are not in any schedule here). Per-provider rates with statewide min/median/max, effective date and earlier published semesters.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        schedule: { type: 'string', enum: scheduleEnum, description: 'Which rate schedule. "hospital" is the state mental health hospital per diem table only (3 hospitals); community hospitals are paid by DRG/EAPG and are not published as rates here.' },
        period: { type: 'string', description: '"latest" (default), a year ("2025"), a month ("2025-10") or "October 2024".' },
        provider: { type: 'string', description: 'Provider name fragment or Medicaid provider number.' },
        limit: { type: 'number', description: 'Max provider rows returned (default 25, max 200).' },
      },
      required: ['schedule'],
    },
  },
  {
    name: 'fl_rate_periods',
    description: 'List which Florida Medicaid rate schedules exist and the effective periods published for each (e.g. October 2026, October 2025, October 2024 for FQHC).',
    inputSchema: {
      type: 'object' as const,
      properties: { schedule: { type: 'string', enum: scheduleEnum, description: 'One schedule, or omit for all.' } },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  // The gateway hands the egress relay's address and token to packs that need it.
  PROXY = typeof args._proxyUrl === 'string' && typeof args._proxyToken === 'string' ? { url: args._proxyUrl, token: args._proxyToken } : null;
  switch (name) {
    case 'fl_fqhc_rates':
      return rates('fqhc', args);
    case 'fl_medicaid_rates':
      return rates(String(args.schedule ?? ''), args);
    case 'fl_rate_periods': {
      const ids = typeof args.schedule === 'string' && args.schedule ? [args.schedule] : SCHEDULE_IDS;
      const schedules = [];
      const metas: Meta[] = [];
      for (const id of ids) {
        if (!SCHEDULES[id]) throw new Error(`Unknown schedule "${id}". Valid: ${SCHEDULE_IDS.join(', ')}`);
        const { files, meta } = await listFiles(id);
        metas.push(meta);
        schedules.push({
          schedule: id,
          description: SCHEDULES[id].label,
          ...(SCHEDULES[id].scope ? { scope: SCHEDULES[id].scope } : {}),
          periods: files.map((f) => ({ period: periodLabel(f.effective) ?? 'undated', effective_date: f.effective })),
        });
      }
      return { schedules, source: SOURCE, ...(metas.length ? provenance(...metas) : { retrieved_at: new Date().toISOString() }) };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
