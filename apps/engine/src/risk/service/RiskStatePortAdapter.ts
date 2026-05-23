import { Injectable } from '@nestjs/common';

import { MoneyValue } from '../../common/utils/money';
import { RiskStateRepository } from '../repository/RiskStateRepository';
import { IRiskStateDay, IRiskStatePort } from '../interface';

// Live IRiskStatePort (ADR 0004 §7): bridges the gate's pure state port onto
// RiskStateRepository. Backtest swaps an in-memory map for the same interface.
@Injectable()
export class RiskStatePortAdapter implements IRiskStatePort {
    constructor(private readonly riskStates: RiskStateRepository) {}

    async getDay(dateString: string): Promise<IRiskStateDay | null> {
        const row = await this.riskStates.findByDate(dateString);

        if (row === null) {
            return null;
        }

        return {
            date: row.date,
            realizedPnlDay: row.realizedPnlDay,
            openExposure: row.openExposure,
            tradesCount: row.tradesCount,
            isHalted: row.isHalted,
            haltReason: row.haltReason ?? null,
        };
    }

    async sumRealizedPnlBetween(fromDate: string, toDate: string): Promise<MoneyValue> {
        return this.riskStates.sumRealizedPnlBetween(fromDate, toDate);
    }

    async upsertDay(day: IRiskStateDay): Promise<void> {
        await this.riskStates.upsertDay({
            date: day.date,
            realizedPnlDay: day.realizedPnlDay,
            openExposure: day.openExposure,
            tradesCount: day.tradesCount,
            isHalted: day.isHalted,
            haltReason: day.haltReason,
        });
    }
}
