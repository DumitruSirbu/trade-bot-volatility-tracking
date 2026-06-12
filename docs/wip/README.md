# Work-in-progress analysis (`docs/wip/`)

Scratch and investigation docs **before** they become milestone plans or ADRs.

## Layout

| Location | Purpose |
|----------|---------|
| **Root (`docs/wip/*.md`)** | Active open questions — not yet implemented or still deciding scope |
| **`docs/wip/done/`** | Analysis tied to **completed** milestones; kept for forensics and plan traceability |

## Active (root)

- [live-exit-enforcement-gap.md](live-exit-enforcement-gap.md) — stuck open positions; live time-stop / paper SL-TP gap (2026-06-12)
- [slot-model-and-correlated-leg-gaps.md](slot-model-and-correlated-leg-gaps.md) — slot C / correlated leg; gated by M30 soak (open)

## Archived (`done/`)

| Doc | Milestone(s) |
|-----|----------------|
| [documentation-structure-reorganization.md](done/documentation-structure-reorganization.md) | **Meta** — docs hub, archive layout, agent routing (2026-06-12; implemented) |
| [first-three-paper-fills-and-zombie-positions.md](done/first-three-paper-fills-and-zombie-positions.md) | **M31** — zombie lifecycle |
| [main-architector-paper-soak-fill-and-gate-analysis.md](done/main-architector-paper-soak-fill-and-gate-analysis.md) | **M24–M27** — P0–P5 fill/gate/observability |
| [paper-soak-zero-trades-and-shadow-fill-gap.md](done/paper-soak-zero-trades-and-shadow-fill-gap.md) | **M24–M26** — companion to architect analysis |
| [shadow-fill-diagnosis-m26-timing-flaw.md](done/shadow-fill-diagnosis-m26-timing-flaw.md) | **M26** — shadow fill timing |

When a WIP doc’s recommendations land in a milestone, move it to `done/` and add a **Status** line naming the milestone.
