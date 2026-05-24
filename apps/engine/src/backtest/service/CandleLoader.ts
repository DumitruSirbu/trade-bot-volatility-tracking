import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { multiplyMoney } from '../../common/utils/money';
import { CANDLE_5M_INTERVAL_MS } from '../../market-data/const';
import { CandleEntity, TickAggregateEntity } from '../../market-data/entity';
import { ICandle } from '../../market-data/interface';

// 5-minute candle interval string as stored in the `interval` column. Matches the
// emitter in SymbolMarketState/MarketDataPersistenceListener — kept local to the
// loader because it's only meaningful at this DB-query boundary.
const CANDLE_INTERVAL_5M = '5m';

// Backtest-only request to load a window of stored 5-minute candles. The half-open
// `[fromMs, toMs)` interval matches how IBacktestConfig.dateRange is interpreted
// (inclusive of `fromUtcDate`, exclusive of `toUtcDate`).
export interface ICandleLoadRequest {
    readonly symbol: string;
    readonly fromMs: number;
    readonly toMs: number;
}

// Loads stored 5-minute candles and 1-second tick aggregates from the database for a
// replay run. Result is sorted ascending by open_time (oldest first) — the replay loop
// feeds them in that order to IndicatorStateBuilder so the per-symbol bar window stays
// causal. `quoteVolume` is reconstructed from close × volume (the closed-bar typical-
// price approximation already used by live recompute) so the loader yields a complete
// ICandle without a separate join.
@Injectable()
export class CandleLoader {
    constructor(
        @InjectRepository(CandleEntity) private readonly candleRepository: Repository<CandleEntity>,
        @InjectRepository(TickAggregateEntity) private readonly tickAggregateRepository: Repository<TickAggregateEntity>,
    ) {}

    async loadFor5mWindow(request: ICandleLoadRequest): Promise<ICandle[]> {
        const fromDate = new Date(request.fromMs);
        const toDate = new Date(request.toMs);

        const rows = await this.candleRepository
            .createQueryBuilder('candle')
            .where('candle.symbol = :symbol', { symbol: request.symbol })
            .andWhere('candle.interval = :interval', { interval: CANDLE_INTERVAL_5M })
            .andWhere('candle.open_time >= :fromDate', { fromDate })
            .andWhere('candle.open_time < :toDate', { toDate })
            .orderBy('candle.open_time', 'ASC')
            .getMany();

        return rows.map((entity) => this.toCandle(entity));
    }

    async loadTicksForBar(symbol: string, barOpenMs: number): Promise<TickAggregateEntity[]> {
        const fromDate = new Date(barOpenMs);
        const toDate = new Date(barOpenMs + CANDLE_5M_INTERVAL_MS);

        return this.tickAggregateRepository
            .createQueryBuilder('tick')
            .where('tick.symbol = :symbol', { symbol })
            .andWhere('tick.ts >= :fromDate', { fromDate })
            .andWhere('tick.ts < :toDate', { toDate })
            .orderBy('tick.ts', 'ASC')
            .getMany();
    }

    private toCandle(entity: CandleEntity): ICandle {
        return {
            openTimeMs: entity.openTime.getTime(),
            open: entity.open,
            high: entity.high,
            low: entity.low,
            close: entity.close,
            volume: entity.volume,
            quoteVolume: multiplyMoney(entity.close, entity.volume),
            isClosed: true,
        };
    }
}
