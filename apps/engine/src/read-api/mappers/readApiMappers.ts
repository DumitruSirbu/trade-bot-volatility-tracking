import {
    FlowTypeEnum,
    IAccountEquityView,
    IClosedPositionView,
    IDailyPerformanceRow,
    IDecisionView,
    IOpenPositionView,
    IPerformanceByVersionView,
    IPositionDetailView,
    IRiskStateView,
    IShadowPerformanceSummary,
    mapDecisionOutcome,
    PositionSideEnum,
    PositionSlotEnum,
    PositionStateEnum,
    ProtectiveOrderTypeEnum,
    SignalActionEnum,
} from '@bot/shared';

import { Money, MoneyValue } from '../../common/utils/money';
import { AccountSnapshotEntity, PositionEntity } from '../../position/entity';
import { RiskStateEntity } from '../../risk/entity';
import { DecisionEntity, ShadowDecisionEntity } from '../../strategy/entity';
import { StrategyVersionEntity } from '../../strategy/entity/StrategyVersionEntity';

// M9 W4 (ADR 0022 §2.3-§2.4). Pure functions: entity → least-disclosure DTO.
//
// Every mapper enumerates the DTO keys EXPLICITLY (no spread, no Object.assign,
// no class-transformer @Expose). That's the construction-only-from-entities
// pattern from ADR 0022 §2.3 — a future entity column cannot accidentally leak
// onto the wire because the mapper does not see "the entity minus excludes",
// it sees "the keys I name".
//
// Money fields serialise as decimal-safe strings via `formatMoneyString` (the
// `Money.toFixed()` convention from the M4 helper). Nullable money fields
// return `null` rather than `'0'` so the dashboard can render "not set" vs.
// "zero" distinctly.

// ---------------------------------------------------------------------------
// Position views
// ---------------------------------------------------------------------------

export interface IOpenPositionMapInput {
    readonly position: PositionEntity;
    readonly markPrice: MoneyValue | null;
}

export function mapOpenPosition(input: IOpenPositionMapInput): IOpenPositionView {
    const { position, markPrice } = input;
    const effectiveMark = markPrice ?? position.entryPrice;
    // Read-API uses a price-only unrealized PnL approximation (fees / funding live
    // in the M6 W5 snapshot writer; surfacing them on the OPEN view would require
    // a second I/O hop per position per request — out of scope for this wave).
    // ADR 0012 §4's canonical helper stays the source of truth for accounting;
    // this projection is consciously a display estimate.
    const priceDelta = position.side === PositionSideEnum.LONG ? effectiveMark.minus(position.entryPrice) : position.entryPrice.minus(effectiveMark);
    const unrealised = priceDelta.times(position.qty);

    return {
        id: String(position.id),
        symbol: position.symbol,
        side: position.side,
        entryPrice: formatMoneyString(position.entryPrice),
        currentPrice: formatMoneyString(effectiveMark),
        qty: formatMoneyString(position.qty),
        leverage: formatMoneyString(position.leverage),
        unrealizedPnlPriceUsd: formatMoneyString(unrealised),
        // ADR 0022 §2.3.1: split fields surface the price-only estimate AND a
        // separate funding component. The funding accrual lives on the M6 W5
        // snapshot writer (deferred); until that wires `position.accruedFunding`
        // into the read path, the dashboard renders `null` as "n/a", never 0.
        unrealizedPnlFundingUsd: null,

        openedAt: position.openedAt.toISOString(),
        slot: slotToOrdinal(position.positionSlot),
        strategyVersionId: String(position.strategyVersionId),
        eventId: deriveEventId(position),
        state: position.state,
        protectiveOrderType: position.protectiveOrderType,
        slPrice: formatNullableMoney(position.stopLossPrice ?? null),
        tpPrice: formatNullableMoney(position.takeProfitPrice ?? null),
    };
}

