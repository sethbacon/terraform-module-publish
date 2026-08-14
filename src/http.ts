import {
    HttpError,
    METADATA_TIMEOUT_MS,
    createHttpClient,
    resolveEnvProxy,
    truncateForLog,
    type ProxyEnvironment,
} from '@4cloudguru/pipeline-task-core';
import { Agent, ProxyAgent, type Dispatcher } from 'undici';
import { URL } from 'url';
import { AuthorizeHost } from './egress';

export interface HttpResponse {
    status: number;
    body: string;
}

/**
 * `body` is `Uint8Array` as well as `string` because the HCP module-archive
 * upload PUTs gzipped tar bytes. A buffer rather than a stream: the shared
 * client retries a transient transport failure, and a stream is consumed by the
 * first attempt, so a retried upload would send an empty body.
 */
export type HttpClient = (
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string | Uint8Array,
) => Promise<HttpResponse>;

/** Optional per-run tuning for {@link createHttpsClient}. */
export interface HttpsClientOptions {
    /**
     * PEM trust anchor(s) for a registry fronted by a private CA. Supplying one
     * REPLACES the default trust store for this client's requests, which is the
     * tighter choice: a publicly-trusted CA cannot then mint a certificate for
     * an internal registry name and be believed.
     */
    caCert?: string;
    /** `fetch` implementation, injectable so tests need no network. */
    fetchImpl?: typeof fetch;
    /**
     * The runner's environment, read for `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`.
     * Defaults to `process.env`; injectable so tests need no global mutation.
     */
    env?: ProxyEnvironment;
    /**
     * Registers a proxy credential with the job's mask. Wire to
     * `core.setSecret`.
     *
     * A proxy URL may embed `user:password@`, and it reaches this process from
     * the environment rather than from an action input, so nothing else in the
     * run has had the chance to mask it.
     */
    setSecret?: (secret: string) => void;
}

/** Refusal text for the withdrawn `skip-tls-verify` input; names the replacement. */
export const SKIP_TLS_VERIFY_REMOVED =
    "The 'skip-tls-verify' input has been removed because it disabled certificate AND hostname " +
    'verification on the very requests that carry the registry API key as a Bearer credential, so any ' +
    'host that answered for the registry name harvested it. For a registry fronted by a private CA, ' +
    "supply that CA's certificate (PEM) as the 'ca-cert' input instead — verification stays on and the " +
    "private CA is trusted. Remove 'skip-tls-verify' from the step.";

/**
 * Turns the action's TLS inputs into the client's trust configuration, refusing
 * the withdrawn verification-off switch.
 *
 * Read as raw text rather than through `getBooleanInput` so that every spelling
 * an operator might reach for (`true`, `TRUE`, `yes`, `1`) hits the explanatory
 * refusal instead of a schema `TypeError` that says nothing about why. Only an
 * absent or explicitly-false value is treated as "not requested"; anything else
 * fails the step rather than being quietly ignored.
 */
export function resolveTlsTrust(rawSkipTlsVerify: string, rawCaCert: string): HttpsClientOptions {
    const skip = rawSkipTlsVerify.trim().toLowerCase();
    if (skip !== '' && skip !== 'false' && skip !== '0' && skip !== 'no') {
        throw new Error(SKIP_TLS_VERIFY_REMOVED);
    }
    const caCert = rawCaCert.trim();
    return caCert ? { caCert } : {};
}

/**
 * Creates an HTTPS client on top of the shared `@4cloudguru/pipeline-task-core`
 * client rather than a local copy of one. The hand-copied `https.request`
 * helper this replaces was the original of three transcriptions across this
 * family, which is why the ADO extensions' egress hardening never reached it;
 * consuming the shared client means the next fix arrives by version bump
 * instead of by transcription.
 *
 * The client pins https, follows redirects manually, and re-runs
 * `authorizeHost` on the initial host AND on every hop — every request re-sends
 * the registry bearer credential, so a hop is exactly as sensitive as the first
 * destination.
 *
 * TLS peer verification is not optional here and there is deliberately no
 * switch to turn it off: the first request already carries
 * `Authorization: Bearer <api-key>`, so an unverified peer is a peer that
 * harvests the credential. A private CA is accommodated by ADDING its
 * certificate as a trust anchor (`caCert`), which keeps both chain and
 * hostname verification — the two checks that the withdrawn verification-off
 * switch dropped together.
 *
 * On a self-hosted runner behind a mandatory egress proxy the requests are
 * routed through it, because Node's `fetch` honours none of `HTTPS_PROXY` /
 * `HTTP_PROXY` / `NO_PROXY` on its own — so every credential-bearing registry
 * call used to leave the network outside the organisation's allowlist and audit
 * trail, or fail with an undiagnosable connect error where direct egress is
 * blocked. The proxy decision is re-taken for EVERY hop, never once for the
 * original URL; see the per-hop resolver below.
 *
 * @param authorizeHost the egress-authorization decision from `./egress`.
 * @param options trust anchor and test seams; see {@link HttpsClientOptions}.
 */
