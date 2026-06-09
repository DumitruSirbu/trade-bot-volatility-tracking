import { IVolatilityDetectedEvent } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import {
    CANDLE_CLOSED_EVENT,
    FUNDING_RATE_OBSERVED_EVENT,
    INSTRUMENT_REFRESHED_EVENT,
    OPEN_INTEREST_SAMPLED_EVENT,
    TICK_AGGREGATE_EVENT,
    UNIVERSE_SYMBOL_ENTERED_EVENT,
    UNIVERSE_SYMBOL_LEFT_EVENT,
    UNIVERSE_SYMBOL_TIER_CHANGED_EVENT,
    VOLATILITY_DETECTED_EVENT,
} from '../../common/const';
import { describeError, parseMoney } from '../../common/utils';
import { DUPLICATE_KEY_ERROR_FRAGMENTS } from '../const';
import {
    ICandleClosedEvent,
    IFundingRateObservedEvent,
    IInstrumentRefreshedEvent,
    IOpenInterestSampledEvent,
    ITickAggregateEvent,
    IUniverseTransition,
} from '../interface';
import { BookSnapshotRepository } from '../repository/BookSnapshotRepository';
import { CandleRepository } from '../repository/CandleRepository';
import { FundingRateRepository } from '../repository/FundingRateRepository';
import { InstrumentRepository } from '../repository/InstrumentRepository';
import { OpenInterestRepository } from '../repository/OpenInterestRepository';
import { TickAggregateRepository } from '../repository/TickAggregateRepository';
import { UniverseMembershipRepository } from '../repository/UniverseMembershipRepository';

// Passive @OnEvent subscriber (ADR 0002 §4): turns MarketData events into durable rows.
// It is NEVER in the order path and never calls strategy/risk. Every write is idempotent
// on its table's UNIQUE constraint; a duplicate-key race is caught, logged at warn, and
// swallowed. universe_membership is point-in-time: enter → open row; leave → set left_at;
// tier change → close prior + open new — a gap-free tier timeline.
@Injectable()
export class MarketDataPersistenceListener {
    private readonly logger = new Logger(MarketDataPersistenceListener.name);

    constructor(
        private readonly candles: CandleRepository,
        private readonly tickAggregates: TickAggregateRepository,
        private readonly openInterest: OpenInterestRepository,
        private readonly fundingRates: FundingRateRepository,
        private readonly instruments: InstrumentRepository,
        private readonly membership: UniverseMembershipRepository,
        private readonly bookSnapshots: BookSnapshotRepository,
    ) {}

    @OnEvent(CANDLE_CLOSED_EVENT)
    async onCandleClosed(event: ICandleClosedEvent): Promise<void> {
        await this.persist('candles', () =>
            this.candles.upsertClosed({
                symbol: event.symbol,
                interval: event.interval,
                openTime: new Date(event.candle.openTimeMs),
                open: event.candle.open,
                high: event.candle.high,
                low: event.candle.low,
                close: event.candle.close,
                volume: event.candle.volume,
            }),
        );
    }

    @OnEvent(TICK_AGGREGATE_EVENT)
    async onTickAggregate(event: ITickAggregateEvent): Promise<void> {
        await this.persist('tick_aggregates', () =>
            this.tickAggregates.recordSample({
                symbol: event.symbol,
                ts: new Date(event.tsMs),
                open: event.open,
                high: event.high,
                low: event.low,
                close: event.close,
                volume: event.volume,
            }),
        );
    }

    @OnEvent(OPEN_INTEREST_SAMPLED_EVENT)
    async onOpenInterestSampled(event: IOpenInterestSampledEvent): Promise<void> {
        await this.persist('open_interest', () =>
            this.openInterest.recordSample({
                symbol: event.symbol,
                ts: new Date(event.tsMs),
                value: event.value,
            }),
        );
    }

    @OnEvent(FUNDING_RATE_OBSERVED_EVENT)
    async onFundingRateObserved(event: IFundingRateObservedEvent): Promise<void> {
        await this.persist('funding_rates', () =>
            this.fundingRates.recordObservation({
                symbol: event.symbol,
                fundingTime: new Date(event.fundingTimeMs),
                rate: event.rate,
            }),
        );
    }

