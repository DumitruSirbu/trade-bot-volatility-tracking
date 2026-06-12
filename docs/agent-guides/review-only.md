# Playbook: code review (read-only)

## Read

1. The diff under review
2. [code-conventions.md](../best-practices/code-conventions.md) — authoritative for style
3. Relevant ADR sections from [adr/README.md](../architecture/adr/README.md)
4. Active plan or WIP doc **only** if spec alignment is disputed

## Skip by default

- [milestone-log.md](../milestone-log.md) / archive
- Done plans, independent-analysis archive
- [00-overview.md](../plans/00-overview.md)

## Four reviewer agents (dispatch in parallel)

| Agent | Checks |
|-------|--------|
| `bot-review-security` | Secrets, auth, kill-switch, input validation, MCP boundary, logging redaction |
| `bot-review-logic` | Spec/ADR alignment, state transitions, idempotency, edge cases, signal→risk→execution flow |
| `bot-review-clean-code` | Team conventions in `code-conventions.md`; naming, SRP, repository pattern, dead code |
| `bot-review-quant` | Trade math, PnL/fees/funding, sizing, backtest integrity, statistical comparisons |

Report: blockers / highs / mediums / nits. Reviewers stay on the same diff across fix rounds when possible.
