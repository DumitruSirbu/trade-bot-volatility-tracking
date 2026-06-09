# Review: M28 — Same-bar stress threshold recalibration + auto-resume wiring

## Executive Summary
The M28 plan represents a robust, code-only approach to recalibrating the `same_bar` market stress halt mechanism. It adheres strictly to the project's invariants, particularly prioritizing conservative, low-risk survival without altering the data persistence structure or sharing logic incorrectly. The decoupling of the strategy parameter from the engine threshold is a clean architectural move that resolves the issue of silent flow classification changes.

## Architectural Decisions Assessment

### D1: Decoupling and Threshold Recalibration (STRESS_SAME_BAR_HALT_COUNT = 20)
- **Strengths:** Moving the halt threshold from a strategy parameter to an engine constant cleanly decouples the `classifyFlowType` (which uses 5) from the engine's halt logic. This maintains the flow classification semantics while properly separating risk config as engine-side only. 
- **Value Choice (20):** Based on the empirical soak evidence (Jun 4/5 hitting ~30, Jun 7 cascade hitting 52, routine ceilings at ~12), 20 provides a safe 8-count buffer from routine sessions. It is conservative yet prevents over-reaction on normal correlated drifts.

### D2: Wire `same_bar` into M23 auto-resume
- **Strengths:** Adapting the existing breadth auto-resume mechanism minimizes new complexity. Selecting an inner-band resume ceiling of 12 establishes a healthy hysteresis buffer (20 to 12).
- **Confirmation Ticks (2):** Choosing 2 clear ticks instead of 3 (used for breadth) appropriately addresses the more transient nature of same-bar pile-ons. Reusing the `MARKET_STRESS_MAX_DAILY_REHALT = 3` cap as a shared bucket across all stress legs keeps the behavior conservative—cascades and chatters deplete the same daily budget.

### D3 & D4: Suffix and Config Flags
- **Strengths:** Reusing `market_stress:same_bar` and the `MARKET_STRESS_AUTO_RESUME_ENABLED` master switch preserves system determinism and avoids flag bloat. Single master switches for unified auto-resume logic (breadth and same-bar) makes operational management cleaner.

### D5: Constants in riskConsts.ts
- **Strengths:** Consistent with M21, M22, and M23 patterns. Treating these as constants rather than runtime environment variables maintains deployment predictability.

## Safety and Invariants
- **Database Safety:** The plan correctly highlights that there are no schema changes and no DB writes at rest. The `pg_dump` procedure is mandated prior to restart, fully honoring `CLAUDE.md` Hard Rule #9.
- **Fail-closed Logic:** Maintaining the `NaN` / `Infinity` fail-closed mechanism in `isSameBarStillStressed` upholds the system's core conservative trading invariant.
- **Param Integrity:** Retaining `stress_same_bar_trigger_count: 5` strictly for `MARKET_BETA` ensures that live backtest consistency and strategy purity aren't violated.

## Testing and QA
- **Unit Tests:** The proposed test checklist covers all critical paths: boundary checks (19 vs 20), parameter decoupling checks, auto-resume counter resets, hysteresis logic, and shared daily cap hits.
- **Integration/Replay:** Replay tests against the 14-day soak are well-scoped. Confirming determinism (same snapshot → same resume) aligns tightly with backtest reproducibility mandates.

## Post-Deploy & Tech Debt
- The acknowledgement that the thresholds (20, 12, N=2) are "distribution-separated starting points" rather than held-out-validated calibrations is honest and aligns with the project's data-driven, empirical iteration style. Logging this as tech debt alongside the breadth-N per-bar autocorrelation item is appropriate.
- The 14-day paper soak before live activation is a mandatory, excellent safeguard.

## Conclusion
The M28 plan is **approved with no blockers**. It is a highly focused, risk-aware specification that elegantly extends existing mechanics while patching an empirically proven defect (full-day locks on non-cascade days). The implementation steps provide a crystal-clear path for `bot-engine-nestjs`.