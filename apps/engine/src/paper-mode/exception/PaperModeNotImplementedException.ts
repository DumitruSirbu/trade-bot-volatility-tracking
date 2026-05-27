// PAPER-mode order-command stub exception (ADR 0032 §3 D2).
//
// `PaperExecutionClient` in R2a is a contract-only stub: it satisfies the
// `IExecutionClient` interface so `PaperModeModule` boots clean, but every
// order-command method throws this exception until R2c wires the real
// `PaperFillSimulator` (D15) behind the port. The message names R2c so a
// developer hitting this at runtime can trace it back to the wave that lands
// the implementation.
//
// Lives in `paper-mode/exception/` (not `exchange/exception/`) so a future
// architecture review can grep the PAPER surface independently of the LIVE
// exchange surface.

export class PaperModeNotImplementedException extends Error {
    constructor(method: string) {
        super(`PaperExecutionClient.${method} is not implemented in R2a; real fill-simulator wiring lands in R2c (ADR 0032 §3 D2 / D15).`);
        this.name = 'PaperModeNotImplementedException';
    }
}
