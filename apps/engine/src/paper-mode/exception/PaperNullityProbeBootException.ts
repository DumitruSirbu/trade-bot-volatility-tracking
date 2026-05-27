// Raised when PaperExchangeNullityProbe preflight refuses to let the engine
// start because the D13 capability assertion failed (permission/credential
// error against the dedicated PAPER sub-account). Separable from
// PaperAccountStateBootException because the action is different: the
// operator runbook for a nullity-probe failure is "fix the key per ADR
// 0032 §D8" — not "restore the soak meta" the state-boot exception signals.
//
// M11a R4 Item 5 (clean-code raw-Error sweep).

export class PaperNullityProbeBootException extends Error {
    constructor(reason: string) {
        super(`PaperExchangeNullityProbe preflight refused PAPER boot: ${reason}`);
        this.name = 'PaperNullityProbeBootException';
    }
}
