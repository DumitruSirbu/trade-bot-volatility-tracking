---
adr: []
modules: [go-live]
---

# M11 — Go-live hardening (split)

M11 has been split into two sequential milestones. The original conflated
"operate safely on the local box for a multi-week demo soak" with "move the
stack to a cloud for real-money trading." At $500–$1,000 of live capital,
paying $30–60/mo in infra before there is any evidence of live edge is
negative-EV, so the soak (free) must gate the cloud move (paid).

| # | Milestone | File | Goal | Cost |
|---|-----------|------|------|------|
| **M11a** | Local soak hardening | [`M11a-local-soak.md`](./archive/M11a-local-soak.md) | Run Binance demo-trading on a single trusted machine for weeks, hands-off, with all safety rails | $0 infra |
| **M15** | Cloud go-live & scaling | [`M15-cloud-go-live.md`](./M15-cloud-go-live.md) | Move the same stack to a cheap single-cloud deployment for real-money trading at minimal size — **only after M11a soak exit criteria are met + M12/M13/M14 complete** | $5–60/mo depending on hosting profile |

**Milestone renumbering (2026-05-27):** M11b was originally planned as the immediate successor to M11a. However, the strategy has shifted to stay local for the foreseeable future and run M12 (Analysis MCP), M13 (Agentic loop), and M14 (CI review gate) on the local box first. The cloud go-live milestone has been renumbered to **M15** to reflect its position at the end of the local-first sequence. This keeps all development and research work off paid infrastructure while preserving the gate structure: M11a soak exits into local-only work, and M15 (cloud go-live) is entered only after soak + M12/M13/M14 are complete.

The pre-M11 deferred items listed in `CLAUDE.md` are partitioned between M11a
and M15 inside each milestone file. Items not pulled into either stay deferred
under their own future scope.

See also:

- `docs/plans/00-overview.md` for project-wide topology context.
- `docs/best-practices/dev-qa-cycle.md` for dispatch / review rules that apply
  to both M11a and M15.
