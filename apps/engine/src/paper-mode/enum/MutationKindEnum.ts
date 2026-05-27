// Mutation kinds for the `paper_state_audit` HMAC chain (ADR 0032 §D6 / §D16).
// The DB CHECK constraint in CreatePaperStateAuditTable mirrors this enum set
// verbatim; adding a value here requires a paired forward migration that
// widens the CHECK.
export enum MutationKindEnum {
    OPEN_POSITION = 'OPEN_POSITION',
    CLOSE_POSITION = 'CLOSE_POSITION',
    APPLY_FUNDING = 'APPLY_FUNDING',
    APPLY_FILL = 'APPLY_FILL',
    OPERATOR_DRAIN = 'OPERATOR_DRAIN',
    RECONCILIATION_FORCED = 'RECONCILIATION_FORCED',
    META_INIT = 'META_INIT',
    SNAPSHOT = 'SNAPSHOT',
    // R2c.D Item 2 — drawdown-abort audit row. Written by
    // PaperDrawdownAbortHandler when PAPER_MARK_TO_MARKET_EVENT trips the
    // 15%-from-peak threshold. Paired with the
    // AddPaperStateAuditMutationKindDrawdownAbort migration which widens the
    // DB CHECK constraint.
    DRAWDOWN_ABORT = 'DRAWDOWN_ABORT',
    // R2c.D Item 3 — funding magnitude-bound breach. Written by
    // PaperFundingAccrualService when the per-window absolute cap is exceeded
    // (apply-and-alert per ADR 0032 §D4). The position-level audit row for
    // the underlying funding application is still written by
    // PaperAccountStateService.applyFunding under APPLY_FUNDING; this row
    // documents the cap breach separately so the violation is forensically
    // distinguishable from a routine accrual.
    FUNDING_CAP_BREACH = 'FUNDING_CAP_BREACH',
}
