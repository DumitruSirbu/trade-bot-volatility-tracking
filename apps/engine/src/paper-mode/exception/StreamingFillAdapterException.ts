// Raised by StreamingFillAdapter when a caller violates the registry
// contract (re-registering a positionId without first releasing it).
// Distinct from generic Error so the call site / a test harness can
// assert on the typed failure rather than a string match.
//
// M11a R4 Item 5 (clean-code raw-Error sweep).

export class StreamingFillAdapterException extends Error {
    constructor(reason: string) {
        super(`StreamingFillAdapter invariant violated: ${reason}`);
        this.name = 'StreamingFillAdapterException';
    }
}
