/**
 * Migration AddPositionTriggerSource — unit test (ADR 0048 M50c).
 *
 * Mocked-QueryRunner unit test (F.I.R.S.T. — no live Postgres required), mirroring the
 * established pattern in migration.add-position-state-machine-columns.spec.ts.
 *
 * Coverage:
 *   - up() adds positions.trigger_source as a bare nullable varchar — no NOT NULL, no DEFAULT,
 *     no backfill (ADR 0048 M50c: NULL is the permanent, correct value for every pre-existing
 *     row and every VWAP/legacy open; a DEFAULT would falsely assert those rows were
 *     'scheduled').
 *   - down() drops the column using IF EXISTS (idempotent revert — safe to run twice / on a
 *     partially-applied state).
 *   - up() + down() are reversible: the one column added has a matching drop.
 */

import { QueryRunner } from 'typeorm';

import { AddPositionTriggerSource20260710000000 } from '../../src/database/migrations/20260710000000-AddPositionTriggerSource';

function makeQueryRunner(): { qr: QueryRunner; querySpy: jest.Mock } {
    const querySpy = jest.fn().mockResolvedValue(undefined);
    const qr = { query: querySpy } as unknown as QueryRunner;

    return { qr, querySpy };
}

describe('Migration AddPositionTriggerSource — up()', () => {
    it('adds positions.trigger_source as a bare nullable varchar column', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionTriggerSource20260710000000();

        await migration.up(qr);

        expect(querySpy).toHaveBeenCalledTimes(1);
        const [sql] = querySpy.mock.calls[0] as [string];

        expect(sql).toContain('"positions"');
        expect(sql).toContain('"trigger_source"');
        expect(sql).toContain('ADD COLUMN');
        expect(sql).toMatch(/varchar/i);
    });

    // ADR 0048 M50c: a NOT NULL DEFAULT would falsely assert every pre-existing row was
    // 'scheduled'. NULL must be reachable — the column must carry neither constraint.
    it('does NOT add a NOT NULL constraint', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionTriggerSource20260710000000();

        await migration.up(qr);

        const [sql] = querySpy.mock.calls[0] as [string];
        expect(sql).not.toMatch(/NOT NULL/i);
    });

    it('does NOT add a DEFAULT value (no fabricated backfill)', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionTriggerSource20260710000000();

        await migration.up(qr);

        const [sql] = querySpy.mock.calls[0] as [string];
        expect(sql).not.toMatch(/DEFAULT/i);
    });
});

describe('Migration AddPositionTriggerSource — down()', () => {
    it('drops positions.trigger_source using IF EXISTS (idempotent revert)', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionTriggerSource20260710000000();

        await migration.down(qr);

        expect(querySpy).toHaveBeenCalledTimes(1);
        const [sql] = querySpy.mock.calls[0] as [string];

        expect(sql).toContain('"positions"');
        expect(sql).toContain('DROP COLUMN IF EXISTS "trigger_source"');
    });
});

describe('Migration AddPositionTriggerSource — reversibility', () => {
    it('the single column added by up() has a matching drop in down()', async () => {
        const upRun = makeQueryRunner();
        const downRun = makeQueryRunner();
        const migration = new AddPositionTriggerSource20260710000000();

        await migration.up(upRun.qr);
        await migration.down(downRun.qr);

        const wasAdded = upRun.querySpy.mock.calls.some(([sql]) => (sql as string).includes('"trigger_source"') && (sql as string).includes('ADD COLUMN'));
        const wasDropped = downRun.querySpy.mock.calls.some(([sql]) => (sql as string).includes('DROP COLUMN IF EXISTS "trigger_source"'));

        expect(wasAdded).toBe(true);
        expect(wasDropped).toBe(true);
    });
});
