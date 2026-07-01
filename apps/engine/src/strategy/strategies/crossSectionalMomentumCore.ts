import { IMomentumParams, IPortfolioSelection, ISelectedSymbol, PortfolioSelectionReasonEnum, UniverseEntry } from '@bot/shared';

// Pure cross-sectional momentum ranking core (ADR 0047 §2.1). A deterministic function of
// (universe, params, nowMs): no I/O, no clock, no RNG, no mutation of inputs. The whole-universe
// "skip" is expressed as an empty selection with a reason — it never throws for the empty case.
// `nowMs` is threaded in for parity with the portfolio-strategy contract even though the ranking
// itself does not read a clock (the orchestrator single-sources the rebalance instant, ADR 0048).
export function crossSectionalMomentumCore(universe: ReadonlyArray<UniverseEntry>, params: IMomentumParams, nowMs: number): IPortfolioSelection {
    void nowMs;

    const eligible = universe.filter((entry) => entry.trailingReturnPct !== null && Number.isFinite(entry.trailingReturnPct));

    // No-eligible guard runs BEFORE the min-universe guard so a wholly-missing-data universe gets
    // its own distinct reason (a thin-but-present universe is universe_too_small, ADR 0048 §5).
    if (eligible.length === 0) {
        return { selected: [], reason: PortfolioSelectionReasonEnum.NO_ELIGIBLE_SYMBOLS };
    }

    if (eligible.length < params.min_universe_size) {
        return { selected: [], reason: PortfolioSelectionReasonEnum.UNIVERSE_TOO_SMALL };
    }

    const sorted = [...eligible].sort((left, right) => compareByReturnThenSymbol(left, right));
    const selected: ISelectedSymbol[] = sorted.slice(0, params.top_n).map((entry, index) => ({
        symbol: entry.symbol,
        rank: index + 1,
        trailingReturnPct: entry.trailingReturnPct as number,
    }));

    return { selected, reason: PortfolioSelectionReasonEnum.RANKED };
}

// Strongest trailing return first; ties broken by symbol ascending so the ranking is fully
// deterministic (matches the VWAP candidate tie-break, ADR 0004 §4).
function compareByReturnThenSymbol(left: UniverseEntry, right: UniverseEntry): number {
    const diff = (right.trailingReturnPct as number) - (left.trailingReturnPct as number);

    return diff !== 0 ? diff : left.symbol.localeCompare(right.symbol);
}
