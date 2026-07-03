/**
 * Migration AddPositionRetryAttribution — unit test (M52 D3, ADR 0051 §6).
 *
 * Mocked-QueryRunner unit test (F.I.R.S.T. — no live Postgres required), mirroring the established
 * migration.add-position-trigger-source.spec.ts pattern.
 *
 * Coverage:
 *   - up() adds positions.is_retry_entry (boolean) and positions.force_close_atr_units_drift
 *     (numeric(18,8)) as bare nullable columns — no NOT NULL, no DEFAULT, no backfill (ADR 0051 §6:
 *     NULL is the permanent, correct value for every pre-existing row, every attempt-1 open, and every
 *     row the guard never force-closed; a DEFAULT would falsely assert those rows were retries /
 *     drift-measured).
 *   - down() drops both columns using IF EXISTS (idempotent revert), in reverse order of the adds.
 *   - up() + down() are reversible: every column added has a matching drop.
 */

import { QueryRunner } from 'typeorm';

import { AddPositionRetryAttribution20260711000000 } from '../../src/database/migrations/20260711000000-AddPositionRetryAttribution';

function makeQueryRunner(): { qr: QueryRunner; querySpy: jest.Mock } {
    const querySpy = jest.fn().mockResolvedValue(undefined);
    const qr = { query: querySpy } as unknown as QueryRunner;

    return { qr, querySpy };
}

describe('Migration AddPositionRetryAttribution — up()', () => {
    it('adds is_retry_entry (boolean) and force_close_atr_units_drift (numeric) as nullable columns', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionRetryAttribution20260711000000();

        await migration.up(qr);

        expect(querySpy).toHaveBeenCalledTimes(2);

        const retrySql = querySpy.mock.calls[0][0] as string;
        expect(retrySql).toContain('"positions"');
        expect(retrySql).toContain('"is_retry_entry"');
        expect(retrySql).toContain('ADD COLUMN');
        expect(retrySql).toMatch(/boolean/i);

        const driftSql = querySpy.mock.calls[1][0] as string;
        expect(driftSql).toContain('"positions"');
        expect(driftSql).toContain('"force_close_atr_units_drift"');
        expect(driftSql).toContain('ADD COLUMN');
        expect(driftSql).toMatch(/numeric\(18,\s*8\)/i);
    });

    // ADR 0051 §6: a NOT NULL DEFAULT would falsely assert every pre-existing row was an attempt-1
    // retry / drift-measured. NULL must be reachable — neither column may carry a constraint.
    it('does NOT add a NOT NULL constraint or a DEFAULT on either column', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionRetryAttribution20260711000000();

        await migration.up(qr);

        for (const call of querySpy.mock.calls) {
            const sql = call[0] as string;
            expect(sql).not.toMatch(/NOT NULL/i);
            expect(sql).not.toMatch(/DEFAULT/i);
        }
    });
});

describe('Migration AddPositionRetryAttribution — down()', () => {
    it('drops both columns using IF EXISTS in reverse order of the adds', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionRetryAttribution20260711000000();

        await migration.down(qr);

        expect(querySpy).toHaveBeenCalledTimes(2);

        const firstDrop = querySpy.mock.calls[0][0] as string;
        const secondDrop = querySpy.mock.calls[1][0] as string;

        expect(firstDrop).toContain('DROP COLUMN IF EXISTS "force_close_atr_units_drift"');
        expect(secondDrop).toContain('DROP COLUMN IF EXISTS "is_retry_entry"');
    });
});

describe('Migration AddPositionRetryAttribution — reversibility', () => {
    it('every column added by up() has a matching drop in down()', async () => {
        const upRun = makeQueryRunner();
        const downRun = makeQueryRunner();
        const migration = new AddPositionRetryAttribution20260711000000();

        await migration.up(upRun.qr);
        await migration.down(downRun.qr);

        for (const column of ['is_retry_entry', 'force_close_atr_units_drift']) {
            const wasAdded = upRun.querySpy.mock.calls.some(([sql]) => (sql as string).includes(`"${column}"`) && (sql as string).includes('ADD COLUMN'));
            const wasDropped = downRun.querySpy.mock.calls.some(([sql]) => (sql as string).includes(`DROP COLUMN IF EXISTS "${column}"`));

            expect(wasAdded).toBe(true);
            expect(wasDropped).toBe(true);
        }
    });
});
