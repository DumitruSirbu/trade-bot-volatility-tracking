// Raised when a paper-mode mutator looks up an open position by client_order_id
// and finds none. Surfaces as a typed domain exception (per code-conventions
// "throw domain exceptions — never raw Error") so callers can map the failure
// to a clean HTTP 4xx + audit row without string-matching message text.

export class PaperPositionNotFoundException extends Error {
    readonly clientOrderId: string;

    constructor(clientOrderId: string, operation: string) {
        super(`${operation}: no open paper position with clientOrderId=${clientOrderId}`);
        this.name = 'PaperPositionNotFoundException';
        this.clientOrderId = clientOrderId;
    }
}
