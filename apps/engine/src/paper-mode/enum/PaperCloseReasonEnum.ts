// Close reasons for `paper_account_state_history.close_reason` (ADR 0032 §D10).
//
// Engine-local rather than shared because the values genuinely diverge from
// the shared `ExitReasonEnum`:
//   - `sl`/`tp` vs `stop_loss`/`take_profit` (label form differs).
//   - `intra_bar_stop`, `operator_drain`, `reconciliation_forced` have no
//     shared analogue — they are PAPER-mode operational concepts (intra-bar
//     fills are a simulator construct; operator-drain and
//     reconciliation-forced are paper-soak-specific cleanup paths).
// PAPER state is engine-local persistence (D16 — never written to live
// position tables) so widening the shared enum would mix unrelated label
// spaces. Decision recorded in R2b wave-B work-log; the CHECK on the
// wave-A migration already pins these exact strings, so no DDL change is
// needed in this wave.
export enum PaperCloseReasonEnum {
    SL = 'sl',
    TP = 'tp',
    INTRA_BAR_STOP = 'intra_bar_stop',
    FORCE_CLOSE = 'force_close',
    OPERATOR_DRAIN = 'operator_drain',
    RECONCILIATION_FORCED = 'reconciliation_forced',
}
