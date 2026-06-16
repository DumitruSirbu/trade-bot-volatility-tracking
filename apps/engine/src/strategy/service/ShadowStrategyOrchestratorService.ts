import {
    classifyFlowType,
    computeSignalScore,
    IMarketSnapshot,
    IStrategyParams,
    IVirtualGateOutcome,
    IVirtualLedgerSnapshot,
    IVolatilityDetectedEvent,
    MissedReasonEnum,
    OrderPolicyEnum,
    PositionSideEnum,
    SignalActionEnum,
    type ISimulatedFill,
    type ITierSlippageParams,
} from '@bot/shared';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import Decimal from 'decimal.js';

import { Money, MoneyValue } from '../../common/utils/money';
import { AppConfigService } from '../../config/service';
import { RISK_PER_TRADE_PCT } from '../../risk/const';
import { HistoricalFillAdapter, IFillRequest, IStopSimulatorResult } from '../../backtest/fill/HistoricalFillAdapter';
import { TickAggregateEntity } from '../../market-data/entity';
import { TickAggregateRepository } from '../../market-data/repository/TickAggregateRepository';
import {
    SHADOW_FILL_LATENCY_MS,
    SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL,
    SHADOW_GATE_HALT_AFTER_CONSECUTIVE_LOSSES,
    SHADOW_GATE_MARGIN_MODE,
    SHADOW_GATE_MAX_OPEN_POSITIONS,
    SHADOW_GATE_MAX_TRADES_PER_DAY,
    SHADOW_GATE_REQUIRE_EXHAUSTION_CONFIRMATION,
    SHADOW_GATE_SKIP_MARKET_STRESS,
    SHADOW_TAKER_FEE_PCT,
    SHADOW_VERSION_DISCRIMINATOR_PREFIX,
} from '../const';
import { StrategyVersionEntity } from '../entity';
import { buildMarketSnapshot } from '../mapper';
import { IStrategy } from '../interface';
import { StrategyRegistry } from '../registry';
import { ShadowDecisionRepository } from '../repository/ShadowDecisionRepository';
import { StrategyVersionRepository } from '../repository/StrategyVersionRepository';
import { reconstructReferencePrice } from '../utils';
import { VirtualPositionLedgerService } from './VirtualPositionLedgerService';

// One resolved shadow version with its per-version ledger + strategy + params.
// Held in-memory once at boot; the ledger mutates as the soak progresses.
interface IResolvedShadow {
    readonly row: StrategyVersionEntity;
    readonly discriminator: string;
    readonly strategy: IStrategy;
    readonly params: IStrategyParams;
    readonly ledger: VirtualPositionLedgerService;
}

// W5c FIX 5: the four open-only sizing fields (qty / stopLoss / takeProfit /
// simulatedFill) move together — they are populated iff the row represents a
// realised OPEN that passed the gate. Grouping them on a single discriminated
// `openData` member makes the "required for OPEN / null for SKIP" invariant
// expressible in the type system; a SKIP/gate-rejected row carries
// `openData: null`, an OPEN row carries every field non-null.
interface IShadowOpenData {
    readonly qty: string;
    readonly stopLoss: string;
    readonly takeProfit: string;
    readonly simulatedFill: ISimulatedFill;
}

// M26 (ADR 0029): the per-event signal-bar evidence loaded ONCE in `runShadows`
// and threaded immutably into every `runOneShadow` (A2 — one DB read per event,
// not per shadow version, so all versions see an identical verdict). `ticks` are
// the signal-bar `tick_aggregates` over the half-open window `[barOpen, barOpen+5m)`;
// `nextBarOpenPrice` is the M7-aligned entry reference (last signal-bar tick close,
// the bar-close ≈ next-bar open proxy on a continuous tape). Both collapse to the
// "no evidence" state when the tick set is empty: `ticks.length === 0` ⇒
// `nextBarOpenPrice === null` ⇒ the shadow open is declined as a conservative miss
// (A3/A4) — mirroring `BacktestOrchestrator` returning `null` when no next bar exists.
interface ISignalBarEvidence {
    readonly ticks: TickAggregateEntity[];
    readonly nextBarOpenPrice: string | null;
}

// FIX 7: persist-call input grouped into a single structured argument so the
// call site stays readable (≤2-argument convention). Private to this service —
// not part of the shared contract surface.
interface IShadowDecisionPersistInput {
    readonly shadow: IResolvedShadow;
    readonly event: IVolatilityDetectedEvent;
    readonly snapshot: IMarketSnapshot;
    readonly action: SignalActionEnum;
    readonly tradeSide: PositionSideEnum | null;
    readonly gateOutcome: IVirtualGateOutcome;
    readonly virtualSnapshot: IVirtualLedgerSnapshot;
    readonly openData: IShadowOpenData | null;
}

