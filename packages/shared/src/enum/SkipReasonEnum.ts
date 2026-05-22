export enum SkipReasonEnum {
    BASELINE_NO_TRADE = 'baseline_no_trade',
    REGIME_SUPPRESSED = 'regime_suppressed',
    MARKET_STRESS = 'market_stress',
    NO_EXHAUSTION_CONFIRMATION = 'no_exhaustion_confirmation',
    OUT_OF_SCOPE = 'out_of_scope',
    IDIOSYNCRATIC_TRAP = 'idiosyncratic_trap',
    FLOW_ROUTED_SKIP = 'flow_routed_skip',
    LOW_SIGNAL_SCORE = 'low_signal_score',
    FUNDING_COST_TOO_HIGH = 'funding_cost_too_high',
    MOVE_OUT_OF_BAND = 'move_out_of_band',
    OI_UNAVAILABLE = 'oi_unavailable',
}
