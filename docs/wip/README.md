# Work-in-progress analysis (`docs/wip/`)

Scratch and investigation docs **before** they become milestone plans or ADRs.

## Layout

| Location | Purpose |
|----------|---------|
| **Root (`docs/wip/*.md`)** | Active open questions — not yet implemented or still deciding scope |
| **`docs/wip/done/`** | Analysis tied to **completed** milestones; kept for forensics and plan traceability |

## Active (root)

- [2026-06-17-halt-blocks-protective-close-and-shadow-fill-regression.md](2026-06-17-halt-blocks-protective-close-and-shadow-fill-regression.md) — **CRITICAL**: global halt short-circuits protective closes (time-stop + SL frozen 2h12m on #101 INJ); shadow `simulated_fill` collapsed to ~0/day since Jun 10 (contradicts M37/M39); zombie `pending_open` #38 (2026-06-17) → **M40**
- [live-exit-enforcement-gap.md](live-exit-enforcement-gap.md) — stuck open positions; live time-stop / paper SL-TP gap (2026-06-12)
- [slot-model-and-correlated-leg-gaps.md](slot-model-and-correlated-leg-gaps.md) — slot C / correlated leg; gated by M30 soak (open)

## Archived (`done/`)

| Doc | Milestone(s) |
|-----|----------------|
| [2026-07-01-xmom-cascade-topn-rebalance-timing.md](done/2026-07-01-xmom-cascade-topn-rebalance-timing.md) | **M50b** — cascade fallback, `top_n` 1→3, fixed 01:07 UTC cron (ADR 0050; 2026-07-01) |
| [2026-06-19-decisions-open-badge-vs-positions-empty.md](done/2026-06-19-decisions-open-badge-vs-positions-empty.md) | **M42** (stale-tick fill) + **M41** (outcome UX + cashflow audit, open) — Decisions OPEN vs empty Positions (2026-06-19) |
| [m38-momentum-exit-geometry-and-strategy-routing.md](done/m38-momentum-exit-geometry-and-strategy-routing.md) | **M38** — TP geometry stale at fill time, entry staleness gate, V3 hybrid promotion (2026-06-15) |
| [documentation-structure-reorganization.md](done/documentation-structure-reorganization.md) | **Meta** — docs hub, archive layout, agent routing (2026-06-12; implemented) |
| [first-three-paper-fills-and-zombie-positions.md](done/first-three-paper-fills-and-zombie-positions.md) | **M31** — zombie lifecycle |
| [main-architector-paper-soak-fill-and-gate-analysis.md](done/main-architector-paper-soak-fill-and-gate-analysis.md) | **M24–M27** — P0–P5 fill/gate/observability |
| [paper-soak-zero-trades-and-shadow-fill-gap.md](done/paper-soak-zero-trades-and-shadow-fill-gap.md) | **M24–M26** — companion to architect analysis |
| [shadow-fill-diagnosis-m26-timing-flaw.md](done/shadow-fill-diagnosis-m26-timing-flaw.md) | **M26** — shadow fill timing |

When a WIP doc’s recommendations land in a milestone, move it to `done/` and add a **Status** line naming the milestone.