export function mapClosedPosition(position: PositionEntity, strategyVersionName: string): IClosedPositionView {
    return {
        id: String(position.id),
        symbol: position.symbol,
        side: position.side,
        entryPrice: formatMoneyString(position.entryPrice),
        // ADR 0022 §2.3.1: never fabricate exitPrice/realizedPnl from entryPrice
        // or `0`. A null column means "not yet recorded" — the dashboard
        // surfaces "n/a" rather than a misleading sentinel.
        exitPrice: position.exitPrice !== null && position.exitPrice !== undefined ? formatMoneyString(position.exitPrice) : null,
        qty: formatMoneyString(position.qty),
        leverage: formatMoneyString(position.leverage),
        realizedPnlUsd: position.realizedPnl !== null && position.realizedPnl !== undefined ? formatMoneyString(position.realizedPnl) : null,
        openedAt: position.openedAt.toISOString(),
        closedAt: (position.closedAt ?? position.openedAt).toISOString(),
        // M9 W4 NOTE: ExitReasonEnum is the persisted column; rows pre-M6 may have
        // null. We fall back to the enum's canonical "unknown" sentinel only when
        // missing — never invent a category.
        exitReason: position.exitReason ?? ('unknown' as PositionEntity['exitReason'] & string),
        strategyVersionId: String(position.strategyVersionId),
        strategyVersionName,
    };
}

export interface IPositionDetailMapInput {
    readonly position: PositionEntity;
    readonly markPrice: MoneyValue | null;
    readonly clientOrderId: string;
    readonly strategyVersionName: string;
}

export function mapPositionDetail(input: IPositionDetailMapInput): IPositionDetailView {
    const open = mapOpenPosition({ position: input.position, markPrice: input.markPrice });

    return {
        id: open.id,
        symbol: open.symbol,
        side: open.side,
        entryPrice: open.entryPrice,
        currentPrice: open.currentPrice,
        qty: open.qty,
        leverage: open.leverage,
        unrealizedPnlPriceUsd: open.unrealizedPnlPriceUsd,
        unrealizedPnlFundingUsd: open.unrealizedPnlFundingUsd,
        openedAt: open.openedAt,
        slot: open.slot,
        strategyVersionId: open.strategyVersionId,
        strategyVersionName: input.strategyVersionName,
        eventId: open.eventId,
        state: open.state,
        protectiveOrderType: open.protectiveOrderType,
        slPrice: open.slPrice,
        tpPrice: open.tpPrice,
        // Detail-only fields per ADR 0022 §2.3. clientOrderId is the operator-debug
        // breadcrumb (never on the OPEN list view). reservationId / recoveryPhase
        // remain null until M6 W4b surfaces them on the entity directly — stubbed
        // here for the contract.
        clientOrderId: input.clientOrderId,
        reservationId: null,
        recoveryPhase: null,
    };
}

// ---------------------------------------------------------------------------
// Decision view
// ---------------------------------------------------------------------------

export function mapDecision(decision: DecisionEntity): IDecisionView {
    const positionId = decision.positionId === null || decision.positionId === undefined ? null : String(decision.positionId);

    return {
        id: String(decision.id),
        occurredAt: decision.ts.toISOString(),
        symbol: decision.symbol,
        action: decision.action as SignalActionEnum,
        outcome: mapDecisionOutcome({
            action: decision.action,
            gateAllowed: decision.gateAllowed,
            positionId,
        }),
        flowType: decision.signalType as FlowTypeEnum,
        // ADR 0022 §2.3.1: `null` distinguishes "skip decision had no score"
        // from "score was literally 0"; empty-string `reason` likewise ambiguous.
        signalScore: extractSignalScore(decision),
        reason: decision.reason ?? null,
        strategyVersionId: String(decision.strategyVersionId),
        eventId: decision.eventId,
        positionId,
    };
}

// ---------------------------------------------------------------------------
// Account equity view
// ---------------------------------------------------------------------------

export function mapAccountEquity(snapshot: AccountSnapshotEntity | null): IAccountEquityView {
    if (snapshot === null) {
        return {
            equityUsd: '0',
            marginUsed: null,
            freeMargin: null,
            openExposureUsd: null,
            asOf: new Date(0).toISOString(),
        };
    }

    // ADR 0022 §2.3.1: `marginUsed`, `freeMargin`, `openExposureUsd` are NOT
    // persisted as discrete columns on AccountSnapshotEntity yet — the M6 W7
    // writer is deferred. Reusing `balance`/`unrealizedPnl` as a stand-in
    // fabricates numbers the engine does not actually have (balance is not
    // free margin; unrealizedPnl is not exposure). Surface `null` so the
    // dashboard renders "n/a" until the writer ships.
    return {
        equityUsd: formatMoneyString(snapshot.equity),
        marginUsed: null,
        freeMargin: null,
        openExposureUsd: null,
        asOf: snapshot.ts.toISOString(),
    };
}

