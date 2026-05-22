import {
    classifyFlowType,
    CoinTierEnum,
    computeSignalScore,
    CorrelationModeEnum,
    FlowTypeEnum,
    IMarketSnapshot,
    IStrategyParams,
    IVolatilityDetectedEvent,
    PositionSlotEnum,
} from '@bot/shared';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { VOLATILITY_DETECTED_EVENT } from '../../common/const';
import { AppConfigService } from '../../config/service';
import { PositionEntity } from '../../position/entity';
import { PositionRepository } from '../../position/repository/PositionRepository';
import { ACTIVE_POSITIONS_COUNT_DRY_RUN, CANDLE_INTERVAL_MS } from '../const';
import { StrategyConfigException } from '../exception';
import { IOpenPositionState, IStrategy, ISignal } from '../interface';
import { DecisionRepository } from '../repository/DecisionRepository';
import { StrategyVersionRepository } from '../repository/StrategyVersionRepository';
import { StrategyRegistry } from '../registry';

// The only impure piece of the strategy engine (ADR 0003 §6/§7). On startup it loads the
// active strategy_versions row, resolves its IStrategy via the registry and validates
// params (fail fast). Per trigger it classifies flow_type + signal_score ONCE (shared pure
// utils), stamps them on the event/snapshot so every version sees the same classification,
// runs the active strategy, and writes ONE dry-run decision. It emits nothing to
// risk/execution — M3 is dry-run only.
@Injectable()
export class StrategyService implements OnModuleInit {
    private readonly logger = new Logger(StrategyService.name);

    private activeStrategy!: IStrategy;
    private activeParams!: IStrategyParams;
    private activeStrategyVersionId!: number;

    constructor(
        private readonly config: AppConfigService,
        private readonly registry: StrategyRegistry,
        private readonly strategyVersions: StrategyVersionRepository,
        private readonly positions: PositionRepository,
        private readonly decisions: DecisionRepository,
    ) {}

    async onModuleInit(): Promise<void> {
        const versionId = this.config.activeStrategyVersionId;
        const row = await this.strategyVersions.findById(versionId);

        if (row === null) {
            throw new StrategyConfigException(`ACTIVE_STRATEGY_VERSION_ID=${versionId} matches no strategy_versions row`);
        }

        const resolved = this.registry.resolve(row.name, row.version, row.params);
        this.activeStrategy = resolved.strategy;
        this.activeParams = resolved.params;
        this.activeStrategyVersionId = row.id;

        this.logger.log(`Active strategy ${row.name}:${row.version} (id=${row.id}, direction=${row.direction}) resolved`);
    }

    @OnEvent(VOLATILITY_DETECTED_EVENT)
    async onVolatilityDetected(event: IVolatilityDetectedEvent): Promise<void> {
        const nowMs = event.entryCandleOpenTime + CANDLE_INTERVAL_MS;
        const flowType = classifyFlowType(event, this.activeParams);
        const signalScore = computeSignalScore(event, this.activeParams, flowType);

        const stampedEvent: IVolatilityDetectedEvent = { ...event, flowType };
        const snapshot = this.buildMarketSnapshot(stampedEvent, flowType, signalScore);
        const openPosition = await this.loadOpenPositionState(event.symbol);

        const signal = this.activeStrategy.evaluate({
            event: stampedEvent,
            snapshot,
            openPosition,
            params: this.activeParams,
            nowMs,
        });

        await this.recordDecision(stampedEvent, snapshot, signal);
    }

    private async recordDecision(event: IVolatilityDetectedEvent, snapshot: IMarketSnapshot, signal: ISignal): Promise<void> {
        await this.decisions.record({
            symbol: event.symbol,
            strategyVersionId: this.activeStrategyVersionId,
            ts: new Date(event.entryCandleOpenTime + CANDLE_INTERVAL_MS),
            eventId: event.eventId,
            signalType: signal.signalType,
            marketSnapshot: snapshot,
            action: signal.action,
            reason: signal.reason,
        });

        this.logger.log(
            `decision ${event.symbol} v=${this.activeStrategyVersionId} action=${signal.action} ` +
                `side=${signal.tradeSide ?? '-'} flow=${signal.flowType} score=${signal.signalScore.toFixed(1)} reason=${signal.reason}`,
        );
    }

    private async loadOpenPositionState(symbol: string): Promise<IOpenPositionState | null> {
        const open = await this.positions.findOpenBySymbol(symbol);

        if (open.length === 0) {
            return null;
        }

        return this.toOpenPositionState(open[0]);
    }

