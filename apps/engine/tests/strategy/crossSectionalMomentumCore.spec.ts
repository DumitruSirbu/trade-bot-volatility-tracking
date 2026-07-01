/**
 * Unit tests for crossSectionalMomentumCore (ADR 0047 §2.1).
 *
 * The function is pure and deterministic: no I/O, no mocks, no DI.
 * Each test calls the function directly and asserts on the returned IPortfolioSelection.
 *
 * Coverage map (all mandatory adversarial cases from the M50 QA mandate):
 *   Case  1 — empty universe                              → NO_ELIGIBLE_SYMBOLS
 *   Case  2 — all returns null                            → NO_ELIGIBLE_SYMBOLS
 *   Case  3 — all returns NaN / Infinity / -Infinity      → NO_ELIGIBLE_SYMBOLS
 *   Case  4 — mixed: valid count < min_universe_size      → UNIVERSE_TOO_SMALL
 *   Case  5 — mixed: valid count >= min_universe_size     → RANKED (only valid entries)
 *   Case  6 — exactly at min_universe_size (boundary)     → RANKED
 *   Case  7 — one below min_universe_size (boundary)      → UNIVERSE_TOO_SMALL
 *   Case  8 — top_n > eligible count                      → RANKED, length = eligible count
 *   Case  9 — tie on trailingReturnPct                    → symbol-ascending tie-break
 *   Case 10 — negative-only returns                       → ranked correctly (least negative first)
 *   Case 11 — single eligible symbol, min_universe_size=1 → RANKED (1 entry)
 *   Case 12 — large universe (100 symbols)                → top_n entries, rank 1..top_n descending
 *   Case 13 — determinism                                 → identical output on repeated calls
 *   Case 14 — mutation guard                              → input array order unchanged
 *   Case 15 — rank values                                 → dense 1..N, first entry has rank=1
 */

import { IMomentumParams, ISelectedSymbol, PortfolioSelectionReasonEnum, UniverseEntry } from '@bot/shared';

import { crossSectionalMomentumCore } from '../../src/strategy/strategies/crossSectionalMomentumCore';

// ─── fixture builders ─────────────────────────────────────────────────────────

const NOW_MS = 1_700_000_000_000;

function buildParams(overrides: Partial<IMomentumParams> = {}): IMomentumParams {
    return {
        top_n: 3,
        lookback_ms: 86_400_000,
        rebalance_interval_ms: 86_400_000,
        min_universe_size: 3,
        xmom_atr_stop_multiplier: 2.0,
        xmom_min_rr: 1.5,
        ...overrides,
    };
}

function buildEntry(symbol: string, trailingReturnPct: number | null, tier = 1): UniverseEntry {
    return { symbol, trailingReturnPct, tier };
}

// ─── eligibility / early-exit guards ─────────────────────────────────────────

describe('crossSectionalMomentumCore — empty / all-null / non-finite guards', () => {
    it('returns NO_ELIGIBLE_SYMBOLS for an empty universe', () => {
        const result = crossSectionalMomentumCore([], buildParams(), NOW_MS);

        expect(result.reason).toBe(PortfolioSelectionReasonEnum.NO_ELIGIBLE_SYMBOLS);
        expect(result.selected).toHaveLength(0);
    });

    it('returns NO_ELIGIBLE_SYMBOLS when all entries have null trailingReturnPct', () => {
        const universe = [buildEntry('AAAUSDT', null), buildEntry('BBBUSDT', null), buildEntry('CCCUSDT', null)];

        const result = crossSectionalMomentumCore(universe, buildParams(), NOW_MS);

        expect(result.reason).toBe(PortfolioSelectionReasonEnum.NO_ELIGIBLE_SYMBOLS);
        expect(result.selected).toHaveLength(0);
    });

    it('returns NO_ELIGIBLE_SYMBOLS when all entries have NaN trailingReturnPct', () => {
        const universe = [buildEntry('AAAUSDT', NaN), buildEntry('BBBUSDT', NaN)];

        const result = crossSectionalMomentumCore(universe, buildParams({ min_universe_size: 1 }), NOW_MS);

        expect(result.reason).toBe(PortfolioSelectionReasonEnum.NO_ELIGIBLE_SYMBOLS);
        expect(result.selected).toHaveLength(0);
    });

    it('returns NO_ELIGIBLE_SYMBOLS when all entries have Infinity trailingReturnPct', () => {
        const universe = [buildEntry('AAAUSDT', Infinity), buildEntry('BBBUSDT', -Infinity)];

        const result = crossSectionalMomentumCore(universe, buildParams({ min_universe_size: 1 }), NOW_MS);

        expect(result.reason).toBe(PortfolioSelectionReasonEnum.NO_ELIGIBLE_SYMBOLS);
        expect(result.selected).toHaveLength(0);
    });

    it('returns NO_ELIGIBLE_SYMBOLS (not UNIVERSE_TOO_SMALL) when a mix of null and non-finite entries produces zero eligible', () => {
        // This distinguishes the no-eligible guard from the thin-universe guard.
        const universe = [buildEntry('AAAUSDT', null), buildEntry('BBBUSDT', NaN), buildEntry('CCCUSDT', Infinity)];

        const result = crossSectionalMomentumCore(universe, buildParams({ min_universe_size: 1 }), NOW_MS);

        expect(result.reason).toBe(PortfolioSelectionReasonEnum.NO_ELIGIBLE_SYMBOLS);
    });
});