// ---------------------------------------------------------------------------
// Risk state view
// ---------------------------------------------------------------------------

export function mapRiskState(state: RiskStateEntity | null, asOfDate: string): IRiskStateView {
    if (state === null) {
        return {
            date: asOfDate,
            realizedPnlDay: '0',
            openExposure: '0',
            tradesCount: 0,
            isHalted: false,
            haltReason: null,
            lossWindowsState: {},
        };
    }

    return {
        date: state.date,
        realizedPnlDay: formatMoneyString(state.realizedPnlDay),
        openExposure: formatMoneyString(state.openExposure),
        tradesCount: state.tradesCount,
        isHalted: state.isHalted,
        haltReason: state.haltReason ?? null,
        // M9 W4 NOTE: per-window aggregate state (M4 daily / weekly loss windows)
        // is not yet persisted as a separate column. The view returns an empty
        // map for now; the M4 writer adds the projection in a follow-up wave.
        lossWindowsState: {},
    };
}

// ---------------------------------------------------------------------------
// Performance by version
// ---------------------------------------------------------------------------

export interface IPerformanceAggregateRow {
    readonly strategyVersionId: number;
    readonly tradeCount: number;
    readonly winCount: number;
    readonly netPnlUsd: string;
}

export function mapPerformanceByVersion(
    row: IPerformanceAggregateRow,
    version: StrategyVersionEntity,
    windowDays: number,
    liveStrategyVersionId: number | null,
): IPerformanceByVersionView {
    // ADR 0022 §2.3.1: drawdown / sharpe / sortino / expectancyPerUnitRisk
    // require a per-version equity series that the live engine does not
    // compute; the M7 backtest reporter owns those numbers. Surface `null`
    // here so the dashboard falls back to the comparison-report artefact.
    //
    // M9 R2 wave B (Q7): the shared contract now types `winRate: string | null`.
    // Return `null` when `tradeCount === 0` so consumers distinguish "no trades
    // observed in the window" from "0% win rate over a real sample". The prior
    // `'0.000000'` sentinel conflated the two and would silently rank an empty
    // version equal to a fully losing one in dashboard sort orders.
    const winRate = row.tradeCount > 0 ? new Money(row.winCount).div(row.tradeCount).toFixed(6) : null;

    return {
        strategyVersionId: String(row.strategyVersionId),
        label: `${version.name}@v${version.version}`,
        isLive: row.strategyVersionId === liveStrategyVersionId,
        status: version.status,
        windowDays,
        tradeCount: row.tradeCount,
        winRate,
        netPnlUsd: formatMoneyString(new Money(row.netPnlUsd)),
        maxDrawdownUsd: null,
        sharpe: null,
        sortino: null,
        expectancyPerUnitRisk: null,
        forceCloseFraction: null,
        missRate: null,
    };
}

// ---------------------------------------------------------------------------
// Daily performance series
// ---------------------------------------------------------------------------

interface IDailyPerformanceAggregateRow {
    readonly strategyVersionId: number;
    readonly date: string;
    readonly trades: number;
    readonly winCount: number;
    readonly netPnlUsd: string;
}