// M37 (D1.6): grouped input for the shadow fill counterfactual (≤2-argument
// convention). All money fields are decimal-as-string at the boundary.
interface IShadowFillInput {
    readonly shadow: IResolvedShadow;
    readonly event: IVolatilityDetectedEvent;
    readonly side: PositionSideEnum;
    readonly entryPriceStr: string;
    readonly qtyStr: string;
    readonly stopLossStr: string;
    readonly takeProfitStr: string;
    readonly evidence: ISignalBarEvidence;
}

// M37 (D1.6): the resolved forward-only exit — price, reason, and a deterministic
// close timestamp derived from the breaching (or last) tick, never wall-clock.
interface IShadowExitOutcome {
    readonly exitPrice: string;
    readonly closeReason: 'sl' | 'tp' | 'force_close';
    readonly closedAt: string | null;
}

// M11a W2 (ADR 0029 §2.2). Orchestrates the shadow-mode counterfactual: when
// the live `StrategyService` finishes routing v1's decision for an event, this
// service evaluates every non-active, non-archived strategy version against
// the SAME event with its OWN ledger, routes the open through the M7 fill
// simulator (ADR 0029 §2.3 hard rule), and persists a `shadow_decisions` row.
//
// Hard rules honoured:
//   - Strategies remain PURE (this service builds inputs, never patches strategies).
//   - Shadow run is FIRE-AND-FORGET — `StrategyService` wraps `runShadows` in
//     try/catch so a shadow failure cannot cascade into the active path.
//   - Idempotent on restart: `insertShadowDecision` is idempotent on
//     (shadow_version, event_id) and `tryOpen` / `tryClose` are idempotent on
//     eventId. Cold-restart ledger rebuild is BEST-EFFORT in W2 — see
//     `rebuildLedger` doc for the documented limitation.
//   - The fill simulator is the SAME `HistoricalFillAdapter` M7 uses (no
//     parallel implementation per ADR 0029 §2.3 alt #4).
//
// Sizing input (ADR 0029 §5 open question (a)): each shadow ledger sizes
// against the per-shadow virtual equity seeded from `PAPER_STARTING_EQUITY_USDT`.
// Notional is derived directly here (risk_per_trade_pct × equity × entry / stop
// distance) rather than reusing live `PositionSizer` because shadow opens
// never reach the live risk gate — there is no instrument-min-notional
// enforcement and no funding-suppress on the shadow path; both would cause
// shadow opens to silently drop and bias the counterfactual.
@Injectable()
export class ShadowStrategyOrchestratorService implements OnModuleInit {
    private readonly logger = new Logger(ShadowStrategyOrchestratorService.name);

    private readonly shadows: IResolvedShadow[] = [];

    constructor(
        private readonly config: AppConfigService,
        private readonly registry: StrategyRegistry,
        private readonly strategyVersions: StrategyVersionRepository,
        private readonly shadowDecisions: ShadowDecisionRepository,
        // M26 (A1): TickAggregateRepository is exported by MarketDataModule, which
        // StrategyModule already imports. Injecting it here loads signal-bar ticks
        // WITHOUT pulling BacktestModule (CandleLoader lives there and would form the
        // cycle StrategyModule → BacktestModule → StrategyModule).
        private readonly tickAggregates: TickAggregateRepository,
        private readonly moduleRef: ModuleRef,
    ) {}

    // M36 (D3/D4): the effective consecutive-loss halt threshold the shadow path
    // applies to BOTH the per-call gate (`haltAfterConsecutiveLosses`) AND the
    // durable arm inside `tryClose`. Returns the unreachable sentinel under
    // PAPER_RELAX_CONSECUTIVE_LOSS_HALT so neither surface can fire; otherwise the
    // restricted-profile const. Read once per call site so the gate input and the
    // close path never diverge (the trap: the durable arm short-circuits
    // `evaluateGates` via `isHalted()`, so both must use the same value).
    private get effectiveConsecutiveLossHaltThreshold(): number {
        return this.config.paperRelaxConsecutiveLossHalt ? SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL : SHADOW_GATE_HALT_AFTER_CONSECUTIVE_LOSSES;
    }

