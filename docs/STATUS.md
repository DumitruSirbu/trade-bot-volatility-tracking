# Project status

Living snapshot (~15 lines). **Single writer = scribe** at milestone close. Do not duplicate this block in `CLAUDE.md`.

| Field | Value |
|-------|-------|
| **ACTIVE** | **M15** — Cloud go-live & scaling (D1 blocker resolved) |
| **Last DONE** | **M43** — Strategy selectivity (D1a `catalyst_risk → skip`), long-book RR geometry (D2, 3.5× long multiplier + cost-floor anchor), phantom purge (D5) (2026-06-22). Branch: `feat/m43-strategy-selectivity-rr-geometry`, ready for PR / deploy. |
| **Deploy** | M43 coded+reviewed. **Engine restart required.** No schema migration. D1a takes effect on restart. D1b deferred (v3 promotion blocked — no soak-data path in engine; queued with prerequisites). D3 investigation pending (post-D1a soak day). B5 status: `!hasNextBarEntry` rate not measured (engine unreachable) — remains open, blocks deferred D1b. |
| **Next queue** | D3 residual dead-signal investigation (needs post-D1a soak data); D1b v3 promotion prerequisites (soak-promotion pathway ADR, B5 closed, paired-CI + mechanism-attribution + ≥30 floor); M15 (cloud go-live). |
