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

    // Column-scoped accounting upsert for the lifecycle listener. Writes
    // ONLY open_exposure, realized_pnl_day, and trades_count (plus the updated_at guard
    // field). It MUST NEVER touch is_halted or halt_reason — those columns are owned
    // exclusively by the halt-gate paths (RiskGateService.persistHalt / clearHaltForDate).
    // The full-row `upsertDay` carried a read-then-write race: a halt persisted between the
    // listener's read and its upsert would be silently overwritten back to false. This narrow
    // ON CONFLICT update set closes it.
    //
    // First-touch INSERT seeds is_halted=false / halt_reason=null (a brand-new UTC day starts
    // un-halted); the DO UPDATE set deliberately omits both halt columns, so an existing
    // halted row keeps its halt state on conflict.
    //
    // Newer-wins guard (M45 D2): the DO UPDATE applies only when this write is at least as
    // fresh as the stored row (`WHERE risk_state.updated_at <= EXCLUDED.updated_at`). With
    // EXCLUDED.updated_at = now(), a concurrent write whose row was already stamped later does
    // not overwrite the fresher accounting. Raw query because TypeORM's orUpdate cannot express
    // a conditional WHERE on the conflict clause.
    async upsertAccountingForDay(date: string, data: { openExposure: MoneyValue; realizedPnlDay: MoneyValue; tradesCount: number }): Promise<void> {
        await this.repository.query(
            `INSERT INTO "risk_state" ("date", "open_exposure", "realized_pnl_day", "trades_count", "is_halted", "halt_reason", "updated_at")
             VALUES ($1, $2, $3, $4, false, NULL, now())
             ON CONFLICT ("date") DO UPDATE SET
                 "open_exposure" = EXCLUDED."open_exposure",
                 "realized_pnl_day" = EXCLUDED."realized_pnl_day",
                 "trades_count" = EXCLUDED."trades_count",
                 "updated_at" = EXCLUDED."updated_at"
             WHERE "risk_state"."updated_at" <= EXCLUDED."updated_at"`,
            [date, data.openExposure.toString(), data.realizedPnlDay.toString(), data.tradesCount],
        );
    }

    // Column-scoped halt upsert for the halt-gate paths (RiskGateService.persistHalt).
    // Writes ONLY is_halted, halt_reason (plus the updated_at guard field). It MUST NEVER
    // touch realized_pnl_day, open_exposure, or trades_count — those are owned exclusively
    // by the accounting paths (upsertAccountingForDay). Mirror of upsertAccountingForDay:
    // the full-row upsertDay carried a read-then-write race where an accounting write between
    // the gate's read and its upsert would be silently clobbered. This narrow ON CONFLICT
    // update set closes it.
    //
    // First-touch INSERT seeds open_exposure=0 / realized_pnl_day=0 / trades_count=0 (a
    // brand-new UTC day starts with empty accounting); the DO UPDATE set deliberately omits
    // those columns, so an existing row keeps its day's accounting on conflict.
    //
    // Newer-wins guard (M45 D2): the DO UPDATE applies only when this write is at least as
    // fresh as the stored row. Raw query because TypeORM's orUpdate cannot express a
    // conditional WHERE on the conflict clause.
    async upsertHaltForDay(date: string, isHalted: boolean, haltReason: string | null): Promise<void> {
        await this.repository.query(
            `INSERT INTO "risk_state" ("date", "is_halted", "halt_reason", "open_exposure", "realized_pnl_day", "trades_count", "updated_at")
             VALUES ($1, $2, $3, 0, 0, 0, now())
             ON CONFLICT ("date") DO UPDATE SET
                 "is_halted" = EXCLUDED."is_halted",
                 "halt_reason" = EXCLUDED."halt_reason",
                 "updated_at" = EXCLUDED."updated_at"
             WHERE "risk_state"."updated_at" <= EXCLUDED."updated_at"`,
            [date, isHalted, haltReason],
        );
    }

    // Idempotent full-row upsert on uq_risk_state_date (ADR 0004 §5/§7). The live writer
    // updates today's row in place.
    //
    // Newer-wins guard (M45 D2): like upsertAccountingForDay, the DO UPDATE applies only when
    // this write is at least as fresh as the stored row, so a full-row write copying a stale
    // accounting/halt snapshot cannot clobber a fresher column-scoped write. Raw query for the
    // conditional WHERE on the conflict clause.
    async upsertDay(day: {
        date: string;
        realizedPnlDay: MoneyValue;
        openExposure: MoneyValue;
        tradesCount: number;
        isHalted: boolean;
        haltReason: string | null;
    }): Promise<void> {
        await this.repository.query(
            `INSERT INTO "risk_state" ("date", "realized_pnl_day", "open_exposure", "trades_count", "is_halted", "halt_reason", "updated_at")
             VALUES ($1, $2, $3, $4, $5, $6, now())
             ON CONFLICT ("date") DO UPDATE SET
                 "realized_pnl_day" = EXCLUDED."realized_pnl_day",
                 "open_exposure" = EXCLUDED."open_exposure",
                 "trades_count" = EXCLUDED."trades_count",
                 "is_halted" = EXCLUDED."is_halted",
                 "halt_reason" = EXCLUDED."halt_reason",
                 "updated_at" = EXCLUDED."updated_at"
             WHERE "risk_state"."updated_at" <= EXCLUDED."updated_at"`,
            [day.date, day.realizedPnlDay.toString(), day.openExposure.toString(), day.tradesCount, day.isHalted, day.haltReason],
        );
    }
}