    @OnEvent(INSTRUMENT_REFRESHED_EVENT)
    async onInstrumentRefreshed(event: IInstrumentRefreshedEvent): Promise<void> {
        await this.persist('instruments', () =>
            this.instruments.upsertBySymbol({
                symbol: event.symbol,
                base: event.base,
                quote: event.quote,
                status: event.status,
                tickSize: event.tickSize,
                stepSize: event.stepSize,
                minNotional: event.minNotional,
                isTradable: event.isTradable,
                volume24h: event.volume24h,
                coinTier: event.coinTier,
                updatedAt: new Date(),
            }),
        );
    }

    @OnEvent(UNIVERSE_SYMBOL_ENTERED_EVENT)
    async onSymbolEntered(event: IUniverseTransition): Promise<void> {
        await this.persist('universe_membership(enter)', async () => {
            await this.membership.openMembership(event.symbol, event.tier, new Date());
        });
    }

    @OnEvent(UNIVERSE_SYMBOL_LEFT_EVENT)
    async onSymbolLeft(event: IUniverseTransition): Promise<void> {
        await this.persist('universe_membership(leave)', async () => {
            await this.membership.closeOpenMembership(event.symbol, new Date());
        });
    }

    @OnEvent(UNIVERSE_SYMBOL_TIER_CHANGED_EVENT)
    async onSymbolTierChanged(event: IUniverseTransition): Promise<void> {
        await this.persist('universe_membership(tierChange)', async () => {
            // Atomic close+open (single transaction in the repository) so a crash mid-change
            // can never leave the symbol with zero open rows (a survivorship-biasing gap).
            await this.membership.changeTier(event.symbol, event.tier, new Date());
        });
    }

    // M27 Dispatch C — observability-only. Best-effort capture of the trigger-time
    // book snapshot keyed by the stable per-trigger `event_id` so depth/spread can be
    // joined back to the decision/shadow record. NEVER in the order path: every error
    // (including the idempotent duplicate-key race) is swallowed so a persistence
    // hiccup can never destabilise the trade loop. Only writes when `event_id` is
    // present; idempotency is enforced by the partial UNIQUE index on event_id.
    // INVARIANT: this handler must NEVER rethrow regardless of emit mode. It is fired
    // fire-and-forget via `eventEmitter.emit` (not `emitAsync`), so a rejection here would
    // surface as an unhandledRejection; the book-snapshot write is observability-only and
    // must never destabilise the trade loop — recordBookSnapshot swallows every error.
    @OnEvent(VOLATILITY_DETECTED_EVENT)
    async onVolatilityDetected(event: IVolatilityDetectedEvent): Promise<void> {
        await this.recordBookSnapshot(event);
    }

    private async recordBookSnapshot(event: IVolatilityDetectedEvent): Promise<void> {
        const eventId = event.eventId?.trim();

        if (!eventId) {
            return;
        }

        try {
            await this.bookSnapshots.record({
                eventId,
                symbol: event.symbol,
                ts: new Date(event.entryCandleOpenTime),
                spread: parseMoney(event.bidAskSpreadPct.toString()),
                depth10bps: parseMoney(event.bookDepth10bpsUsdt),
                depth50bps: parseMoney(event.bookDepth50bpsUsdt),
                // No bid/ask on the event → mid cannot be derived; left NULL by design.
                midAtTrigger: null,
            });
        } catch (cause) {
            const message = describeError(cause).toLowerCase();

            if (DUPLICATE_KEY_ERROR_FRAGMENTS.some((fragment) => message.includes(fragment))) {
                // Idempotent happy path: same event_id already captured (re-emit /
                // restart). Debug, not warn — this is expected and benign.
                this.logger.debug(`book_snapshots row for event ${eventId} already present (idempotent)`);

                return;
            }

            this.logger.warn(`Failed to persist book_snapshots for event ${eventId}: ${describeError(cause)}`);
        }
    }

    // Single try/catch wrapper so error handling is one thing. A duplicate-key collision
    // is the idempotency happy path (concurrent re-emit) → warn + swallow; anything else
    // is logged at error and swallowed so persistence never destabilises the trade loop.
    private async persist(target: string, write: () => Promise<unknown>): Promise<void> {
        try {
            await write();
        } catch (cause) {
            const message = describeError(cause).toLowerCase();

            if (DUPLICATE_KEY_ERROR_FRAGMENTS.some((fragment) => message.includes(fragment))) {
                this.logger.warn(`Duplicate ${target} row ignored (idempotent): ${describeError(cause)}`);

                return;
            }

            this.logger.error(`Failed to persist ${target}: ${describeError(cause)}`);
        }
    }
}
