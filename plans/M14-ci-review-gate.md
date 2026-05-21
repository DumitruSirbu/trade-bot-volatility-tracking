# M14 — CI review gate (phase 2)

**Goal:** An automated agent team that reviews every change for clean code, business
logic, and security before merge.

**Depends on:** a working repo + CI.

## Tasks

- **Review agents** (clean-code, business-logic, security) wired into CI on PRs.
  - *Output:* each PR gets automated review comments.
- **QA agent.** Generate/verify tests for the diff.
  - *Output:* test coverage feedback per PR.
- **Scribe agent.** Keep docs (`CLAUDE.md`, plans, README) in sync after merges.
  - *Output:* doc drift flagged/updated.
- **Supply-chain / dependency gate.** SCA (`npm/pnpm audit`) + lockfile-integrity check on every PR; pin and verify exchange-touching dependencies (ccxt, decimal.js). Critical for a money-handling bot.
  - *Output:* a vulnerable dependency or lockfile tampering blocks merge.
- **Gate policy.** Block merge on critical security/logic findings.
  - *Output:* failing review blocks merge.

## Definition of done

PRs are automatically reviewed by the agent team, tests are checked, docs stay in
sync, and critical findings block merge.

> This is the deliberate "agents for development" / résumé-skills track, kept
> entirely outside the trading runtime.
