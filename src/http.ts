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
 * @param rejectUnauthorized when false, TLS certificate validation is disabled
 *        (only appropriate for internal registries fronted by a private CA the
 *        runner does not trust).
 * @param authorizeHost the egress-authorization decision from `./egress`.
 * @param fetchImpl `fetch` implementation, injectable so tests need no network.
 */
export function createHttpsClient(
    rejectUnauthorized: boolean,
    authorizeHost: AuthorizeHost,
    fetchImpl?: typeof fetch,
): HttpClient {
    // One dispatcher for the client's lifetime, built only when the operator
    // opted out of TLS verification; Node's fetch has no other way to reach
    // that socket option.
    const dispatcher = rejectUnauthorized ? undefined : new Agent({ connect: { rejectUnauthorized: false } });

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

/** Parses a JSON response body into the requested shape. */
export function parseJson<T>(body: string): T {
    return JSON.parse(body) as T;
}

/** Resolves after the given number of milliseconds. */
export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
