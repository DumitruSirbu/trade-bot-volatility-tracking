# Playbook: small bugfix (known area)

## Read (in order)

1. [STATUS.md](../STATUS.md)
2. Grep [milestone-log/archive/](../milestone-log/archive/) for the relevant `M<N>.md` only
3. ADR topic section → [adr/README.md](../architecture/adr/README.md)
4. [code-conventions.md](../best-practices/code-conventions.md)
5. [dev-qa-cycle.md](../best-practices/dev-qa-cycle.md) — **authoritative** for fix waves

## Skip by default

- Full milestone plans in `docs/plans/archive/`
- [00-overview.md](../plans/00-overview.md)
- `docs/archive/independent-analysis/`
- Unrelated ADRs and plans

## Fix-wave rules (from dev-qa-cycle)

- **≤5 must-fix items** and **≤5 files** per engine dispatch
- **Architect first** on any contract touch (ADR, shared schema, event shape, state machine)
- **Adversarial QA** is the bar — happy path alone is insufficient
- **Paired test per fix item**
- **Reviewer continuity** across rounds (same reviewers re-read the diff)
- Cycle until zero blockers, zero highs, majority of mediums resolved

For DB/postgres ops: follow CLAUDE.md hard rules (#8/#9) — dump + explicit user confirm.
