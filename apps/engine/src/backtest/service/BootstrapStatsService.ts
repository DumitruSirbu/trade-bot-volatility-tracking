import { Injectable, Logger } from '@nestjs/common';

import {
    BACKTEST_BOOTSTRAP_PAIRED_NON_ZERO_EVENTS_FLOOR,
    BACKTEST_BOOTSTRAP_RESAMPLES,
    BACKTEST_BOOTSTRAP_TRADES_PER_CANDIDATE_FLOOR,
} from '../const/backtestConsts';
import { IComparisonEventOutcome } from '../interface/IComparisonEventOutcome';
import {
    IPairwiseBootstrapResult,
    IPairwiseSampleCounters,
    PairwiseWinner,
} from '../interface/IPairwiseBootstrapResult';
import { circularBlockBootstrap } from '../stats/circularBlockBootstrap';
import { politisWhite } from '../stats/politisWhite';
import { fnv1a32 } from '../stats/rng';

// M8 W5b — paired block bootstrap orchestration (ADR 0018). Given the per-event outcome
// tape produced by ComparisonRunnerService (W4) and the candidate version set, build the
// paired difference series for every ordered version pair, apply the sample-size gates,
// and run `circularBlockBootstrap` per pair with a deterministic seed derived from the
// run label. Output is one `IPairwiseBootstrapResult` per pair — conclusive with a 95%
// CI when gates pass, or inconclusive with the tripped reason otherwise.
//
// Why a Nest service rather than a free function: the comparison harness injects it
// alongside the runner so a future variant (e.g. stationary bootstrap, bias correction)
// can be swapped without touching ComparisonRunnerService's call site. The service itself
// is stateless — every method is pure given its inputs and deterministic given the seed.

@Injectable()
export class BootstrapStatsService {
    private readonly logger = new Logger(BootstrapStatsService.name);

    // Produce one bootstrap result per ordered pair `(A, B)` of `versionIds`. Pairs are
    // emitted in `(i, j)` order with `i < j` so a 4-version run yields 6 results, not 12.
    // The promotion gate's family-wise reasoning (ADR 0018 §2.7) assumes this ordering.
    computePairwiseStats(
        eventOutcomes: readonly IComparisonEventOutcome[],
        versionIds: readonly number[],
        runLabel: string,
    ): IPairwiseBootstrapResult[] {
        const results: IPairwiseBootstrapResult[] = [];

        for (let i = 0; i < versionIds.length; i += 1) {
            for (let j = i + 1; j < versionIds.length; j += 1) {
                results.push(this.computeOnePair(eventOutcomes, versionIds[i], versionIds[j], runLabel));
            }
        }

        return results;
    }

    // ADR 0018 §2.7 — the family-wise false-positive note. Emitted by ComparisonRunner at
    // the report level when more than one pair exists; null otherwise.
    buildMultipleComparisonNote(versionIds: readonly number[]): string | null {
        const pairCount = (versionIds.length * (versionIds.length - 1)) / 2;

        if (pairCount < 2) {
            return null;
        }

        return (
            `Family-wise note (ADR 0018 §2.7): ${pairCount} pairwise CIs reported. ` +
            `Any single pair flagged 'winner' at α=0.05 carries a non-trivial false-positive risk; ` +
            `the promotion gate must combine this with the per-regime breakdown before promoting on a marginal pair.`
        );
    }

