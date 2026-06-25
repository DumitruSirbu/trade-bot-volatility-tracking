# Project status

Living snapshot (~15 lines). **Single writer = scribe** at milestone close. Do not duplicate this block in `CLAUDE.md`.

| Field | Value |
|-------|-------|
| **ACTIVE** | **M44** — Shadow-fill fidelity B5 verification gate (soak accumulation, no fix required). ≥30 clean v3 fills from ≥2026-06-21; currently ≈10 fills, need ≈9–10 more soak days. |
| **Last DONE** | **M47** — R:R Geometry Fix (uncoupled SL/TP anchors + asymmetric fill-rebase). Branch: `feat/m47-rr-geometry-fix`. Delivered: TP/SL coupling in momentum (rrFloor cap) and mean-reversion (SL cap), no-rebase Option B for momentum, risk-gate `RR_TOO_LOW` backstop at 1.0, 4 new versioned params (min_rr provisional 1.5, entry_pct_floor, atr_floor_multiplier, max_tp_dist_factor), MFE/MAE seed-timing race fix (Task 5a — resolves tech-debt M7), position_segment_stats view for M48 foundation. New v11/v21/v31 version rows backfilled via JSON-merge migration. BLOCKERs resolved (anchor parity, cap guard). Tests: 64 new (3,983 total). Review: 1 wave clean. ADRs amended: 0003, 0045, 0004. |
| **Deploy** | M47 non-rolling migration + engine (JSON-merge param backfill + new shadow version rows). M44 soak continues (B5 gate ≥30 fills). |
| **Next queue** | **M44 B5 soak closure** (≥30 fills, re-measure from 2026-06-21; unblocks v3-promotion evaluation). Then: **M15 cloud go-live** (gated on B5 + v3-edge evaluation); **D6 branch-protection ops** (operator). |
