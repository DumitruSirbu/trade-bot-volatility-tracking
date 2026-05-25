// M10 W0 (ADR 0027 §2.5). Halt audit action types. Stored uppercase in the
// database; surfaced to the API via IHaltAuditEntry as lowercase literals.
// Login actions (M10 new) are also lowercase for consistency with halt/resume.
// M11a W0.2 (ADR 0028): Key-permission assertion actions.
// M11a W1.4 (ADR 0030 §2.6.2): RATE_LIMIT_HALT_AUTO_CLEARED is written when a
// rate-limit freeze window expires without further 429/418, releasing the
// programmatic halt that was engaged at the start of the window.
export enum HaltAuditActionEnum {
    HALT = 'halt',
    RESUME = 'resume',
    LOGIN_SUCCESS = 'login_success',
    LOGIN_FAILURE = 'login_failure',
    LOGIN_THROTTLED = 'login_throttled',
    KEY_PERMISSION_ASSERTION_FAILED = 'key_permission_assertion_failed',
    KEY_PERMISSION_ASSERTION_SKIPPED = 'key_permission_assertion_skipped',
    RATE_LIMIT_HALT_AUTO_CLEARED = 'rate_limit_halt_auto_cleared',
}
