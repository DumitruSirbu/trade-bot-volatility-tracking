export enum AlertTypeEnum {
    POSITION_OPENED = 'position_opened',
    POSITION_CLOSED = 'position_closed',
    ORDER_REJECTED_TERMINAL = 'order_rejected_terminal',
    RISK_HALT_ENGAGED = 'risk_halt_engaged',
    MODEL_DIVERGENCE_ENGAGED = 'model_divergence_engaged',
    OPERATOR_HALT = 'operator_halt',
    OPERATOR_RESUME = 'operator_resume',
    BOOT_SCHEMA_GATE_FAILED = 'boot_schema_gate_failed',
    RECONCILIATION_DRIFT_UNRESOLVED = 'reconciliation_drift_unresolved',
    UNHANDLED_EXCEPTION = 'unhandled_exception',
    DAILY_PNL_SUMMARY = 'daily_pnl_summary',
    BOOT_ENGINE_STARTED = 'boot_engine_started',
}