// Wave 2 — flatten per-day-per-version aggregates into IDailyPerformanceRow[], stamping a running
// cumulative PnL per version. The rows arrive already sorted (strategyVersionId ASC, date ASC) from
// `aggregateDailyByVersion`, so a single forward pass accumulates `cumulativePnlUsd` correctly
// without re-sorting. A version absent from the map (out-of-band deletion) is skipped — the same
// silent-skip policy `getPerformanceByVersion` applies.
export function mapDailyPerformanceRows(
    rows: ReadonlyArray<IDailyPerformanceAggregateRow>,
    versions: ReadonlyMap<number, StrategyVersionEntity>,
    liveStrategyVersionId: number | null,
): IDailyPerformanceRow[] {
    const cumulativeByVersion = new Map<number, MoneyValue>();
    const mapped: IDailyPerformanceRow[] = [];

    for (const row of rows) {
        const version = versions.get(row.strategyVersionId);

        if (version === undefined) {
            continue;
        }

        const dayPnl = new Money(row.netPnlUsd);
        const runningTotal = (cumulativeByVersion.get(row.strategyVersionId) ?? new Money(0)).plus(dayPnl);
        cumulativeByVersion.set(row.strategyVersionId, runningTotal);

        mapped.push({
            strategyVersionId: String(row.strategyVersionId),
            label: `${version.name}@v${version.version}`,
            isLive: row.strategyVersionId === liveStrategyVersionId,
            date: row.date,
            trades: row.trades,
            winCount: row.winCount,
            winRate: computeRateString(row.winCount, row.trades),
            dayPnlUsd: formatMoneyString(dayPnl),
            cumulativePnlUsd: formatMoneyString(runningTotal),
        });
    }

    mapped.sort((left, right) => compareByLabelThenDate(left, right));

    return mapped;
}

function compareByLabelThenDate(left: IDailyPerformanceRow, right: IDailyPerformanceRow): number {
    const byLabel = left.label.localeCompare(right.label);

    if (byLabel !== 0) {
        return byLabel;
    }

    return left.date.localeCompare(right.date);
}

// ---------------------------------------------------------------------------
// Shadow performance summary
// ---------------------------------------------------------------------------

interface IShadowTradePnl {
    readonly grossPnl: MoneyValue;
    readonly netPnl: MoneyValue;
    readonly forceClose: boolean;
}

interface IShadowVersionAccumulator {
    tradeCount: number;
    winCount: number;
    forceCloseCount: number;
    netPnl: MoneyValue;
    strategyVersionId: number;
}

// Wave 2 — collapse completed shadow trades into one IShadowPerformanceSummary per shadowVersion.
// PnL is computed per entity from the simulated-fill JSONB via Money (no float arithmetic). `missRate`
// is left null: it needs the open-decision denominator from a separate query out of scope for this
// endpoint. Win is defined on NET PnL > 0 (gross minus both fee legs) so a fee-eroded "winner" does
// not inflate the win rate.
export function mapShadowPerformanceSummary(
    entities: ReadonlyArray<ShadowDecisionEntity>,
    versions: ReadonlyMap<number, StrategyVersionEntity>,
    windowDays: number,
): IShadowPerformanceSummary[] {
    const accumulatorByVersion = new Map<string, IShadowVersionAccumulator>();

    for (const entity of entities) {
        const accumulator = accumulatorByVersion.get(entity.shadowVersion) ?? createShadowAccumulator(entity.strategyVersionId);
        applyShadowTrade(accumulator, computeShadowTradePnl(entity));
        accumulatorByVersion.set(entity.shadowVersion, accumulator);
    }

    const summaries: IShadowPerformanceSummary[] = [];

    for (const [shadowVersion, accumulator] of accumulatorByVersion) {
        summaries.push(toShadowSummary(shadowVersion, accumulator, versions, windowDays));
    }

    summaries.sort((left, right) => left.shadowVersion.localeCompare(right.shadowVersion));

    return summaries;
}

function applyShadowTrade(accumulator: IShadowVersionAccumulator, pnl: IShadowTradePnl): void {
    accumulator.tradeCount += 1;
    accumulator.netPnl = accumulator.netPnl.plus(pnl.netPnl);

    if (pnl.netPnl.greaterThan(0)) {
        accumulator.winCount += 1;
    }

    if (pnl.forceClose) {
        accumulator.forceCloseCount += 1;
    }
}

function createShadowAccumulator(strategyVersionId: number): IShadowVersionAccumulator {
    return {
        tradeCount: 0,
        winCount: 0,
        forceCloseCount: 0,
        netPnl: new Money(0),
        strategyVersionId,
    };
}