    async onModuleInit(): Promise<void> {
        // M37 (D1.3): the shadow set is resolved ONCE at boot from
        // `strategy_versions.status = shadow`. A version whose status flips to
        // `shadow` at runtime (a live promotion demoting the incumbent — see
        // PromotionService.demoteIncumbentToShadow) is therefore NOT picked up
        // until the next restart. This is acceptable today because promotion is a
        // config-change-plus-restart operation (ACTIVE_STRATEGY_VERSION_ID is an
        // env var read at boot); the demoted incumbent resumes shadow-logging on
        // the very next engine start with no durable gap.
        // TODO(M-future): a hot `reloadShadows()` that re-queries findActiveShadows
        // and resolves any newly-shadow version without a restart — tracked in
        // docs/tech-debt.md (LOW) under shadow-orchestrator runtime reload.
        const activeId = this.config.activeStrategyVersionId;
        const rows = await this.strategyVersions.findActiveShadows(activeId);

        for (const row of rows) {
            const resolved = await this.resolveShadow(row);

            if (resolved !== null) {
                this.shadows.push(resolved);
            }
        }

        for (const shadow of this.shadows) {
            await this.rebuildLedger(shadow);
        }

        const labels = this.shadows.map((shadow) => `${shadow.row.name}:${shadow.row.version}`).join(', ');
        this.logger.log(`Shadow orchestrator initialized: ${this.shadows.length} shadows ready${labels.length === 0 ? '' : ` [${labels}]`}`);
    }

    // Entry point invoked by `StrategyService.onVolatilityDetected` AFTER the
    // active-strategy path has finished. Each shadow re-classifies under its
    // own params (ADR 0029 §2.1 cardinal rule), so the active path's snapshot/
    // flowType/signalScore are NOT inputs here — only the raw event + clock.
    // All failures are contained internally so the live path is never affected.
    async runShadows(event: IVolatilityDetectedEvent, nowMs: number): Promise<void> {
        // M26 (A2): load the signal-bar evidence ONCE per event and thread it into
        // every shadow. Loading inside `runOneShadow` would issue N identical SELECTs
        // (one per shadow version) and open a determinism gap if ticks land between
        // versions — all shadows must judge the same tape.
        const evidence = await this.loadSignalBarEvidence(event);

        for (const shadow of this.shadows) {
            try {
                await this.runOneShadow(shadow, event, nowMs, evidence);
            } catch (cause) {
                const message = cause instanceof Error ? cause.message : String(cause);
                this.logger.error(`shadow run failed ${shadow.discriminator} eventId=${event.eventId}: ${message}`);
            }
        }
    }

    // M26 (A1/A2/A3/A4/A6): loads the signal-bar `tick_aggregates` over the half-open
    // window `[barOpen, barOpen+5m)` and derives the M7-aligned next-bar open entry
    // reference. The next-bar open price is approximated by the signal bar's last tick
    // close (bar-close ≈ next-bar open on a continuous tape) so it stays consistent with
    // the same tick set that drives the miss-detector (A6 — never mix a separate candle
    // read). When no ticks exist there is no next-bar evidence: `nextBarOpenPrice` is null,
    // the open is later declined as a conservative miss (A3), and a `debug` log makes the
    // missing-data case join/log-detectable (durable `missedReason` field deferred to M27).
    private async loadSignalBarEvidence(event: IVolatilityDetectedEvent): Promise<ISignalBarEvidence> {
        const ticks = await this.tickAggregates.loadTicksForBar(event.symbol, event.entryCandleOpenTime);

        if (ticks.length === 0) {
            this.logger.debug(
                { eventId: event.eventId, symbol: event.symbol, barOpenMs: event.entryCandleOpenTime },
                'Shadow: no tick_aggregates for signal bar — conservative missing-data miss',
            );

            return { ticks, nextBarOpenPrice: null };
        }

        const nextBarOpenPrice = ticks[ticks.length - 1].close.toFixed();

        return { ticks, nextBarOpenPrice };
    }