// ─── min_universe_size guard ──────────────────────────────────────────────────

describe('crossSectionalMomentumCore — min_universe_size boundary', () => {
    it('returns UNIVERSE_TOO_SMALL when valid count is below min_universe_size (mixed null + valid)', () => {
        // 2 valid, min = 5 → too small
        const universe = [buildEntry('AAAUSDT', 5.0), buildEntry('BBBUSDT', null), buildEntry('CCCUSDT', 3.0), buildEntry('DDDUSTD', null)];
        const params = buildParams({ min_universe_size: 5, top_n: 2 });

        const result = crossSectionalMomentumCore(universe, params, NOW_MS);

        expect(result.reason).toBe(PortfolioSelectionReasonEnum.UNIVERSE_TOO_SMALL);
        expect(result.selected).toHaveLength(0);
    });

    it('returns RANKED when valid count equals min_universe_size exactly (boundary)', () => {
        // 3 valid, min = 3 → exactly at boundary → RANKED
        const universe = [buildEntry('AAAUSDT', 5.0), buildEntry('BBBUSDT', 3.0), buildEntry('CCCUSDT', 1.0)];
        const params = buildParams({ min_universe_size: 3, top_n: 3 });

        const result = crossSectionalMomentumCore(universe, params, NOW_MS);

        expect(result.reason).toBe(PortfolioSelectionReasonEnum.RANKED);
        expect(result.selected).toHaveLength(3);
    });

    it('returns UNIVERSE_TOO_SMALL when valid count is one below min_universe_size (boundary)', () => {
        // 2 valid, min = 3 → one below
        const universe = [buildEntry('AAAUSDT', 5.0), buildEntry('BBBUSDT', 3.0), buildEntry('CCCUSDT', null)];
        const params = buildParams({ min_universe_size: 3, top_n: 2 });

        const result = crossSectionalMomentumCore(universe, params, NOW_MS);

        expect(result.reason).toBe(PortfolioSelectionReasonEnum.UNIVERSE_TOO_SMALL);
        expect(result.selected).toHaveLength(0);
    });

    it('returns RANKED when valid count is greater than min_universe_size (mixed null + valid)', () => {
        // 4 valid out of 6 entries, min = 3 → passes
        const universe = [
            buildEntry('AAAUSDT', 5.0),
            buildEntry('BBBUSDT', null),
            buildEntry('CCCUSDT', 3.0),
            buildEntry('DDDUSTD', 1.0),
            buildEntry('EEEUSDT', 2.0),
            buildEntry('FFFUSDT', null),
        ];
        const params = buildParams({ min_universe_size: 3, top_n: 3 });

        const result = crossSectionalMomentumCore(universe, params, NOW_MS);

        expect(result.reason).toBe(PortfolioSelectionReasonEnum.RANKED);
        expect(result.selected.every((entry: ISelectedSymbol) => entry.trailingReturnPct !== null)).toBe(true);
    });

    it('returns RANKED with 1 entry when min_universe_size is 1 and only 1 eligible symbol exists', () => {
        const universe = [buildEntry('SOLOUSDT', 7.5), buildEntry('BTCUSDT', null)];
        const params = buildParams({ min_universe_size: 1, top_n: 3 });

        const result = crossSectionalMomentumCore(universe, params, NOW_MS);

        expect(result.reason).toBe(PortfolioSelectionReasonEnum.RANKED);
        expect(result.selected).toHaveLength(1);
        expect(result.selected[0].symbol).toBe('SOLOUSDT');
    });

    it('returns UNIVERSE_TOO_SMALL when only 1 eligible symbol exists and min_universe_size is 2', () => {
        const universe = [buildEntry('SOLOUSDT', 7.5), buildEntry('BTCUSDT', null)];
        const params = buildParams({ min_universe_size: 2, top_n: 1 });

        const result = crossSectionalMomentumCore(universe, params, NOW_MS);

        expect(result.reason).toBe(PortfolioSelectionReasonEnum.UNIVERSE_TOO_SMALL);
    });
});

