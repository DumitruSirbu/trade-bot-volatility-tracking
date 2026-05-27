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
 * Extended in the pre-M11b deferred item #1 ("urgent") to cover the
 * CRITICAL M11a live-smoke bug: `manager.save()` does NOT refresh
 * BIGSERIAL columns from INSERT…RETURNING, so the HMAC computed at write
 * time used `seq=undefined` while the chain-integrity verifier loaded
 * `seq='1'` and recomputed a different HMAC — the engine could not
 * survive a restart. The regression tests below pin the atomic
 * INSERT…RETURNING fix that replaced `manager.save()`.
 *
 * Row isolation: each test records every ID it inserts into `insertedIds`.
 * The `afterEach` block deletes those rows by primary key so parallel runs
 * within the same Postgres schema do not interfere. Tests that must commit
 * (cross-transaction continuity) clean up via `afterEach`; tests that only
 * need constraint rejection stay inside a transaction that rolls back.
 *
 * Run with --runInBand when executing the full integration suite to avoid
 * any DB-level ordering surprises.
 *
 * Guarded by `RUN_PG_INTEGRATION` (same opt-in as the other
 * `requires Postgres` specs). When Postgres is unavailable the spec
 * file imports cleanly + the `describe.skip` short-circuit takes over,
 * so the suite still passes on the CI laptop.
 */

import { DataSource } from 'typeorm';

import { CHAIN_NAME_BOOT_MODE_HISTORY, SUBKEY_BYTES } from '../../src/boot-mode-history/const';
import { BootModeHistoryEntity } from '../../src/boot-mode-history/entity/BootModeHistoryEntity';
import { BootModeHistoryRowKindEnum } from '../../src/boot-mode-history/enum';
import { BootModeHistoryRepository } from '../../src/boot-mode-history/repository/BootModeHistoryRepository';
import { BootModeHmacCodec } from '../../src/boot-mode-history/service/BootModeHmacCodec';
import { BootstrapSubkeyDeriver } from '../../src/boot-mode-history/service/BootstrapSubkeyDeriver';
import { AppConfigService } from '../../src/config/service';

const RUN_PG_INTEGRATION = process.env.RUN_PG_INTEGRATION === '1';

const describePg = RUN_PG_INTEGRATION ? describe : describe.skip;

// Fixed bootstrap secret — deterministic across all runs; never touches prod.
const BOOTSTRAP_SECRET = 'a'.repeat(64);

function buildSubkey(): Buffer {
    const appConfig = { authBootstrapSecret: BOOTSTRAP_SECRET } satisfies Pick<AppConfigService, 'authBootstrapSecret'>;
    const deriver = new BootstrapSubkeyDeriver(appConfig as AppConfigService);
    return deriver.deriveSubkey('boot_mode_history v1');
}

function makeComputeHmac(subkey: Buffer, codec: BootModeHmacCodec) {
    return (payload: {
        seq: string;
        bootedAt: Date;
        rowKind: string;
        exchangeEnv: string;
        fromEnv: string | null;
        toEnv: string | null;
        prevRowHash: Buffer | null;
    }): Buffer => codec.computeHmac(subkey, codec.encodeBootModeHistoryPayload(CHAIN_NAME_BOOT_MODE_HISTORY, payload));
}