    private async runOneShadow(shadow: IResolvedShadow, event: IVolatilityDetectedEvent, nowMs: number, evidence: ISignalBarEvidence): Promise<void> {
        // Re-classify per shadow params so each version sees the flow_type +
        // signal_score it would have stamped live (v0/v2/v3 may have different
        // signal_score weights than v1).
        const flowType = classifyFlowType(event, shadow.params);
        const signalScore = computeSignalScore(event, shadow.params, flowType);
        const stampedEvent: IVolatilityDetectedEvent = { ...event, flowType };
        const snapshot = buildMarketSnapshot({ event: stampedEvent, params: shadow.params, flowType, signalScore });

        // Pure evaluate — strategies receive only the snapshot + their own
        // ledger's virtual open position (under restricted profile,
        // max_open_positions=1, so at most one). They never see v1's slot
        // state (ADR 0029 §2.1 "cardinal rule").
        const signal = shadow.strategy.evaluate({
            event: stampedEvent,
            snapshot,
            openPosition: null,
            params: shadow.params,
            nowMs,
        });

        const riskDayUtcDate = deriveRiskDayUtcDate(nowMs);

        // W5c FIX 1: reverse-signal close MUST happen BEFORE `evaluateGates`.
        // Under the restricted-profile `max_open_positions: 1`, the gate would
        // otherwise reject the new OPEN with `max_open_positions_reached` and
        // the close-then-reopen path would be dead code. We detect the
        // reverse-signal condition (existing open position for the same symbol
        // on the opposite side from the new OPEN's tradeSide), close at the
        // entry-price proxy, then evaluate gates against the cleared ledger.
        //
        // Same-side re-confirmations are NOT churned — they fall through to
        // the gate and are rejected naturally by `max_open_positions_reached`.
        //
        // TODO(M-future): `reconstructReferencePrice` is the entry-price proxy
        // used here as the close fill price. A dedicated `intent: 'close'`
        // simulation through HistoricalFillAdapter would be more accurate —
        // tracked in docs/tech-debt.md under shadow-orchestrator close-sim.
        const existingPosition = shadow.ledger.findOpenPositionBySymbol(event.symbol);
        const isReverseClose =
            signal.action === SignalActionEnum.OPEN &&
            signal.tradeSide !== null &&
            existingPosition !== null &&
            existingPosition.side !== sideToString(signal.tradeSide);

        if (isReverseClose) {
            const closePrice = reconstructReferencePrice(stampedEvent).toFixed();
            shadow.ledger.closeBySymbol(
                event.symbol,
                closePrice,
                nowMs,
                'reverse_signal',
                `${event.eventId}:reverse`,
                this.effectiveConsecutiveLossHaltThreshold,
            );
        }

        const virtualSnapshot = shadow.ledger.snapshotForDecision(nowMs);

        const gateOutcome = shadow.ledger.evaluateGates({
            eventId: event.eventId,
            nowMs,
            riskDayUtcDate,
            decision: { action: signal.action },
            maxOpenPositions: SHADOW_GATE_MAX_OPEN_POSITIONS,
            maxTradesPerDay: SHADOW_GATE_MAX_TRADES_PER_DAY,
            haltAfterConsecutiveLosses: this.effectiveConsecutiveLossHaltThreshold,
            requireExhaustionConfirmation: SHADOW_GATE_REQUIRE_EXHAUSTION_CONFIRMATION,
            skipMarketStress: SHADOW_GATE_SKIP_MARKET_STRESS,
            marginMode: SHADOW_GATE_MARGIN_MODE,
        });

        // `shouldSimulateFill` is the single gate. When true, the strategy's
        // OPEN signal carries non-null `tradeSide` and `proposedExit` by
        // construction (an OPEN without either is not a valid OPEN signal and
        // is excluded from `isOpen` below).
        const isOpen = signal.action === SignalActionEnum.OPEN && signal.tradeSide !== null && signal.proposedExit !== null;
        const shouldSimulateFill = isOpen && gateOutcome.allowed;

        let openData: IShadowOpenData | null = null;

        // M26 (A4): mirror M7 — shadow entry fills at the NEXT-bar open, not the
        // signal-bar reference. When no next bar exists (the signal bar produced no
        // tick_aggregates, so there is no next-bar open evidence), decline the open and
        // leave it as a conservative missing-data miss — mirroring `BacktestOrchestrator`
        // returning `null`. The missing-data case is already debug-logged in
        // `loadSignalBarEvidence`; the row still persists with `openData: null`.
        const hasNextBarEntry = evidence.nextBarOpenPrice !== null;

        if (shouldSimulateFill && !hasNextBarEntry) {
            this.logger.debug(
                { eventId: event.eventId, symbol: event.symbol, shadowVersion: shadow.discriminator },
                'Shadow: no next-bar open (no signal-bar ticks) — declining open as conservative miss',
            );
        }

        if (shouldSimulateFill && evidence.nextBarOpenPrice !== null && signal.tradeSide !== null && signal.proposedExit !== null) {
            const stopLossStr = signal.proposedExit.stopLossPrice.toFixed();
            const takeProfitStr = signal.proposedExit.takeProfitPrice.toFixed();
            // M26 (A4): the inline `nextBarOpenPrice !== null` check narrows the type, so
            // `nextBarOpenPrice` is non-null here — the next-bar open is the entry, sizing,
            // and limit reference.
            const entryPriceStr = evidence.nextBarOpenPrice;

            // W5c FIX 4: validate stop-loss side against the trade direction.
            // A malformed strategy that emits `stopLoss > entry` for a LONG
            // (or `stopLoss < entry` for a SHORT) would size normally here
            // (`deriveShadowQty` uses `.abs()` on the stop distance) but the
            // resulting position would "stop" by hitting take-profit — silent
            // incorrect behaviour. We skip the open with a WARN log; the row
            // is still persisted as a gate-allowed-but-not-filled record so
            // the soak sees the malformed-strategy footprint.
            if (!isStopSideValid(signal.tradeSide, entryPriceStr, stopLossStr)) {
                this.logger.warn(
                    { symbol: event.symbol, side: signal.tradeSide, entry: entryPriceStr, stopLoss: stopLossStr },
                    'Shadow: invalid stop-loss side — skipping open',
                );
            } else {
                const qtyForLedger = this.deriveShadowQty(shadow, entryPriceStr, stopLossStr);
                const simulatedFill = this.simulateShadowFill({
                    shadow,
                    event: stampedEvent,
                    side: signal.tradeSide,
                    entryPriceStr,
                    qtyStr: qtyForLedger,
                    stopLossStr,
                    takeProfitStr,
                    evidence,
                });

                openData = {
                    qty: qtyForLedger,
                    stopLoss: stopLossStr,
                    takeProfit: takeProfitStr,
                    simulatedFill,
                };
            }
        }

        await this.persistShadowDecision({
            shadow,
            event: stampedEvent,
            snapshot,
            action: signal.action,
            tradeSide: signal.tradeSide,
            gateOutcome,
            virtualSnapshot,
            openData,
        });

        // FIX 6: trust `shouldSimulateFill` as the single gate. Once
        // `simulatedFill` is non-null and not missed, `tradeSide` and
        // `proposedExit` are guaranteed populated by the block above. The
        // W5c FIX 1 reverse-close has already run above the gate so the
        // ledger here has at most `max_open_positions - 1` positions for
        // this symbol.
        if (openData !== null && !openData.simulatedFill.missed) {
            // Non-null assertions are safe under `shouldSimulateFill === true`
            // — same precondition that produced `openData`.
            const tradeSide = signal.tradeSide!;

            const result = shadow.ledger.tryOpen({
                eventId: event.eventId,
                nowMs,
                riskDayUtcDate,
                symbol: event.symbol,
                side: sideToString(tradeSide),
                entryPrice: openData.simulatedFill.entryPrice,
                qty: openData.qty,
                stopLoss: openData.stopLoss,
                takeProfit: openData.takeProfit,
                virtualOrderId: this.buildVirtualOrderId(shadow, event),
            });

            if (!result.success) {
                this.logger.debug(`shadow ledger tryOpen rejected ${shadow.discriminator} eventId=${event.eventId} reason=${result.reason ?? 'unknown'}`);
            }
        }
    }