// ─── top_n and ranking correctness ───────────────────────────────────────────

describe('crossSectionalMomentumCore — ranking and selection', () => {
    it('returns all eligible entries when top_n exceeds eligible count (no crash)', () => {
        // 3 eligible, top_n = 10 → returns all 3
        const universe = [buildEntry('AAAUSDT', 5.0), buildEntry('BBBUSDT', 3.0), buildEntry('CCCUSDT', 1.0)];
        const params = buildParams({ min_universe_size: 1, top_n: 10 });

        const result = crossSectionalMomentumCore(universe, params, NOW_MS);

        expect(result.reason).toBe(PortfolioSelectionReasonEnum.RANKED);
        expect(result.selected).toHaveLength(3);
    });

    it('breaks ties on trailingReturnPct by symbol ascending (deterministic)', () => {
        // CCCUSDT and AAAUSDT both at 5.0 — AAAUSDT should sort first (rank=1), CCCUSDT rank=2
        const universe = [buildEntry('CCCUSDT', 5.0), buildEntry('AAAUSDT', 5.0), buildEntry('BBBUSDT', 3.0)];
        const params = buildParams({ min_universe_size: 1, top_n: 3 });

        const result = crossSectionalMomentumCore(universe, params, NOW_MS);

        expect(result.selected[0].symbol).toBe('AAAUSDT');
        expect(result.selected[0].rank).toBe(1);
        expect(result.selected[1].symbol).toBe('CCCUSDT');
        expect(result.selected[1].rank).toBe(2);
        expect(result.selected[2].symbol).toBe('BBBUSDT');
        expect(result.selected[2].rank).toBe(3);
    });

    it('ranks negative-only returns correctly — least negative is strongest (rank=1)', () => {
        // -1% is stronger than -5%
        const universe = [buildEntry('AAAUSDT', -5.0), buildEntry('BBBUSDT', -1.0), buildEntry('CCCUSDT', -3.0)];
        const params = buildParams({ min_universe_size: 1, top_n: 3 });

        const result = crossSectionalMomentumCore(universe, params, NOW_MS);

        expect(result.selected[0].symbol).toBe('BBBUSDT');
        expect(result.selected[0].trailingReturnPct).toBe(-1.0);
        expect(result.selected[2].symbol).toBe('AAAUSDT');
        expect(result.selected[2].trailingReturnPct).toBe(-5.0);
    });

    it('returns exactly top_n entries for a large universe and assigns rank 1..top_n in descending return order', () => {
        const TOP_N = 5;
        const UNIVERSE_SIZE = 100;

        // Build 100 entries with distinct returns: symbol-i has return = i (so i=99 is strongest)
        const universe: UniverseEntry[] = Array.from({ length: UNIVERSE_SIZE }, (_, i) => buildEntry(`SYM${String(i).padStart(3, '0')}USDT`, i));
        const params = buildParams({ min_universe_size: 10, top_n: TOP_N });

        const result = crossSectionalMomentumCore(universe, params, NOW_MS);

        expect(result.reason).toBe(PortfolioSelectionReasonEnum.RANKED);
        expect(result.selected).toHaveLength(TOP_N);

        // Rank 1 should have the highest return (99)
        expect(result.selected[0].rank).toBe(1);
        expect(result.selected[0].trailingReturnPct).toBe(99);

        // Each subsequent rank is one lower in return
        for (let i = 0; i < TOP_N; i++) {
            expect(result.selected[i].rank).toBe(i + 1);
            expect(result.selected[i].trailingReturnPct).toBe(99 - i);
        }
    });
});

