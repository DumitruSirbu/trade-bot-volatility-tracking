// M11a W1.4 (ADR 0030 §2.6.2).
//
// Port the rate-limit policy uses to engage / auto-clear a programmatic halt
// on Binance 429/418. The implementation lives in `ControlModule`
// (`RateLimitHaltAdapter`) so the exchange module stays cycle-free: exchange
// depends on the port token, control supplies the adapter, both modules avoid
// importing each other directly.
//
// Engage path (on 429/418):
//   - Flip the in-process M0 halt flag so the M5 executor's exposure-
//     increasing path refuses in the same tick.
//   - Write a `control_audit` row with `source='RATE_LIMIT'`, `action='HALT'`,
//     `reason='RATE_LIMIT_BAN:<details>'` via the existing programmatic path.
//   - Notify `HaltService.notePragmaticTransition` so `GET /v1/control/halt`
//     reports the correct `haltSource` + `haltedAt`.
//
// Auto-clear path (on freeze expiry without a further 429/418):
//   - Flip the in-process halt flag back to RUNNING (only if the current
//     reason is still our RATE_LIMIT halt — never clobber an unrelated
//     operator or programmatic halt that was issued in the interim).
//   - Write a `control_audit` row with `action='RATE_LIMIT_HALT_AUTO_CLEARED'`
//     (ADR 0030 §2.6.2).
//   - Notify `HaltService` of the synthetic transition.
//
// Both methods are non-throwing — the policy invokes them as fire-and-forget
// best-effort side-effects: a DB outage at the moment of engage must not
// prevent the bucket-freeze from taking effect.

export const RATE_LIMIT_HALT_PORT = Symbol('RATE_LIMIT_HALT_PORT');

export interface IRateLimitHaltEngageParams {
    readonly reason: string;
    readonly occurredAt: Date;
}

export interface IRateLimitHaltAutoClearParams {
    readonly reason: string;
    readonly occurredAt: Date;
}

export interface IRateLimitHaltPort {
    engage(params: IRateLimitHaltEngageParams): Promise<void>;
    autoClear(params: IRateLimitHaltAutoClearParams): Promise<void>;
}
