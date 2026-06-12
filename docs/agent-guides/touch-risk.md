# Playbook: touch risk / halts / exits / depth

## Read (in order)

1. [adr/README.md](../architecture/adr/README.md) → **Risk, halts, paper profile** table
2. ADR **0004** relevant § only (depth, breadth, stress, sizing — use index anchors)
3. ADR **0042** if paper-mode / exploration profile applies
4. ADRs cited by the active plan frontmatter (e.g. 0008 SL/TP, 0011 local fallback)
5. `apps/engine/src/risk/const/riskConsts.ts` for live constants
6. [code-conventions.md](../best-practices/code-conventions.md)

## Invariants (non-negotiable)

- No order path bypasses the risk gate
- Strategies stay pure/deterministic — risk limits live outside strategy code
- Money is `decimal`, never float
- Exchange is source of truth; idempotent execution

## When to involve architect

- New halt leg, resume rule, or gate ordering change
- Shared enum / event payload / position state transition
- Live-vs-backtest contract change → also read [live-vs-backtest-contract.md](../architecture/live-vs-backtest-contract.md)

## Skip by default

- M19–M28 plan files in `docs/plans/archive/` (use ADR sections instead)
- Full milestone-log unless debugging a regression for a specific M<N>