    // M37 (D1.6, ADR 0029 M37 amendment): produce a NON-HOLLOW counterfactual for an
    // accepted shadow open. Entry is at the M26 next-bar-open reference (last signal-bar
    // tick close). Exit walks only the post-entry tick window — ticks at or after the
    // entry tick — so no pre-entry price action can trigger SL/TP (causal same-bar
    // approximation). In live evaluation the next bar is not yet available, so the
    // post-entry window is typically just the entry tick itself, and force_close is the
    // expected outcome for most shadow positions. lowFidelity: true until the depth-aware
    // extension (ADR 0029 §2.4).
    private simulateShadowFill(input: IShadowFillInput): ISimulatedFill {
        const { side, entryPriceStr, stopLossStr, takeProfitStr, evidence } = input;
        const entryPrice = new Money(entryPriceStr);

        if (evidence.ticks.length === 0) {
            return buildMissedShadowFill(MissedReasonEnum.MISSING_TICK_DATA);
        }

        const entryTick = evidence.ticks[evidence.ticks.length - 1];
        // Only ticks at-or-after the entry reference are causal; the full signal bar
        // contains pre-entry price action that a position opened at bar close could not
        // have experienced. In live evaluation the next bar is not yet available, so
        // force_close is the expected outcome for most shadow positions.
        const postEntryTicks = evidence.ticks.filter((t) => t.ts.getTime() >= entryTick.ts.getTime());
        const postEntryExtremes = deriveBarExtremes(postEntryTicks, entryPrice);
        const entrySlippagePct = this.computeEntrySlippagePct(input);
        const stop = new HistoricalFillAdapter().simulateIntrabarStop(
            side === PositionSideEnum.LONG ? 'long' : 'short',
            new Money(stopLossStr),
            new Money(takeProfitStr),
            postEntryTicks,
            postEntryExtremes.high,
            postEntryExtremes.low,
            input.event.entryCandleOpenTime,
        );
        const exit = this.resolveShadowExit(stop, evidence.ticks);

        return this.buildFilledShadowFill(input, entryPrice, entrySlippagePct, exit);
    }