// ─── rank-value shape ─────────────────────────────────────────────────────────

describe('crossSectionalMomentumCore — rank values are dense 1..N with no gaps', () => {
    it('assigns dense ranks 1..N with first selected entry having rank=1', () => {
        const universe = [buildEntry('AAAUSDT', 10.0), buildEntry('BBBUSDT', 8.0), buildEntry('CCCUSDT', 6.0), buildEntry('DDDUSTD', 4.0)];
        const params = buildParams({ min_universe_size: 1, top_n: 4 });

        const result = crossSectionalMomentumCore(universe, params, NOW_MS);

        expect(result.selected[0].rank).toBe(1);
        const ranks = result.selected.map((entry: ISelectedSymbol) => entry.rank);
        expect(ranks).toEqual([1, 2, 3, 4]);
    });

    it('propagates trailingReturnPct to the selected entry from the eligible list', () => {
        const universe = [buildEntry('SOLOUSDT', 12.5), buildEntry('BTCUSDT', 5.0), buildEntry('ETHUSDT', 9.0)];
        const params = buildParams({ min_universe_size: 1, top_n: 3 });

        const result = crossSectionalMomentumCore(universe, params, NOW_MS);

        expect(result.selected[0].symbol).toBe('SOLOUSDT');
        expect(result.selected[0].trailingReturnPct).toBe(12.5);
        expect(result.selected[1].symbol).toBe('ETHUSDT');
        expect(result.selected[1].trailingReturnPct).toBe(9.0);
    });
});

// ─── determinism and mutation guard ──────────────────────────────────────────

describe('crossSectionalMomentumCore — determinism and no input mutation', () => {
    it('produces identical output on two consecutive calls with the same inputs', () => {
        const universe = [buildEntry('AAAUSDT', 5.0), buildEntry('BBBUSDT', 3.0), buildEntry('CCCUSDT', 7.0)];
        const params = buildParams({ min_universe_size: 1, top_n: 3 });

        const first = crossSectionalMomentumCore(universe, params, NOW_MS);
        const second = crossSectionalMomentumCore(universe, params, NOW_MS);

        expect(second.reason).toBe(first.reason);
        expect(second.selected).toEqual(first.selected);
    });

    it('does not mutate the input universe array order', () => {
        const universe = [buildEntry('CCCUSDT', 7.0), buildEntry('AAAUSDT', 5.0), buildEntry('BBBUSDT', 3.0)];
        const originalOrder = universe.map((entry) => entry.symbol);
        const params = buildParams({ min_universe_size: 1, top_n: 3 });

        crossSectionalMomentumCore(universe, params, NOW_MS);

        // The original array must be in the same order after the call.
        expect(universe.map((entry) => entry.symbol)).toEqual(originalOrder);
    });

    it('produces the same tie-break order regardless of input array permutation', () => {
        const permutation1 = [buildEntry('ZZZUSDT', 5.0), buildEntry('AAAUSDT', 5.0), buildEntry('MMMUSDT', 5.0)];
        const permutation2 = [buildEntry('AAAUSDT', 5.0), buildEntry('MMMUSDT', 5.0), buildEntry('ZZZUSDT', 5.0)];
        const params = buildParams({ min_universe_size: 1, top_n: 3 });

        const result1 = crossSectionalMomentumCore(permutation1, params, NOW_MS);
        const result2 = crossSectionalMomentumCore(permutation2, params, NOW_MS);

        expect(result1.selected.map((e: ISelectedSymbol) => e.symbol)).toEqual(result2.selected.map((e: ISelectedSymbol) => e.symbol));
    });
});
