/**
 * Migration AddPositionStateMachineColumns — unit test (M6 W1).
 *
 * Coverage:
 *   - up() adds positions.state with NOT NULL DEFAULT 'open' (back-fills pre-M6 rows).
 *   - up() adds positions.stop_loss_price + positions.take_profit_price (NULL).
 *   - up() adds transactions.cashflow with NOT NULL DEFAULT 0.
 *   - up() adds account_snapshots.unrealized_pnl_funding + unrealized_pnl_price
 *     (NOT NULL DEFAULT 0).
 *   - up() inserts the sentinel strategy_versions row (name='manual_adopted').
 *   - down() drops columns + sentinel row in REVERSE order of up().
 *   - up() + down() are reversible — every structural addition has a matching removal.
 */

import { QueryRunner } from 'typeorm';

import { AddPositionStateMachineColumns20260525010000 } from '../../src/database/migrations/20260525010000-AddPositionStateMachineColumns';

function makeQueryRunner(): { qr: QueryRunner; querySpy: jest.Mock } {
    const querySpy = jest.fn().mockResolvedValue(undefined);
    const qr = { query: querySpy } as unknown as QueryRunner;

    return { qr, querySpy };
}

describe('Migration AddPositionStateMachineColumns — up()', () => {
    it('adds positions.state varchar NOT NULL DEFAULT open', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionStateMachineColumns20260525010000();

        await migration.up(qr);

        const stateSql = querySpy.mock.calls
            .map(([sql]) => sql as string)
            .find((sql) => sql.includes('"positions"') && sql.includes('"state"') && sql.includes('ADD COLUMN'));
        expect(stateSql).toBeDefined();
        expect(stateSql).toMatch(/NOT NULL/);
        expect(stateSql).toMatch(/DEFAULT 'open'/);
    });

    it('adds positions.stop_loss_price and take_profit_price nullable', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionStateMachineColumns20260525010000();

        await migration.up(qr);

        const sqls = querySpy.mock.calls.map(([sql]) => sql as string);
        expect(sqls.some((sql) => sql.includes('"stop_loss_price"') && sql.includes('ADD COLUMN'))).toBe(true);
        expect(sqls.some((sql) => sql.includes('"take_profit_price"') && sql.includes('ADD COLUMN'))).toBe(true);
    });

    it('adds transactions.cashflow NOT NULL DEFAULT 0', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionStateMachineColumns20260525010000();

        await migration.up(qr);

        const cashflowSql = querySpy.mock.calls
            .map(([sql]) => sql as string)
            .find((sql) => sql.includes('"transactions"') && sql.includes('"cashflow"') && sql.includes('ADD COLUMN'));
        expect(cashflowSql).toBeDefined();
        expect(cashflowSql).toMatch(/NOT NULL/);
        expect(cashflowSql).toMatch(/DEFAULT 0/);
    });

    it('adds account_snapshots PnL split columns NOT NULL DEFAULT 0', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionStateMachineColumns20260525010000();

        await migration.up(qr);

        const sqls = querySpy.mock.calls.map(([sql]) => sql as string);
        const fundingSql = sqls.find((sql) => sql.includes('"account_snapshots"') && sql.includes('"unrealized_pnl_funding"'));
        const priceSql = sqls.find((sql) => sql.includes('"account_snapshots"') && sql.includes('"unrealized_pnl_price"'));

        expect(fundingSql).toBeDefined();
        expect(fundingSql).toMatch(/NOT NULL/);
        expect(fundingSql).toMatch(/DEFAULT 0/);
        expect(priceSql).toBeDefined();
        expect(priceSql).toMatch(/NOT NULL/);
        expect(priceSql).toMatch(/DEFAULT 0/);
    });

    it('inserts the manual_adopted sentinel strategy_versions row idempotently', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionStateMachineColumns20260525010000();

        await migration.up(qr);

        const sentinelCall = querySpy.mock.calls.find(([sql]) => (sql as string).includes('strategy_versions') && (sql as string).includes('INSERT'));
        expect(sentinelCall).toBeDefined();
        const [sentinelSql, sentinelParams] = sentinelCall as [string, unknown[]];
        expect(sentinelSql).toMatch(/ON CONFLICT/i);
        expect(sentinelParams).toEqual(['manual_adopted']);
    });
});

describe('Migration AddPositionStateMachineColumns — down()', () => {
    it('drops everything in reverse order of up()', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new AddPositionStateMachineColumns20260525010000();

        await migration.down(qr);

        const sqls = querySpy.mock.calls.map(([sql]) => sql as string);
        // The sentinel row removal comes first; positions.state DROP comes last.
        const sentinelIdx = sqls.findIndex((sql) => sql.includes('DELETE FROM "strategy_versions"'));
        const stateDropIdx = sqls.findIndex((sql) => sql.includes('"positions"') && sql.includes('DROP COLUMN "state"'));
        const cashflowDropIdx = sqls.findIndex((sql) => sql.includes('"transactions"') && sql.includes('DROP COLUMN "cashflow"'));

        expect(sentinelIdx).toBeGreaterThanOrEqual(0);
        expect(stateDropIdx).toBeGreaterThan(cashflowDropIdx);
        expect(cashflowDropIdx).toBeGreaterThan(sentinelIdx);
    });
});

describe('Migration AddPositionStateMachineColumns — reversibility', () => {
    it('every ADD COLUMN in up() has a matching DROP COLUMN in down()', async () => {
        const upRun = makeQueryRunner();
        const downRun = makeQueryRunner();
        const migration = new AddPositionStateMachineColumns20260525010000();

        await migration.up(upRun.qr);
        await migration.down(downRun.qr);

        const addedColumns = ['state', 'stop_loss_price', 'take_profit_price', 'cashflow', 'unrealized_pnl_funding', 'unrealized_pnl_price'];

        for (const column of addedColumns) {
            const wasAdded = upRun.querySpy.mock.calls.some(([sql]) => (sql as string).includes(`"${column}"`) && (sql as string).includes('ADD COLUMN'));
            const wasDropped = downRun.querySpy.mock.calls.some(([sql]) => (sql as string).includes(`DROP COLUMN "${column}"`));
            expect(wasAdded).toBe(true);
            expect(wasDropped).toBe(true);
        }
    });
});
