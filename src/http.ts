import { METADATA_TIMEOUT_MS, createHttpClient } from '@4cloudguru/pipeline-task-core';
import { Agent } from 'undici';
import { URL } from 'url';
import { AuthorizeHost } from './egress';

export interface HttpResponse {
    status: number;
    body: string;
}

export type HttpClient = (
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string,
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
 * @param authorizeHost the egress-authorization decision from `./egress`.
 * @param options trust anchor and test seams; see {@link HttpsClientOptions}.
 */
export function createHttpsClient(authorizeHost: AuthorizeHost, options: HttpsClientOptions = {}): HttpClient {
    const { caCert, fetchImpl } = options;
    // One dispatcher for the client's lifetime, built only when the operator
    // supplied a trust anchor; Node's fetch has no other way to reach that
    // socket option.
    const dispatcher = caCert ? new Agent({ connect: { ca: caCert } }) : undefined;

    return async (method, url, headers, body) => {
        const client = createHttpClient({
            fetchImpl,
            fetchOptions: () => {
                const init: RequestInit = { method, headers };
                if (body !== undefined) {
                    init.body = body;
                }
                if (dispatcher) {
                    (init as RequestInit & { dispatcher: unknown }).dispatcher = dispatcher;
                }
                return init;
            },
            // `next.host`, not `next.hostname`, so an explicit port travels with
            // the host and an allowlist entry without one cannot silently match
            // a redirect to a different port. Awaited: an async rejection that
            // is not awaited cannot stop the in-flight request.
            redirectPolicy: async (_originHost, next) => {
                await authorizeHost(next.host);
                return true;
            },
        });

        await authorizeHost(new URL(url).hostname);
        return client.fetchWithTimeout(url, METADATA_TIMEOUT_MS, async (response) => ({
            status: response.status,
            body: await response.text(),
        }));
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

/** Parses a JSON response body into the requested shape. */
export function parseJson<T>(body: string): T {
    return JSON.parse(body) as T;
}

/** Resolves after the given number of milliseconds. */
export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
