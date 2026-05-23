/**
 * Migration AddPositionProtectiveOrderTypeDefault — unit test (ADR 0008 §5).
 *
 * Verifies the up/down SQL calls without a real DB by mocking QueryRunner.
 * Integration coverage (actual Postgres round-trip) is in migration.roundtrip.spec.ts.
 *
 * Coverage:
 *   - up() executes backfill UPDATE before ALTER (ordering matters for safety)
 *   - up() sets DEFAULT 'local_fallback' on protective_order_type
 *   - up() sets NOT NULL on protective_order_type
 *   - up() adds uq_transactions_client_order_id UNIQUE constraint
 *   - down() drops the unique constraint first
 *   - down() drops NOT NULL before dropping DEFAULT (reverse of up)
 *   - up() + down() are reversible: call sequence matches expectation
 */

import { QueryRunner } from 'typeorm';

import { AddPositionProtectiveOrderTypeDefault20260524010000 } from '../../src/database/migrations/20260524010000-AddPositionProtectiveOrderTypeDefault';

// Returns a jest mock fn and a QueryRunner stub that delegates to it.
function makeQueryRunner(): { qr: QueryRunner; querySpy: jest.Mock } {
    const querySpy = jest.fn().mockResolvedValue(undefined);
    const qr = { query: querySpy } as unknown as QueryRunner;
    return { qr, querySpy };
}

describe('Migration AddPositionProtectiveOrderTypeDefault — up()', () => {
    it('executes exactly four SQL statements', async () => {
        // BUILD
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionProtectiveOrderTypeDefault20260524010000();

        // OPERATE
        await migration.up(qr);

        // CHECK
        expect(querySpy).toHaveBeenCalledTimes(4);
    });

    it('first statement is the backfill UPDATE (NULL → local_fallback)', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionProtectiveOrderTypeDefault20260524010000();

        await migration.up(qr);

        const firstCall = (querySpy.mock.calls[0][0] as string).trim();
        expect(firstCall).toMatch(/UPDATE\s+"positions"/i);
        expect(firstCall).toMatch(/local_fallback/);
        expect(firstCall).toMatch(/IS NULL/i);
    });

    it('sets DEFAULT local_fallback on protective_order_type', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionProtectiveOrderTypeDefault20260524010000();

        await migration.up(qr);

        const defaultSql = querySpy.mock.calls.find(([sql]) => (sql as string).includes('SET DEFAULT') && (sql as string).includes('local_fallback'));
        expect(defaultSql).toBeDefined();
    });

    it('sets NOT NULL on protective_order_type after the DEFAULT is set', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionProtectiveOrderTypeDefault20260524010000();

        await migration.up(qr);

        const notNullIdx = querySpy.mock.calls.findIndex(
            ([sql]) => (sql as string).includes('SET NOT NULL') && (sql as string).includes('protective_order_type'),
        );
        const defaultIdx = querySpy.mock.calls.findIndex(([sql]) => (sql as string).includes('SET DEFAULT') && (sql as string).includes('local_fallback'));

        expect(notNullIdx).toBeGreaterThan(-1);
        expect(defaultIdx).toBeGreaterThan(-1);
        // DEFAULT must come before NOT NULL
        expect(defaultIdx).toBeLessThan(notNullIdx);
    });

    it('adds uq_transactions_client_order_id UNIQUE constraint', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionProtectiveOrderTypeDefault20260524010000();

        await migration.up(qr);

        const uniqueSql = querySpy.mock.calls.find(
            ([sql]) => (sql as string).includes('uq_transactions_client_order_id') && (sql as string).includes('UNIQUE'),
        );
        expect(uniqueSql).toBeDefined();
    });
});

describe('Migration AddPositionProtectiveOrderTypeDefault — down()', () => {
    it('executes exactly three SQL statements', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionProtectiveOrderTypeDefault20260524010000();

        await migration.down(qr);

        expect(querySpy).toHaveBeenCalledTimes(3);
    });

    it('first statement in down() drops the unique constraint', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionProtectiveOrderTypeDefault20260524010000();

        await migration.down(qr);

        const firstCall = (querySpy.mock.calls[0][0] as string).trim();
        expect(firstCall).toMatch(/DROP CONSTRAINT/i);
        expect(firstCall).toMatch(/uq_transactions_client_order_id/);
    });

    it('drops NOT NULL before dropping DEFAULT (reverse order of up)', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionProtectiveOrderTypeDefault20260524010000();

        await migration.down(qr);

        const dropNotNullIdx = querySpy.mock.calls.findIndex(([sql]) => (sql as string).includes('DROP NOT NULL'));
        const dropDefaultIdx = querySpy.mock.calls.findIndex(([sql]) => (sql as string).includes('DROP DEFAULT'));

        expect(dropNotNullIdx).toBeGreaterThan(-1);
        expect(dropDefaultIdx).toBeGreaterThan(-1);
        expect(dropNotNullIdx).toBeLessThan(dropDefaultIdx);
    });
});

describe('Migration AddPositionProtectiveOrderTypeDefault — reversibility', () => {
    it('up() + down() cover matching structural changes (NOT NULL / DEFAULT / UNIQUE)', async () => {
        const { qr: upQr, querySpy: upSpy } = makeQueryRunner();
        const { qr: downQr, querySpy: downSpy } = makeQueryRunner();
        const migration = new AddPositionProtectiveOrderTypeDefault20260524010000();

        await migration.up(upQr);
        await migration.down(downQr);

        // up() has 4 statements; down() has 3 (no backfill needed in revert)
        expect(upSpy).toHaveBeenCalledTimes(4);
        expect(downSpy).toHaveBeenCalledTimes(3);

        const upSqls = upSpy.mock.calls.map(([sql]) => sql as string);
        const downSqls = downSpy.mock.calls.map(([sql]) => sql as string);

        expect(upSqls.some((s) => s.includes('SET NOT NULL'))).toBe(true);
        expect(downSqls.some((s) => s.includes('DROP NOT NULL'))).toBe(true);

        expect(upSqls.some((s) => s.includes('SET DEFAULT'))).toBe(true);
        expect(downSqls.some((s) => s.includes('DROP DEFAULT'))).toBe(true);

        expect(upSqls.some((s) => s.includes('uq_transactions_client_order_id') && s.includes('UNIQUE'))).toBe(true);
        expect(downSqls.some((s) => s.includes('uq_transactions_client_order_id') && s.includes('DROP CONSTRAINT'))).toBe(true);
    });
});
