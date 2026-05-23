// Reject classification taxonomy per ADR 0006 §4. The submitter inspects the ccxt error
// type + Binance numeric code and stamps `rejectClass` on the structured ISubmitResult
// field so callers can branch on it (never on substring-matching the venue message —
// venue messages are not API).
//
// The previous `ExchangeRejectError` exception class was unused: nothing instantiated it,
// and the same information already flows through `ISubmitResult.rejectClass` /
// `venueCode` / `venueMessage`. Deleting it removes a second source of truth; the type
// alias below is the contract callers depend on.
export type ExchangeRejectClass = 'RETRIABLE' | 'TERMINAL' | 'UNKNOWN';
