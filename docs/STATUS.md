# Project status

Living snapshot (~15 lines). **Single writer = scribe** at milestone close. Do not duplicate this block in `CLAUDE.md`.

| Field | Value |
|-------|-------|
| **ACTIVE** | **M15** — Cloud go-live & scaling (D1 blocker resolved) |
| **Last DONE** | **M40** — Halt-exempt closes (D1, go-live unblock), shadow fill regression (D2), stuck-position sweeper (D4) (2026-06-19). Followed by M41 + M42 (sequential, both live). |
| **Deploy** | M40+M41+M42 coded+reviewed. **Engine restart required.** No schema migration. D2 production-verification gate (B5): non-zero `simulated_fill` + non-degenerate `close_reason` distribution over ≥1 soak day, then re-qualify shadow series. D1 blocker resolved: closes exempt under halt. M15 (cloud go-live) unblocked. |
| **Next queue** | M15 (cloud go-live; **D1 blocker is gone**). |