    private buildFilledShadowFill(input: IShadowFillInput, entryPrice: MoneyValue, entrySlippagePct: string, exit: IShadowExitOutcome): ISimulatedFill {
        return {
            entryPrice: entryPrice.toFixed(),
            exitPrice: exit.exitPrice,
            slippageEntryPct: entrySlippagePct,
            slippageExitPct: '0',
            slippageComponents: {
                tierBase: entrySlippagePct,
                latency: '0',
                crossingSpread: '0',
            },
            feeUsdtEntry: computeTakerFeeUsdt(entryPrice.toFixed(), input.qtyStr),
            feeUsdtExit: computeTakerFeeUsdt(exit.exitPrice, input.qtyStr),
            missed: false,
            missedReason: null,
            forceClose: exit.closeReason === 'force_close',
            lowFidelity: true,
            closedAt: exit.closedAt,
            closeReason: exit.closeReason,
        };
    }

    // Entry-side slippage from the tier-floor model (REDUCE_MARKET — never misses).
    // Accepts the full IShadowFillInput DTO; the adapter is invoked only to read the
    // tier-floor slippage component, not to accept/reject the fill.
    private computeEntrySlippagePct(input: IShadowFillInput): string {
        const { shadow, event, side, entryPriceStr, qtyStr } = input;
        const entryPrice = new Money(entryPriceStr);
        const fillRequest: IFillRequest = {
            eventId: event.eventId,
            symbol: event.symbol,
            side: side === PositionSideEnum.LONG ? 'long' : 'short',
            intent: 'open',
            policy: OrderPolicyEnum.REDUCE_MARKET,
            limitPrice: entryPrice,
            qty: new Money(qtyStr),
            coinTier: event.coinTier,
            signalBarOpenMs: event.entryCandleOpenTime,
            barHigh: entryPrice,
            barLow: entryPrice,
            ticks: [],
            bookSnapshot: null,
            tierSlippageParams: this.toTierSlippageParams(shadow.params),
            config: {
                latencyMs: SHADOW_FILL_LATENCY_MS,
                enableDepthAwareSlippage: false,
                enableIntrabarStopSimulation: false,
            },
        };

        const fill = new HistoricalFillAdapter().simulateFill(fillRequest);

        return fill.slippagePct;
    }

    // Map the forward-only intra-bar stop verdict to the close fields. A breach (SL or TP)
    // closes at the hit price with the matching reason; no breach force-closes at the bar
    // close (the last tick close), the M26 next-bar-open ≈ bar-close proxy. `closedAt` is
    // derived from the relevant tick timestamp — deterministic, no wall-clock.
    private resolveShadowExit(stop: IStopSimulatorResult, ticks: TickAggregateEntity[]): IShadowExitOutcome {
        if (stop.hit !== null && stop.hitPrice !== null) {
            const closedAt = stop.hitTsMs === null ? null : new Date(stop.hitTsMs).toISOString();

            return {
                exitPrice: stop.hitPrice.toFixed(),
                closeReason: stop.hit === 'stop_loss' ? 'sl' : 'tp',
                closedAt,
            };
        }

        const lastTick = ticks[ticks.length - 1];

        return {
            exitPrice: lastTick.close.toFixed(),
            closeReason: 'force_close',
            closedAt: lastTick.ts.toISOString(),
        };
    }

    private deriveShadowQty(shadow: IResolvedShadow, entryPriceStr: string, stopLossPriceStr: string): string {
        // Per-shadow virtual equity (ADR 0029 §5 open question (a)): seed from
        // PAPER_STARTING_EQUITY_USDT and apply the same risk_per_trade_pct v1
        // would apply at its restricted profile. The shadow ledger does NOT
        // mutate equity over time in this wave — equity stays constant at the
        // soak baseline. Tracking realised PnL through equity is a follow-up
        // (deferred to W4 sizing calibration); the constant-equity assumption
        // keeps notional dimensionally comparable to v1's live notional which
        // also draws from the same starting equity.
        const equity = new Decimal(this.config.paperStartingEquityUsdt);
        const riskPerTradePct = new Decimal(RISK_PER_TRADE_PCT);
        const entryPrice = new Decimal(entryPriceStr);
        const stopLossPrice = new Decimal(stopLossPriceStr);
        const stopDistance = entryPrice.minus(stopLossPrice).abs();

        if (!stopDistance.isFinite() || stopDistance.isZero() || !entryPrice.isFinite() || entryPrice.isZero()) {
            return '0';
        }

        const riskBudget = equity.times(riskPerTradePct);
        const qty = riskBudget.dividedBy(stopDistance);

        return qty.toFixed();
    }

    private toTierSlippageParams(params: IStrategyParams): ITierSlippageParams {
        return {
            slippage_tier1_pct: params.slippage_tier1_pct,
            slippage_tier2_pct: params.slippage_tier2_pct,
            slippage_tier3_pct: params.slippage_tier3_pct,
        };
    }

    private buildVirtualOrderId(shadow: IResolvedShadow, event: IVolatilityDetectedEvent): string {
        return `${shadow.discriminator}:${event.eventId}`;
    }

