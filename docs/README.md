# Documentation hub

**Read this first** for task routing. Do not load `milestone-log.md`, `independent-analysis/`, or done plan files unless the task requires forensics.

## Single sources of truth

| Concern | Owner doc | When to read |
|---------|-----------|--------------|
| Hard rules + trading invariants | [CLAUDE.md](../CLAUDE.md) | Every session |
| Where we are now | [STATUS.md](STATUS.md) | Every session |
| Task routing | This file | Every session |
| Timeless architecture + locked decisions | [00-overview.md](plans/00-overview.md) | New contributors, large features |
| Milestone outcomes (forensics) | [milestone-log.md](milestone-log.md) | Regressions, "why was this built?" |
| Active implementation spec | `docs/plans/archive/MN-*.md` (see [plans/README.md](plans/README.md)) | Current milestone work |
| Deferred work | [tech-debt.md](tech-debt.md) | Planning, go-live gates |
| Pre-milestone gaps | [wip/](wip/) | Before plan freeze |
| Code style (authoritative) | [code-conventions.md](best-practices/code-conventions.md) | Before engine code |
| QA / dispatch process | [dev-qa-cycle.md](best-practices/dev-qa-cycle.md) | Before fix/QA waves |
| ADR topic map | [architecture/adr/README.md](architecture/adr/README.md) | Before touching a domain |

## Task playbooks

Short dispatch guides in [agent-guides/](agent-guides/):

| Playbook | Use when |
|----------|----------|
| [implement-milestone.md](agent-guides/implement-milestone.md) | Shipping the active milestone (5-wave flow) |
| [fix-bug.md](agent-guides/fix-bug.md) | Targeted bugfix in a known area |
| [touch-risk.md](agent-guides/touch-risk.md) | Risk, halts, depth, exits, paper profile |
| [review-only.md](agent-guides/review-only.md) | Read-only review dispatch |

## Agent routing table

**Default rule:** Do not read `milestone-log.md`, `independent-analysis/`, or archived plans unless the task requires forensics.

| Task | Read (in order) | Skip by default |
|------|-----------------|-----------------|
| Implement active milestone | `STATUS.md` → active plan → ADRs from plan/frontmatter → `code-conventions.md` → relevant architecture doc | `independent-analysis/`, done plans, full `00-overview` |
| Small bugfix (known area) | `STATUS.md` → grep `milestone-log` for MN → ADR topic section → `code-conventions.md` | Full plans, `00-overview` |
| Touch risk / halts / depth | ADR 0004 (+ 0042 if paper) relevant § only → `riskConsts.ts` | M19–M28 plan files |
| Touch execution / fills | ADR 0005, 0007, 0011, 0029 as needed → `live-vs-backtest-contract.md` | Full milestone plans |
| Dashboard / read API | ADR 0026, 0022, M10 plan → dashboard conventions | Engine plans unless API contract |
| Code review | Diff + `code-conventions.md` + relevant ADR sections | Plans unless spec dispute |
| Ops / deploy / DB | `runbooks/` index → specific runbook | All plans |
| Forensics / regression | `milestone-log` (grep MN) → WIP `done/` → `independent-analysis/` | — |

### Token budget targets

| Scenario | Target reads | ~Tokens |
|----------|--------------|---------|
| Small bugfix | STATUS + 1 ADR section + conventions | under 8k |
| Active milestone | STATUS + active plan + 2–4 ADRs + conventions | under 25k |
| Architecture / contract change | Above + `data-model.md` + architect ADR draft | under 40k |
| Full history / multi-model reviews | `archive/independent-analysis/` (future) | optional, unbounded |
