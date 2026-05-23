import { Injectable } from '@nestjs/common';

import { Money } from '../../common/utils/money';
import { InstrumentRepository } from '../../market-data/repository/InstrumentRepository';
import { DEFAULT_MAINTENANCE_MARGIN_RATE } from '../const';
import { IInstrumentConstraints, IInstrumentPort } from '../interface';

// Live IInstrumentPort (ADR 0004 §7/§8): bridges the sizer's instrument constraints onto the
// instruments table. Backtest replays the instruments snapshot behind the same interface.
@Injectable()
export class InstrumentPortAdapter implements IInstrumentPort {
    constructor(private readonly instruments: InstrumentRepository) {}

    async findConstraints(symbol: string): Promise<IInstrumentConstraints | null> {
        const row = await this.instruments.findBySymbol(symbol);

        if (row === null) {
            return null;
        }

        return {
            symbol: row.symbol,
            stepSize: row.stepSize,
            tickSize: row.tickSize,
            minNotional: row.minNotional,
            // The instruments table carries no per-symbol Binance maintenance-margin tier yet;
            // use the conservative engine-side default (over-estimates the requirement so the
            // liquidation distance is never under-stated). M6 can backfill real tiers later.
            maintenanceMarginRate: new Money(DEFAULT_MAINTENANCE_MARGIN_RATE),
        };
    }
}
