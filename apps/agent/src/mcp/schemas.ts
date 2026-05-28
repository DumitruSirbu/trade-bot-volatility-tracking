// M13 W1.D — Zod schemas for the 6 MCP tool responses.
//
// These schemas are the SINGLE contract between the agent and MCP. The agent
// MUST NOT import `@bot/mcp` or `@bot/analysis` (ADR 0035 §2.2); when a tool's
// response shape lives only in those packages (e.g. `IGetDecisionsResult`,
// `IVersionComparisonResult`) we redeclare a structurally-identical Zod schema
// here. For shapes that already live in `@bot/shared` we import the TS type
// for the inferred-type cross-check only and keep Zod as the runtime parser.

import type {
    IBacktestReport,
    IClosedPositionView,
    IHaltStateView,
    IOpenPositionView,
    IPaginated,
    IPerformanceByVersionView,
    IVersionComparisonResult,
} from '@bot/shared';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Leaf schemas
// ---------------------------------------------------------------------------

const DecimalString = z.string();
const IsoTimestamp = z.string();

// ---------------------------------------------------------------------------
// get_halt_state — IHaltStateView
// ---------------------------------------------------------------------------

export const HaltStateViewSchema = z.object({
    isHalted: z.boolean(),
    haltReason: z.string().nullable(),
    asOf: IsoTimestamp,
});
// Cross-check: structural compatibility with the shared DTO.
const _haltStateCheck: IHaltStateView = {} as z.infer<typeof HaltStateViewSchema>;
void _haltStateCheck;

// ---------------------------------------------------------------------------
// get_performance — IPerformanceByVersionView
// ---------------------------------------------------------------------------

export const PerformanceByVersionViewSchema = z.object({
    strategyVersionId: z.string(),
    label: z.string(),
    status: z.string(),
    windowDays: z.number(),
    tradeCount: z.number(),
    winRate: DecimalString.nullable(),
    netPnlUsd: DecimalString,
    maxDrawdownUsd: DecimalString.nullable(),
    sharpe: DecimalString.nullable(),
    sortino: DecimalString.nullable(),
    expectancyPerUnitRisk: DecimalString.nullable(),
});
const _perfCheck: IPerformanceByVersionView = {} as z.infer<typeof PerformanceByVersionViewSchema>;
void _perfCheck;

// ---------------------------------------------------------------------------
// compare_versions — IVersionComparisonResult
// ---------------------------------------------------------------------------

const PairedDiffSummarySchema = z.object({
    pairedEventCount: z.number(),
    pairedTradedEventCount: z.number(),
    netPnlDeltaUsd: DecimalString,
    meanPnlDeltaUsd: DecimalString.nullable(),
    belowSampleFloor: z.boolean(),
});

export const VersionComparisonResultSchema = z.object({
    aPerformance: PerformanceByVersionViewSchema,
    bPerformance: PerformanceByVersionViewSchema,
    pairedDiff: PairedDiffSummarySchema,
});
const _cmpCheck: IVersionComparisonResult = {} as z.infer<typeof VersionComparisonResultSchema>;
void _cmpCheck;

// ---------------------------------------------------------------------------
// list_positions — IPaginated<IOpenPositionView | IClosedPositionView>
// ---------------------------------------------------------------------------

const OpenPositionViewSchema = z.object({
    id: z.string(),
    symbol: z.string(),
    side: z.string(),
    entryPrice: DecimalString,
    currentPrice: DecimalString,
    qty: DecimalString,
    leverage: DecimalString,
    unrealizedPnlPriceUsd: DecimalString,
    unrealizedPnlFundingUsd: DecimalString.nullable(),
    openedAt: IsoTimestamp,
    slot: z.number(),
    strategyVersionId: z.string(),
    eventId: z.string().nullable(),
    state: z.string(),
    protectiveOrderType: z.string(),
    slPrice: DecimalString.nullable(),
    tpPrice: DecimalString.nullable(),
});

const ClosedPositionViewSchema = z.object({
    id: z.string(),
    symbol: z.string(),
    side: z.string(),
    entryPrice: DecimalString,
    exitPrice: DecimalString.nullable(),
    qty: DecimalString,
    leverage: DecimalString,
    realizedPnlUsd: DecimalString.nullable(),
    openedAt: IsoTimestamp,
    closedAt: IsoTimestamp,
    exitReason: z.string(),
    strategyVersionId: z.string(),
});

const PositionViewSchema = z.union([OpenPositionViewSchema, ClosedPositionViewSchema]);

export const ListPositionsResultSchema = z.object({
    items: z.array(PositionViewSchema),
    nextCursor: z.string().nullable(),
    pageSize: z.number(),
});
type _PositionUnion = IOpenPositionView | IClosedPositionView;
const _listCheck: IPaginated<_PositionUnion> = { items: [], nextCursor: null, pageSize: 0 };
void _listCheck;

