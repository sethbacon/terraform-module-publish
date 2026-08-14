import { extractUrlTokenSecrets, redactUrl, scrubSecretsFromMessage } from '@4cloudguru/pipeline-task-core';
import { URL } from 'url';
import { createModuleArchive } from './archive';
import { HttpClient, httpError, parseJson, pollUntil, trimTrailingSlash } from './http';
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
    /** Module root archived and uploaded for an upload-driven version. */
    moduleDirectory: string;
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
    const base = trimTrailingSlash(o.address);
    return (
        `${base}/api/v2/organizations/${encodeURIComponent(o.namespace)}/registry-modules/private/` +
        `${encodeURIComponent(o.namespace)}/${encodeURIComponent(o.name)}/${encodeURIComponent(o.provider)}`
    );
}

export function versionsUrl(o: HcpModuleRef): string {
    return `${moduleUrl(o)}/versions`;
}

/**
 * The organization's registry-modules collection: both where a module with NO
 * VCS connection is created and the base the VCS-connected creation endpoint
 * hangs off. Written once so the two cannot drift apart.
 */
export function createModuleUrl(address: string, namespace: string): string {
    return `${trimTrailingSlash(address)}/api/v2/organizations/${encodeURIComponent(namespace)}/registry-modules`;
}

export function vcsUrl(address: string, namespace: string): string {
    return `${createModuleUrl(address, namespace)}/vcs`;
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
 * The archive-upload URL HCP answered a version creation with, if any.
 *
 * Its presence is HCP stating that the version it just created is `pending` and
 * stays that way until module content is PUT to that URL. Only an https URL is
 * returned: the response body is chosen by whatever host `hcp-address` names,
 * and this value becomes a request destination carrying the module's source, so
 * a `http://` or `file:` spelling is refused here rather than handed to the
 * client. Host authorization happens separately, in the client, on this URL and
 * on every redirect off it.
 */
export function uploadUrl(body: string): string | undefined {
    let raw: string | undefined;
    try {
        raw = parseJson<HcpVersionResponse>(body, 'The HCP Terraform version response').data?.links?.upload;
    } catch {
        // A body that is not JSON cannot be asserting an upload requirement.
        return undefined;
    }
    if (!raw) return undefined;
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('HCP Terraform returned a module-archive upload link that is not a valid URL.');
    }
    if (parsed.protocol !== 'https:') {
        // The URL itself is not echoed: it is a bearer capability to write that
        // object, and the scheme is the whole of what the operator needs.
        throw new Error(
            `Refusing to upload the module archive: HCP Terraform returned an upload link with scheme ` +
                `'${parsed.protocol}', and the archive is only ever sent over https.`,
        );
    }
    return raw;
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

/**
 * Body for creating a private module with NO VCS connection.
 *
 * Shape taken from HCP Terraform's API documentation, Private Registry >
 * Modules, "Create a Module" — `POST /organizations/:organization_name/
 * registry-modules`, whose sample payload is
 * `{"data":{"type":"registry-modules","attributes":{"name":"my-module",
 * "provider":"aws","registry-name":"private","no-code":true}}}`. This is a
 * DIFFERENT endpoint from the `/vcs` one {@link vcsModuleBody} feeds, and it is
 * the one that produces a module whose versions come from `POST .../versions`
 * plus an archive upload — exactly the flow this action performs.
 *
 * Two attributes are deliberate:
 *
 *  - `registry-name: 'private'` is required, and `private` is what makes this
 *    the organization's own module rather than a curated public one.
 *  - `namespace` is NOT sent. The docs say it "cannot be set for private
 *    modules" — the organization in the URL already names it, and sending it
 *    anyway is a 422. `o.namespace` IS that organization, so passing it through
 *    is the natural mistake here.
 *
 * `no-code` is sent as false, as {@link vcsModuleBody} sends it: the no-code
 * provisioning workflow is a different product surface from a module a
 * consumer writes `module {}` against, and this action publishes the latter.
 */
export function noVcsModuleBody(o: ModuleCoordinates): string {
    return JSON.stringify({
        data: {
            type: 'registry-modules',
            attributes: {
                name: o.name,
                provider: o.provider,
                'registry-name': 'private',
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
 * Publishes a module version to HCP Terraform: checks the module, creates it if it does not exist
 * — VCS-connected when the VCS inputs are supplied, with no VCS connection when they are not —
 * then completes the publish the way that module's own class of version requires — observing the
 * tag import for a tag-based module, or creating the version and uploading the module archive for
 * an upload-driven one — and (optionally) waits for it to become ready.
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
        /**
         * Registers a value with the job's secret mask. Wired to
         * `core.setSecret`; called on the archive-upload URL BEFORE that URL is
         * used for anything, because the mask is applied to output as it is
         * written and cannot be applied retroactively to a line already logged.
         */
        private readonly maskSecret: (secret: string) => void = () => {},
        /**
         * Builds the module archive. Injectable so the flow tests above stay
         * hermetic; the default reads the real `module-directory`.
         */
        private readonly createArchive?: () => Promise<Uint8Array>,
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
            mode = await this.createMissingModule(headers);
        } else {
            // Fail here rather than logging and carrying on. Anything that is
            // neither 2xx nor 404 is a 401 (bad or expired token), a 403, a 429
            // or a 5xx — and the follow-up request fails on the same condition,
            // so the consumer's error became "Failed to create version (HTTP
            // 401)" with no hint that the true cause was already visible one
            // call earlier and was deliberately ignored. The private publisher
            // has always failed fast on its own non-2xx/non-404 case; this is
            // the same rule, and it also stops a version-create proceeding
            // against a module whose actual state was never confirmed.
            throw httpError('check the existing HCP module', check, this.debug);
        }

        return mode === 'tag-based' ? this.publishTagBased(headers) : this.publishUploadDriven(headers);
    }

    /**
     * Creates the module the publish needs, and answers with the class of
     * version it will take.
     *
     * Which module gets created is decided by the VCS inputs, because they are
     * the only thing that can express a VCS connection:
     *
     *  - BOTH supplied: a VCS-connected module, exactly as before.
     *  - NEITHER supplied: a module with no VCS connection. This is the
     *    API-driven flow — the one the tarball upload exists to serve — and it
     *    has no VCS connection to name by construction. It used to be a hard
     *    error demanding VCS inputs that this flow cannot have, which left
     *    creating the module an undocumented out-of-band step.
     *  - EXACTLY ONE supplied: refused. Silently creating a no-VCS module for an
     *    operator who plainly asked for a VCS-connected one would publish by a
     *    different mechanism than they configured, and the half they forgot is
     *    the useful thing to say.
     */
    private async createMissingModule(headers: Record<string, string>): Promise<PublishMode> {
        const o = this.options;
        if (o.vcsRepoIdentifier && o.vcsOauthTokenId) {
            return this.createVcsModule(headers);
        }
        if (o.vcsRepoIdentifier || o.vcsOauthTokenId) {
            const supplied = o.vcsRepoIdentifier ? 'vcs-repo-identifier' : 'vcs-oauth-token-id';
            const missing = o.vcsRepoIdentifier ? 'vcs-oauth-token-id' : 'vcs-repo-identifier';
            throw new Error(
                `Module ${o.namespace}/${o.name}/${o.provider} does not exist, and only half of the pair ` +
                    `needed to create a VCS-connected one was supplied: '${supplied}' is set but ` +
                    `'${missing}' is not. Supply both to create a VCS-connected module, or neither to ` +
                    'create a module with no VCS connection and publish it by uploading the module archive.',
            );
        }
        return this.createNoVcsModule(headers);
    }

    /** Unchanged: the VCS-connected creation, reached only when both inputs are set. */
    private async createVcsModule(headers: Record<string, string>): Promise<PublishMode> {
        const o = this.options;
        this.log(`Module not found; creating VCS-connected module ${o.namespace}/${o.name}/${o.provider}.`);
        const created = await this.http('POST', vcsUrl(o.address, o.namespace), headers, vcsModuleBody(o));
        if (created.status < 200 || created.status >= 300) {
            throw httpError('create HCP module', created, this.debug);
        }
        return o.vcsBranch ? 'upload-driven' : 'tag-based';
    }

    /**
     * Creates a module with no VCS connection, converging rather than failing
     * when it turns out someone else created it first.
     *
     * IDEMPOTENCY, AND WHY IT IS NOT A STATUS CHECK. Two runs of this action can
     * reach the create at once — two workflows publishing two versions, or a
     * retry after a partial failure — and only one of them can win. HCP's
     * documentation for this endpoint lists 201, 422, 403 and 404 and describes
     * no duplicate-specific status at all, so a guard written as "treat 409 (or
     * 422) as already-exists" would be pinned to a status the API never promised
     * and would fail the loser of the race the day it answered with the other
     * one. What IS unambiguous is the module's own existence, so that is what
     * gets asked: on ANY failed create, re-read the module, and if it is there
     * now, carry on with the publish. The loser of a race converges on success.
     *
     * The re-read also keeps a genuine failure legible. A 401 or 403 on create
     * leaves the module still absent, the re-read fails too, and the error
     * raised is the CREATE's own — "Failed to create HCP module (HTTP 401)" —
     * rather than anything claiming the module merely does not exist.
     *
     * The mode comes from the module that actually exists, not from the
     * assumption that it is the one this run tried to create: the winner of the
     * race may have connected it to VCS, in which case its versions arrive by a
     * different route entirely.
     */
    private async createNoVcsModule(headers: Record<string, string>): Promise<PublishMode> {
        const o = this.options;
        this.log(`Module not found; creating ${o.namespace}/${o.name}/${o.provider} with no VCS connection.`);
        const created = await this.http(
            'POST',
            createModuleUrl(o.address, o.namespace),
            headers,
            noVcsModuleBody(o),
        );
        if (created.status >= 200 && created.status < 300) {
            return 'upload-driven';
        }

        const recheck = await this.http('GET', moduleUrl(o), headers);
        if (recheck.status >= 200 && recheck.status < 300) {
            this.log(
                `Module ${o.namespace}/${o.name}/${o.provider} already exists; continuing with the publish.`,
            );
            return publishMode(recheck.body);
        }
        throw httpError('create HCP module', created, this.debug);
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
     * stays at status `pending` until a gzipped module archive is PUT to the
     * `links.upload` URL the creation returned. Both halves happen here — a
     * version created and left without content is a version consumers can
     * resolve and cannot use, so the upload is part of the publish rather than
     * something left to the caller.
     */
    private async publishUploadDriven(headers: Record<string, string>): Promise<PublishResult> {
        const o = this.options;
        let uploaded = false;
        const versionResp = await this.http('POST', versionsUrl(o), headers, versionBody(o.version, o.commitSha));
        if (versionResp.status === 422) {
            this.log(`Version ${o.version} already exists.`);
        } else if (versionResp.status < 200 || versionResp.status >= 300) {
            throw httpError('create version', versionResp, this.debug);
        } else {
            const upload = uploadUrl(versionResp.body);
            if (upload) {
                await this.uploadArchive(upload);
                uploaded = true;
            } else {
                this.log(`Version ${o.version} created.`);
            }
        }

        if (o.waitForPublish && !(await this.waitForOk(headers))) {
            throw new Error(`Timed out after ${o.timeoutSeconds}s waiting for version ${o.version} to become ready.`);
        }
        return {
            published: true,
            message: uploaded
                ? `Version ${o.version} published to HCP Terraform with the module archive uploaded.`
                : `Version ${o.version} published to HCP Terraform.`,
        };
    }

    /**
     * PUTs the module archive to the capability URL HCP just issued.
     *
     * Three things about this request differ from every other one this class
     * makes, and each is deliberate:
     *
     *  - The URL is masked BEFORE it is used. The archivist capability lives in
     *    the URL's PATH, not its query, so neither `redactUrl` (which drops only
     *    the query) nor `extractUrlTokenSecrets` covers it — the whole URL is
     *    registered with the mask, and the query-string tokens are registered
     *    too for a TFE install whose upload link is a presigned object-store URL.
     *    Nothing logs the URL; the host alone is what an operator needs to see.
     *  - The HCP bearer token is NOT sent. The upload host is a different host
     *    from the API (`archivist.terraform.io` for HCP), and the URL already
     *    carries its own authorization, so attaching the token would hand an
     *    org-scoped `registry-modules` credential to a host named by a response
     *    body.
     *  - The request goes through the same client as every other call, so the
     *    upload host is authorized against `registry-allowed-hosts` — and so is
     *    every redirect hop off it — rather than being contacted because a
     *    response body named it.
     */
    private async uploadArchive(url: string): Promise<void> {
        const tokens = extractUrlTokenSecrets(url);
        this.maskSecret(url);
        for (const token of tokens) this.maskSecret(token);

        const archive = await (this.createArchive
            ? this.createArchive()
            : createModuleArchive(this.options.moduleDirectory));

        this.log(
            `Uploading the ${archive.byteLength}-byte module archive for version ${this.options.version} to ` +
                `${new URL(url).host}.`,
        );
        const resp = await this.http('PUT', url, { 'Content-Type': 'application/octet-stream' }, archive);
        if (resp.status < 200 || resp.status >= 300) {
            // Scrubbed, because the failure body comes from the upload host and
            // an object store that echoes the request URL back in its error
            // would otherwise put the capability into the job annotation.
            //
            // `redactUrl(url)` is passed as a secret in its own right:
            // `scrubSecretsFromMessage` rewrites the URL to that form, which
            // drops the QUERY only — the right redaction for a presigned
            // object-store link, but the archivist capability lives in the
            // PATH, so the rewritten form is still the capability. Both
            // spellings are redacted outright.
            throw new Error(
                scrubSecretsFromMessage(httpError('upload the module archive', resp, this.debug).message, url, [
                    url,
                    redactUrl(url),
                    ...tokens,
                ]),
            );
        }
        this.log(`Module archive uploaded for version ${this.options.version}.`);
    }

    private waitForOk(headers: Record<string, string>): Promise<boolean> {
        return pollUntil(
            async () => {
                const resp = await this.http('GET', moduleUrl(this.options), headers);
                return (
                    resp.status >= 200 &&
                    resp.status < 300 &&
                    versionStatus(resp.body, this.options.version) === 'ok'
                );
            },
            this.options.timeoutSeconds,
            this.debug,
        );
    }
}
