/**
 * M11a R4 Item 1 — Postgres-backed integration test for the
 * BootModeHistoryRepository two-phase append. Pins the BLOCKER fix:
 * the placeholder HMAC MUST be filled with 0xFF (sentinel) instead of
 * 0x00, because migration 20260614000000 added a non-deferrable CHECK
 * constraint `this_row_hmac <> decode(repeat('00', 32), 'hex')` that
 * rejected the all-zero placeholder at INSERT time — the engine could
 * not start once the migration ran.
 *
 * The unit-test gap that hid this regression: every previous spec
 * mocked the repository, so the CHECK never executed. This spec exercises
 * the real Postgres path inside a single transaction so the placeholder
 * INSERT + the followup UPDATE both run against the live constraint.
 *
 * Guarded by `RUN_PG_INTEGRATION` (same opt-in as the other
 * `requires Postgres` specs). When Postgres is unavailable the spec
 * file imports cleanly + the `describe.skip` short-circuit takes over,
 * so the suite still passes on the CI laptop.
 */

import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { SUBKEY_BYTES } from '../const';
import { BootModeHistoryEntity } from '../entity/BootModeHistoryEntity';
import { BootModeHistoryRowKindEnum } from '../enum';
import { BootModeHistoryRepository } from '../repository/BootModeHistoryRepository';

const RUN_PG_INTEGRATION = process.env.RUN_PG_INTEGRATION === '1';

const describePg = RUN_PG_INTEGRATION ? describe : describe.skip;

describePg('BootModeHistoryRepository — genesis append against live Postgres (M11a R4 Item 1)', () => {
    let dataSource: DataSource;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'postgres',
            host: process.env.PGHOST ?? '127.0.0.1',
            port: Number(process.env.PGPORT ?? 5432),
            username: process.env.PGUSER ?? 'postgres',
            password: process.env.PGPASSWORD ?? 'postgres',
            database: process.env.PGDATABASE ?? 'tbvt',
            entities: [BootModeHistoryEntity],
            synchronize: false,
        });
        await dataSource.initialize();
    });

    afterAll(async () => {
        if (dataSource !== undefined && dataSource.isInitialized) {
            await dataSource.destroy();
        }
    });

    it('appends a GENESIS BOOT row + verifies the resulting HMAC is non-zero (placeholder CHECK survives)', async () => {
        // BUILD
        const repo = new BootModeHistoryRepository(dataSource.getRepository(BootModeHistoryEntity));
        const computedHmac = Buffer.alloc(SUBKEY_BYTES, 0x42); // any non-zero sentinel

        // OPERATE — runs the two-phase append inside a transaction;
        // pre-R4 this throws on the placeholder INSERT because of the
        // CHECK constraint on `this_row_hmac`.
        const persisted = await dataSource.transaction(async (manager) => {
            return repo.appendInTransaction(manager, {
                rowKind: BootModeHistoryRowKindEnum.BOOT,
                exchangeEnv: `paper-r4-${randomUUID().slice(0, 8)}`,
                fromEnv: null,
                toEnv: null,
                prevRowHash: null,
                computeHmac: () => computedHmac,
            });
        });

        // CHECK
        expect(persisted.thisRowHmac.equals(computedHmac)).toBe(true);
        expect(persisted.rowKind).toBe(BootModeHistoryRowKindEnum.BOOT);
    });
});