    private computeOnePair(
        eventOutcomes: readonly IComparisonEventOutcome[],
        versionA: number,
        versionB: number,
        runLabel: string,
    ): IPairwiseBootstrapResult {
        const { diffSeries, tradesA, tradesB, pairedNonZeroEvents } = this.buildPairedDiffSeries(eventOutcomes, versionA, versionB);

        // The bootstrap operates on the difference series — it has no per-event regime
        // metadata to bucket on, and no calendar window awareness for shadow days. These
        // two counters are intentionally left at 0 here; the promotion gate
        // (PromotionGateService.pickSampleCounters) falls through to a tape-derived count
        // filtered by REGIME_TARGETS_BY_DIRECTION whenever it sees a zero from the
        // bootstrap (R1-H1 fix). Treat these fields as "not supplied by bootstrap" rather
        // than "actually zero".
        const counters: IPairwiseSampleCounters = {
            tradesA,
            tradesB,
            regimeTradesA: 0,
            regimeTradesB: 0,
            shadowDays: 0,
        };

        if (tradesA < BACKTEST_BOOTSTRAP_TRADES_PER_CANDIDATE_FLOOR || tradesB < BACKTEST_BOOTSTRAP_TRADES_PER_CANDIDATE_FLOOR) {
            return {
                outcome: 'inconclusive',
                versionA,
                versionB,
                reason: 'insufficient_samples',
                countersByGate: counters,
            };
        }

        if (pairedNonZeroEvents < BACKTEST_BOOTSTRAP_PAIRED_NON_ZERO_EVENTS_FLOOR) {
            return {
                outcome: 'inconclusive',
                versionA,
                versionB,
                reason: 'insufficient_samples',
                countersByGate: counters,
            };
        }

        // Deterministic seed: `fnv1a32(runLabel + ':' + pairId)`. Same run_label → same
        // pair_id → same seed → byte-identical CI on a re-run (ADR 0018 §2.4).
        const pairId = `${versionA}-${versionB}`;
        const seed = fnv1a32(`${runLabel}:${pairId}`);
        const blockLen = politisWhite(diffSeries);

        // n=10000 is fixed by the brief (ADR 0018 §2.4 "n = 10000 is fixed"). Lower
        // weakens the CI; higher has diminishing returns. The constant is named so a
        // future ADR amendment changes one symbol.
        const distribution = circularBlockBootstrap(diffSeries, {
            blockLen,
            n: BACKTEST_BOOTSTRAP_RESAMPLES,
            seed,
        });

        const winner = resolveWinner(distribution.ci95Low, distribution.ci95High);

        this.logger.debug(
            `pair v${versionA} vs v${versionB} blockLen=${blockLen} ` +
            `mean=${distribution.meanDiff.toFixed(6)} ci=[${distribution.ci95Low.toFixed(6)}, ${distribution.ci95High.toFixed(6)}] winner=${winner}`,
        );

        return {
            outcome: 'conclusive',
            versionA,
            versionB,
            winner,
            meanDiff: distribution.meanDiff,
            ci95Low: distribution.ci95Low,
            ci95High: distribution.ci95High,
            blockLen,
            n: distribution.n,
            countersByGate: counters,
        };
    }

    // Walk the chronological event tape once, building `D_AB[e] = r_e(A) - r_e(B)` for
    // every event. ADR 0018 §2.2 pairs by event_id (not by timestamp) — `eventOutcomes`
    // is already keyed that way, so iteration order suffices. Both sides default to 0 for
    // events where the version produced no outcome (defensive — should not happen with
    // W4's tape contract, which seeds every event with every version).
    //
    // Counters:
    //   - tradesA / tradesB: count of `action === 'open'` for each version (sample-size gate).
    //   - pairedNonZeroEvents: events where at least one side has r ≠ 0 (bootstrap floor).
    private buildPairedDiffSeries(
        eventOutcomes: readonly IComparisonEventOutcome[],
        versionA: number,
        versionB: number,
    ): { diffSeries: number[]; tradesA: number; tradesB: number; pairedNonZeroEvents: number } {
        const diffSeries: number[] = new Array(eventOutcomes.length);
        let tradesA = 0;
        let tradesB = 0;
        let pairedNonZeroEvents = 0;

        for (let i = 0; i < eventOutcomes.length; i += 1) {
            const event = eventOutcomes[i];
            const recordA = event.outcomesByVersion.get(versionA);
            const recordB = event.outcomesByVersion.get(versionB);

            const rA = recordA?.rPerUnitRisk ?? 0;
            const rB = recordB?.rPerUnitRisk ?? 0;

            diffSeries[i] = rA - rB;

            if (recordA !== undefined && recordA.action === 'open') {
                tradesA += 1;
            }

            if (recordB !== undefined && recordB.action === 'open') {
                tradesB += 1;
            }

            if (rA !== 0 || rB !== 0) {
                pairedNonZeroEvents += 1;
            }
        }

        return { diffSeries, tradesA, tradesB, pairedNonZeroEvents };
    }
}

// ADR 0018 §2.5: winner = A iff the CI lies strictly above zero, B iff strictly below,
// `tie` if the CI straddles zero. Equality at the boundary is treated as a tie — a CI
// touching zero is not evidence of difference.
function resolveWinner(ci95Low: number, ci95High: number): PairwiseWinner {
    if (ci95Low > 0) {
        return 'A';
    }

    if (ci95High < 0) {
        return 'B';
    }

    return 'tie';
}

