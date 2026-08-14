# module-publish

[![GitHub release](https://img.shields.io/github/v/release/sethbacon/terraform-module-publish?logo=github&label=Marketplace&color=2ea44f)](https://github.com/marketplace/actions/terraform-module-publish)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Publish a Terraform/OpenTofu module version to a **self-hosted private registry**
(`terraform-registry-backend`) or to **HCP Terraform / Terraform Enterprise**.
The registry protocol is binary-agnostic — it works for Terraform and OpenTofu
consumers alike.

- **private** — resolves the (already SCM-linked) module and triggers the
  registry's tag-sync so the freshly-pushed git tag is imported as a new version.
- **hcp** — checks the module, creating it if it is missing (VCS-connected when
  you supply the VCS inputs, otherwise with **no VCS connection**), and
  completes the publish the way that module's class of version requires: HCP
  imports the pushed tag, or — for a branch-based or VCS-less module — the
  action creates the version and uploads the module archive HCP is waiting for.
  Optionally waits until the version is ready. See
  [HCP publishing modes](#hcp-publishing-modes).

## Inputs

| Input | Default | Notes |
|-------|---------|-------|
| `registry-type` | — (required) | `private` or `hcp` |
| `namespace` / `name` / `provider` / `version` | — (required) | module coordinates |
| `registry-url` | `""` | private registry base URL (**required** for `private`) — see [Token scope and host trust](#token-scope-and-host-trust) |
| `api-key` | `""` | private registry Bearer key (**required** for `private`) — must be **admin-capable**, see [Token scope and host trust](#token-scope-and-host-trust) |
| `ca-cert` | `""` | PEM CA certificate for a registry behind a private CA (see [Private CAs](#private-cas)) |
| `skip-tls-verify` | — | **removed**; setting it fails the step (see [Private CAs](#private-cas)) |
| `hcp-address` | `https://app.terraform.io` | HCP/TFE base URL |
| `hcp-token` | `""` | HCP/TFE API token (**required** for `hcp`) — needs `registry-modules` write, see [Token scope and host trust](#token-scope-and-host-trust) |
| `vcs-repo-identifier` / `vcs-oauth-token-id` | `""` | supply **both** to create a missing HCP module VCS-connected; leave **both** empty for API-driven publishing, where a missing module is created with no VCS connection (see [Creating the module](#creating-the-module)) |
| `vcs-branch` | `""` | only consulted when creating a VCS-connected module: empty creates a **tag-based** one; a branch creates one whose versions are completed by an archive upload (see [HCP publishing modes](#hcp-publishing-modes)) |
| `module-directory` | `"."` | module source archived and uploaded when HCP asks for content; its contents land at the archive root (see [HCP publishing modes](#hcp-publishing-modes)) |
| `commit-sha` | `$GITHUB_SHA` | commit recorded on the new HCP version; defaults to the commit the workflow ran on (see [Version provenance](#version-provenance)) |
| `wait-for-publish` | `false` | wait until the version is available/ready |
| `timeout-seconds` | `180` | wait timeout, in whole seconds. A value that is not a positive whole number is **rejected with a warning** and the default used — it is not silently truncated. Use `wait-for-publish: false` to not wait at all |
| `registry-allowed-hosts` | `""` | hosts the registry requests may reach (see [Registry egress](#registry-egress)) |

## Outputs

| Output | Notes |
|--------|-------|
| `published` | `"true"` when this run created something; `"false"` when the version already existed |
| `message` | human-readable status |

`registry-url`, `api-key` and `hcp-token` are declared `required: false` in the
manifest because the Actions schema has no conditional-required construct — each
is required for exactly one `registry-type`. The check happens at run time, and
the error names the type that needed it.

**Neither output is set when the step fails.** Both `core.setOutput` calls are
on the success path, so with `continue-on-error: true` a later step reads the
empty string, not `"false"` — and an empty string cannot be told apart from a
step that has not run. Detect failure with the step's own
`steps.<id>.outcome`/`conclusion`, never by inspecting these.

## Token scope and host trust

**`api-key` must be admin-capable.** The private publish flow's second request
is `POST /api/v1/admin/modules/{id}/scm/sync`, so a narrowly-scoped
"publish this module" key will 403. There is no narrower scope that works today,
which means the credential in your repository secrets reaches every module in
that registry — provision it with a rotation schedule, and prefer an environment
with required reviewers on the workflow that uses it.

**`hcp-token` needs `registry-modules` write access** on the organization —
which also covers creating a module that does not exist yet, see
[Creating the module](#creating-the-module). Use a team token scoped to the
organization rather than a personal user token, so revoking it does not depend
on one person's account.

**`registry-url` and `hcp-address` are not validated against an allowlist by
default.** Any host that is not private, link-local or otherwise reserved is
accepted, and the request carries the Bearer credential to it. Hardcode them to
a known-good registry rather than templating them from a matrix value, another
job's output, or anything a lower-trust input can reach — and set
`registry-allowed-hosts` when you want the guarantee enforced rather than
assumed. See [Registry egress](#registry-egress).

## Registry egress

`registry-url` and `hcp-address` are operator-supplied and every request carries
the registry `Authorization: Bearer` credential, so the destination is
authorized before the request is issued **and again on every redirect hop** — a
hop re-sends the same credential, so it is exactly as sensitive as the first
destination.

- **`registry-allowed-hosts` empty (default).** Any public host is permitted,
  including the default `app.terraform.io`. A destination that *is* — or that
  *resolves to* — a private, link-local, carrier-grade-NAT or otherwise
  reserved address is refused, including the cloud instance-metadata service at
  `169.254.169.254`. The classification is numeric, so `127.1`, `2130706433`,
  `0x7f000001`, `017700000001` and `[::ffff:127.0.0.1]` are all recognised as
  loopback.
- **`registry-allowed-hosts` set.** Only the listed hosts are permitted, on
  every hop — which is how a deliberately-private, self-hosted registry stays
  reachable. Entries are comma/newline-separated hostnames, IP literals, or
  single-label wildcards (`*.registry.example.com` covers
  `modules.registry.example.com` but not `a.modules.registry.example.com`). An
  entry that cannot mean what you intended (`*.com`, a trailing `*`, an
  embedded port) fails the step rather than degrading to a weaker allowlist.

The initial URL is authorized on its hostname, so
`https://registry.example.com:8443/` works under a `registry.example.com` pin; a
*redirect* onto a non-default port is refused, so a pin cannot be widened to
another port on the same host.

Only `https://` URLs are accepted, and each request is bounded by a 60s timeout.

## Private CAs

Every request this action makes carries the registry credential
(`api-key` / `hcp-token`) as a Bearer token, so the peer is always
authenticated: both the certificate chain **and** the hostname are verified,
and there is no switch to turn that off.

For a registry whose certificate is issued by a **private CA** the runner does
not already trust, supply that CA certificate:

```yaml
- uses: sethbacon/terraform-module-publish@v1
  with:
    registry-type: private
    registry-url: https://registry.internal.example.com
    ca-cert: ${{ secrets.INTERNAL_ROOT_CA_PEM }}   # PEM, may hold a chain
    registry-allowed-hosts: registry.internal.example.com
    # ...
```

Trusting the CA keeps verification on, which is the difference that matters: an
attacker who answers for the registry name still cannot present a certificate
your CA did not issue, so the credential is not handed over. While `ca-cert` is
set it **replaces** the default trust store for this action's requests, so a
publicly-trusted CA cannot vouch for an internal name either. `NODE_EXTRA_CA_CERTS`
on the runner works too, if you prefer to trust the CA process-wide.

> **`skip-tls-verify` was removed.** It disabled certificate *and* hostname
> verification together, so any host that answered for the registry name — a
> hostile proxy, a spoofed DNS or ARP reply, a shared self-hosted runner network
> — received the registry credential in full and could then steer the
> authenticated admin request that followed. Setting it now fails the step with
> a message pointing here. If you were using it for a private CA, move that CA's
> certificate to `ca-cert` above.

## Proxy support

On a self-hosted runner behind a mandatory egress proxy, the registry calls are
routed through it. The action reads the variables the runner already sets — in
both spellings, lowercase winning:

| Variable                      | Effect                                                     |
| ----------------------------- | ---------------------------------------------------------- |
| `HTTPS_PROXY` / `https_proxy` | Proxy for the `https://` registry and HCP endpoints.        |
| `HTTP_PROXY` / `http_proxy`   | Read only for an `http://` destination, which this action refuses anyway. |
| `NO_PROXY` / `no_proxy`       | Comma-separated hosts to reach directly. `*` disables proxying entirely. Entries may carry a port, and a leading `.` matches subdomains. |

Nothing needs configuring in the workflow — if the variables are set, they are
honoured. Node's `fetch` honours none of them on its own, which is why these
calls previously left the network outside the organisation's allowlist and audit
trail where direct egress was possible, and failed with an undiagnosable connect
error where it was not. That gap is also what pushed consumers toward
`skip-tls-verify`; see [Private CAs](#private-cas) for the supported answer.

**A proxy does not widen `registry-allowed-hosts`.** The egress decision is
about the **destination**, and it is unchanged by how the packets get there — a
CONNECT tunnel to an unauthorized host is still unauthorized egress. Allowing
the proxy's own host does not launder a destination that is not allowed. The
decision is applied to the initial destination and re-applied to every redirect
hop; the proxy is never its subject.

The proxy is also resolved **per hop, not once per run**, because `NO_PROXY` is
matched against the destination: a registry that redirects a module download to
a CDN, or to an internal host covered by `NO_PROXY`, is routed by that hop's own
destination rather than by the URL the run started from.

A proxy URL may embed credentials (`https://user:pass@proxy.example.com:3128`).
Those arrive from the environment rather than from an action input, so the
action registers them with the job's mask itself before making any connection.

If a proxy variable is set but unusable, the step **fails** rather than quietly
going direct — going direct is exactly the failure the variable exists to
prevent. The message names the variable and never echoes its value, which may
carry a password.

Private CAs compose with proxying: `ca-cert` is the trust anchor for the
handshake with the **registry**, inside the tunnel, so a TLS-inspecting proxy's
CA belongs there too (or in `NODE_EXTRA_CA_CERTS`).

> One caveat worth stating rather than discovering: with `registry-allowed-hosts`
> empty, the default-deny check resolves DNS **on the runner**, while a proxied
> connection is resolved **at the proxy** — so the two can disagree about what a
> name points at. Setting `registry-allowed-hosts` is a decision about the name
> and is unaffected; it is the recommended configuration behind a proxy.

## HCP publishing modes

HCP Terraform fills in a module's versions one of two ways, and the action
detects which from HCP's own description of the module rather than guessing from
your inputs:

- **Tag-based** (a VCS-connected module with `vcs-branch` empty). HCP imports
  every pushed git tag as a version by itself. There is no version for this
  action to create and nothing to upload: it ensures the module exists and, with
  `wait-for-publish: true`, waits for the version to become ready.
- **Branch-based** (`vcs-branch` set) **or no VCS repo at all.** The version is
  created through the API and sits at status `pending` until a gzipped module
  archive is uploaded to the URL HCP returns with it. The action builds that
  archive from `module-directory` and uploads it, so the version reaches `ok`
  rather than being left pending.

Because it is the workflow's tag push that produces a tag-based version, run
this action on the tag (the first example below).

### Creating the module

If the module does not exist yet, the action creates it, and **the VCS inputs
decide which kind it creates**:

| `vcs-repo-identifier` + `vcs-oauth-token-id` | What is created | How versions arrive |
|---|---|---|
| both supplied | a VCS-connected module | pushed git tags (`vcs-branch` empty) or an archive upload (`vcs-branch` set) |
| **both empty** (the default) | a module with **no VCS connection** | this action creates the version and uploads the archive built from `module-directory` |
| exactly one supplied | nothing — the step fails, naming the missing input | — |

**API-driven publishing needs no VCS configuration at all.** Point the action at
a module that does not exist yet, leave both VCS inputs empty, and it creates the
module and publishes the first version by upload. This is the flow the tarball
upload exists for, so nothing has to be created out of band first.

The only requirement is that `hcp-token` can create registry modules in the
organization — the same `registry-modules` write access publishing a version
already needs. A token without it fails with the create's own status
(`Failed to create HCP module (HTTP 403)`), not with a message about the module
being missing.

Creation is **idempotent**. Two runs publishing two versions at once can both
find the module missing and both try to create it; only one wins. The loser
re-reads the module, finds it there, and carries on with its own publish rather
than failing. (HCP documents no duplicate-specific status for this endpoint,
so the module's existence is what gets checked, not a status code.)

### The uploaded archive

`module-directory` (default `.`) is the module root. Its **contents** land at
the archive root, so `module-directory/main.tf` becomes `main.tf` — which is
where HCP looks. `.git` and `.terraform` are excluded; everything else under it
is included.

The archive is byte-reproducible: file modes, uid/gid and mtimes are pinned to
constants and entries are sorted, so identical module content always produces an
identical archive regardless of the runner's clock or umask.

Four things are refused rather than published:

- a `module-directory` with no `.tf`/`.tf.json` files **at its root** — that is
  a mis-pointed path, not a module;
- a symlink resolving **outside** `module-directory`. This archive is uploaded
  and, for a public module, published, so following a link into the runner's
  filesystem would turn the publish step into an exfiltration primitive;
- a symlink to a directory, or a broken one, rather than silently dropping it;
- a tree over 64 MiB uncompressed, which is a mis-pointed path far more often
  than it is a module.

### Upload host trust

The upload URL comes from HCP's **response body**, and it is a bearer
capability — anything holding it can write that object. Two consequences:

- The URL is registered with the job's secret mask **before** it is used, and is
  never logged; only its host is printed, so you can see where the archive went.
  The whole URL is masked, not just its query string, because HCP's archivist
  capability is in the URL **path**.
- The upload host is authorized against `registry-allowed-hosts` exactly like
  the API host, on the initial request and on every redirect hop. **If you set
  `registry-allowed-hosts`, add the upload host too** — `archivist.terraform.io`
  for HCP Terraform; for Terraform Enterprise it is your TFE host or whatever
  object store it fronts. Otherwise the upload is refused by name.

The HCP token is **not** sent to the upload host: the capability URL is itself
the authorization, and the token is an org-scoped `registry-modules` credential
that has no business going to a host named by a response body.

The host-authorization primitives come from
[`@4cloudguru/pipeline-task-core`](https://www.npmjs.com/package/@4cloudguru/pipeline-task-core),
shared with the Azure Pipelines task extensions, so this action and they cannot
drift apart.

## Version provenance

Read this before treating a green run as evidence of *what* was published.

**HCP.** The version this action creates carries `commit-sha`, which defaults to
the runner's `GITHUB_SHA` — the commit the workflow ran on. That is the binding
between the registry's version record and your repository, and you get it
without setting anything. Override `commit-sha` only when the version genuinely
comes from a different commit.

**Private registry.** This action does **not** upload module content. It calls
the registry's `POST /api/v1/admin/modules/{id}/scm/sync`, which asks the
registry to re-read its own SCM link and import whatever the matching tags
resolve to *at sync time*. Two consequences follow, and neither is something
this action can close on its own:

- The endpoint is module-scoped and accepts no ref and no body, so the action
  cannot pin the sync to a commit. Between your `checkout` and the registry's
  fetch there is a window in which a force-moved tag changes what gets
  published.
- `wait-for-publish` polls until the version *string* appears. The registry
  **does** record a `commit_sha` and `tag_name` per version, but its
  `GET /api/v1/modules/{namespace}/{name}/{system}` response does not serialize
  them, so "1.2.3 is present" is all a client can assert — not that its content
  is what your workflow built.

Both need a registry-side change — a ref-scoped sync, and exposing the commit
the registry already stores — tracked as
[terraform-registry-backend#879](https://github.com/sethbacon/terraform-registry-backend/issues/879).
The second is additive and unblocks verification on its own; `wait-for-publish`
will check the commit once it lands.

Until then, protect the tag rather than relying on this action: trigger the
publishing workflow on a tag push, and prevent tags from being force-moved.

## Examples

```yaml
# self-hosted registry. `version` comes from a TAG trigger:
#
#   on:
#     push:
#       tags: ["v*"]
#
# github.ref_name is the tag there. On any other trigger it is a BRANCH name,
# which is how a branch name ends up published as a module version.
- uses: sethbacon/terraform-module-publish@v1
  with:
    registry-type: private
    registry-url: https://registry.example.com
    api-key: ${{ secrets.TSM_REGISTRY_API_KEY }}
    namespace: myorg
    name: vpc
    provider: aws
    version: ${{ github.ref_name }}
    wait-for-publish: "true"

# HCP Terraform, API-driven: no VCS connection anywhere in the picture.
#
# With both VCS inputs left empty, a module that does not exist yet is created
# with no VCS connection, and this version is published by uploading the archive
# built from `module-directory` — nothing has to be created out of band first.
- uses: sethbacon/terraform-module-publish@v1
  with:
    registry-type: hcp
    hcp-token: ${{ secrets.TFE_TOKEN }}
    namespace: my-org
    name: vpc
    provider: aws
    version: 1.2.3
    module-directory: .
```

## Rebuilding `dist/`

`dist/` is committed, because GitHub Actions execute the bundled output rather
than the source. That has one standing consequence: **Dependabot cannot open a
mergeable bundled-dependency bump.** It edits `package.json` and the lockfile
and never runs a build, so the committed bundle no longer matches its lockfile
and both dist gates go red by construction. This is expected, not a broken PR.

CI says which of two situations it is, in the failing run's log:

- **"This bump builds cleanly …"** — mechanical. Rebuild and push:

  ```bash
  git fetch origin <dependabot-branch>
  git switch <dependabot-branch>
  npm ci && npm run build
  git commit -am 'build: rebuild dist for this dependency bump'
  git push
  ```

- **"This bump does not merely need a rebuild …"** — the bundle cannot be built
  from that dependency set at all. **Do not commit a rebuilt `dist/`.** Either
  `tsc` fails or the bundle would not load. `npm run build` is therefore three
  steps, and each one is there to make a class of that failure impossible to
  commit:

  1. `npm run lint` (`tsc --noEmit`), because esbuild transpiles without
     type-checking. Under `@vercel/ncc` the type check came free — its bundled
     `ts-loader` failed the build on a type error — and dropping the bundler
     without replacing it would have quietly moved a red build to a green one.
  2. `esbuild`, which exits non-zero on an import it cannot resolve.
  3. `scripts/verify-bundle.mjs`, which refuses a bundle that still resolves
     something at run time. esbuild does *not* fail on every unresolved import:
     an `--external` flag, a `require()` inside a `try`/`catch`, or a computed
     specifier each exit 0 — the middle one without even a warning — and write a
     bundle that looks for a module in a `node_modules` that is not shipped. The
     staleness gates cannot catch that, since they compare `dist/` to a fresh
     build *of itself* and a committed dead bundle matches its own rebuild
     exactly.

### Why no bot pushes the rebuild

The common recipe is a workflow that rebuilds `dist/` and pushes to the PR
branch, usually written as `pull_request_target` with `contents: write`. That
runs the pull request's own code — including any build-time script a new
lockfile pulls in — with a writable token against this repository. On an action
whose threat model is untrusted input reaching a privileged context, it is worse
than the friction it removes, so it is not done here.

The safe shape (build unprivileged, commit the bytes from a trusted ref) does
not help either, for a mechanical reason: a push authored by `GITHUB_TOKEN`
creates no `pull_request` event, and `Conventional PR Title` — a required check
— is produced only by that event. An auto-pushed commit would move the PR head
to a commit where a required check can never appear, turning an actionably red
PR into a permanently unmergeable one. Making it work needs a write-capable
credential in both the Actions **and** Dependabot secret stores; that is a
larger blast radius than the four commands above.

## Pinning this action

The examples above use `@v1` for readability. **`v1` is a mutable tag** — this
repository's maintainers move it to each new `v1.x`, so what your workflow
executes changes without any diff on your side. That is a convenience, and it is
a trust decision you are making about this repository. What you actually run is
a ~440 KB minified, sourcemap-free `esbuild` bundle, so a substitution is not
something anyone will catch by reading a diff.

For supply-chain-sensitive workflows, pin the full commit SHA instead:

```yaml
- uses: sethbacon/terraform-module-publish@<full-40-char-sha> # v1.0.1
  with:
    registry-type: private
    # ...
```

The trailing comment is what makes the pin maintainable — Dependabot reads it,
and so does the next human. The tradeoff is the mirror image of `@v1`: a SHA pin
never changes under you, and it never picks up a fix either, so it needs
updating deliberately.

Releases are cut by [`release.yml`](.github/workflows/release.yml), which
against the tagged tree re-runs lint, tests, `npm audit` and — the point of the
tag trigger — **the dist-sync check**, proving the committed bundle is the one a
build of that ref produces. Because matching a bundle to a fresh build of itself
says nothing about whether that bundle *runs*, it then **executes** the bundle
(`npm run test:dist`, [`scripts/dist-behaviour.mjs`](scripts/dist-behaviour.mjs))
with real `INPUT_*` variables against a live TLS endpoint, and asserts the guards
documented above — the egress refusals, the private-CA trust, the withdrawn
`skip-tls-verify`, the rejection of a hostile registry-supplied module id, the
outputs and the credential masking. CI runs the same check on every pull request.
It refuses a tag not reachable from `main`, emits a
[build-provenance attestation](https://docs.github.com/actions/security-guides/using-artifact-attestations)
over `dist/index.js` plus a CycloneDX SBOM, and only then moves the `v1` alias.
Verify a release with:

```bash
gh attestation verify --owner sethbacon --repo terraform-module-publish dist/index.js
```
