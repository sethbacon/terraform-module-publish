import { assertEgressHostAllowed, parseAllowedHosts } from '@4cloudguru/pipeline-task-core';

/**
 * Authorizes ONE destination host before it is contacted. Throws to refuse, so
 * the rejection carries a message naming the offending host.
 */
export type AuthorizeHost = (host: string) => Promise<void>;

/** DNS resolver shape used by the egress check; overridden only by tests. */
export type Lookup = (host: string) => Promise<{ address: string }[]>;

/**
 * Builds the publisher's egress-authorization decision from the operator's
 * `registry-allowed-hosts` input, and applies it — via
 * `@4cloudguru/pipeline-task-core` — to the initial URL and to every redirect
 * hop. `registry-url` / `hcp-address` are operator-supplied and every request
 * carries the registry `Authorization: Bearer` credential, so an unchecked
 * destination hands that credential to whatever host the URL (or a redirect off
 * it) names, including the cloud instance-metadata service.
 *
 *  - allowed hosts set   -> only those hosts are permitted, on every hop. This
 *    is how a deliberately-private, self-hosted registry stays reachable.
 *  - allowed hosts empty -> default deny: refuse a host that IS a private/
 *    link-local/reserved address in any spelling, or that RESOLVES to one. A
 *    registry on an ordinary public host — including the default
 *    app.terraform.io — is unaffected.
 *
 * The classification is numeric, not textual, so `127.1`, `2130706433`,
 * `0x7f000001`, `017700000001` and `[::ffff:127.0.0.1]` are all recognised as
 * loopback.
 */
export function createHostAuthorizer(rawAllowedHosts: string, lookup?: Lookup): AuthorizeHost {
    const allowedHosts = parseAllowedHosts(rawAllowedHosts);
    return (host) =>
        assertEgressHostAllowed(
            host,
            allowedHosts,
            {
                notAllowed: (hostname, allowed) =>
                    `Refusing to contact registry host ${hostname}: it is not in registry-allowed-hosts (${allowed}).`,
                isPrivate: (hostname) =>
                    `Refusing to contact registry host ${hostname}: it is a private, link-local or otherwise ` +
                    `reserved address. Set registry-allowed-hosts to explicitly permit a trusted internal registry.`,
            },
            lookup,
        );
}
