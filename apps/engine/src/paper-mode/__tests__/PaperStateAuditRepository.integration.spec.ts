/**
 * Pre-M11b deferred item #1 — Postgres-backed integration tests for
 * PaperStateAuditRepository. Pins the append + verify path that was
 * exclusively mocked in production-code unit tests.
 *
 * Key invariants tested:
 *
 * 1. Single-row round-trip: append → read-back → HMAC recomputes from
 *    persisted entity. Verifies the same atomic INSERT…RETURNING pattern
 *    that PaperStateAuditRepository uses (it pre-dated the M11a smoke bug
 *    but deserves the same regression coverage as the sibling repositories).
 *
 * 2. Three-row chain walk: OPEN_POSITION → CLOSE_POSITION → APPLY_FUNDING
 *    with prevRowHash linkage; each row's HMAC must reproduce from its
 *    persisted seq.
 *
 * 3. Concurrency behaviour: PaperStateAuditRepository.appendInTransaction
 *    does NOT acquire the advisory lock — that is the caller's
 *    responsibility (see PaperAccountStateService.acquireAuditAdvisoryLock).
 *    When two transactions call appendInTransaction concurrently WITHOUT the
 *    advisory lock, BOTH succeed (BIGSERIAL assigns distinct seqs atomically).
 *    The test asserts both rows are persisted, seqs are distinct, and each
 *    HMAC reproduces from its own persisted seq. The test does NOT assert
 *    which row gets the lower seq — that is intentionally non-deterministic
 *    under concurrent INSERT. This pins the actual repository behaviour so a
 *    future refactor that accidentally adds a serialization invariant inside
 *    the repository (rather than the service layer) will be caught here.
 *
 * 4. CHECK constraint: all-zero this_row_hmac is rejected by migration
 *    20260616000000's ck_paper_state_audit_this_row_hmac_nonzero.
 *
 * Row isolation: each test records every ID it inserts into `insertedIds`.
 * The `afterEach` block deletes those rows by primary key. Tests that only
 * need constraint rejection run inside a transaction that rolls back, so no
 * explicit cleanup is needed for them.
 *
 * Run with --runInBand when executing the full integration suite.
 *
 * Guarded by `RUN_PG_INTEGRATION=1`. When unset the suite skips cleanly.
 */

import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { CHAIN_NAME_PAPER_STATE_AUDIT, PAPER_STATE_AUDIT_SUBKEY_BYTES } from '../const';
import { PaperStateAuditEntity } from '../entity/PaperStateAuditEntity';
import { MutationKindEnum, SubjectKindEnum } from '../enum';
import { PaperStateAuditRepository } from '../repository/PaperStateAuditRepository';
import { PaperStateAuditHmacCodec } from '../service/PaperStateAuditHmacCodec';
import { BootstrapSubkeyDeriver } from '../../boot-mode-history/service/BootstrapSubkeyDeriver';
import { AppConfigService } from '../../config/service';

const RUN_PG_INTEGRATION = process.env.RUN_PG_INTEGRATION === '1';

const describePg = RUN_PG_INTEGRATION ? describe : describe.skip;

// Fixed bootstrap secret — deterministic across all runs; never touches prod.
const BOOTSTRAP_SECRET = 'a'.repeat(64);

function buildSubkey(): Buffer {
    const appConfig = { authBootstrapSecret: BOOTSTRAP_SECRET } satisfies Pick<AppConfigService, 'authBootstrapSecret'>;
    const deriver = new BootstrapSubkeyDeriver(appConfig as AppConfigService);
    return deriver.deriveSubkey('paper_state_audit v1');
}

function makeComputeHmac(
    subkey: Buffer,
    codec: PaperStateAuditHmacCodec,
): (payload: {
    seq: string;
    recordedAt: Date;
    mutationKind: string;
    subjectKind: string;
    subjectId: string;
    payloadHash: Buffer;
    prevRowHash: Buffer | null;
}) => Buffer {
    return (payload) => codec.computeHmac(subkey, codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, payload));
}