    private async persistShadowDecision(input: IShadowDecisionPersistInput): Promise<void> {
        const { shadow, event, snapshot, action, tradeSide, gateOutcome, virtualSnapshot, openData } = input;

        await this.shadowDecisions.insertShadowDecision({
            eventId: event.eventId,
            shadowVersion: shadow.discriminator,
            strategyVersionId: shadow.row.id,
            symbol: event.symbol,
            action,
            // M11a W2.1: persist side so the cold-restart rebuild path can
            // restore the virtual ledger faithfully (ADR 0029 §2.1.3). Null
            // for skip / rejected rows that never had a side.
            tradeSide: tradeSide === null ? null : sideToString(tradeSide),
            rejectReason: gateOutcome.allowed ? null : (gateOutcome.rejectReason ?? null),
            gateAllowed: gateOutcome.allowed,
            virtualSlotStateSnapshot: virtualSnapshot,
            // W5c FIX 5: the four open-only fields move together — populated
            // iff `openData !== null` (gate-allowed OPEN that passed stop-side
            // validation). SKIP / gate-rejected / invalid-stop rows all emit
            // null for every open-only field.
            simulatedFill: openData?.simulatedFill ?? null,
            // M11a W5a (ADR 0029 §2.1.2): persist the sized qty + SL/TP so
            // the cold-restart rebuild can replay opens faithfully rather than
            // re-deriving qty from the entry price (which produced qty=0).
            qty: openData?.qty ?? null,
            stopLoss: openData?.stopLoss ?? null,
            takeProfit: openData?.takeProfit ?? null,
            haltRelaxActive: this.config.paperRelaxConsecutiveLossHalt,
            marketSnapshot: snapshot,
        });
    }

    private async resolveShadow(row: StrategyVersionEntity): Promise<IResolvedShadow | null> {
        try {
            const resolved = this.registry.resolve(row.name, row.version, row.params);
            // VirtualPositionLedgerService is Scope.TRANSIENT — `resolve` returns
            // a fresh instance per call (cf. W1 hand-off note). We cache the
            // per-version instance on the IResolvedShadow record so the same
            // ledger is reused across every event for this version.
            const ledger = await this.moduleRef.resolve(VirtualPositionLedgerService);

            return {
                row,
                discriminator: `${SHADOW_VERSION_DISCRIMINATOR_PREFIX}${row.version}`,
                strategy: resolved.strategy,
                params: resolved.params,
                ledger,
            };
        } catch (cause) {
            // A shadow that fails to resolve (bad params, no registered impl)
            // is logged and skipped rather than failing boot — the live path
            // must not be blocked by a misconfigured non-active version.
            const message = cause instanceof Error ? cause.message : String(cause);
            this.logger.warn(`skipping shadow ${row.name}:${row.version} (id=${row.id}) — resolve failed: ${message}`);

            return null;
        }
    }

    // Cold-restart ledger rebuild (ADR 0029 §2.1.2). Replays shadow_decisions
    // rows for this version in createdAt order: each `open` row with a
    // non-missed simulatedFill and gate_allowed=true replays through `tryOpen`
    // using the persisted qty/SL/TP (W5a). Rows missing qty (legacy rows
    // persisted before the W5a migration) are logged and skipped — silently
    // producing 0-qty opens biases the soak's PnL series and is forbidden.
    //
    // After all rows replay, every recorded `eventId` is seeded into the
    // ledger's `processedEventIds` set so a redelivered live event after
    // restart cannot double-open against the same id (ADR 0029 open question
    // (b) "event_id continuity across shadow restarts").
    private async rebuildLedger(shadow: IResolvedShadow): Promise<void> {
        const rows = await this.shadowDecisions.findRowsForLedgerRebuild(shadow.discriminator);
        let replayedOpens = 0;
        let skippedLegacyOpens = 0;
        const eventIds: string[] = [];

        for (const row of rows) {
            eventIds.push(row.eventId);
            const fill = row.simulatedFill ?? null;

            if (fill === null || !row.gateAllowed || row.action !== SignalActionEnum.OPEN || fill.missed) {
                continue;
            }

            // M11a W5a: never silently produce a 0-qty open. Legacy rows
            // persisted before the W5a migration have no qty column value;
            // log a warn and skip so the ledger replay stays honest.
            if (row.qty === null || row.qty === undefined || row.qty === '' || row.qty === '0') {
                this.logger.warn(
                    `skipping legacy shadow-decision open without persisted qty: shadowVersion=${shadow.discriminator} eventId=${row.eventId} — pre-W5a row`,
                );
                skippedLegacyOpens += 1;
                continue;
            }

            const replayResult = shadow.ledger.tryOpen({
                eventId: row.eventId,
                nowMs: row.createdAt.getTime(),
                riskDayUtcDate: deriveRiskDayUtcDate(row.createdAt.getTime()),
                symbol: row.symbol,
                // Defensive 'long' fallback for legacy rows persisted before
                // the W2.1 `trade_side` column landed. New rows always carry
                // a non-null tradeSide for OPEN actions.
                side: row.tradeSide ?? 'long',
                entryPrice: fill.entryPrice,
                qty: row.qty,
                stopLoss: row.stopLoss ?? '0',
                takeProfit: row.takeProfit ?? '0',
                virtualOrderId: `${shadow.discriminator}:${row.eventId}`,
            });

            if (replayResult.success) {
                replayedOpens += 1;
            }
        }

        // Seed idempotency cursor regardless of whether opens replayed — a
        // SKIP / gate-rejected row still consumed its event_id and a redeliver
        // must not re-fire downstream logic.
        if (eventIds.length > 0) {
            shadow.ledger.seedProcessedEventIds(eventIds);
        }

        if (rows.length > 0) {
            const rebuildSummary =
                `shadow ${shadow.discriminator} ledger rebuilt from ${rows.length} historical rows` +
                ` (replayed ${replayedOpens} opens, skipped ${skippedLegacyOpens} legacy)`;
            this.logger.log(rebuildSummary);
        }
    }

