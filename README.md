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

## Outputs

| Output | Notes |
|--------|-------|
| `published` | `"true"` if published / sync triggered, `"false"` if it already existed |
| `message` | human-readable status |

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