    // Frozen readonly snapshot carrying only what a strategy may legitimately read; the
    // strategy never touches TypeORM (ADR 0003 §1).
    private toOpenPositionState(position: PositionEntity): IOpenPositionState {
        return Object.freeze({
            side: position.side,
            entryPrice: position.entryPrice,
            qty: position.qty,
            entryNotional: position.entryNotional,
            strategyVersionId: position.strategyVersionId,
            positionSlot: position.positionSlot ?? null,
            openedAtMs: position.openedAt.getTime(),
            timeStopAtMs: position.timeStopAt?.getTime() ?? null,
        });
    }

    // Builds the persisted market_snapshot from the event + the orchestrator-stamped
    // flow_type and signal_score. ASSUMPTIONS (reviewers scrutinize): the M1 event carries
    // no estimated_slippage_pct, correlation_mode, position_slot or active_positions_count,
    // so the orchestrator derives them — slippage from the tier params, correlation_mode
    // from the BTC-correlation threshold, position_slot defaults to A (M4 owns real slot
    // assignment), active_positions_count is 0 in M3 dry-run (no positions are opened yet).
    private buildMarketSnapshot(event: IVolatilityDetectedEvent, flowType: FlowTypeEnum, signalScore: number): IMarketSnapshot {
        return {
            vwap_session: event.vwapSession,
            vwap_20bar: event.vwap20bar,
            vwap_deviation_pct: event.vwapDeviationPct,
            vwap_deviation_sigma: event.vwapDeviationSigma,
            volume_ratio: event.volumeRatio,
            volume_20bar_avg: event.volume20barAvg,
            atr_14: event.atr14,
            adx_14: event.adx14,
            adx_di_plus: event.adxDiPlus,
            adx_di_minus: event.adxDiMinus,
            rsi_14: event.rsi14,
            bollinger_upper: event.bollingerUpper,
            bollinger_lower: event.bollingerLower,
            bollinger_pct_b: event.bollingerPctB,
            btc_5m_move_pct: event.btc5mMovePct,
            idiosyncrasy_score: event.idiosyncrasyScore,
            funding_rate: event.fundingRate,
            funding_rate_annualized: event.fundingRateAnnualized,
            bid_ask_spread_pct: event.bidAskSpreadPct,
            estimated_slippage_pct: this.resolveSlippagePct(event),
            coin_tier: event.coinTier,
            coin_volume_rank: event.coinVolumeRank,
            correlation_mode: this.resolveCorrelationMode(event),
            signal_score: signalScore,
            position_slot: PositionSlotEnum.A,
            active_positions_count: ACTIVE_POSITIONS_COUNT_DRY_RUN,
            regime_label: event.regimeLabel,
            entry_candle_open_time: event.entryCandleOpenTime,
            open_interest: event.openInterest,
            open_interest_change_5m_pct: event.openInterestChange5mPct,
            open_interest_change_15m_pct: event.openInterestChange15mPct,
            agg_trade_buy_volume_ratio: event.aggTradeBuyVolumeRatio,
            market_breadth_5m_up_pct: event.marketBreadth5mUpPct,
            same_bar_trigger_count: event.sameBarTriggerCount,
            book_depth_10bps_usdt: event.bookDepth10bpsUsdt,
            book_depth_50bps_usdt: event.bookDepth50bpsUsdt,
            vwap_anchor_type: event.vwapAnchorType,
            symbol_universe_age_hours: event.symbolUniverseAgeHours,
            btc_1m_move_pct: event.btc1mMovePct,
            eth_5m_move_pct: event.eth5mMovePct,
            flow_type: flowType,
        };
    }

    private resolveSlippagePct(event: IVolatilityDetectedEvent): number {
        const slippageByTier: Record<CoinTierEnum, number> = {
            [CoinTierEnum.TIER_1]: this.activeParams.slippage_tier1_pct,
            [CoinTierEnum.TIER_2]: this.activeParams.slippage_tier2_pct,
            [CoinTierEnum.TIER_3]: this.activeParams.slippage_tier3_pct,
        };

        return slippageByTier[event.coinTier];
    }

    private resolveCorrelationMode(event: IVolatilityDetectedEvent): CorrelationModeEnum {
        if (Math.abs(event.btc5mMovePct) >= this.activeParams.btc_correlated_move_threshold_pct) {
            return CorrelationModeEnum.CORRELATED;
        }

        return CorrelationModeEnum.IDIOSYNCRATIC;
    }
}
