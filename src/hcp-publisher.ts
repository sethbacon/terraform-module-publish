import { HttpClient, bodyExcerpt, parseJson, delay } from './http';
import { ModuleCoordinates, PublishResult, RegistryPublisher } from './types';

/** Inputs for publishing to HCP Terraform / Terraform Enterprise. */
export interface HcpOptions extends ModuleCoordinates {
    address: string;
    token: string;
    vcsRepoIdentifier: string;
    vcsBranch: string;
    vcsOauthTokenId: string;
    commitSha: string;
    waitForPublish: boolean;
    timeoutSeconds: number;
}

interface VersionStatus {
    version: string;
    status: string;
}

interface HcpModuleResponse {
    data?: {
        attributes?: {
            'version-statuses'?: VersionStatus[];
            'vcs-repo'?: { branch?: string } | null;
        };
    };
}

interface HcpVersionResponse {
    data?: {
        links?: { upload?: string };
    };
}

/**
 * How a module's versions come into being, which decides whether this action
 * can complete a publish at all.
 *
 * HCP's registry-modules API splits modules in two: a VCS module linked to a
 * branch, and a module with no VCS repo, both take versions from
 * `POST .../versions` followed by a PUT of a gzipped module archive to the
 * `links.upload` URL the response returns — the version sits at status
 * `pending` until that upload lands. A VCS module linked by TAG takes its
 * versions from pushed git tags automatically and never uses that endpoint.
 */
export type PublishMode = 'tag-based' | 'upload-driven';

type HcpModuleRef = ModuleCoordinates & { address: string };

export function moduleUrl(o: HcpModuleRef): string {
    const base = o.address.replace(/\/+$/, '');
    return (
        `${base}/api/v2/organizations/${encodeURIComponent(o.namespace)}/registry-modules/private/` +
        `${encodeURIComponent(o.namespace)}/${encodeURIComponent(o.name)}/${encodeURIComponent(o.provider)}`
    );
}

export function versionsUrl(o: HcpModuleRef): string {
    return `${moduleUrl(o)}/versions`;
}

export function vcsUrl(address: string, namespace: string): string {
    return `${address.replace(/\/+$/, '')}/api/v2/organizations/${encodeURIComponent(namespace)}/registry-modules/vcs`;
}

/**
 * Reads one version's status out of HCP's module description.
 *
 * `Array.isArray` rather than `?? []`: the nullish default only substitutes for
 * null/undefined, so a `version-statuses` that is present but a TRUTHY non-array
 * — an object, a string, whatever an intermediary or a compromised endpoint
 * chose to send — reached `.find` and threw `TypeError: statuses.find is not a
 * function` from inside the wait loop. `hasVersion` in the private publisher,
 * this function's structural twin, already guarded its array; this one did not.
 * A non-array is treated as "no known status", which is what the callers'
 * `=== 'ok'` comparison already means by "not ready yet".
 */
export function versionStatus(body: string, version: string): string | undefined {
    const parsed = parseJson<HcpModuleResponse>(body, 'The HCP Terraform module response');
    const statuses = parsed.data?.attributes?.['version-statuses'];
    if (!Array.isArray(statuses)) {
        return undefined;
    }
    return statuses.find((s) => s?.version === version)?.status;
}

/**
 * Reads a module's publish mode off the registry's own description of it,
 * rather than guessing from the action's inputs.
 *
 * A `vcs-repo` with a branch is branch-based and an absent `vcs-repo` is a
 * no-VCS module; both take content by upload. A `vcs-repo` without a branch is
 * tag-based, and HCP fills its versions in from pushed tags.
 */
export function publishMode(body: string): PublishMode {
    const vcsRepo = parseJson<HcpModuleResponse>(body, 'The HCP Terraform module response').data
        ?.attributes?.['vcs-repo'];
    return vcsRepo && !vcsRepo.branch ? 'tag-based' : 'upload-driven';
}

/**
 * True when HCP answered a version creation with an archive-upload URL, which
 * is HCP stating that the version it just created is `pending` and stays that
 * way until module content is PUT to that URL.
 */
export function requiresContentUpload(body: string): boolean {
    try {
        return Boolean(
            parseJson<HcpVersionResponse>(body, 'The HCP Terraform version response').data?.links
                ?.upload,
        );
    } catch {
        // A body that is not JSON cannot be asserting an upload requirement.
        return false;
    }
}

/**
 * Body for creating a VCS-connected module.
 *
 * `branch` is omitted entirely when no branch was requested, which is what
 * makes the created module TAG-based: HCP then imports each pushed git tag as
 * a version on its own. Sending `branch: ""` would instead create a
 * branch-based module, whose versions need an archive upload this action does
 * not perform.
 */
export function vcsModuleBody(o: HcpOptions): string {
    const vcsRepo: Record<string, string> = {
        identifier: o.vcsRepoIdentifier,
        'display-identifier': o.vcsRepoIdentifier,
        'oauth-token-id': o.vcsOauthTokenId,
    };
    if (o.vcsBranch) {
        vcsRepo.branch = o.vcsBranch;
    }
    return JSON.stringify({
        data: {
            type: 'registry-modules',
            attributes: {
                'vcs-repo': vcsRepo,
                'no-code': false,
            },
        },
    });
}

