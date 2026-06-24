/**
 * RiskStateRepository — M45 D2 newer-wins guard tests.
 *
 * Coverage (B1):
 *   B1 — upsertAccountingForDay SQL contains the newer-wins WHERE guard
 *        (the conditional prevents a stale write from overwriting a fresher row).
 *
 * Strategy: mock the TypeORM Repository.query runner so the test captures the
 * raw SQL string without a real DB. No Docker, no testcontainers — fast unit test.
 */

import { Repository } from 'typeorm';

import { Money } from '../../../src/common/utils/money';
import { RiskStateEntity } from '../../../src/risk/entity';
import { RiskStateRepository } from '../../../src/risk/repository/RiskStateRepository';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeRepository(): { repo: RiskStateRepository; querySpy: jest.Mock } {
    const querySpy = jest.fn().mockResolvedValue(undefined);

    const typeormRepo = {
        query: querySpy,
        // Other TypeORM methods are not exercised by these tests.
        findOne: jest.fn(),
        find: jest.fn(),
        save: jest.fn(),
        update: jest.fn(),
    } as unknown as Repository<RiskStateEntity>;

    const repo = new RiskStateRepository(typeormRepo);

    return { repo, querySpy };
}

// ─── B1: newer-wins guard present in upsertAccountingForDay SQL ───────────────

describe('RiskStateRepository M45 D2 — B1: upsertAccountingForDay carries newer-wins guard', () => {
    it('SQL contains the conditional WHERE clause preventing stale overwrites', async () => {
        const { repo, querySpy } = makeRepository();

        await repo.upsertAccountingForDay('2024-05-21', {
            openExposure: new Money('500'),
            realizedPnlDay: new Money('-10'),
            tradesCount: 3,
        });

        expect(querySpy).toHaveBeenCalledTimes(1);

        const [sql] = querySpy.mock.calls[0] as [string];

        // The newer-wins predicate must appear in the ON CONFLICT DO UPDATE clause
        expect(sql).toContain('WHERE "risk_state"."updated_at" <= EXCLUDED."updated_at"');
    });

    it('SQL targets only accounting columns (does NOT update is_halted or halt_reason in the DO UPDATE set)', async () => {
        const { repo, querySpy } = makeRepository();

        await repo.upsertAccountingForDay('2024-05-21', {
            openExposure: new Money('100'),
            realizedPnlDay: new Money('0'),
            tradesCount: 0,
        });

        const [sql] = querySpy.mock.calls[0] as [string];
        const doUpdateSection = sql.slice(sql.indexOf('DO UPDATE'));

        // Halt columns must NOT appear in the DO UPDATE set (column-scoped ownership rule)
        expect(doUpdateSection).not.toContain('"is_halted" = EXCLUDED."is_halted"');
        expect(doUpdateSection).not.toContain('"halt_reason" = EXCLUDED."halt_reason"');
    });

    it('passes the date and accounting values as positional parameters', async () => {
        const { repo, querySpy } = makeRepository();

        await repo.upsertAccountingForDay('2024-05-22', {
            openExposure: new Money('750.50'),
            realizedPnlDay: new Money('-25.00'),
            tradesCount: 7,
        });

        const [, params] = querySpy.mock.calls[0] as [string, unknown[]];

        expect(params[0]).toBe('2024-05-22');
        expect(params[1]).toBe('750.5'); // MoneyValue.toString()
        expect(params[2]).toBe('-25'); // MoneyValue.toString()
        expect(params[3]).toBe(7);
    });
});

// ─── B1b: newer-wins guard present in upsertHaltForDay SQL ───────────────────

describe('RiskStateRepository M45 D2 — B1b: upsertHaltForDay carries newer-wins guard', () => {
    it('SQL contains the conditional WHERE clause preventing stale halt overwrites', async () => {
        const { repo, querySpy } = makeRepository();

        await repo.upsertHaltForDay('2024-05-21', true, 'daily_loss_limit');

        expect(querySpy).toHaveBeenCalledTimes(1);

        const [sql] = querySpy.mock.calls[0] as [string];

        expect(sql).toContain('WHERE "risk_state"."updated_at" <= EXCLUDED."updated_at"');
    });

    it('upsertHaltForDay SQL does NOT update accounting columns in the DO UPDATE set', async () => {
        const { repo, querySpy } = makeRepository();

        await repo.upsertHaltForDay('2024-05-21', true, 'market_stress:btc_shock');

        const [sql] = querySpy.mock.calls[0] as [string];
        const doUpdateSection = sql.slice(sql.indexOf('DO UPDATE'));

        // Accounting columns must NOT appear in the DO UPDATE set (column-scoped ownership rule)
        expect(doUpdateSection).not.toContain('"realized_pnl_day" = EXCLUDED."realized_pnl_day"');
        expect(doUpdateSection).not.toContain('"open_exposure" = EXCLUDED."open_exposure"');
        expect(doUpdateSection).not.toContain('"trades_count" = EXCLUDED."trades_count"');
    });
});

// ─── B1c: newer-wins guard present in upsertDay SQL ──────────────────────────

describe('RiskStateRepository M45 D2 — B1c: upsertDay carries newer-wins guard', () => {
    it('SQL contains the conditional WHERE clause for the full-row upsert path', async () => {
        const { repo, querySpy } = makeRepository();

        await repo.upsertDay({
            date: '2024-05-21',
            realizedPnlDay: new Money('0'),
            openExposure: new Money('0'),
            tradesCount: 0,
            isHalted: false,
            haltReason: null,
        });

        expect(querySpy).toHaveBeenCalledTimes(1);

        const [sql] = querySpy.mock.calls[0] as [string];

        expect(sql).toContain('WHERE "risk_state"."updated_at" <= EXCLUDED."updated_at"');
    });
});
