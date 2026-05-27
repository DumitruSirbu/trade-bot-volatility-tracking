/**
 * Pre-M11b deferred item #1 — Postgres-backed integration tests for
 * BootModeChainRotationRepository. Mirrors the extended
 * BootModeHistoryRepository.integration.spec.ts coverage.
 *
 * The M11a live-smoke CRITICAL bug (manager.save() not refreshing BIGSERIAL
 * seq from INSERT…RETURNING) applies equally to BootModeChainRotationRepository:
 * if the write-time seq is `undefined` the stored HMAC diverges from any
 * subsequent verifier recompute. The fix is the same atomic INSERT…RETURNING
 * pattern used by both sibling repositories; these tests pin that fix.
 *
 * Row isolation: each test records every ID it inserts into `insertedIds`.
 * The `afterEach` block deletes those rows by primary key. Tests that only
 * need constraint rejection run inside a transaction that rolls back, so no
 * explicit cleanup is needed for them.
 *
 * Run with --runInBand when executing the full integration suite.
 *
 * Guarded by `RUN_PG_INTEGRATION=1`. When unset, describe.skip short-circuits
 * so the test suite passes on a laptop without Postgres.
 */

import { DataSource } from 'typeorm';

import { CHAIN_NAME_BOOT_MODE_CHAIN_ROTATIONS, SUBKEY_BYTES } from '../../src/boot-mode-history/const';
import { BootModeChainRotationEntity } from '../../src/boot-mode-history/entity/BootModeChainRotationEntity';
import { BootModeChainRotationRepository } from '../../src/boot-mode-history/repository/BootModeChainRotationRepository';
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
    return deriver.deriveSubkey('boot_mode_chain_rotations v1');
}

function makeComputeHmac(subkey: Buffer, codec: BootModeHmacCodec) {
    return (payload: {
        seq: string;
        rotatedAt: Date;
        fromEnv: string;
        toEnv: string;
        preTipHash: Buffer;
        transitionTokenHash: Buffer;
        prevRowHash: Buffer | null;
    }): Buffer => codec.computeHmac(subkey, codec.encodeBootModeChainRotationPayload(CHAIN_NAME_BOOT_MODE_CHAIN_ROTATIONS, payload));
}

