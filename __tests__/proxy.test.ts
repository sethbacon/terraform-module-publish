import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { ProxyAgent } from 'undici';
import { createHostAuthorizer } from '../src/egress';
import { createHttpsClient } from '../src/http';

/**
 * The class test for routing the credentialed registry calls through the
 * runner's configured egress proxy.
 *
 * The property under test is NOT "a proxy is used". It is that introducing one
 * does not become a way around egress authorization, and that the decision is
 * re-taken per hop:
 *
 *  - the proxy is resolved from the DESTINATION of each hop, so a redirect off
 *    the origin (a registry pointing a download at a CDN) is routed by its own
 *    destination and not by the original URL's;
 *  - `authorizeHost` keeps running against the destination and is never asked
 *    about the proxy, so a CONNECT tunnel to an unauthorized host is still
 *    unauthorized egress;
 *  - an allowlisted PROXY does not launder an unallowlisted destination.
 *
 * A test that only asserts a refusal passes just as well when proxying is
 * entirely broken, so the last describe block is a positive control: a real
 * CONNECT proxy in front of a real TLS endpoint, asserting the tunnel was
 * actually established and the response came back through it.
 */

const DEST = 'https://registry.example.com/v1/modules';
const PROXY = 'http://proxy.internal:3128';

interface Hop {
    status: number;
    location?: string;
    body?: string;
}

/** Records the dispatcher handed to each hop, and replays a scripted redirect chain. */
function recordingFetch(hops: Hop[]) {
    const calls: { url: string; dispatcher: unknown }[] = [];
    const impl = (async (input: unknown, init?: Record<string, unknown>) => {
        const url = String(input);
        calls.push({ url, dispatcher: init?.dispatcher });
        const hop = hops[calls.length - 1];
        if (!hop) throw new Error(`unscripted hop ${calls.length} to ${url}`);
        return new Response(hop.body ?? '{"ok":true}', {
            status: hop.status,
            headers: hop.location ? { location: hop.location } : {},
        });
    }) as unknown as typeof fetch;
    return { impl, calls };
}

/** True when the hop went through a proxy rather than straight out. */
const proxied = (dispatcher: unknown): boolean => dispatcher instanceof ProxyAgent;

// ---------------------------------------------------------------------------
// Per-hop resolution
// ---------------------------------------------------------------------------

interface HopRow {
    what: string;
    env: Record<string, string>;
    /** Destination of hop 2, reached by a 302 from DEST. */
    redirectTo: string;
    /** Whether each hop must be proxied, in order. */
    expect: boolean[];
}

const HOP_ROWS: HopRow[] = [
    {
        what: 'no proxy configured: every hop goes direct',
        env: {},
        redirectTo: 'https://cdn.example.com/v1/modules',
        expect: [false, false],
    },
    {
        what: 'a proxy with no NO_PROXY: every hop is tunnelled',
        env: { HTTPS_PROXY: PROXY },
        redirectTo: 'https://cdn.example.com/v1/modules',
        expect: [true, true],
    },
    {
        // Resolving once for the original URL would have proxied hop 2 as well,
        // handing the registry bearer to a proxy that NO_PROXY says must not
        // see this destination.
        what: 'a redirect INTO NO_PROXY leaves the proxy behind',
        env: { HTTPS_PROXY: PROXY, NO_PROXY: 'internal.example.com' },
        redirectTo: 'https://internal.example.com/v1/modules',
        expect: [true, false],
    },
    {
        // The sharpest row. Resolving once for the original URL would have sent
        // hop 2 direct too — the request the organisation's chokepoint never
        // sees, which is the whole defect this fix exists to close.
        what: 'a redirect OUT OF NO_PROXY picks the proxy up',
        env: { HTTPS_PROXY: PROXY, NO_PROXY: 'registry.example.com' },
        redirectTo: 'https://cdn.example.com/v1/modules',
        expect: [false, true],
    },
    {
        what: 'NO_PROXY covering both ends keeps both hops direct',
        env: { HTTPS_PROXY: PROXY, NO_PROXY: 'registry.example.com,cdn.example.com' },
        redirectTo: 'https://cdn.example.com/v1/modules',
        expect: [false, false],
    },
    {
        // http_proxy is not the variable for an https destination; reading it
        // would route a credentialed request through a proxy never nominated
        // for it.
        what: 'HTTP_PROXY alone does not route an https destination',
        env: { HTTP_PROXY: PROXY },
        redirectTo: 'https://cdn.example.com/v1/modules',
        expect: [false, false],
    },
];

