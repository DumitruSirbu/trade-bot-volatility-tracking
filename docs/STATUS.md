# Project status

Living snapshot (~15 lines). **Single writer = scribe** at milestone close. Do not duplicate this block in `CLAUDE.md`.

| Field | Value |
|-------|-------|
| **ACTIVE** | **M44** — Shadow-fill fidelity B5 verification gate (soak accumulation, no fix required). ≥30 clean v3 fills from ≥2026-06-21; currently ≈10 fills, need ≈9–10 more soak days. |
| **Last DONE** | **M46** — Rate-limit ledger audit, Scenario A1 (SAPI host-bucket split). Branch: `feat/m46-rate-limit-ledger-audit`. Investigation verdict: separate-ledger confirmed (host boundary: `/fapi` vs `/sapi`). New `SAPI_REQUEST_WEIGHT_1M` bucket (local-only) isolates `/sapi` boot calls; `REQUEST_WEIGHT_1M` now `/fapi`-only. ADR 0030 amended §2.7. Tech-debt H4 resolved. |
| **Deploy** | M46 engine live (restarted 2026-06-25, build clean, 10-min smoke passed). M44 soak continues (B5 gate ≥30 fills). |
| **Next queue** | M44 B5 soak closure (≥30 fills, re-measure from 2026-06-21); M15 cloud go-live (gated on B5 + v3-edge evaluation); D6 branch-protection ops (operator). |