export function createHttpsClient(authorizeHost: AuthorizeHost, options: HttpsClientOptions = {}): HttpClient {
    const { caCert, fetchImpl, env, setSecret } = options;
    // Built once for the client's lifetime, only when the operator supplied a
    // trust anchor; Node's fetch has no other way to reach that socket option.
    // Used for the hops that go direct.
    const direct = caCert ? new Agent({ connect: { ca: caCert } }) : undefined;
    // Client-lifetime, keyed by proxy URL: `waitForVersion`/`waitForOk` re-issue
    // a request every three seconds for up to `timeout-seconds`, so building a
    // dispatcher per request would leak a connection pool per poll.
    const proxyAgents = new Map<string, ProxyAgent>();
    const masked = new Set<string>();

    /**
     * The dispatcher for ONE hop, chosen from that hop's own destination.
     *
     * Resolved per hop rather than once for the original URL because every part
     * of the decision belongs to the destination: `NO_PROXY` is matched against
     * it and its scheme picks the variable. A registry that redirects a module
     * download off to a CDN — or an internal host covered by `NO_PROXY` —
     * has to be answered again, and resolving once would send the later hops
     * through the wrong route (or through a proxy not permitted to see them).
     *
     * WHAT THIS DOES NOT DECIDE. A proxy changes which socket carries the
     * request, never which destination is permitted. `authorizeHost` still runs
     * against the DESTINATION host — the initial one below and every redirect
     * hop in `redirectPolicy` — and its subject is never the proxy: a CONNECT
     * tunnel to an unauthorized host is still unauthorized egress. Nothing here
     * is consulted by that decision, and nothing here can widen it.
     */
    function dispatcherFor(hopUrl: string): Dispatcher | undefined {
        let proxy: ReturnType<typeof resolveEnvProxy>;
        try {
            proxy = resolveEnvProxy(hopUrl, env);
        } catch (error) {
            // Re-thrown NON-retryable, for the same reason the redirect refusal
            // below is: an unusable proxy variable is a configuration error, and
            // the shared client treats any non-HttpError as a transient
            // transport failure, so a plain throw would be retried three times
            // over — and `pollUntil` would then repeat that for the whole
            // timeout. Fail closed and once — never silently direct, which is
            // the failure that would put the registry bearer outside the
            // chokepoint the variable exists to enforce.
            throw new HttpError(error instanceof Error ? error.message : String(error), false);
        }
        if (!proxy) return direct;
        // Masked before the agent is constructed, so a proxy that refuses the
        // connection cannot put the credential in the error text unmasked.
        // Deduped because polling resolves the same proxy every three seconds
        // and each registration is an ::add-mask:: line in the log.
        for (const secret of proxy.secrets) {
            if (masked.has(secret)) continue;
            masked.add(secret);
            setSecret?.(secret);
        }
        let agent = proxyAgents.get(proxy.proxyUrl);
        if (!agent) {
            // `requestTls`, not `connect`: with a tunnel in play that is the
            // TLS handshake with the DESTINATION, which is the peer `caCert`
            // vouches for. Putting the anchor on the proxy leg instead would
            // leave the destination handshake on the default store and fail
            // exactly the private-CA case the input exists for.
            agent = new ProxyAgent(
                caCert ? { uri: proxy.proxyUrl, requestTls: { ca: caCert } } : { uri: proxy.proxyUrl },
            );
            proxyAgents.set(proxy.proxyUrl, agent);
        }
        return agent;
    }

    return async (method, url, headers, body) => {
        const client = createHttpClient({
            fetchImpl,
            fetchOptions: (hopUrl) => {
                const init: RequestInit = { method, headers };
                if (body !== undefined) {
                    // Cast: a Uint8Array IS a valid `fetch` body at runtime, but
                    // the DOM lib's `BodyInit` names `ArrayBufferView<ArrayBuffer>`
                    // and a `Uint8Array<ArrayBufferLike>` does not satisfy it.
                    init.body = body as BodyInit;
                }
                const dispatcher = dispatcherFor(hopUrl);
                if (dispatcher) {
                    (init as RequestInit & { dispatcher: unknown }).dispatcher = dispatcher;
                }
                return init;
            },
            // `next.host`, not `next.hostname`, so an explicit port travels with
            // the host and an allowlist entry without one cannot silently match
            // a redirect to a different port. Awaited: an async rejection that
            // is not awaited cannot stop the in-flight request.
            //
            // The refusal is re-thrown NON-retryable. `fetchStatusText` retries,
            // and the shared client classifies any non-HttpError as a transient
            // transport failure — so a plain throw here would be REPEATED,
            // giving a host that resolves differently per lookup several chances
            // inside one run to flip from refused to allowed. The library's own
            // `downloadToFile` wraps its `authorizeHost` refusal for the same
            // reason.
            redirectPolicy: async (_originHost, next) => {
                try {
                    await authorizeHost(next.host);
                } catch (error) {
                    throw new HttpError(error instanceof Error ? error.message : String(error), false);
                }
                return true;
            },
        });

        // Outside the retrying accessor, so this refusal is already fatal.
        await authorizeHost(new URL(url).hostname);
        // `fetchStatusText`, not a hand-rolled `consume`: a caller-supplied
        // consume owns the body and never reaches the shared client's
        // `readBounded`, so `maxResponseBytes` silently did not apply to it and
        // a hostile or wedged registry could stream until the runner OOMed —
        // while `waitForVersion`/`waitForOk` re-issued the same request every
        // three seconds. This accessor returns the status alongside a BOUNDED
        // body.
        return client.fetchStatusText(url, METADATA_TIMEOUT_MS);
    };
}