describe('the proxy decision is re-taken for every hop', () => {
    it.each(HOP_ROWS)('$what', async (row) => {
        const { impl, calls } = recordingFetch([{ status: 302, location: row.redirectTo }, { status: 200 }]);
        const client = createHttpsClient(
            // Both destinations allowlisted, so the egress decision is not what
            // is being measured here.
            createHostAuthorizer('registry.example.com,cdn.example.com,internal.example.com'),
            { fetchImpl: impl, env: row.env },
        );
        const response = await client('GET', DEST, { Authorization: 'Bearer key' });
        expect(response).toEqual({ status: 200, body: '{"ok":true}' });
        expect(calls.map((c) => c.url)).toEqual([DEST, row.redirectTo]);
        expect(calls.map((c) => proxied(c.dispatcher))).toEqual(row.expect);
    });

    it('reuses ONE dispatcher per proxy across every request the client makes', async () => {
        // Client-lifetime, not per-request: waitForVersion/waitForOk re-issue a
        // request every three seconds, so a dispatcher built per request would
        // leak a connection pool per poll.
        const { impl, calls } = recordingFetch([{ status: 200 }, { status: 200 }, { status: 200 }]);
        const client = createHttpsClient(createHostAuthorizer('registry.example.com'), {
            fetchImpl: impl,
            env: { HTTPS_PROXY: PROXY },
        });
        await client('GET', DEST, {});
        await client('GET', DEST, {});
        await client('GET', DEST, {});
        expect(calls).toHaveLength(3);
        expect(calls.every((c) => proxied(c.dispatcher))).toBe(true);
        expect(new Set(calls.map((c) => c.dispatcher)).size).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// A proxy is not a way around egress authorization
// ---------------------------------------------------------------------------

describe('a proxy never widens the egress decision', () => {
    it('refuses an unauthorized destination even when a proxy is configured, without issuing the request', async () => {
        const { impl, calls } = recordingFetch([{ status: 200 }]);
        const client = createHttpsClient(createHostAuthorizer('allowed.example.com'), {
            fetchImpl: impl,
            env: { HTTPS_PROXY: PROXY },
        });
        await expect(client('GET', DEST, {})).rejects.toThrow(
            /registry\.example\.com.*not in registry-allowed-hosts/,
        );
        expect(calls, 'the request must not reach the proxy at all').toHaveLength(0);
    });

    it('an allowlisted PROXY does not launder an unallowlisted destination', async () => {
        // The bypass this whole shape exists to prevent: the operator permits
        // the proxy host, and a CONNECT tunnel through it to an unauthorized
        // destination is nevertheless still unauthorized egress.
        const { impl, calls } = recordingFetch([{ status: 200 }]);
        const client = createHttpsClient(createHostAuthorizer('proxy.internal'), {
            fetchImpl: impl,
            env: { HTTPS_PROXY: PROXY },
        });
        await expect(client('GET', DEST, {})).rejects.toThrow(
            /registry\.example\.com.*not in registry-allowed-hosts/,
        );
        expect(calls).toHaveLength(0);
    });

    it('refuses a tunnelled redirect hop to an unauthorized host', async () => {
        const { impl, calls } = recordingFetch([
            { status: 302, location: 'https://attacker.example.com/collect' },
            { status: 200 },
        ]);
        const client = createHttpsClient(createHostAuthorizer('registry.example.com'), {
            fetchImpl: impl,
            env: { HTTPS_PROXY: PROXY },
        });
        await expect(client('GET', DEST, {})).rejects.toThrow(
            /attacker\.example\.com.*not in registry-allowed-hosts/,
        );
        // Hop 1 happened; hop 2 was refused before it was issued.
        expect(calls).toHaveLength(1);
    });

    it('never asks the authorizer about the proxy — only about destinations', async () => {
        // A structural proof rather than an outcome one: whatever the verdict,
        // the SUBJECT of the decision must always be a destination. If the proxy
        // were ever the subject, an allowlist naming it would start deciding
        // requests that are not addressed to it.
        const asked: string[] = [];
        const authorize = createHostAuthorizer('registry.example.com,cdn.example.com');
        const recording = async (host: string) => {
            asked.push(host);
            await authorize(host);
        };
        const { impl } = recordingFetch([
            { status: 302, location: 'https://cdn.example.com/v1/modules' },
            { status: 200 },
        ]);
        const client = createHttpsClient(recording, { fetchImpl: impl, env: { HTTPS_PROXY: PROXY } });
        await client('GET', DEST, {});
        expect(asked).toEqual(['registry.example.com', 'cdn.example.com']);
        expect(asked).not.toContain('proxy.internal');
        expect(asked.join(' ')).not.toMatch(/proxy/);
    });

    it('the default-deny arm still refuses a private destination through a proxy', async () => {
        // With no allowlist the private-address refusal is the control, and a
        // proxy must not be a way to reach 169.254.169.254 from a job that
        // could not reach it directly.
        const { impl, calls } = recordingFetch([{ status: 200 }]);
        const client = createHttpsClient(createHostAuthorizer(''), {
            fetchImpl: impl,
            env: { HTTPS_PROXY: PROXY },
        });
        await expect(client('GET', 'https://169.254.169.254/latest/meta-data/', {})).rejects.toThrow(
            /private, link-local or otherwise/,
        );
        expect(calls).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Fail closed, and mask what the environment carried in
// ---------------------------------------------------------------------------

describe('an unusable proxy variable fails the step rather than going direct', () => {
    it('refuses, names the variable, never echoes its value, and does not retry', async () => {
        let reads = 0;
        const env = {
            get HTTPS_PROXY() {
                reads++;
                return 'not a url';
            },
        } as unknown as Record<string, string>;
        const { impl, calls } = recordingFetch([{ status: 200 }]);
        const client = createHttpsClient(createHostAuthorizer('registry.example.com'), {
            fetchImpl: impl,
            env,
        });
        const error = await client('GET', DEST, {}).then(
            () => null,
            (e: unknown) => e as Error,
        );
        expect(error, 'a malformed proxy variable must not silently go direct').not.toBeNull();
        expect(error?.message).toMatch(/HTTPS_PROXY/);
        expect(error?.message, 'the value can carry a password and must never be echoed').not.toMatch(
            /not a url/,
        );
        expect(calls, 'nothing may be sent when the route cannot be determined').toHaveLength(0);
        // Non-retryable: a configuration error resolved once, not three times.
        expect(reads).toBe(1);
    });
});

describe('proxy credentials are registered with the job mask', () => {
    it('masks every representation, once, across every request', async () => {
        const secrets: string[] = [];
        const { impl } = recordingFetch([{ status: 200 }, { status: 200 }]);
        const client = createHttpsClient(createHostAuthorizer('registry.example.com'), {
            fetchImpl: impl,
            env: { HTTPS_PROXY: 'http://bob:hunter2@proxy.internal:3128' },
            setSecret: (s) => secrets.push(s),
        });
        await client('GET', DEST, {});
        await client('GET', DEST, {});
        expect(secrets).toContain('hunter2');
        // Deduped across requests: one ::add-mask:: per distinct secret, not one
        // per poll.
        expect(new Set(secrets).size).toBe(secrets.length);
    });
});

// ---------------------------------------------------------------------------
// Positive control: a REAL CONNECT tunnel actually carries the request
// ---------------------------------------------------------------------------

/**
 * Every assertion above is a refusal or a dispatcher identity, and all of them
 * would still pass if proxying never worked at all. This block is the control
 * that says it does: a real HTTP CONNECT proxy in front of a real TLS endpoint
 * served by a private CA.
 *
 * The load-bearing assertion is that the PROXY SAW THE CONNECT. Both servers are
 * on loopback, so a request that ignored the proxy entirely would also return
 * 200 — the tunnel record is the only thing that distinguishes "routed through
 * the chokepoint" from "went around it".
 */
let dir: string;
let tlsServer: https.Server;
let proxyServer: http.Server;
let tlsPort: number;
let proxyPort: number;
let caPem: string;
let connects: string[] = [];
let hits = 0;

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tmp-proxy-'));
    const keyPath = join(dir, 'key.pem');
    const certPath = join(dir, 'cert.pem');
    execFileSync(
        'openssl',
        [
            'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', keyPath, '-out', certPath,
            '-days', '2', '-subj', '/CN=localhost',
            '-addext', 'subjectAltName=DNS:localhost',
        ],
        { stdio: 'ignore' },
    );
    caPem = readFileSync(certPath, 'utf8');

    tlsServer = https.createServer(
        { key: readFileSync(keyPath), cert: readFileSync(certPath) },
        (_req, res) => {
            hits++;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true}');
        },
    );
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
    tlsPort = (tlsServer.address() as AddressInfo).port;

    // A minimal forward proxy: it answers CONNECT by opening a TCP socket to
    // the requested destination and splicing the two together, which is exactly
    // the tunnel an enterprise egress proxy provides.
    proxyServer = http.createServer((_req, res) => {
        res.writeHead(405);
        res.end();
    });
    proxyServer.on('connect', (req, clientSocket, head) => {
        connects.push(req.url ?? '');
        const [host, port] = (req.url ?? '').split(':');
        const upstream = net.connect(Number(port), host, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            upstream.write(head);
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
        });
        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
    proxyPort = (proxyServer.address() as AddressInfo).port;
}, 30_000);

afterAll(() => {
    tlsServer?.close();
    proxyServer?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('the registry call really travels through a configured proxy (real CONNECT tunnel)', () => {
    it('tunnels to the destination and returns its response', async () => {
        connects = [];
        hits = 0;
        const client = createHttpsClient(createHostAuthorizer('localhost'), {
            caCert: caPem,
            env: { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` },
        });
        const response = await client('GET', `https://localhost:${tlsPort}/v1/modules`, {
            Authorization: 'Bearer key',
        });
        expect(response).toEqual({ status: 200, body: '{"ok":true}' });
        // The control: the request went THROUGH the chokepoint, and the tunnel
        // was opened to the destination — not to some other host.
        expect(connects).toEqual([`localhost:${tlsPort}`]);
        expect(hits).toBe(1);
    }, 30_000);

    it('keeps verifying the destination certificate through the tunnel', async () => {
        // A tunnel must not become a way to lose peer verification: the private
        // CA is trusted for the DESTINATION handshake, so dropping the trust
        // anchor has to fail even though the proxy leg itself is plain HTTP.
        connects = [];
        const client = createHttpsClient(createHostAuthorizer('localhost'), {
            env: { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` },
        });
        await expect(client('GET', `https://localhost:${tlsPort}/v1/modules`, {})).rejects.toThrow();
        // The tunnel was opened and the TLS handshake INSIDE it is what failed —
        // more than once, because the shared client reads a refused handshake as
        // a transient transport failure and retries it. Every attempt must still
        // have been addressed to the destination.
        expect(connects.length).toBeGreaterThan(0);
        expect(new Set(connects)).toEqual(new Set([`localhost:${tlsPort}`]));
    }, 30_000);

    it('honours NO_PROXY against a real proxy, reaching the endpoint directly', async () => {
        connects = [];
        hits = 0;
        const client = createHttpsClient(createHostAuthorizer('localhost'), {
            caCert: caPem,
            env: { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: 'localhost' },
        });
        const response = await client('GET', `https://localhost:${tlsPort}/v1/modules`, {});
        expect(response).toEqual({ status: 200, body: '{"ok":true}' });
        expect(connects, 'NO_PROXY means the proxy must never be dialled').toEqual([]);
        expect(hits).toBe(1);
    }, 30_000);
});
