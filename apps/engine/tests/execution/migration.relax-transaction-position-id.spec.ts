/**
 * Migration RelaxTransactionPositionIdNullable (20260524020000) — unit test.
 *
 * Mirrors the pattern in migration.protective-order-default.spec.ts.
 *
 * Coverage:
 *   - up() executes exactly two SQL statements
 *   - up() first statement drops NOT NULL on transactions.position_id
 *   - up() second statement adds the CHECK constraint (ck_transactions_position_id_zero_fill_only)
 *   - CHECK constraint body allows NULL only for qty=0 AND type IN ('open','add')
 *   - down() executes exactly three SQL statements
 *   - down() first statement drops the CHECK constraint
 *   - down() second statement deletes zero-fill rows (position_id IS NULL)
 *   - down() third statement re-applies NOT NULL
 *   - up() + down() are structurally reversible
 */

import { QueryRunner } from 'typeorm';

import { RelaxTransactionPositionIdNullable20260524020000 } from '../../src/database/migrations/20260524020000-RelaxTransactionPositionIdNullable';

function makeQueryRunner(): { qr: QueryRunner; querySpy: jest.Mock } {
    const querySpy = jest.fn().mockResolvedValue(undefined);
    const qr = { query: querySpy } as unknown as QueryRunner;
    return { qr, querySpy };
}

describe('Migration RelaxTransactionPositionIdNullable — up()', () => {
    it('executes exactly two SQL statements', async () => {
        // BUILD
        const { qr, querySpy } = makeQueryRunner();
        const migration = new RelaxTransactionPositionIdNullable20260524020000();

        // OPERATE
        await migration.up(qr);

        // CHECK
        expect(querySpy).toHaveBeenCalledTimes(2);
    });

    it('first statement drops NOT NULL on transactions.position_id', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new RelaxTransactionPositionIdNullable20260524020000();

        await migration.up(qr);

        const firstSql = (querySpy.mock.calls[0][0] as string).trim();
        expect(firstSql).toMatch(/ALTER\s+TABLE\s+"transactions"/i);
        expect(firstSql).toMatch(/DROP\s+NOT\s+NULL/i);
        expect(firstSql).toMatch(/position_id/);
    });

    it('second statement adds the CHECK constraint named ck_transactions_position_id_zero_fill_only', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new RelaxTransactionPositionIdNullable20260524020000();

        await migration.up(qr);

        const secondSql = (querySpy.mock.calls[1][0] as string).trim();
        expect(secondSql).toMatch(/ADD\s+CONSTRAINT/i);
        expect(secondSql).toMatch(/ck_transactions_position_id_zero_fill_only/);
    });

    it('CHECK constraint body enforces NULL only for qty=0 AND type IN (open, add)', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new RelaxTransactionPositionIdNullable20260524020000();

        await migration.up(qr);

        const secondSql = querySpy.mock.calls[1][0] as string;
        // Must reference position_id IS NOT NULL OR (qty = 0 AND type IN (...))
        expect(secondSql).toContain('position_id');
        expect(secondSql).toContain('IS NOT NULL');
        expect(secondSql).toContain('qty');
        expect(secondSql).toContain("'open'");
        expect(secondSql).toContain("'add'");
    });
});

describe('Migration RelaxTransactionPositionIdNullable — down()', () => {
    it('executes exactly three SQL statements', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new RelaxTransactionPositionIdNullable20260524020000();

        await migration.down(qr);

        expect(querySpy).toHaveBeenCalledTimes(3);
    });

    it('first statement drops the CHECK constraint', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new RelaxTransactionPositionIdNullable20260524020000();

        await migration.down(qr);

        const firstSql = (querySpy.mock.calls[0][0] as string).trim();
        expect(firstSql).toMatch(/DROP\s+CONSTRAINT/i);
        expect(firstSql).toMatch(/ck_transactions_position_id_zero_fill_only/);
    });

    it('second statement deletes zero-fill audit rows (position_id IS NULL)', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new RelaxTransactionPositionIdNullable20260524020000();

        await migration.down(qr);

        const secondSql = (querySpy.mock.calls[1][0] as string).trim();
        expect(secondSql).toMatch(/DELETE\s+FROM\s+"transactions"/i);
        expect(secondSql).toMatch(/position_id/);
        expect(secondSql).toMatch(/IS\s+NULL/i);
    });

    it('third statement re-applies NOT NULL on position_id', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new RelaxTransactionPositionIdNullable20260524020000();

        await migration.down(qr);

        const thirdSql = (querySpy.mock.calls[2][0] as string).trim();
        expect(thirdSql).toMatch(/ALTER\s+TABLE\s+"transactions"/i);
        expect(thirdSql).toMatch(/SET\s+NOT\s+NULL/i);
        expect(thirdSql).toMatch(/position_id/);
    });
});

describe('Migration RelaxTransactionPositionIdNullable — reversibility', () => {
    it('up() adds what down() removes: DROP NOT NULL ↔ SET NOT NULL', async () => {
        const { qr: upQr, querySpy: upSpy } = makeQueryRunner();
        const { qr: downQr, querySpy: downSpy } = makeQueryRunner();
        const migration = new RelaxTransactionPositionIdNullable20260524020000();

        await migration.up(upQr);
        await migration.down(downQr);

        const upSqls = upSpy.mock.calls.map(([sql]) => sql as string);
        const downSqls = downSpy.mock.calls.map(([sql]) => sql as string);

        // up() drops NOT NULL; down() re-adds NOT NULL
        expect(upSqls.some((s) => s.match(/DROP\s+NOT\s+NULL/i) !== null)).toBe(true);
        expect(downSqls.some((s) => s.match(/SET\s+NOT\s+NULL/i) !== null)).toBe(true);

        // up() adds CHECK constraint; down() drops it
        expect(upSqls.some((s) => s.includes('ck_transactions_position_id_zero_fill_only') && s.match(/ADD\s+CONSTRAINT/i) !== null)).toBe(true);
        expect(downSqls.some((s) => s.includes('ck_transactions_position_id_zero_fill_only') && s.match(/DROP\s+CONSTRAINT/i) !== null)).toBe(true);

        // down() deletes zero-fill rows (destructive, documented)
        expect(downSqls.some((s) => s.match(/DELETE\s+FROM/i) !== null)).toBe(true);
    });
});