describePg('BootModeChainRotationRepository — append + verify against live Postgres (pre-M11b deferred item #1)', () => {
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
            entities: [BootModeChainRotationEntity],
            synchronize: false,
        });
        await dataSource.initialize();
    });

    beforeEach(() => {
        insertedIds = [];
    });

    afterEach(async () => {
        if (insertedIds.length > 0) {
            await dataSource.getRepository(BootModeChainRotationEntity).delete(insertedIds);
        }
    });

    afterAll(async () => {
        if (dataSource !== undefined && dataSource.isInitialized) {
            await dataSource.destroy();
        }
    });

    it('single rotation row — persisted seq + rotatedAt are non-null and HMAC reproduces from persisted entity', async () => {
        // BUILD
        // Appends one rotation row with deterministic inputs; reads the row
        // back and recomputes its HMAC from the persisted entity's
        // DB-assigned seq. If seq was not captured via INSERT…RETURNING, the
        // recomputed HMAC diverges from the stored one.
        const repo = new BootModeChainRotationRepository(dataSource.getRepository(BootModeChainRotationEntity));
        const codec = new BootModeHmacCodec();
        const subkey = buildSubkey();
        const preTipHash = Buffer.alloc(SUBKEY_BYTES, 0xaa);
        const transitionTokenHash = Buffer.alloc(SUBKEY_BYTES, 0xbb);

        // OPERATE
        const appended = await dataSource.transaction(async (manager) => {
            return repo.appendInTransaction(manager, {
                fromEnv: 'testnet',
                toEnv: 'paper',
                preTipHash,
                transitionTokenHash,
                prevRowHash: null,
                computeHmac: makeComputeHmac(subkey, codec),
            });
        });

        insertedIds.push(appended.id);

        const allRows = await repo.findOrderedAll();
        const readBack = allRows.find((r) => r.id === appended.id);

        // CHECK
        expect(readBack).toBeDefined();
        const row = readBack!;

        expect(row.seq).not.toBeNull();
        expect(row.seq).not.toBe('undefined');
        expect(Number(row.seq)).toBeGreaterThan(0);
        expect(row.rotatedAt).toBeInstanceOf(Date);

        // Recompute HMAC using the DB-assigned seq — the atomic INSERT…RETURNING
        // regression test. If seq were not captured at write time the HMAC
        // stored in thisRowHmac would differ from what we recompute here.
        const recomputed = codec.computeHmac(
            subkey,
            codec.encodeBootModeChainRotationPayload(CHAIN_NAME_BOOT_MODE_CHAIN_ROTATIONS, {
                seq: row.seq,
                rotatedAt: row.rotatedAt,
                fromEnv: row.fromEnv,
                toEnv: row.toEnv,
                preTipHash: row.preTipHash,
                transitionTokenHash: row.transitionTokenHash,
                prevRowHash: row.prevRowHash,
            }),
        );

        expect(recomputed.equals(row.thisRowHmac)).toBe(true);
        expect(row.fromEnv).toBe('testnet');
        expect(row.toEnv).toBe('paper');
        expect(row.prevRowHash).toBeNull();
    });

    it('two-row sequence — second row binds prevRowHash to first; both HMACs reproduce from persisted entities', async () => {
        // BUILD
        // Appends two rotation rows in separate transactions so each row's
        // prevRowHash is the prior row's thisRowHmac (the chain link). Reads
        // both back and verifies each HMAC from its persisted seq.
        const repo = new BootModeChainRotationRepository(dataSource.getRepository(BootModeChainRotationEntity));
        const codec = new BootModeHmacCodec();
        const subkey = buildSubkey();
        const preTipHash1 = Buffer.alloc(SUBKEY_BYTES, 0xcc);
        const preTipHash2 = Buffer.alloc(SUBKEY_BYTES, 0xdd);
        const tokenHash1 = Buffer.alloc(SUBKEY_BYTES, 0x11);
        const tokenHash2 = Buffer.alloc(SUBKEY_BYTES, 0x22);

        // OPERATE
        const row1 = await dataSource.transaction(async (manager) => {
            return repo.appendInTransaction(manager, {
                fromEnv: 'testnet',
                toEnv: 'paper',
                preTipHash: preTipHash1,
                transitionTokenHash: tokenHash1,
                prevRowHash: null,
                computeHmac: makeComputeHmac(subkey, codec),
            });
        });

        const row2 = await dataSource.transaction(async (manager) => {
            return repo.appendInTransaction(manager, {
                fromEnv: 'testnet',
                toEnv: 'paper',
                preTipHash: preTipHash2,
                transitionTokenHash: tokenHash2,
                prevRowHash: row1.thisRowHmac,
                computeHmac: makeComputeHmac(subkey, codec),
            });
        });

        insertedIds.push(row1.id, row2.id);

        const allRows = await repo.findOrderedAll();
        const ourRows = allRows.filter((r) => insertedIds.includes(r.id));

        // CHECK
        expect(ourRows).toHaveLength(2);
        const [p1, p2] = ourRows;

        for (const row of [p1, p2]) {
            const recomputed = codec.computeHmac(
                subkey,
                codec.encodeBootModeChainRotationPayload(CHAIN_NAME_BOOT_MODE_CHAIN_ROTATIONS, {
                    seq: row.seq,
                    rotatedAt: row.rotatedAt,
                    fromEnv: row.fromEnv,
                    toEnv: row.toEnv,
                    preTipHash: row.preTipHash,
                    transitionTokenHash: row.transitionTokenHash,
                    prevRowHash: row.prevRowHash,
                }),
            );
            expect(recomputed.equals(row.thisRowHmac)).toBe(true);
        }

        // Chain linkage: row2.prevRowHash === row1.thisRowHmac.
        expect(p1.prevRowHash).toBeNull();
        expect(p2.prevRowHash!.equals(p1.thisRowHmac)).toBe(true);

        // Returned entities match the persisted rows.
        expect(p1.id).toBe(row1.id);
        expect(p2.id).toBe(row2.id);

        // Seqs are distinct and ascending.
        expect(Number(p1.seq)).toBeLessThan(Number(p2.seq));
    });

    it('CHECK constraint rejects all-zero HMAC — pins migration 20260614000000 ck_boot_mode_chain_rotations_this_row_hmac_nonzero', async () => {
        // BUILD
        // Direct raw INSERT with this_row_hmac = 0x00…00 (32 bytes) and a
        // valid 32-byte payload_hash. The non-deferrable CHECK added by
        // migration 20260614000000 MUST throw. The transaction rolls back on
        // rejection, so no cleanup is needed.
        const preTipHash = Buffer.alloc(SUBKEY_BYTES, 0xee);
        const tokenHash = Buffer.alloc(SUBKEY_BYTES, 0xff);

        // OPERATE + CHECK
        await expect(
            dataSource.transaction(async (manager) => {
                await manager.query(
                    `INSERT INTO boot_mode_chain_rotations
                     (from_env, to_env, pre_tip_hash, transition_token_hash, prev_row_hash, this_row_hmac)
                     VALUES ($1, $2, $3, $4, NULL, $5)`,
                    ['testnet', 'paper', preTipHash, tokenHash, Buffer.alloc(SUBKEY_BYTES, 0x00)],
                );
            }),
        ).rejects.toThrow();
    });
});
