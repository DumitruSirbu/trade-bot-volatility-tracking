import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Repository } from 'typeorm';

import { DecimalValue, Money, MoneyValue } from '../../common/utils/money';
import { FundingRateEntity } from '../../market-data/entity';

// One historical funding tick reified for the replay loop (ADR 0015 §9). The rate is the
// raw 8-hour funding ratio Binance settled; positive means longs paid shorts. tsMs is
// the funding-time epoch in UTC milliseconds.
export interface IFundingEvent {
    readonly symbol: string;
    readonly tsMs: number;
    readonly rate: DecimalValue;
}

// Loads historical funding rates and computes the per-position cashflow on each event.
// Live-parity formula (ADR 0012):
//
//     cashflow_long  = notional * (-rate)   // longs PAY when rate > 0, RECEIVE when rate < 0
//     cashflow_short = notional * rate      // shorts RECEIVE when rate > 0, PAY when rate < 0
//
// The orchestrator (W4) iterates funding events between position.openedAtMs (inclusive)
// and position.closedAtMs (exclusive) and applies cashflow to the PnL ledger.
@Injectable()
export class FundingReplayLoader {
    constructor(
        @InjectRepository(FundingRateEntity)
        private readonly repo: Repository<FundingRateEntity>,
    ) {}

    async loadForWindow(symbols: string[], fromMs: number, toMs: number): Promise<IFundingEvent[]> {
        if (symbols.length === 0 || toMs <= fromMs) {
            return [];
        }

        const fromDate = new Date(fromMs);
        // Repository Between is inclusive on both ends; subtract 1 ms from toMs to keep
        // the half-open [fromMs, toMs) contract callers expect.
        const toDate = new Date(toMs - 1);

        const rows = await this.repo.find({
            where: {
                symbol: In(symbols),
                fundingTime: Between(fromDate, toDate),
            },
            order: { fundingTime: 'ASC' },
        });

        return rows.map((row) => ({
            symbol: row.symbol,
            tsMs: row.fundingTime.getTime(),
            rate: row.rate,
        }));
    }

    computeCashflow(notionalUsdt: MoneyValue, fundingRate: DecimalValue, side: 'long' | 'short'): MoneyValue {
        const rate = new Money(fundingRate.toString());
        if (side === 'long') {
            return notionalUsdt.times(rate.negated());
        }
        return notionalUsdt.times(rate);
    }
}
