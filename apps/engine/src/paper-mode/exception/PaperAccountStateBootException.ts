// Raised when PaperAccountStateService refuses to start because a boot-time
// invariant is violated (ADR 0032 §D3 simulator-config-hash mismatch, missing
// snapshot under non-empty state, etc.). The engine treats this as a fatal
// boot failure — the soak cannot run against a tampered or mismatched
// derived-metadata row.

export class PaperAccountStateBootException extends Error {
    constructor(reason: string, cause?: unknown) {
        super(`PaperAccountStateService boot refused: ${reason}`);
        this.name = 'PaperAccountStateBootException';

        if (cause !== undefined) {
            (this as Error & { cause?: unknown }).cause = cause;
        }
    }
}
