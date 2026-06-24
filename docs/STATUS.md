# Project status

Living snapshot (~15 lines). **Single writer = scribe** at milestone close. Do not duplicate this block in `CLAUDE.md`.

| Field | Value |
|-------|-------|
| **ACTIVE** | **M44** — Shadow-fill fidelity B5 verification gate (soak accumulation, no fix required). ≥30 clean v3 fills from ≥2026-06-21; currently ≈10 fills, need ≈9–10 more soak days. |
| **Last DONE** | **M45** — Position-risk sizing + risk-accounting hardening (D1 sizer/stop alignment, D2 newer-wins upsert, D3a halt isolation, D3b ADD recompute, D4 double-close guard, D5 BAD_AUDIENCE). Migration `20260624172000-AddUpdatedAtToRiskState` applied on soak DB. D6 (branch protection) pending operator. Branch: `feat/m45-tech-debt-hardening`. |
| **Deploy** | M45 coded+reviewed. **Engine restart required** (D1 stop-distance sizing takes effect, D4 in-memory guard wires). No additional migration. D6 ops: apply branch protection via `docs/runbooks/ci-gates.md` §2 before any live merge. |
| **Next queue** | M44 B5 soak closure (≥30 fills, re-measure from 2026-06-21); M15 cloud go-live (gated on B5 + v3-edge evaluation); D6 branch protection ops (operator). |
