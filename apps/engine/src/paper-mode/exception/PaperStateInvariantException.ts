// Raised when an audited-mutation call into PaperAccountStateService violates
// a runtime invariant that the boot pipeline is supposed to have guaranteed
// (e.g. `paper_account_state_meta` is empty at the moment of an
// `applyFunding` / `appendStandaloneAuditRow` call). Distinct from
// PaperAccountStateBootException because the boot exception aborts startup;
// this exception fires AFTER a successful boot and signals a regression in
// the boot or hydration discipline.
//
// M11a R4 Item 5: introduced so applyFunding / appendStandaloneAuditRow stop
// throwing raw `Error` from inside the audited transaction (clean-code
// "errors are typed at domain boundaries"). The audited-transaction helper
// rolls back on any throw, so the typing here only affects how the operator
// reads the failure — but a typed exception is greppable and keeps the
// failure mode separable from generic NodeJS errors.

export class PaperStateInvariantException extends Error {
    constructor(operation: string, reason: string, cause?: unknown) {
        super(`PaperAccountStateService invariant violated in ${operation}: ${reason}`);
        this.name = 'PaperStateInvariantException';

        if (cause !== undefined) {
            (this as Error & { cause?: unknown }).cause = cause;
        }
    }
}
