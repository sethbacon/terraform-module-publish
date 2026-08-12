# module-publish

[![GitHub release](https://img.shields.io/github/v/release/sethbacon/terraform-module-publish?logo=github&label=Marketplace&color=2ea44f)](https://github.com/marketplace/actions/terraform-module-publish)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Publish a Terraform/OpenTofu module version to a **self-hosted private registry**
(`terraform-registry-backend`) or to **HCP Terraform / Terraform Enterprise**.
The registry protocol is binary-agnostic — it works for Terraform and OpenTofu
consumers alike.

- **private** — resolves the (already SCM-linked) module and triggers the
  registry's tag-sync so the freshly-pushed git tag is imported as a new version.
- **hcp** — checks the module (creating a VCS-connected module if missing) and
  creates the version, optionally waiting until it is ready.

## Inputs

| Input | Default | Notes |
|-------|---------|-------|
| `registry-type` | — (required) | `private` or `hcp` |
| `namespace` / `name` / `provider` / `version` | — (required) | module coordinates |
| `registry-url` | `""` | private registry base URL (required for `private`) |
| `api-key` | `""` | private registry Bearer key (required for `private`) |
| `skip-tls-verify` | `false` | disable TLS verification (private-CA endpoints only) |
| `hcp-address` | `https://app.terraform.io` | HCP/TFE base URL |
| `hcp-token` | `""` | HCP/TFE API token (required for `hcp`) |
| `vcs-repo-identifier` / `vcs-branch` / `vcs-oauth-token-id` | — | used to create an HCP module if missing |
| `commit-sha` | `""` | commit associated with the new HCP version |
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

The host-authorization primitives come from
[`@4cloudguru/pipeline-task-core`](https://www.npmjs.com/package/@4cloudguru/pipeline-task-core),
shared with the Azure Pipelines task extensions, so this action and they cannot
drift apart.

## Examples

```yaml
# self-hosted registry (on a version tag)
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
