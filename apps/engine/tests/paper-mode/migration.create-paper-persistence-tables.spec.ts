/**
 * Migration CreatePaperPersistenceTables20260615000000 — unit test
 * (M11a R2b wave A; ADR 0032 §5).
 *
 * Coverage:
 *   - up() creates the five PAPER persistence tables.
 *   - Every table carries the `mode` CHECK pinning to 'paper' (where applicable).
 *   - `paper_account_state.client_order_id` is UNIQUE.
 *   - `paper_account_state` does NOT carry an unrealised_pnl column (D16).
 *   - `paper_account_state_history.close_reason` CHECK pins the addendum's
 *     value set.
 *   - `paper_simulator_idempotency` has the composite UNIQUE
 *     (event_id, order_intent_id, version_namespace) (D3).
 *   - down() drops every table created by up() (reverse-order reversibility).
 */

import { QueryRunner } from 'typeorm';

import { CreatePaperPersistenceTables20260615000000 } from '../../src/database/migrations/20260615000000-CreatePaperPersistenceTables';

function makeQueryRunner(): { qr: QueryRunner; querySpy: jest.Mock } {
    const querySpy = jest.fn().mockResolvedValue(undefined);
    const qr = { query: querySpy } as unknown as QueryRunner;

    return { qr, querySpy };
}

function allSql(querySpy: jest.Mock): string[] {
    return querySpy.mock.calls.map(([sql]) => sql as string);
}

describe('Migration CreatePaperPersistenceTables — up()', () => {
    it('creates the five PAPER persistence tables', async () => {
        const { qr, querySpy } = makeQueryRunner();
        await new CreatePaperPersistenceTables20260615000000().up(qr);
        const sqls = allSql(querySpy);

        expect(sqls.some((sql) => /CREATE TABLE\s+"paper_account_state"/.test(sql))).toBe(true);
        expect(sqls.some((sql) => /CREATE TABLE\s+"paper_account_state_history"/.test(sql))).toBe(true);
        expect(sqls.some((sql) => /CREATE TABLE\s+"paper_account_state_meta"/.test(sql))).toBe(true);
        expect(sqls.some((sql) => /CREATE TABLE\s+"paper_account_snapshots"/.test(sql))).toBe(true);
        expect(sqls.some((sql) => /CREATE TABLE\s+"paper_simulator_idempotency"/.test(sql))).toBe(true);
    });

    it('pins paper_account_state.mode to literal "paper" via CHECK constraint', async () => {
        const { qr, querySpy } = makeQueryRunner();
        await new CreatePaperPersistenceTables20260615000000().up(qr);
        const sqls = allSql(querySpy);
        const stateTable = sqls.find((sql) => /CREATE TABLE\s+"paper_account_state"\s/.test(sql));

        expect(stateTable).toBeDefined();
        expect(stateTable).toMatch(/CHECK\s*\(\s*"mode"\s*=\s*'paper'\s*\)/);
    });

    it('paper_account_state.client_order_id has a UNIQUE constraint (idempotency anchor)', async () => {
        const { qr, querySpy } = makeQueryRunner();
        await new CreatePaperPersistenceTables20260615000000().up(qr);
        const sqls = allSql(querySpy);
        const stateTable = sqls.find((sql) => /CREATE TABLE\s+"paper_account_state"\s/.test(sql));

        expect(stateTable).toMatch(/UNIQUE\s*\(\s*"client_order_id"\s*\)/);
    });

    it('paper_account_state does NOT carry an unrealised_pnl column (D16 — derived, not state)', async () => {
        const { qr, querySpy } = makeQueryRunner();
        await new CreatePaperPersistenceTables20260615000000().up(qr);
        const sqls = allSql(querySpy);
        const stateTable = sqls.find((sql) => /CREATE TABLE\s+"paper_account_state"\s/.test(sql));

        expect(stateTable).not.toMatch(/"unrealised_pnl"/);
        expect(stateTable).not.toMatch(/"unrealized_pnl"/);
    });

    it('paper_account_state_history.close_reason CHECK pins the addendum enum value set', async () => {
        const { qr, querySpy } = makeQueryRunner();
        await new CreatePaperPersistenceTables20260615000000().up(qr);
        const sqls = allSql(querySpy);
        const historyTable = sqls.find((sql) => /CREATE TABLE\s+"paper_account_state_history"\s/.test(sql));

        expect(historyTable).toBeDefined();

        for (const value of ['sl', 'tp', 'intra_bar_stop', 'force_close', 'operator_drain', 'reconciliation_forced']) {
            expect(historyTable).toContain(`'${value}'`);
        }
    });

    it('paper_simulator_idempotency carries the composite UNIQUE (D3 collision-free key)', async () => {
        const { qr, querySpy } = makeQueryRunner();
        await new CreatePaperPersistenceTables20260615000000().up(qr);
        const sqls = allSql(querySpy);
        const idempotencyTable = sqls.find((sql) => /CREATE TABLE\s+"paper_simulator_idempotency"\s/.test(sql));

        expect(idempotencyTable).toBeDefined();
        expect(idempotencyTable).toMatch(/UNIQUE\s*\(\s*"event_id"\s*,\s*"order_intent_id"\s*,\s*"version_namespace"\s*\)/);
    });
});

describe('Migration CreatePaperPersistenceTables — down() is reversible', () => {
    it('drops every PAPER persistence table created by up()', async () => {
        const { qr, querySpy } = makeQueryRunner();
        await new CreatePaperPersistenceTables20260615000000().down(qr);
        const sqls = allSql(querySpy);

        for (const table of [
            'paper_simulator_idempotency',
            'paper_account_snapshots',
            'paper_account_state_meta',
            'paper_account_state_history',
            'paper_account_state',
        ]) {
            expect(sqls.some((sql) => sql.includes(`DROP TABLE IF EXISTS "${table}"`))).toBe(true);
        }
    });

    it('down() drops tables in reverse order of up()', async () => {
        const { qr, querySpy } = makeQueryRunner();
        await new CreatePaperPersistenceTables20260615000000().down(qr);
        const sqls = allSql(querySpy);
        const dropOrder = sqls.filter((sql) => sql.includes('DROP TABLE IF EXISTS')).map((sql) => sql.match(/"([^"]+)"/)?.[1]);

        expect(dropOrder).toEqual([
            'paper_simulator_idempotency',
            'paper_account_snapshots',
            'paper_account_state_meta',
            'paper_account_state_history',
            'paper_account_state',
        ]);
    });
});
