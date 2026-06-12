# Playbook: implement active milestone

## Read (in order)

1. [STATUS.md](../STATUS.md) — active milestone, deploy state, queue
2. Active plan from [plans/README.md](../plans/README.md) (YAML `adr:` / `modules:` frontmatter)
3. ADR sections listed in the plan → [adr/README.md](../architecture/adr/README.md)
4. [code-conventions.md](../best-practices/code-conventions.md) before engine code
5. Relevant architecture doc (`data-model.md`, `live-vs-backtest-contract.md`, …)
6. [dev-qa-cycle.md](../best-practices/dev-qa-cycle.md) — dispatch + QA rules

## Skip by default

- [milestone-log.md](../milestone-log.md) and `milestone-log/archive/` (unless forensics)
- `docs/plans/archive/` done specs
- `docs/archive/independent-analysis/`
- Full [00-overview.md](../plans/00-overview.md) unless new contributor context needed

## Five-wave dispatch

1. **Serial:** `bot-shared-maintainer` if shared contract changes
2. **Parallel:** `bot-engine-nestjs` + `bot-dashboard-react`
3. **Serial:** `bot-qa-engineer` (adversarial bar)
4. **Parallel:** security + logic + clean-code + quant reviewers
5. **Serial:** `bot-scribe` — [Live-memory write protocol](../best-practices/dev-qa-cycle.md) §8

Orchestrator verifies every diff after each wave. Milestone not closed until tests green + scribe updates complete.
