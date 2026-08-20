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

## Shared CI workflows

Part of this repository's CI is **defined in another repository** — [`4cloudguru/shared-workflows`](https://github.com/4cloudguru/shared-workflows) — and called from `.github/workflows/`. That is a real supply-chain relationship, and it is recorded here so an audit of this repository does not stop at this repository's own tree.

**What runs, and where it is pinned.** Each caller in `.github/workflows/` names the shared workflow on its `uses:` line, pinned to a full 40-hex commit SHA with a trailing comment naming the release that SHA is. The tag is a label; the SHA is what runs. An unlabelled SHA is rejected by the workflow-hardening gate, because a bare 40-hex ref cannot be reviewed or updated deliberately.

**Why the pins have to agree across repositories.** A shared definition drifts differently from a duplicated file: every repository looks like it is using "the shared one" while sitting on different commits, which is *harder* to see than divergent files, not easier. A signature in `security-orchestration` (`shared-workflow-pin-parity`) reports **disagreement** between callers of the same shared workflow — it reports disagreement rather than staleness, because a repository deliberately held back is a decision while N repositories disagreeing without anyone deciding is drift.

**What the shared repository is itself protected by.** Its `main` requires its own zizmor and actionlint checks with `enforce_admins` enabled, restricts which third-party actions may run to an explicit allowlist, issues a read-only default `GITHUB_TOKEN`, and runs the workflow-hardening gate against itself.

**What this repository still controls.** Triggers, concurrency, and the secrets it passes. Secrets are passed **by name** — never `secrets: inherit`, which would forward every secret in this repository to a workflow owned by someone else. Any `vars.*` a shared workflow reads resolve against **this** repository, so credentials and their installation scope do not move.
