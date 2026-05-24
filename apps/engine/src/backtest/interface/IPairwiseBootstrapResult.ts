// The per-pair output of the M8 paired block bootstrap (ADR 0018 §2.5).
//
// Discriminated union on `outcome`:
//   - `'conclusive'` — sample-size gates passed; the bootstrap ran. `winner`
//     identifies which side the CI lies on, or `'tie'` if it straddles zero.
//   - `'inconclusive'` — at least one gate failed; no CI is reported. `reason`
//     carries the gate that tripped. Inconclusive != fail; the promotion gate
//     treats it as not-promotable WITHOUT prejudice and the run may be retried
//     when more data accrues.
//
// `countersByGate` is always emitted (both branches) so an operator can read
// off the actual sample counts that drove the decision without re-deriving
// them from the underlying event tape.

export type PairwiseInconclusiveReason = 'insufficient_samples' | 'insufficient_regime_samples' | 'insufficient_shadow_days';

export type PairwiseWinner = 'A' | 'B' | 'tie';

export interface IPairwiseSampleCounters {
    readonly tradesA: number;
    readonly tradesB: number;
    readonly regimeTradesA: number;
    readonly regimeTradesB: number;
    readonly shadowDays: number;
}

export interface IPairwiseConclusiveResult {
    readonly outcome: 'conclusive';
    readonly versionA: number;
    readonly versionB: number;
    readonly winner: PairwiseWinner;
    readonly meanDiff: number;
    readonly ci95Low: number;
    readonly ci95High: number;
    readonly blockLen: number;
    readonly n: number;
    readonly countersByGate: IPairwiseSampleCounters;
}

export interface IPairwiseInconclusiveResult {
    readonly outcome: 'inconclusive';
    readonly versionA: number;
    readonly versionB: number;
    readonly reason: PairwiseInconclusiveReason;
    readonly countersByGate: IPairwiseSampleCounters;
}

export type IPairwiseBootstrapResult = IPairwiseConclusiveResult | IPairwiseInconclusiveResult;
