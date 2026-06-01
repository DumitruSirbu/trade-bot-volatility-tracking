// ADR 0021 §5.3 (M11a soak fix).
//
// Port the operator resume path uses to clear the gate's hot-path halt SoT
// (`risk_state.is_halted` for today's UTC-day row). `ControlModule` wires the
// whole chain locally so it stays cycle-free: it provides `RiskStateRepository`
// itself (via `forFeature([RiskStateEntity])`), imports the adapter
// (`RiskHaltStatePortAdapter`, wrapping that repository) by file path, and
// binds this token to the adapter with `useExisting`. `RiskModule` is not
// involved — it neither provides nor exports the adapter or this token, and
// `ControlModule` never imports `RiskModule` (which would close the DI cycle).
//
// Single method, least surface: the only thing the resume path needs from the
// risk state is the targeted clear of today's halt. A narrow token (rather
// than injecting `RiskStateRepository` directly) keeps `HaltService` ignorant
// of risk-state internals, in the spirit of the `RATE_LIMIT_HALT_PORT`
// inversion (ADR 0030 §2.6.2).
//
// Why this exists: `RiskGateService.evaluate(...)` reads `risk_state.is_halted`
// on every call, so a programmatic halt (market-stress, consecutive-loss)
// persists `is_halted=true` for the UTC day. Operator resume must clear that
// column — clearing only the in-memory flag leaves the gate rejecting
// `GLOBAL_HALT` on every subsequent trigger (ADR 0021 §5.1).

export const RISK_HALT_STATE_PORT = 'RISK_HALT_STATE_PORT';

export interface IRiskHaltStatePort {
    clearHaltForDate(utcDateString: string): Promise<void>;
}