export function versionBody(version: string, commitSha: string): string {
    return JSON.stringify({
        data: {
            type: 'registry-modules-versions',
            attributes: { version, 'commit-sha': commitSha },
        },
    });
}

/**
 * Publishes a module version to HCP Terraform: checks the module, creates a VCS-connected module
 * if it does not exist, creates the version, and (optionally) waits for it to become ready.
 */
export class HcpPublisher implements RegistryPublisher {
    constructor(
        private readonly http: HttpClient,
        private readonly options: HcpOptions,
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
        const o = this.options;
        const headers = {
            Authorization: `Bearer ${o.token}`,
            'Content-Type': 'application/vnd.api+json',
        };

        let mode: PublishMode;
        const check = await this.http('GET', moduleUrl(o), headers);
        if (check.status >= 200 && check.status < 300) {
            if (versionStatus(check.body, o.version) === 'ok') {
                return { published: false, message: `Version ${o.version} already exists and is ready.` };
            }
            mode = publishMode(check.body);
        } else if (check.status === 404) {
            if (!o.vcsRepoIdentifier || !o.vcsOauthTokenId) {
                throw new Error(
                    'Module does not exist and vcsRepoIdentifier / vcsOauthTokenId were not provided to create it.',
                );
            }
            this.log(`Module not found; creating VCS-connected module ${o.namespace}/${o.name}/${o.provider}.`);
            const created = await this.http('POST', vcsUrl(o.address, o.namespace), headers, vcsModuleBody(o));
            if (created.status < 200 || created.status >= 300) {
                this.debug(`HCP module-creation response body: ${created.body}`);
                throw new Error(
                    `Failed to create HCP module (HTTP ${created.status}): ${bodyExcerpt(created.body)}`,
                );
            }
            mode = o.vcsBranch ? 'upload-driven' : 'tag-based';
        } else {
            this.log(`Could not check existing module (HTTP ${check.status}); assuming the mode implied by vcs-branch.`);
            mode = o.vcsBranch ? 'upload-driven' : 'tag-based';
        }

        return mode === 'tag-based' ? this.publishTagBased(headers) : this.publishUploadDriven(headers);
    }

    /**
     * Tag-based module: HCP imports the version from the git tag the workflow
     * pushed, so there is nothing for this action to create — `POST
     * .../versions` does not apply to this class of module — and nothing to
     * upload. All that remains is to observe the import, if asked to.
     */
    private async publishTagBased(headers: Record<string, string>): Promise<PublishResult> {
        const o = this.options;
        if (!o.waitForPublish) {
            return {
                published: true,
                message:
                    `Module ${o.namespace}/${o.name}/${o.provider} is tag-based: HCP Terraform imports version ` +
                    `${o.version} from the pushed git tag. Not waiting for the import (wait-for-publish: false).`,
            };
        }
        if (!(await this.waitForOk(headers))) {
            throw new Error(
                `Timed out after ${o.timeoutSeconds}s waiting for HCP Terraform to import version ${o.version} ` +
                    'from the pushed git tag.',
            );
        }
        return { published: true, message: `Version ${o.version} is ready in HCP Terraform.` };
    }

    /**
     * Branch-based or no-VCS module: the version is created through the API and
     * stays at status `pending` until a gzipped module archive is uploaded.
     * This action has no module content to send, so a version HCP reports as
     * upload-pending fails the step instead of being announced as published.
     */
    private async publishUploadDriven(headers: Record<string, string>): Promise<PublishResult> {
        const o = this.options;
        const versionResp = await this.http('POST', versionsUrl(o), headers, versionBody(o.version, o.commitSha));
        if (versionResp.status === 422) {
            this.log(`Version ${o.version} already exists.`);
        } else if (versionResp.status < 200 || versionResp.status >= 300) {
            this.debug(`HCP version-creation response body: ${versionResp.body}`);
            throw new Error(
                `Failed to create version (HTTP ${versionResp.status}): ${bodyExcerpt(versionResp.body)}`,
            );
        } else if (requiresContentUpload(versionResp.body)) {
            // The upload URL HCP returned is deliberately NOT echoed: it is a
            // bearer capability to write that object, and step logs are not the
            // place for one.
            throw new Error(
                `Version ${o.version} was created but HCP Terraform holds it at status 'pending' until a module ` +
                    'archive is uploaded, and this action does not upload module content. Publish tag-based ' +
                    "instead by leaving 'vcs-branch' empty, so HCP imports the version from the pushed git tag; " +
                    'or upload the archive yourself using the upload URL from the versions API. See the HCP ' +
                    'section of the action README.',
            );
        } else {
            this.log(`Version ${o.version} created.`);
        }

        if (o.waitForPublish && !(await this.waitForOk(headers))) {
            throw new Error(`Timed out after ${o.timeoutSeconds}s waiting for version ${o.version} to become ready.`);
        }
        return { published: true, message: `Version ${o.version} published to HCP Terraform.` };
    }

    private async waitForOk(headers: Record<string, string>): Promise<boolean> {
        const deadline = Date.now() + this.options.timeoutSeconds * 1000;
        for (;;) {
            const resp = await this.http('GET', moduleUrl(this.options), headers);
            if (
                resp.status >= 200 &&
                resp.status < 300 &&
                versionStatus(resp.body, this.options.version) === 'ok'
            ) {
                return true;
            }
            if (Date.now() >= deadline) {
                return false;
            }
            await delay(3000);
        }
    }
}