// ---------------------------------------------------------------------------
// get_decisions — IGetDecisionsResult (lives in @bot/analysis, redeclared here)
// ---------------------------------------------------------------------------

const DecisionViewSchema = z.object({
    id: z.string(),
    occurredAt: IsoTimestamp,
    symbol: z.string(),
    action: z.string(),
    flowType: z.string(),
    signalScore: z.string().nullable(),
    reason: z.string().nullable(),
    strategyVersionId: z.string(),
    eventId: z.string(),
    positionId: z.string().nullable().optional(),
});

export const GetDecisionsResultSchema = z.object({
    items: z.array(DecisionViewSchema),
    snapshots: z.record(z.unknown()).nullable(),
});

// ---------------------------------------------------------------------------
// run_backtest — IBacktestReport
// ---------------------------------------------------------------------------

const EquityPointSchema = z.object({
    utcDate: z.string(),
    equityUsdt: DecimalString,
    dailyReturnPct: DecimalString,
});

const BreakdownRowSchema = z.object({
    key: z.string(),
    tradeCount: z.number(),
    winRatePct: DecimalString,
    netPnlUsdt: DecimalString,
    profitFactor: DecimalString,
});

// IBacktestTradeResult is large; we accept any object shape and let the agent
// downstream code project the fields it actually needs. This keeps the Zod
// schema from drifting against an evolving trade-result shape.
const BacktestTradeResultSchema = z.object({}).passthrough();

// Optional bootstrap CI block. The engine does NOT yet surface this on
// IBacktestReport (criterion-5 source is IPerformanceByVersionView in M8);
// declaring it optional here lets the agent's promotion-gate criterion 5 + the
// runWeeklyLoop CI-bound extractor read a single typed field instead of a
// `as unknown as X` double-cast. When the engine wires the bootstrap block
// onto the run report (W4 follow-up), this schema parses it without
// modification.
const BootstrapCiSchema = z
    .object({
        ci: z
            .object({
                lo: DecimalString,
                hi: DecimalString,
            })
            .optional(),
    })
    .optional();

export const BacktestReportSchema = z.object({
    runLabel: z.string(),
    strategyVersionId: z.number(),
    strategyName: z.string(),
    strategyVersion: z.number(),
    fromUtcDate: z.string(),
    toUtcDate: z.string(),
    tradeCount: z.number(),
    winCount: z.number(),
    lossCount: z.number(),
    winRatePct: DecimalString,
    grossPnlUsdt: DecimalString,
    feesUsdt: DecimalString,
    fundingUsdt: DecimalString,
    slippageCostUsdt: DecimalString,
    netPnlUsdt: DecimalString,
    returnPct: DecimalString,
    profitFactor: DecimalString,
    avgHoldMs: z.number(),
    maxDrawdownPct: DecimalString,
    maxDrawdownDurationDays: z.number(),
    sharpeAnnualized: DecimalString,
    sortinoAnnualized: DecimalString,
    skippedTriggerCount: z.number(),
    rejectedByGateCount: z.number(),
    missedLimitFillCount: z.number(),
    lowFidelityTradeCount: z.number(),
    equityCurve: z.array(EquityPointSchema),
    perRegime: z.array(BreakdownRowSchema),
    perFlowType: z.array(BreakdownRowSchema),
    perSymbol: z.array(BreakdownRowSchema),
    trades: z.array(BacktestTradeResultSchema),
    bootstrap: BootstrapCiSchema,
});
// `trades[]` is parsed via a loose passthrough schema so the agent does not
// have to mirror the IBacktestTradeResult shape verbatim; the top-level
// summary fields the agent actually uses for prompt building remain strict.
type _BtKeysCheck = Pick<IBacktestReport, 'runLabel' | 'strategyVersionId' | 'netPnlUsdt' | 'sharpeAnnualized'>;
const _btCheck: _BtKeysCheck = {} as z.infer<typeof BacktestReportSchema>;
void _btCheck;

// ---------------------------------------------------------------------------
// Inferred TS types
// ---------------------------------------------------------------------------

export type HaltStateViewParsed = z.infer<typeof HaltStateViewSchema>;
export type PerformanceByVersionViewParsed = z.infer<typeof PerformanceByVersionViewSchema>;
export type VersionComparisonResultParsed = z.infer<typeof VersionComparisonResultSchema>;
export type ListPositionsResultParsed = z.infer<typeof ListPositionsResultSchema>;
export type GetDecisionsResultParsed = z.infer<typeof GetDecisionsResultSchema>;
export type BacktestReportParsed = z.infer<typeof BacktestReportSchema>;
