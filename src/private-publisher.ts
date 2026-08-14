import { validateUrlPathSegment } from '@4cloudguru/pipeline-task-core';
import { HttpClient, httpError, parseJson, pollUntil, trimTrailingSlash } from './http';
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
            throw httpError('resolve module', moduleResp, this.debug);
        }
        // Read BEFORE the sync is triggered, because afterwards the answer is
        // ambiguous. action.yml and the README both promise `published: "false"
        // if it already existed", and this path had two return points, both
        // `published: true` — it could not produce false for any input at all.
        // The sync is still triggered either way (it is idempotent, and
        // re-syncing an existing version is the harmless half of the promise);
        // what changes is that the OUTPUT now reports what actually happened,
        // so a consumer gating a release notification on `published == 'true'`
        // stops firing on every run.
        const alreadyPublished = hasVersion(moduleResp.body, version);

        const moduleId = parseJson<ModuleResponse>(moduleResp.body, 'The registry module response').id;
        if (!moduleId) {
            throw new Error('Registry response did not include a module id.');
        }

        const syncResp = await this.http('POST', syncUrl(registryUrl, moduleId), authHeader);
        if (syncResp.status !== 202) {
            throw httpError('trigger sync', syncResp, this.debug);
        }
        this.log(`Sync triggered for ${namespace}/${name}/${provider}.`);

        if (!this.options.waitForPublish) {
            return alreadyPublished
                ? { published: false, message: `Version ${version} already existed; sync re-triggered.` }
                : { published: true, message: `Sync triggered for version ${version}.` };
        }

        if (!(await this.waitForVersion(modUrl, authHeader))) {
            throw new Error(
                `Timed out after ${this.options.timeoutSeconds}s waiting for version ${version} to appear in the registry.`,
            );
        }
        return alreadyPublished
            ? { published: false, message: `Version ${version} already existed in the registry.` }
            : { published: true, message: `Version ${version} is available in the registry.` };
    }

    private waitForVersion(modUrl: string, authHeader: Record<string, string>): Promise<boolean> {
        return pollUntil(
            async () => {
                const resp = await this.http('GET', modUrl, authHeader);
                return resp.status >= 200 && resp.status < 300 && hasVersion(resp.body, this.options.version);
            },
            this.options.timeoutSeconds,
            this.debug,
        );
    }
}
