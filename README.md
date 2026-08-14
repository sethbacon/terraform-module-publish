# module-publish

[![GitHub release](https://img.shields.io/github/v/release/sethbacon/terraform-module-publish?logo=github&label=Marketplace&color=2ea44f)](https://github.com/marketplace/actions/terraform-module-publish)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Publish a Terraform/OpenTofu module version to a **self-hosted private registry**
(`terraform-registry-backend`) or to **HCP Terraform / Terraform Enterprise**.
The registry protocol is binary-agnostic — it works for Terraform and OpenTofu
consumers alike.

- **private** — resolves the (already SCM-linked) module and triggers the
  registry's tag-sync so the freshly-pushed git tag is imported as a new version.
- **hcp** — checks the module (creating a tag-based VCS module if missing) so
  HCP imports the pushed tag as a version, optionally waiting until it is ready.
  See [HCP publishing modes](#hcp-publishing-modes) — this action does not
  upload module archives, and it fails rather than report a version HCP is
  holding at `pending`.

## Inputs

| Input | Default | Notes |
|-------|---------|-------|
| `registry-type` | — (required) | `private` or `hcp` |
| `namespace` / `name` / `provider` / `version` | — (required) | module coordinates |
| `registry-url` | `""` | private registry base URL (required for `private`) |
| `api-key` | `""` | private registry Bearer key (required for `private`) |
| `ca-cert` | `""` | PEM CA certificate for a registry behind a private CA (see [Private CAs](#private-cas)) |
| `skip-tls-verify` | — | **removed**; setting it fails the step (see [Private CAs](#private-cas)) |
| `hcp-address` | `https://app.terraform.io` | HCP/TFE base URL |
| `hcp-token` | `""` | HCP/TFE API token (required for `hcp`) |
| `vcs-repo-identifier` / `vcs-oauth-token-id` | `""` | used to create an HCP module if missing |
| `vcs-branch` | `""` | empty creates a **tag-based** module; a branch creates one whose versions need an archive upload (see [HCP publishing modes](#hcp-publishing-modes)) |
| `commit-sha` | `$GITHUB_SHA` | commit recorded on the new HCP version; defaults to the commit the workflow ran on (see [Version provenance](#version-provenance)) |
| `wait-for-publish` | `false` | wait until the version is available/ready |
| `timeout-seconds` | `180` | wait timeout |
| `registry-allowed-hosts` | `""` | hosts the registry requests may reach (see [Registry egress](#registry-egress)) |

## Outputs

| Output | Notes |
|--------|-------|
| `published` | `"true"` if published / sync triggered, `"false"` if it already existed |
| `message` | human-readable status |

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

## HCP publishing modes

HCP Terraform fills in a module's versions one of two ways, and only one of them
is something a CI action can complete on its own:

- **Tag-based** (`vcs-branch` empty — the default, and what this action creates).
  HCP imports every pushed git tag as a version by itself. This action ensures
  the module exists and, with `wait-for-publish: true`, waits for the version to
  become ready.
- **Branch-based** (`vcs-branch` set) **or no VCS repo at all.** The version is
  created through the API and then sits at status `pending` until a gzipped
  module archive is uploaded to the URL HCP returns. **This action does not
  upload module content.** When HCP answers that an upload is required, the step
  **fails** rather than reporting a publish that has not happened. Either leave
  `vcs-branch` empty so HCP imports the pushed tag, or perform the archive
  upload yourself.

Because it is the workflow's tag push that produces a tag-based version, run
this action on the tag (the first example below).

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
- `wait-for-publish` polls until the version *string* appears. The registry's
  module response carries no commit for a version, so "1.2.3 is present" is all
  that can be asserted — not that its content is what your workflow built.

Both need a registry-side API change (a ref-scoped sync, and a commit on the
version record) and are tracked in `terraform-registry-backend`. Until then,
protect the tag rather than relying on this action: make the publishing
workflow's trigger a tag push, and prevent tags from being force-moved.

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

# HCP Terraform
- uses: sethbacon/terraform-module-publish@v1
  with:
    registry-type: hcp
    hcp-token: ${{ secrets.TFE_TOKEN }}
    namespace: my-org
    name: vpc
    provider: aws
    version: 1.2.3
```

## Pinning this action

The examples above use `@v1` for readability. **`v1` is a mutable tag** — this
repository's maintainers move it to each new `v1.x`, so what your workflow
executes changes without any diff on your side. That is a convenience, and it is
a trust decision you are making about this repository. What you actually run is
a ~500 KB minified, sourcemap-free `ncc` bundle, so a substitution is not
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
