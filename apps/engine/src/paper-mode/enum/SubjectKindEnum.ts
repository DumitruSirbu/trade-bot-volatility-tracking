// Subject kinds for the `paper_state_audit` HMAC chain (ADR 0032 §D16). The
// audit row's `subject_kind` + `subject_id` identify which audited table's
// row this mutation references. DB CHECK in CreatePaperStateAuditTable
// pins the value set.
export enum SubjectKindEnum {
    PAPER_ACCOUNT_STATE = 'paper_account_state',
    PAPER_ACCOUNT_STATE_HISTORY = 'paper_account_state_history',
    PAPER_ACCOUNT_STATE_META = 'paper_account_state_meta',
    PAPER_ACCOUNT_SNAPSHOTS = 'paper_account_snapshots',
}
