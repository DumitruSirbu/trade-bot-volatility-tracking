/**
 * Deterministic PRNG seed material for fill simulation.
 * Used by FillSimulatorCore to make missed-fill decisions reproducible.
 *
 * Per D3 of ADR 0032, the seed is derived stateless at decision time:
 *   order_seed = HMAC-SHA256(seed_master, event_id || symbol || order_intent_id || version_namespace)
 *
 * This DTO carries the computed seed bytes so the core function stays pure
 * (no HMAC derivation inside the core).
 */
export interface IFillSeed {
    readonly seedBytes: Buffer; // deterministic seed derived from event + order + version
    readonly version: string; // seed version label (e.g. 'v1') for audit/debug
}
