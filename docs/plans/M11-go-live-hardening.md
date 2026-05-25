# M11 — Go-live hardening (split)

M11 has been split into two sequential milestones. The original conflated
"operate safely on the local box for a multi-week demo soak" with "move the
stack to a cloud for real-money trading." At $500–$1,000 of live capital,
paying $30–60/mo in infra before there is any evidence of live edge is
negative-EV, so the soak (free) must gate the cloud move (paid).

| # | Milestone | File | Goal | Cost |
|---|-----------|------|------|------|
| **M11a** | Local soak hardening | [`M11a-local-soak.md`](./M11a-local-soak.md) | Run Binance demo-trading on a single trusted machine for weeks, hands-off, with all safety rails | $0 infra |
| **M11b** | Cloud go-live & scaling | [`M11b-cloud-go-live.md`](./M11b-cloud-go-live.md) | Move the same stack to a cheap single-cloud deployment for real-money trading at minimal size — **only after M11a soak exit criteria are met** | $5–60/mo depending on hosting profile |

The pre-M11 deferred items listed in `CLAUDE.md` are partitioned between M11a
and M11b inside each milestone file. Items not pulled into either stay deferred
under their own future scope.

See also:

- `docs/plans/00-overview.md` for project-wide topology context.
- `docs/best-practices/dev-qa-cycle.md` for dispatch / review rules that apply
  to both M11a and M11b.