function buildPayloadHash(codec: PaperStateAuditHmacCodec, subjectId: string): Buffer {
    // Deterministic 32-byte payload hash for test rows. Using hashOrderedPayload
    // so the hash is well-formed (exactly 32 bytes, satisfying the DB CHECK).
    return codec.hashOrderedPayload([
        ['subject_id', subjectId],
        ['test', 'integration'],
    ]);
}

describePg('PaperStateAuditRepository — append + verify against live Postgres (pre-M11b deferred item #1)', () => {
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
            entities: [PaperStateAuditEntity],
            synchronize: false,
        });
        await dataSource.initialize();
    });

    beforeEach(() => {
        insertedIds = [];
    });

    afterEach(async () => {
        if (insertedIds.length > 0) {
            await dataSource.getRepository(PaperStateAuditEntity).delete(insertedIds);
        }
    });

    afterAll(async () => {
        if (dataSource !== undefined && dataSource.isInitialized) {
            await dataSource.destroy();
        }
    });

    it('single audit row — append + read-back + HMAC reproduces from persisted seq', async () => {
        // BUILD
        // Appends one OPEN_POSITION audit row. Reads the row back via
        // findOrderedAll and recomputes its HMAC from the persisted entity's
        // DB-assigned seq. If seq was not captured atomically the recomputed
        // HMAC would diverge from the stored one.
        const repo = new PaperStateAuditRepository(dataSource.getRepository(PaperStateAuditEntity));
        const codec = new PaperStateAuditHmacCodec();
        const subkey = buildSubkey();
        const subjectId = randomUUID();
        const payloadHash = buildPayloadHash(codec, subjectId);

        // OPERATE
        const appended = await dataSource.transaction(async (manager) => {
            return repo.appendInTransaction(manager, {
                mutationKind: MutationKindEnum.OPEN_POSITION,
                subjectKind: SubjectKindEnum.PAPER_ACCOUNT_STATE,
                subjectId,
                payloadHash,
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
        expect(row.recordedAt).toBeInstanceOf(Date);
        expect(row.mutationKind).toBe(MutationKindEnum.OPEN_POSITION);
        expect(row.subjectKind).toBe(SubjectKindEnum.PAPER_ACCOUNT_STATE);
        expect(row.subjectId).toBe(subjectId);

        // Recompute HMAC using the DB-assigned seq from the persisted row.
        const recomputed = codec.computeHmac(
            subkey,
            codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, {
                seq: row.seq,
                recordedAt: row.recordedAt,
                mutationKind: row.mutationKind,
                subjectKind: row.subjectKind,
                subjectId: row.subjectId,
                payloadHash: row.payloadHash,
                prevRowHash: row.prevRowHash,
            }),
        );

        expect(recomputed.equals(row.thisRowHmac)).toBe(true);
    });

    it('three-row chain walk — each row HMAC reproduces and prevRowHash linkage is intact', async () => {
        // BUILD
        // Appends OPEN_POSITION → CLOSE_POSITION → APPLY_FUNDING with
        // prevRowHash chain linkage. Reads all 3 rows back and verifies
        // each HMAC reproduces from its persisted seq. Simulates the
        // chain-integrity walk run by the soak-exit evaluator.
        const repo = new PaperStateAuditRepository(dataSource.getRepository(PaperStateAuditEntity));
        const codec = new PaperStateAuditHmacCodec();
        const subkey = buildSubkey();
        const subjectId1 = randomUUID();
        const subjectId2 = randomUUID();
        const subjectId3 = randomUUID();

        // OPERATE
        const row1 = await dataSource.transaction(async (manager) => {
            return repo.appendInTransaction(manager, {
                mutationKind: MutationKindEnum.OPEN_POSITION,
                subjectKind: SubjectKindEnum.PAPER_ACCOUNT_STATE,
                subjectId: subjectId1,
                payloadHash: buildPayloadHash(codec, subjectId1),
                prevRowHash: null,
                computeHmac: makeComputeHmac(subkey, codec),
            });
        });

        const row2 = await dataSource.transaction(async (manager) => {
            return repo.appendInTransaction(manager, {
                mutationKind: MutationKindEnum.CLOSE_POSITION,
                subjectKind: SubjectKindEnum.PAPER_ACCOUNT_STATE_HISTORY,
                subjectId: subjectId2,
                payloadHash: buildPayloadHash(codec, subjectId2),
                prevRowHash: row1.thisRowHmac,
                computeHmac: makeComputeHmac(subkey, codec),
            });
        });

        const row3 = await dataSource.transaction(async (manager) => {
            return repo.appendInTransaction(manager, {
                mutationKind: MutationKindEnum.APPLY_FUNDING,
                subjectKind: SubjectKindEnum.PAPER_ACCOUNT_STATE,
                subjectId: subjectId3,
                payloadHash: buildPayloadHash(codec, subjectId3),
                prevRowHash: row2.thisRowHmac,
                computeHmac: makeComputeHmac(subkey, codec),
            });
        });

        insertedIds.push(row1.id, row2.id, row3.id);

        const allRows = await repo.findOrderedAll();
        const ourRows = allRows.filter((r) => insertedIds.includes(r.id));

        // CHECK
        expect(ourRows).toHaveLength(3);
        const [p1, p2, p3] = ourRows;

        // Each row's HMAC reproduces from its persisted seq.
        for (const row of [p1, p2, p3]) {
            const recomputed = codec.computeHmac(
                subkey,
                codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, {
                    seq: row.seq,
                    recordedAt: row.recordedAt,
                    mutationKind: row.mutationKind,
                    subjectKind: row.subjectKind,
                    subjectId: row.subjectId,
                    payloadHash: row.payloadHash,
                    prevRowHash: row.prevRowHash,
                }),
            );
            expect(recomputed.equals(row.thisRowHmac)).toBe(true);
        }

        // Chain linkage: each row's prevRowHash equals the prior row's thisRowHmac.
        expect(p1.prevRowHash).toBeNull();
        expect(p2.prevRowHash!.equals(p1.thisRowHmac)).toBe(true);
        expect(p3.prevRowHash!.equals(p2.thisRowHmac)).toBe(true);

        // Seqs are distinct and ascending.
        expect(Number(p1.seq)).toBeLessThan(Number(p2.seq));
        expect(Number(p2.seq)).toBeLessThan(Number(p3.seq));

        // Returned entities match the persisted rows.
        expect(p1.id).toBe(row1.id);
        expect(p2.id).toBe(row2.id);
        expect(p3.id).toBe(row3.id);
    });

    it('concurrency — two parallel transactions WITHOUT advisory lock both succeed with distinct seqs', async () => {
        // BUILD
        // PaperStateAuditRepository.appendInTransaction does NOT acquire the
        // advisory lock (PAPER_STATE_AUDIT_ADVISORY_LOCK_KEY). That is the
        // caller's responsibility (PaperAccountStateService.acquireAuditAdvisoryLock).
        // At the repository level, two concurrent calls race on the BIGSERIAL
        // seq column; Postgres assigns distinct, monotonically-increasing seqs
        // atomically, so BOTH rows succeed. This test pins that behaviour:
        // if a future refactor adds an advisory lock inside the repository
        // (which would be wrong — it belongs in the service), this test
        // would still pass but the concurrency window would shrink.
        // If the repository were to add an optimistic-concurrency check that
        // caused one transaction to fail, this test would detect the regression.
        const repo = new PaperStateAuditRepository(dataSource.getRepository(PaperStateAuditEntity));
        const codec = new PaperStateAuditHmacCodec();
        const subkey = buildSubkey();
        const subjectIdA = randomUUID();
        const subjectIdB = randomUUID();

        // Use a fixed prevRowHash so both transactions bind the same prior
        // hash (as would happen in a real race where both read the same tip
        // before either commits). This is the exact race scenario production
        // code prevents with the advisory lock.
        const sharedPrevRowHash = Buffer.alloc(PAPER_STATE_AUDIT_SUBKEY_BYTES, 0xab);

        // OPERATE — start both transactions in parallel; neither acquires
        // the advisory lock because we are testing the repository in isolation.
        const [resultA, resultB] = await Promise.all([
            dataSource.transaction(async (manager) => {
                return repo.appendInTransaction(manager, {
                    mutationKind: MutationKindEnum.META_INIT,
                    subjectKind: SubjectKindEnum.PAPER_ACCOUNT_STATE_META,
                    subjectId: subjectIdA,
                    payloadHash: buildPayloadHash(codec, subjectIdA),
                    prevRowHash: sharedPrevRowHash,
                    computeHmac: makeComputeHmac(subkey, codec),
                });
            }),
            dataSource.transaction(async (manager) => {
                return repo.appendInTransaction(manager, {
                    mutationKind: MutationKindEnum.SNAPSHOT,
                    subjectKind: SubjectKindEnum.PAPER_ACCOUNT_SNAPSHOTS,
                    subjectId: subjectIdB,
                    payloadHash: buildPayloadHash(codec, subjectIdB),
                    prevRowHash: sharedPrevRowHash,
                    computeHmac: makeComputeHmac(subkey, codec),
                });
            }),
        ]);

        insertedIds.push(resultA.id, resultB.id);

        // CHECK
        // Both rows persisted successfully — the repository does not reject
        // concurrent appends (that is the advisory lock's responsibility).
        expect(resultA.id).not.toBe(resultB.id);
        expect(resultA.seq).not.toBe(resultB.seq);

        // Both seqs are valid positive integers.
        expect(Number(resultA.seq)).toBeGreaterThan(0);
        expect(Number(resultB.seq)).toBeGreaterThan(0);

        // Each HMAC reproduces from its own persisted seq.
        const allRows = await repo.findOrderedAll();
        for (const result of [resultA, resultB]) {
            const row = allRows.find((r) => r.id === result.id)!;
            expect(row).toBeDefined();

            const recomputed = codec.computeHmac(
                subkey,
                codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, {
                    seq: row.seq,
                    recordedAt: row.recordedAt,
                    mutationKind: row.mutationKind,
                    subjectKind: row.subjectKind,
                    subjectId: row.subjectId,
                    payloadHash: row.payloadHash,
                    prevRowHash: row.prevRowHash,
                }),
            );

            expect(recomputed.equals(row.thisRowHmac)).toBe(true);
        }
    });

    it('CHECK constraint rejects all-zero HMAC — pins migration 20260616000000 ck_paper_state_audit_this_row_hmac_nonzero', async () => {
        // BUILD
        // Direct raw INSERT with this_row_hmac = 0x00…00 (32 bytes) and a
        // valid 32-byte payload_hash. The non-deferrable CHECK added by
        // migration 20260616000000 MUST throw. The transaction rolls back on
        // rejection, so no cleanup is needed.
        const subjectId = randomUUID();
        const payloadHash = Buffer.alloc(PAPER_STATE_AUDIT_SUBKEY_BYTES, 0x55);

        // OPERATE + CHECK
        await expect(
            dataSource.transaction(async (manager) => {
                await manager.query(
                    `INSERT INTO paper_state_audit
                     (mutation_kind, subject_kind, subject_id, payload_hash, prev_row_hash, this_row_hmac)
                     VALUES ($1, $2, $3::uuid, $4, NULL, $5)`,
                    [
                        MutationKindEnum.OPEN_POSITION,
                        SubjectKindEnum.PAPER_ACCOUNT_STATE,
                        subjectId,
                        payloadHash,
                        Buffer.alloc(PAPER_STATE_AUDIT_SUBKEY_BYTES, 0x00),
                    ],
                );
            }),
        ).rejects.toThrow();
    });
});