/**
 * Flattens an error and its `cause` chain into a single line.
 *
 * `fetch` reports a refused handshake as a bare "fetch failed" and keeps the
 * reason one level down, so the unflattened message tells an operator nothing.
 * Which reason it is decides what they do next: an untrusted private CA
 * (`DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`) means
 * `ca-cert` is missing or wrong, while a hostname mismatch
 * (`ERR_TLS_CERT_ALTNAME_INVALID`) means the certificate does not name the host
 * they pointed at.
 */
export function describeError(error: unknown): string {
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; current instanceof Error && depth < 5; depth++) {
        const { code } = current as NodeJS.ErrnoException;
        parts.push(code ? `${current.message} (${code})` : current.message);
        current = (current as { cause?: unknown }).cause;
    }
    return parts.length > 0 ? parts.join(': ') : String(error);
}

/**
 * Makes a registry-controlled response body safe to put in a message that
 * reaches `core.setFailed`.
 *
 * The body is chosen by whatever host `registry-url` / `hcp-address` names, and
 * `core.setFailed` writes it as an `::error::` workflow command that the runner
 * renders as a job-level annotation in the PR Checks UI. GitHub's own escaping
 * covers only `%`, CR and LF, so without this the peer picks both the LENGTH of
 * the consumer's annotation — enough volume buries the real error — and every
 * other C0 control character in it. `truncateForLog` strips first and truncates
 * second, so a control character cannot ride in on the boundary.
 */
export function bodyExcerpt(body: string): string {
    return truncateForLog(body, 512);
}

/**
 * Parses a JSON response body into the requested shape.
 *
 * The cast is a compile-time fiction — nothing here validates that the parsed
 * value matches `T`, and callers must guard the shapes they then index into.
 * What this DOES guarantee is that a body which is not JSON at all fails with a
 * message naming which response was bad and showing a bounded excerpt of it,
 * rather than the bare `SyntaxError: Unexpected token ...` that a registry, a
 * WAF or a proxy interstitial answering 2xx with an HTML error page used to
 * produce. That error propagated to the single top-level catch with none of the
 * calling context preserved.
 *
 * @param what names the response being parsed, e.g. `The registry module response`.
 */
export function parseJson<T>(body: string, what: string): T {
    try {
        return JSON.parse(body) as T;
    } catch {
        throw new Error(`${what} was not valid JSON: ${bodyExcerpt(body)}`);
    }
}

/** Resolves after the given number of milliseconds. */
export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The one place a failed HTTP response becomes an Error.
 *
 * Four call sites across the two publishers hand-wrote the identical
 * `Failed to <action> (HTTP <status>): <body>` template. That is where the
 * registry-controlled body reaches `core.setFailed`, so every hardening of how
 * a remote body is surfaced — bounding it, stripping control characters,
 * whatever comes next — had to be applied four times and was easy to apply to
 * three. It is applied once now, and `debug` carries the FULL body to the
 * `ACTIONS_STEP_DEBUG` channel so nothing is lost, only bounded.
 */
export function httpError(
    action: string,
    resp: HttpResponse,
    debug: (message: string) => void = () => {},
): Error {
    debug(`${action} response body: ${resp.body}`);
    return new Error(`Failed to ${action} (HTTP ${resp.status}): ${bodyExcerpt(resp.body)}`);
}

/** Strips every trailing slash from a base URL. */
export function trimTrailingSlash(url: string): string {
    return url.replace(/\/+$/, '');
}

/**
 * Polls `check` until it returns true or the deadline passes.
 *
 * Both publishers had this loop written out separately — same skeleton, same
 * 3-second interval, differing only in which URL they fetched and which
 * predicate they applied — so the errors domain's observation that the deadline
 * is checked AFTER the request (a hung request outlives the timeout; the
 * per-request timeout in the shared client is what actually bounds that) held
 * in two places and any fix had to land in two places.
 *
 * A transient failure mid-poll is not fatal. By the time this runs the side
 * effect that matters has already succeeded — the sync is triggered, or the
 * version is created — so letting one DNS blip or one 502 abort the wait
 * reports total failure for a publish that worked. Failures are retried until
 * the deadline and the last one is surfaced only if the deadline is reached.
 */
export async function pollUntil(
    check: () => Promise<boolean>,
    timeoutSeconds: number,
    onTransient: (message: string) => void = () => {},
    intervalMs = 3000,
): Promise<boolean> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    for (;;) {
        try {
            if (await check()) return true;
        } catch (error) {
            if (Date.now() >= deadline) return false;
            onTransient(`Poll attempt failed, retrying until the deadline: ${describeError(error)}`);
        }
        if (Date.now() >= deadline) return false;
        await delay(intervalMs);
    }
}