    // Test accessor — readonly count surface so the paired W2 unit spec can
    // assert "N shadows initialized" without reflecting into the private field.
    getResolvedShadowCount(): number {
        return this.shadows.length;
    }
}

function deriveRiskDayUtcDate(nowMs: number): string {
    return new Date(nowMs).toISOString().slice(0, 10);
}

function sideToString(side: PositionSideEnum): string {
    if (side === PositionSideEnum.LONG) {
        return 'long';
    }

    return 'short';
}

// W5c FIX 4: stop-side validity check — a LONG's stop must sit BELOW entry, a
// SHORT's stop must sit ABOVE entry. Compared as Decimal values (not raw
// strings) to honour the money-is-Decimal invariant and avoid lexicographic-
// string comparison bugs (e.g. '9' > '10' as strings).
function isStopSideValid(tradeSide: PositionSideEnum, entryPriceStr: string, stopLossStr: string): boolean {
    const entry = new Decimal(entryPriceStr);
    const stop = new Decimal(stopLossStr);

    if (tradeSide === PositionSideEnum.LONG) {
        return stop.lt(entry);
    }

    return stop.gt(entry);
}

// M37 (D1.6): the conservative-miss `ISimulatedFill` for the no-tape case — there is no
// forward path to judge an exit against, so the open stays a miss with `entryPrice:"0"`
// (never a fabricated fill). Accepted opens with ticks emit a filled result (typically
// force_close at bar close when the post-entry window contains no SL/TP breach).
function buildMissedShadowFill(missedReason: MissedReasonEnum): ISimulatedFill {
    return {
        entryPrice: '0',
        exitPrice: null,
        slippageEntryPct: '0',
        slippageExitPct: null,
        slippageComponents: {
            tierBase: '0',
            latency: '0',
            crossingSpread: '0',
        },
        missed: true,
        missedReason,
        forceClose: false,
        lowFidelity: true,
        closedAt: null,
        closeReason: null,
    };
}

function computeTakerFeeUsdt(priceStr: string, qtyStr: string): string {
    return new Decimal(priceStr).times(new Decimal(qtyStr)).times(new Decimal(SHADOW_TAKER_FEE_PCT)).toFixed();
}

interface IBarExtremes {
    readonly high: MoneyValue;
    readonly low: MoneyValue;
}

// M26 (A6): derive the signal bar's high/low from the loaded tick set (max of tick
// highs, min of tick lows) so the fill snapshot draws from a single source of truth.
// When the tick set is empty the fill never reaches this path through an OPEN (the
// open is declined upstream), but a defensive `entryPrice` fallback keeps the request
// well-formed for any direct caller. These extremes do NOT drive `isMissedFill` for
// opens — the ticks do — so the fallback cannot turn a real miss into a fill.
function deriveBarExtremes(ticks: TickAggregateEntity[], entryPrice: MoneyValue): IBarExtremes {
    if (ticks.length === 0) {
        return { high: entryPrice, low: entryPrice };
    }

    let high = new Decimal(ticks[0].high.toFixed());
    let low = new Decimal(ticks[0].low.toFixed());

    for (const tick of ticks.slice(1)) {
        const tickHigh = new Decimal(tick.high.toFixed());
        const tickLow = new Decimal(tick.low.toFixed());

        if (tickHigh.gt(high)) {
            high = tickHigh;
        }

        if (tickLow.lt(low)) {
            low = tickLow;
        }
    }

    return { high: new Money(high.toFixed()), low: new Money(low.toFixed()) };
}
