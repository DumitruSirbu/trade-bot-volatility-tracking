// M10 W0 (ADR 0027 §2.5). Halt audit action types. Stored uppercase in the
// database; surfaced to the API via IHaltAuditEntry as lowercase literals.
// Login actions (M10 new) are also lowercase for consistency with halt/resume.
export enum HaltAuditActionEnum {
    HALT = 'halt',
    RESUME = 'resume',
    LOGIN_SUCCESS = 'login_success',
    LOGIN_FAILURE = 'login_failure',
    LOGIN_THROTTLED = 'login_throttled',
}
