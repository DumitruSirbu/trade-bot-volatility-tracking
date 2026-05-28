import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
import { Money, MoneyValue } from '../../common/utils/money';
import { RiskStateEntity } from '../entity';

// Reads/writes per-day risk accounting + halt state. Keyed on `date` (UNIQUE). M4 is the
// live writer (sizing/limits/halt); it adds the rolling-7d sum + idempotent upsert.
@Injectable()
export class RiskStateRepository extends BaseRepository<RiskStateEntity> {
    constructor(@InjectRepository(RiskStateEntity) repository: Repository<RiskStateEntity>) {
        super(repository);
    }

    async findByDate(date: string): Promise<RiskStateEntity | null> {
        return this.repository.findOne({ where: { date } });
    }

    // Rolling-window weekly sum (ADR 0004 §5): sum realized_pnl_day over rows in the inclusive
    // UTC-date range [fromDate, toDate]. The upper bound stops a future-dated replay/seed row
    // from leaking into the window (caller passes today-6d .. today for a 7-day window).
    async sumRealizedPnlBetween(fromDate: string, toDate: string): Promise<MoneyValue> {
        const rows = await this.repository.find({ where: { date: Between(fromDate, toDate) } });

        return rows.reduce((sum, row) => sum.plus(row.realizedPnlDay), new Money(0));
    }

    // ADR 0021 §5.2 (M11a soak fix). Operator-resume clear of the gate's hot-path halt SoT.
    // Narrow UPDATE of is_halted=false, halt_reason=null for today's UTC-day row only — it MUST
    // NOT touch realized_pnl_day, open_exposure, or trades_count: the operator is lifting the
    // halt, not resetting the day's loss accounting, so the daily/weekly loss windows still bind
    // after resume. No-op when today's row does not exist (a halt always wrote a row first).
    async clearHaltForDate(date: string): Promise<void> {
        // Loud guard: a malformed date would match zero rows and the UPDATE would
        // silently no-op, leaving the gate halted while the operator sees 200 RUNNING.
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            throw new Error(`clearHaltForDate: invalid date format "${date}" — expected YYYY-MM-DD`);
        }

        await this.repository.update({ date }, { isHalted: false, haltReason: null });
    }

    // Idempotent upsert on uq_risk_state_date (ADR 0004 §5/§7). The live writer updates
    // today's row in place.
    async upsertDay(day: {
        date: string;
        realizedPnlDay: MoneyValue;
        openExposure: MoneyValue;
        tradesCount: number;
        isHalted: boolean;
        haltReason: string | null;
    }): Promise<void> {
        await this.repository.upsert(this.create(day), {
            conflictPaths: ['date'],
            skipUpdateIfNoValuesChanged: true,
        });
    }
}
