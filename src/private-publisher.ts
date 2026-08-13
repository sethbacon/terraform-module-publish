import { validateUrlPathSegment } from '@4cloudguru/pipeline-task-core';
import { HttpClient, bodyExcerpt, parseJson, delay } from './http';
import { ModuleCoordinates, PublishResult, RegistryPublisher } from './types';

/** Inputs for publishing to a private registry (terraform-registry-backend). */
export interface PrivateRegistryOptions extends ModuleCoordinates {
    registryUrl: string;
    apiKey: string;
    waitForPublish: boolean;
    timeoutSeconds: number;
}

interface ModuleVersionEntry {
    version: string;
}

interface ModuleResponse {
    id?: string;
    versions?: ModuleVersionEntry[];
}

export function trimTrailingSlash(url: string): string {
    return url.replace(/\/+$/, '');
}

export function moduleUrl(base: string, c: ModuleCoordinates): string {
    return (
        `${trimTrailingSlash(base)}/api/v1/modules/` +
        `${encodeURIComponent(c.namespace)}/${encodeURIComponent(c.name)}/${encodeURIComponent(c.provider)}`
    );
}

/**
 * Builds the admin tag-sync URL for a module id the REGISTRY supplied.
 *
 * Unlike the coordinates in {@link moduleUrl}, `moduleId` is not an author
 * input: it is read out of the registry's own JSON response and then lands in
 * the path of an authenticated admin POST carrying the same Bearer key. It is
 * REJECTED rather than encoded. The registry mints module ids as UUIDs, so a
 * value needing escaping is not an id it issues — encoding would defuse the
 * traversal but still send the credentialed admin request at a compromised
 * registry's direction, and would hide that the peer misbehaved. The shared
 * validator refuses `..` as well as every path-, query- and fragment-meaningful
 * character, so `a/../b`, `%2e%2e%2f`, `1?owner=2#` and whitespace all fail
 * before a request is issued.
 */
export function syncUrl(base: string, moduleId: string): string {
    const id = validateUrlPathSegment('The module id in the registry response', moduleId);
    return `${trimTrailingSlash(base)}/api/v1/admin/modules/${id}/scm/sync`;
}

export function hasVersion(body: string, version: string): boolean {
    const parsed = parseJson<ModuleResponse>(body, 'The registry module response');
    return Array.isArray(parsed.versions) && parsed.versions.some((v) => v?.version === version);
}

/**
 * Publishes by triggering the registry's SCM tag-sync. The module must already exist and be
 * SCM-linked; the registry imports the freshly-pushed git tag as a new version.
 */
export class PrivateRegistryPublisher implements RegistryPublisher {
    constructor(
        private readonly http: HttpClient,
        private readonly options: PrivateRegistryOptions,
        private readonly log: (message: string) => void = console.log,
        /**
         * Diagnostic channel for the FULL response body of a failed request.
         * Wired to `core.debug`, so it is suppressed unless the consumer sets
         * `ACTIONS_STEP_DEBUG` — the always-visible annotation gets only the
         * bounded, control-character-stripped excerpt.
         */
        private readonly debug: (message: string) => void = () => {},
    ) {}

    async publish(): Promise<PublishResult> {
        const { registryUrl, apiKey, namespace, name, provider, version } = this.options;
        const authHeader = { Authorization: `Bearer ${apiKey}` };
        const modUrl = moduleUrl(registryUrl, this.options);

        const moduleResp = await this.http('GET', modUrl, authHeader);
        if (moduleResp.status === 404) {
            throw new Error(
                `Module ${namespace}/${name}/${provider} not found in the registry. ` +
                    'Register and SCM-link the module before publishing.',
            );
        }
        if (moduleResp.status < 200 || moduleResp.status >= 300) {
            this.debug(`Registry module-resolution response body: ${moduleResp.body}`);
            throw new Error(
                `Failed to resolve module (HTTP ${moduleResp.status}): ${bodyExcerpt(moduleResp.body)}`,
            );
        }
        const moduleId = parseJson<ModuleResponse>(moduleResp.body, 'The registry module response').id;
        if (!moduleId) {
            throw new Error('Registry response did not include a module id.');
        }

        const syncResp = await this.http('POST', syncUrl(registryUrl, moduleId), authHeader);
        if (syncResp.status !== 202) {
            this.debug(`Registry sync-trigger response body: ${syncResp.body}`);
            throw new Error(
                `Failed to trigger sync (HTTP ${syncResp.status}): ${bodyExcerpt(syncResp.body)}`,
            );
        }
        this.log(`Sync triggered for ${namespace}/${name}/${provider}.`);

        if (!this.options.waitForPublish) {
            return { published: true, message: `Sync triggered for version ${version}.` };
        }

        if (!(await this.waitForVersion(modUrl, authHeader))) {
            throw new Error(
                `Timed out after ${this.options.timeoutSeconds}s waiting for version ${version} to appear in the registry.`,
            );
        }
        return { published: true, message: `Version ${version} is available in the registry.` };
    }

    private async waitForVersion(modUrl: string, authHeader: Record<string, string>): Promise<boolean> {
        const deadline = Date.now() + this.options.timeoutSeconds * 1000;
        for (;;) {
            const resp = await this.http('GET', modUrl, authHeader);
            if (resp.status >= 200 && resp.status < 300 && hasVersion(resp.body, this.options.version)) {
                return true;
            }
            if (Date.now() >= deadline) {
                return false;
            }
            await delay(3000);
        }
    }
}
