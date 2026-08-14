# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities through GitHub's private vulnerability
reporting on this repository (**Security → Report a vulnerability**). Please do
not open a public issue for an unfixed vulnerability.

Include the action version or commit SHA, the `registry-type` and inputs in use,
and what an attacker would gain. You should get an acknowledgement within a few
days.

## Supported versions

Fixes land on `main` and ship in the next `v1.x` tag. The floating `v1` alias is
moved by the release workflow to the newest `v1.x`, so a consumer pinned to `v1`
picks the fix up on its next run. Older majors are not maintained.

| Version | Supported |
| ------- | --------- |
| `v1.x`  | yes       |

## What this action takes custody of

On every invocation this action is handed a long-lived registry credential and
sends it as a `Bearer` header. Worth stating plainly, because it decides how the
credential should be provisioned:

- **The private path needs an ADMIN-capable registry key.** The publish flow's
  second request is `POST /api/v1/admin/modules/{id}/scm/sync`. There is no
  narrower scope that works today, so `api-key` is necessarily broader than
  "publish this one module version", and a leak of it reaches every module in
  that registry. Provision it as a repository or environment secret with a
  rotation schedule, and prefer an environment with required reviewers on the
  workflow that uses it.
- **The HCP path needs a token with `registry-modules` write access** on the
  organization — a team token scoped to the organization rather than a personal
  user token, so revoking it does not depend on one person's account.
- **Both credentials are registered with the job's mask before any other input
  is read.** The mask is job-scoped and cannot be applied retroactively, so
  ordering is the control; it is asserted by a test, and a refactor that moves
  it fails CI. This matters for a credential the runner does not mask on its own
  — a vault-action output, a `vars.` value, a value read from a file. A
  `secrets.` value is already masked without it.
- **TLS verification cannot be switched off.** `skip-tls-verify` is refused with
  an error rather than honoured: it disabled certificate *and* hostname
  verification on the requests carrying the credential. For a registry behind a
  private CA, supply that CA's certificate as `ca-cert`, which keeps both checks
  on.
- **Every destination is authorized before it is contacted**, on the initial URL
  and on each redirect hop, since every hop re-sends the credential. Private,
  link-local and otherwise reserved addresses are refused unless
  `registry-allowed-hosts` names them explicitly.
- **A registry-controlled response body never reaches an annotation
  unbounded.** It is stripped of control characters and truncated before it can
  reach `core.setFailed`; the full body goes to the debug channel, visible only
  with `ACTIONS_STEP_DEBUG`.

## Pinning

For supply-chain-sensitive workflows, pin this action to a full commit SHA
rather than to `@v1` — `@v1` is a mutable pointer this repository's maintainers
can move.