describePg('BootModeHistoryRepository — genesis append against live Postgres (M11a R4 Item 1)', () => {
    let dataSource: DataSource;
    // Tracks IDs inserted in the current test for cleanup in afterEach.
    let insertedIds: string[];

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

    beforeEach(() => {
        insertedIds = [];
    });

    afterEach(async () => {
        if (insertedIds.length > 0) {
            await dataSource.getRepository(BootModeHistoryEntity).delete(insertedIds);
        }
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
                exchangeEnv: 'paper',
                fromEnv: null,
                toEnv: null,
                prevRowHash: null,
                computeHmac: () => computedHmac,
            });
        });

        insertedIds.push(persisted.id);

        // CHECK
        expect(persisted.thisRowHmac.equals(computedHmac)).toBe(true);
        expect(persisted.rowKind).toBe(BootModeHistoryRowKindEnum.BOOT);
    });

    it('round-trip seq stability — pins atomic INSERT…RETURNING regression from M11a live-smoke', async () => {
        // BUILD
        // The M11a smoke bug: manager.save() returned `seq=undefined`. The
        // HMAC was therefore computed over seq=null while the verifier read
        // back seq='<n>' and computed different bytes. This test appends a
        // row, reads it back with findOrderedAll(), recomputes its HMAC from
        // the PERSISTED entity's seq, and asserts they match.
        const repo = new BootModeHistoryRepository(dataSource.getRepository(BootModeHistoryEntity));
        const codec = new BootModeHmacCodec();
        const subkey = buildSubkey();

        // OPERATE
        const appended = await dataSource.transaction(async (manager) => {
            return repo.appendInTransaction(manager, {
                rowKind: BootModeHistoryRowKindEnum.BOOT,
                exchangeEnv: 'paper',
                fromEnv: null,
                toEnv: null,
                prevRowHash: null,
                computeHmac: makeComputeHmac(subkey, codec),
            });
        });

        insertedIds.push(appended.id);

        // Read the row back via the repository (simulates boot-time chain walk).
        const allRows = await repo.findOrderedAll();
        const readBack = allRows.find((r) => r.id === appended.id);

        // CHECK
        expect(readBack).toBeDefined();
        const readBackRow = readBack!;

        // Recompute HMAC using the DB-assigned seq from the persisted row.
        // If seq was captured correctly (INSERT…RETURNING), this matches the
        // stored HMAC. If seq was `undefined` (manager.save() bug), it diverges.
        const recomputed = codec.computeHmac(
            subkey,
            codec.encodeBootModeHistoryPayload(CHAIN_NAME_BOOT_MODE_HISTORY, {
                seq: readBackRow.seq,
                bootedAt: readBackRow.bootedAt,
                rowKind: readBackRow.rowKind,
                exchangeEnv: readBackRow.exchangeEnv,
                fromEnv: readBackRow.fromEnv,
                toEnv: readBackRow.toEnv,
                prevRowHash: readBackRow.prevRowHash,
            }),
        );

        expect(recomputed.equals(readBackRow.thisRowHmac)).toBe(true);
        expect(readBackRow.seq).not.toBeNull();
        expect(readBackRow.seq).not.toBe('undefined');
        // seq must be a valid positive integer string as returned by Postgres BIGSERIAL.
        expect(Number(readBackRow.seq)).toBeGreaterThan(0);
    });

    it('multi-row chain append — each row HMAC reproduces from persisted seq (3-row walk)', async () => {
        // BUILD
        // Simulates exactly what BootModeChainService does at live boot:
        // appends BOOT → BOOT → TRANSITION rows with prevRowHash linkage,
        // then walks all 3 rows and recomputes each HMAC. The M11a smoke
        // bug would fail at row 2 or 3 because seq=undefined would produce
        // a stored HMAC that diverges from the walk recompute.
        const repo = new BootModeHistoryRepository(dataSource.getRepository(BootModeHistoryEntity));
        const codec = new BootModeHmacCodec();
        const subkey = buildSubkey();

        // OPERATE
        const row1 = await dataSource.transaction(async (manager) => {
            return repo.appendInTransaction(manager, {
                rowKind: BootModeHistoryRowKindEnum.BOOT,
                exchangeEnv: 'paper',
                fromEnv: null,
                toEnv: null,
                prevRowHash: null,
                computeHmac: makeComputeHmac(subkey, codec),
            });
        });

        const row2 = await dataSource.transaction(async (manager) => {
            return repo.appendInTransaction(manager, {
                rowKind: BootModeHistoryRowKindEnum.BOOT,
                exchangeEnv: 'paper',
                fromEnv: null,
                toEnv: null,
                prevRowHash: row1.thisRowHmac,
                computeHmac: makeComputeHmac(subkey, codec),
            });
        });

        const row3 = await dataSource.transaction(async (manager) => {
            return repo.appendInTransaction(manager, {
                rowKind: BootModeHistoryRowKindEnum.TRANSITION,
                exchangeEnv: 'paper',
                fromEnv: 'testnet',
                toEnv: 'paper',
                prevRowHash: row2.thisRowHmac,
                computeHmac: makeComputeHmac(subkey, codec),
            });
        });

        insertedIds.push(row1.id, row2.id, row3.id);

        // Read all rows back, filtered by the IDs inserted in this test.
        const allRows = await repo.findOrderedAll();
        const ourRows = allRows.filter((r) => insertedIds.includes(r.id));

        // CHECK
        expect(ourRows).toHaveLength(3);

        const [persisted1, persisted2, persisted3] = ourRows;

        // Walk the chain: verify each row's HMAC reproduces from its persisted seq.
        for (const row of [persisted1, persisted2, persisted3]) {
            const recomputed = codec.computeHmac(
                subkey,
                codec.encodeBootModeHistoryPayload(CHAIN_NAME_BOOT_MODE_HISTORY, {
                    seq: row.seq,
                    bootedAt: row.bootedAt,
                    rowKind: row.rowKind,
                    exchangeEnv: row.exchangeEnv,
                    fromEnv: row.fromEnv,
                    toEnv: row.toEnv,
                    prevRowHash: row.prevRowHash,
                }),
            );
            expect(recomputed.equals(row.thisRowHmac)).toBe(true);
        }

        // Verify chain linkage: each row's prevRowHash equals the prior row's thisRowHmac.
        expect(persisted1.prevRowHash).toBeNull();
        expect(persisted2.prevRowHash!.equals(persisted1.thisRowHmac)).toBe(true);
        expect(persisted3.prevRowHash!.equals(persisted2.thisRowHmac)).toBe(true);

        // Verify seqs are distinct and ascending.
        expect(Number(persisted1.seq)).toBeLessThan(Number(persisted2.seq));
        expect(Number(persisted2.seq)).toBeLessThan(Number(persisted3.seq));

        // Verify the cross-transaction rows match what appendInTransaction returned.
        expect(persisted1.id).toBe(row1.id);
        expect(persisted2.id).toBe(row2.id);
        expect(persisted3.id).toBe(row3.id);
    });

    it('cross-transaction chain continuity — row N+1 binds prevRowHash from row N across transaction boundaries', async () => {
        // BUILD
        // Appends row N in transaction A, commits. Opens transaction B and
        // appends row N+1 binding prevRowHash to row N's thisRowHmac. Both
        // rows must verify independently from their persisted seq values.
        // This guards against any in-memory-only caching of seq that would
        // fail to survive a transaction commit.
        const repo = new BootModeHistoryRepository(dataSource.getRepository(BootModeHistoryEntity));
        const codec = new BootModeHmacCodec();
        const subkey = buildSubkey();

        // OPERATE — transaction A: append genesis row, commit.
        const rowN = await dataSource.transaction(async (manager) => {
            return repo.appendInTransaction(manager, {
                rowKind: BootModeHistoryRowKindEnum.BOOT,
                exchangeEnv: 'paper',
                fromEnv: null,
                toEnv: null,
                prevRowHash: null,
                computeHmac: makeComputeHmac(subkey, codec),
            });
        });

        // Transaction B: bind prevRowHash to rowN.thisRowHmac, commit.
        const rowNPlus1 = await dataSource.transaction(async (manager) => {
            return repo.appendInTransaction(manager, {
                rowKind: BootModeHistoryRowKindEnum.BOOT,
                exchangeEnv: 'paper',
                fromEnv: null,
                toEnv: null,
                prevRowHash: rowN.thisRowHmac,
                computeHmac: makeComputeHmac(subkey, codec),
            });
        });

        insertedIds.push(rowN.id, rowNPlus1.id);

        // Read both rows back, filtered by the IDs inserted in this test.
        const allRows = await repo.findOrderedAll();
        const ourRows = allRows.filter((r) => insertedIds.includes(r.id));

        // CHECK
        expect(ourRows).toHaveLength(2);
        const [pN, pNPlus1] = ourRows;

        // Each row's HMAC reproduces from its DB-assigned seq.
        for (const row of [pN, pNPlus1]) {
            const recomputed = codec.computeHmac(
                subkey,
                codec.encodeBootModeHistoryPayload(CHAIN_NAME_BOOT_MODE_HISTORY, {
                    seq: row.seq,
                    bootedAt: row.bootedAt,
                    rowKind: row.rowKind,
                    exchangeEnv: row.exchangeEnv,
                    fromEnv: row.fromEnv,
                    toEnv: row.toEnv,
                    prevRowHash: row.prevRowHash,
                }),
            );
            expect(recomputed.equals(row.thisRowHmac)).toBe(true);
        }

        // Chain linkage is intact across transaction boundaries.
        expect(pN.id).toBe(rowN.id);
        expect(pNPlus1.id).toBe(rowNPlus1.id);
        expect(pNPlus1.prevRowHash!.equals(pN.thisRowHmac)).toBe(true);
    });

    it('CHECK constraint rejects all-zero HMAC — pins migration 20260614000000 ck_boot_mode_history_this_row_hmac_nonzero', async () => {
        // BUILD
        // Direct raw INSERT with this_row_hmac = 0x00…00 (32 bytes).
        // The non-deferrable CHECK added by migration 20260614000000 MUST
        // throw. Verifies that the constraint is present and active — if a
        // future migration accidentally dropped it, this test catches the gap.
        // The transaction rolls back on rejection, so no cleanup is needed.

        // OPERATE + CHECK
        await expect(
            dataSource.transaction(async (manager) => {
                await manager.query(
                    `INSERT INTO boot_mode_history
                     (row_kind, exchange_env, from_env, to_env, prev_row_hash, this_row_hmac)
                     VALUES ($1, $2, NULL, NULL, NULL, $3)`,
                    [BootModeHistoryRowKindEnum.BOOT, 'paper', Buffer.alloc(SUBKEY_BYTES, 0x00)],
                );
            }),
        ).rejects.toThrow();
    });
});