function computeShadowTradePnl(entity: ShadowDecisionEntity): IShadowTradePnl {
    const fill = entity.simulatedFill;
    const entryPrice = new Money(fill?.entryPrice ?? '0');
    const exitPrice = new Money(fill?.exitPrice ?? '0');
    const qty = new Money(entity.qty ?? '0');
    const directionSign = entity.tradeSide === PositionSideEnum.LONG ? 1 : -1;

    const grossPnl = exitPrice.minus(entryPrice).times(qty).times(directionSign);
    const feeEntry = new Money(fill?.feeUsdtEntry ?? '0');
    const feeExit = new Money(fill?.feeUsdtExit ?? '0');
    // `entryPrice` holds the clean reference price (nextBarOpenPrice); entry slippage is carried
    // separately as a signed pct. Without this the trade reads optimistic by the slippage cost.
    // Cost = |slippagePct| / 100 × entryNotional (BacktestPnLLedger.addSlippage convention).
    const slippageCost = new Money(fill?.slippageEntryPct ?? '0').abs().div(100).times(entryPrice).times(qty);
    const netPnl = grossPnl.minus(feeEntry).minus(feeExit).minus(slippageCost);

    return { grossPnl, netPnl, forceClose: fill?.forceClose === true };
}

function toShadowSummary(
    shadowVersion: string,
    accumulator: IShadowVersionAccumulator,
    versions: ReadonlyMap<number, StrategyVersionEntity>,
    windowDays: number,
): IShadowPerformanceSummary {
    const version = versions.get(accumulator.strategyVersionId);
    const strategyVersionId = version === undefined ? '0' : String(accumulator.strategyVersionId);
    const label = version === undefined ? shadowVersion : `${version.name}@v${version.version}`;

    return {
        shadowVersion,
        strategyVersionId,
        label,
        windowDays,
        tradeCount: accumulator.tradeCount,
        winCount: accumulator.winCount,
        winRate: computeRateString(accumulator.winCount, accumulator.tradeCount),
        netPnlUsd: formatMoneyString(accumulator.netPnl),
        forceCloseFraction: computeRateString(accumulator.forceCloseCount, accumulator.tradeCount),
        // miss rate needs the open-decision denominator from a separate query — null until wired.
        missRate: null,
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Null when the denominator is 0 so consumers distinguish "no sample" from a real 0% rate (the
// `winRate: string | null` contract from ADR 0022 §2.3.1, reused for force-close fraction).
function computeRateString(numerator: number, denominator: number): string | null {
    if (denominator === 0) {
        return null;
    }

    return new Money(numerator).div(denominator).toFixed(6);
}

function formatMoneyString(value: MoneyValue): string {
    return value.toFixed();
}

function formatNullableMoney(value: MoneyValue | null): string | null {
    if (value === null) {
        return null;
    }

    return formatMoneyString(value);
}

const SLOT_ORDINAL_BY_ENUM: Record<PositionSlotEnum, number> = {
    [PositionSlotEnum.A]: 1,
    [PositionSlotEnum.B]: 2,
    [PositionSlotEnum.C]: 3,
};

function slotToOrdinal(slot: PositionSlotEnum | null | undefined): number {
    if (slot === null || slot === undefined) {
        return 0;
    }

    return SLOT_ORDINAL_BY_ENUM[slot] ?? 0;
}

function deriveEventId(position: PositionEntity): string {
    // `event_id` on the OPEN view echoes the strategy decision that opened the
    // position. The PositionEntity itself does not persist eventId (carried
    // only on DecisionEntity), so we fall back to the row id stringified — a
    // stable identifier the dashboard can correlate against /v1/decisions
    // server-side.  M9 W4 NOTE: a proper eventId column is deferred to the
    // dashboard milestone (M10 will route through /v1/decisions?positionId).
    return `pos-${position.id}`;
}

function extractSignalScore(decision: DecisionEntity): string | null {
    // signalScore is captured on the position row at open (`signalScoreAtEntry`)
    // but the decision row's `market_snapshot` is the authoritative carrier for
    // the raw score. We attempt to read it from the snapshot's known location;
    // when absent (legacy rows, skip decisions), return `null` per ADR 0022
    // §2.3.1 — distinguishes "score=0" from "skip decision had no score".
    const snapshot = decision.marketSnapshot as unknown as Record<string, unknown> | null;

    if (snapshot === null || snapshot === undefined) {
        return null;
    }

    // Canonical `IMarketSnapshot` field is snake_case `signal_score`; older test
    // fixtures used camelCase `signalScore` — accept both.
    const raw = snapshot['signal_score'] ?? snapshot['signalScore'];

    if (typeof raw === 'string') {
        return raw;
    }

    if (typeof raw === 'number' && Number.isFinite(raw)) {
        return new Money(raw).toFixed(6);
    }

    return null;
}

// Permitted-key snapshots for the test layer (ADR 0022 §2.3 part 3). Exporting
// the lists from the mapper file lets the read-api test assert the wire shape
// against the source of truth — the mapper itself — instead of duplicating
// the list. Any new mapper field forces a deliberate edit here, surfacing in
// the test snapshot as a diff.
export const OPEN_POSITION_VIEW_KEYS: ReadonlyArray<keyof IOpenPositionView> = [
    'id',
    'symbol',
    'side',
    'entryPrice',
    'currentPrice',
    'qty',
    'leverage',
    'unrealizedPnlPriceUsd',
    'unrealizedPnlFundingUsd',
    'openedAt',
    'slot',
    'strategyVersionId',
    'eventId',
    'state',
    'protectiveOrderType',
    'slPrice',
    'tpPrice',
];

export const CLOSED_POSITION_VIEW_KEYS: ReadonlyArray<keyof IClosedPositionView> = [
    'id',
    'symbol',
    'side',
    'entryPrice',
    'exitPrice',
    'qty',
    'leverage',
    'realizedPnlUsd',
    'openedAt',
    'closedAt',
    'exitReason',
    'strategyVersionId',
    'strategyVersionName',
];

export const POSITION_DETAIL_VIEW_KEYS: ReadonlyArray<keyof IPositionDetailView> = [
    ...OPEN_POSITION_VIEW_KEYS,
    'strategyVersionName',
    'clientOrderId',
    'reservationId',
    'recoveryPhase',
];

export const DECISION_VIEW_KEYS: ReadonlyArray<keyof IDecisionView> = [
    'id',
    'occurredAt',
    'symbol',
    'action',
    'outcome',
    'flowType',
    'signalScore',
    'reason',
    'strategyVersionId',
    'eventId',
    'positionId',
];

export const ACCOUNT_EQUITY_VIEW_KEYS: ReadonlyArray<keyof IAccountEquityView> = ['equityUsd', 'marginUsed', 'freeMargin', 'openExposureUsd', 'asOf'];

export const RISK_STATE_VIEW_KEYS: ReadonlyArray<keyof IRiskStateView> = [
    'date',
    'realizedPnlDay',
    'openExposure',
    'tradesCount',
    'isHalted',
    'haltReason',
    'lossWindowsState',
];

export const PERFORMANCE_BY_VERSION_VIEW_KEYS: ReadonlyArray<keyof IPerformanceByVersionView> = [
    'strategyVersionId',
    'label',
    'isLive',
    'status',
    'windowDays',
    'tradeCount',
    'winRate',
    'netPnlUsd',
    'maxDrawdownUsd',
    'sharpe',
    'sortino',
    'expectancyPerUnitRisk',
    'forceCloseFraction',
    'missRate',
];

export const DAILY_PERFORMANCE_ROW_KEYS: ReadonlyArray<keyof IDailyPerformanceRow> = [
    'strategyVersionId',
    'label',
    'isLive',
    'date',
    'trades',
    'winCount',
    'winRate',
    'dayPnlUsd',
    'cumulativePnlUsd',
];

export const SHADOW_PERFORMANCE_SUMMARY_KEYS: ReadonlyArray<keyof IShadowPerformanceSummary> = [
    'shadowVersion',
    'strategyVersionId',
    'label',
    'windowDays',
    'tradeCount',
    'winCount',
    'winRate',
    'netPnlUsd',
    'forceCloseFraction',
    'missRate',
];

// Linter pleaser: `PositionSideEnum`, `PositionStateEnum`, `ProtectiveOrderTypeEnum`
// are re-exported in the typed positions above; this no-op reference keeps the
// imports load-bearing for downstream consumers that import from this barrel.
export const READ_API_MAPPER_ENUM_TOUCH = {
    side: PositionSideEnum,
    state: PositionStateEnum,
    protective: ProtectiveOrderTypeEnum,
};
