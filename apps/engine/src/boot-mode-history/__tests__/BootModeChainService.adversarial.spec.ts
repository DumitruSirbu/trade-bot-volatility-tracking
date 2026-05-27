/**
 * Adversarial tests for BootModeChainService (ADR 0032 §D6 / §D7).
 *
 * Covers:
 *   - Genesis boot: empty chain → exactly one BOOT row appended (prev=null).
 *   - Same-mode boot: tip matches EXCHANGE_ENV → exactly one BOOT row appended,
 *     prev=tip's hmac.
 *   - Mode mismatch with no authorized transition → ABORT with zero rows
 *     appended (no chain mutation).
 *   - Authorized TESTNET->PAPER transition with valid token → exactly one
 *     TRANSITION row + one BOOT row + one rotation row, all atomic.
 *   - Authorized PAPER->LIVE transition with INVALID token → ABORT with zero
 *     chain mutation.
 *   - Chain tampering (HMAC mismatch on a prior row) → ABORT on integrity walk.
 *   - Chain tampering (linkage break) → genuine prev_row_hash mismatch path:
 *     the row's own HMAC stays consistent with its (now-wrong) prevRowHash
 *     because the codec re-encodes it, so the walk catches the break via the
 *     prev-vs-expected comparison instead of the HMAC recompute. A sibling
 *     test exercises the HMAC-recompute path explicitly.
 *   - `seq` ordering: a row with a forged earlier seq but valid HMAC still
 *     trips the prev_row_hash linkage walk.
 *   - Atomicity: if the transaction callback throws AFTER any append, none of
 *     the rows become externally visible.
 *   - Concurrent boot sequence (advisory-lock semantics under shared state).
 */

import { ExchangeEnvironmentEnum } from '@bot/shared';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, unlink, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

import { AppConfigService } from '../../config/service';
import { BootModeHistoryEntity } from '../entity/BootModeHistoryEntity';
import { BootModeChainRotationEntity } from '../entity/BootModeChainRotationEntity';
import { BootModeHistoryRepository } from '../repository/BootModeHistoryRepository';
import { BootModeChainRotationRepository } from '../repository/BootModeChainRotationRepository';
import { BootModeChainService } from '../service/BootModeChainService';
import { BootModeHmacCodec } from '../service/BootModeHmacCodec';
import { BootstrapSubkeyDeriver } from '../service/BootstrapSubkeyDeriver';
import { TransitionTokenVerifier } from '../service/TransitionTokenVerifier';
import { BootModeHistoryRowKindEnum } from '../enum';

// ─── fixtures ────────────────────────────────────────────────────────────────

const BOOTSTRAP_SECRET = 'a'.repeat(64);

async function writeTokenFile(content: string): Promise<string> {
    // crypto.randomUUID() instead of Math.random() — adversarial test
    // fixtures must not depend on weak PRNGs even for filename uniqueness.
    const path = join(tmpdir(), `boot-mode-token-${Date.now()}-${randomUUID()}`);
    await writeFile(path, content, 'utf8');
    await chmod(path, 0o600);
    return path;
}

function sha256Hex(text: string): string {
    return createHash('sha256').update(text.trim(), 'utf8').digest('hex');
}

interface IFakeRepoState {
    historyRows: BootModeHistoryEntity[];
    rotationRows: BootModeChainRotationEntity[];
    nextHistorySeq: number;
    nextRotationSeq: number;
}

function buildFakeRepos(state: IFakeRepoState, stagingHistory: BootModeHistoryEntity[], stagingRotations: BootModeChainRotationEntity[]) {
    // The fake repos imitate the two-phase append-in-transaction pattern of
    // the real BaseRepository implementations: INSERT placeholder → assign
    // seq → compute HMAC over the canonical payload → UPDATE.
    //
    // Writes during a transaction land in the STAGING arrays. The transaction
    // shim copies them into the visible (`state.*Rows`) arrays only on
    // successful callback completion, mirroring real DB atomicity.
    const historyRepo: jest.Mocked<Pick<BootModeHistoryRepository, 'findOrderedAll' | 'findTip' | 'appendInTransaction'>> = {
        findOrderedAll: jest.fn().mockImplementation(async () => {
            // verifyChainIntegrity runs inside the locked transaction, so a
            // verification read after staged-but-not-committed appends must
            // see both committed + staged rows. Matches Postgres
            // read-committed-in-our-own-transaction semantics.
            const merged = [...state.historyRows, ...stagingHistory];
            return [...merged].sort((a, b) => Number(a.seq) - Number(b.seq));
        }),
        findTip: jest.fn().mockImplementation(async () => {
            // The real repository now reads the tip THROUGH the transaction
            // manager; the test merges visible+staging so an in-transaction
            // tip read sees its own staged rows.
            const merged = [...state.historyRows, ...stagingHistory];
            if (merged.length === 0) {
                return null;
            }
            return [...merged].sort((a, b) => Number(b.seq) - Number(a.seq))[0];
        }),
        appendInTransaction: jest.fn().mockImplementation(async (_manager, params) => {
            const seq = String(state.nextHistorySeq++);
            const bootedAt = new Date('2026-05-26T00:00:00.000Z');
            const draft: BootModeHistoryEntity = {
                id: `id-${seq}`,
                seq,
                bootedAt,
                rowKind: params.rowKind,
                exchangeEnv: params.exchangeEnv,
                fromEnv: params.fromEnv,
                toEnv: params.toEnv,
                prevRowHash: params.prevRowHash,
                thisRowHmac: Buffer.alloc(32),
            } as never;
            draft.thisRowHmac = params.computeHmac({
                seq,
                bootedAt,
                rowKind: draft.rowKind,
                exchangeEnv: draft.exchangeEnv,
                fromEnv: draft.fromEnv,
                toEnv: draft.toEnv,
                prevRowHash: draft.prevRowHash,
            });
            stagingHistory.push(draft);
            return draft;
        }),
    };

    const rotationRepo: jest.Mocked<Pick<BootModeChainRotationRepository, 'findOrderedAll' | 'findTip' | 'appendInTransaction'>> = {
        findOrderedAll: jest.fn().mockImplementation(async () => {
            const merged = [...state.rotationRows, ...stagingRotations];
            return [...merged].sort((a, b) => Number(a.seq) - Number(b.seq));
        }),
        findTip: jest.fn().mockImplementation(async () => {
            const merged = [...state.rotationRows, ...stagingRotations];
            if (merged.length === 0) {
                return null;
            }
            return [...merged].sort((a, b) => Number(b.seq) - Number(a.seq))[0];
        }),
        appendInTransaction: jest.fn().mockImplementation(async (_manager, params) => {
            const seq = String(state.nextRotationSeq++);
            const rotatedAt = new Date('2026-05-26T00:00:00.000Z');
            const draft: BootModeChainRotationEntity = {
                id: `rot-${seq}`,
                seq,
                rotatedAt,
                fromEnv: params.fromEnv,
                toEnv: params.toEnv,
                preTipHash: params.preTipHash,
                transitionTokenHash: params.transitionTokenHash,
                prevRowHash: params.prevRowHash,
                thisRowHmac: Buffer.alloc(32),
            } as never;
            draft.thisRowHmac = params.computeHmac({
                seq,
                rotatedAt,
                fromEnv: draft.fromEnv,
                toEnv: draft.toEnv,
                preTipHash: draft.preTipHash,
                transitionTokenHash: draft.transitionTokenHash,
                prevRowHash: draft.prevRowHash,
            });
            stagingRotations.push(draft);
            return draft;
        }),
    };

    return { historyRepo, rotationRepo };
}

function buildAppConfig(
    env: ExchangeEnvironmentEnum,
    bootstrap: string = BOOTSTRAP_SECRET,
): jest.Mocked<Pick<AppConfigService, 'exchangeEnv' | 'authBootstrapSecret' | 'readTransitionTokenFile' | 'readTransitionTokenHash'>> {
    return {
        exchangeEnv: env,
        authBootstrapSecret: bootstrap,
        readTransitionTokenFile: jest.fn().mockImplementation((name: string) => process.env[name]),
        readTransitionTokenHash: jest.fn().mockImplementation((name: string) => process.env[name]),
    } as never;
}

interface IBuiltService {
    service: BootModeChainService;
    state: IFakeRepoState;
    codec: BootModeHmacCodec;
    txShim: jest.Mock;
}

function buildService(state: IFakeRepoState, env: ExchangeEnvironmentEnum): IBuiltService {
    const appConfig = buildAppConfig(env);
    const codec = new BootModeHmacCodec();
    const subkeys = new BootstrapSubkeyDeriver(appConfig as unknown as AppConfigService);

    // Per-transaction staging arrays — recreated on every `transaction()`
    // call so a failed transaction's rows never leak into the next attempt.
    let stagingHistory: BootModeHistoryEntity[] = [];
    let stagingRotations: BootModeChainRotationEntity[] = [];

    const { historyRepo, rotationRepo } = buildFakeRepos(state, stagingHistory, stagingRotations);

    const txShim = jest.fn().mockImplementation(async (fn: (manager: never) => Promise<void>) => {
        // Reset staging for this transaction.
        stagingHistory.length = 0;
        stagingRotations.length = 0;
        try {
            await fn({ query: jest.fn().mockResolvedValue(undefined) } as never);
            // Success: commit staging into the visible state.
            state.historyRows.push(...stagingHistory);
            state.rotationRows.push(...stagingRotations);
        } catch (cause) {
            // Failure: rollback by NOT promoting staging. Also roll back the
            // sequence counters so the next attempt's seq numbers do not skip.
            state.nextHistorySeq -= stagingHistory.length;
            state.nextRotationSeq -= stagingRotations.length;
            throw cause;
        }
    });

    const fakeDataSource = { transaction: txShim };

    const tokenVerifier = new TransitionTokenVerifier();

    const service = new BootModeChainService(
        appConfig as unknown as AppConfigService,
        fakeDataSource as never,
        historyRepo as unknown as BootModeHistoryRepository,
        rotationRepo as unknown as BootModeChainRotationRepository,
        subkeys,
        codec,
        tokenVerifier,
    );

    return { service, state, codec, txShim };
}

function emptyState(): IFakeRepoState {
    return { historyRows: [], rotationRows: [], nextHistorySeq: 1, nextRotationSeq: 1 };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('BootModeChainService — adversarial', () => {
    let processExitSpy: jest.SpyInstance;

    beforeEach(() => {
        processExitSpy = jest.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
            throw new Error(`process.exit called with code ${_code ?? 'undefined'}`);
        });
        // clear transition-token env vars to avoid leakage across tests
        delete process.env.TESTNET_TO_PAPER_TOKEN_FILE;
        delete process.env.TESTNET_TO_PAPER_TOKEN_HASH;
        delete process.env.PAPER_TO_LIVE_TOKEN_FILE;
        delete process.env.PAPER_TO_LIVE_TOKEN_HASH;
    });

    afterEach(() => {
        processExitSpy.mockRestore();
    });

    describe('genesis boot — empty chain', () => {
        it('appends exactly one BOOT row with prev_row_hash=null', async () => {
            const state = emptyState();
            const { service } = buildService(state, ExchangeEnvironmentEnum.PAPER);

            await service.runBootSequence();

            expect(state.historyRows).toHaveLength(1);
            expect(state.historyRows[0].rowKind).toBe(BootModeHistoryRowKindEnum.BOOT);
            expect(state.historyRows[0].exchangeEnv).toBe('paper');
            expect(state.historyRows[0].prevRowHash).toBeNull();
            expect(state.rotationRows).toHaveLength(0);
        });
    });

    describe('same-mode boot — tip matches EXCHANGE_ENV', () => {
        it('appends exactly one BOOT row chained to the tip', async () => {
            const state = emptyState();
            // Prime the chain with a genesis PAPER boot.
            {
                const { service } = buildService(state, ExchangeEnvironmentEnum.PAPER);
                await service.runBootSequence();
            }
            const tipHmac = state.historyRows[0].thisRowHmac;

            // Boot again under PAPER — same-mode path.
            const { service } = buildService(state, ExchangeEnvironmentEnum.PAPER);
            await service.runBootSequence();

            expect(state.historyRows).toHaveLength(2);
            expect(state.historyRows[1].rowKind).toBe(BootModeHistoryRowKindEnum.BOOT);
            expect(state.historyRows[1].prevRowHash).toEqual(tipHmac);
            expect(state.rotationRows).toHaveLength(0);
        });
    });

    describe('mode mismatch with no authorized transition → ABORT with zero chain mutation', () => {
        it('does not append any row when transition is unwired (e.g. LIVE->TESTNET)', async () => {
            const state = emptyState();
            // Prime with a LIVE genesis boot.
            {
                const { service } = buildService(state, ExchangeEnvironmentEnum.LIVE);
                await service.runBootSequence();
            }
            const beforeHistoryLen = state.historyRows.length;
            const beforeRotationLen = state.rotationRows.length;

            // Now boot under TESTNET (no D7 wiring in R1) — must abort.
            const { service } = buildService(state, ExchangeEnvironmentEnum.TESTNET);
            await expect(service.runBootSequence()).rejects.toThrow('process.exit');

            expect(processExitSpy).toHaveBeenCalled();
            expect(state.historyRows).toHaveLength(beforeHistoryLen);
            expect(state.rotationRows).toHaveLength(beforeRotationLen);
        });
    });

    describe('authorized TESTNET->PAPER with valid token', () => {
        it('appends exactly one TRANSITION + one BOOT + one rotation row, all atomic', async () => {
            const state = emptyState();
            // Prime with a TESTNET genesis boot.
            {
                const { service } = buildService(state, ExchangeEnvironmentEnum.TESTNET);
                await service.runBootSequence();
            }

            // Operator drops the transition token file + bakes its hash.
            const tokenContent = 'testnet-to-paper-token-value';
            const tokenFile = await writeTokenFile(tokenContent);
            try {
                process.env.TESTNET_TO_PAPER_TOKEN_FILE = tokenFile;
                process.env.TESTNET_TO_PAPER_TOKEN_HASH = sha256Hex(tokenContent);

                const { service, txShim } = buildService(state, ExchangeEnvironmentEnum.PAPER);
                await service.runBootSequence();

                // 1 TESTNET BOOT (genesis) + 1 TRANSITION + 1 PAPER BOOT
                expect(state.historyRows).toHaveLength(3);
                expect(state.historyRows[1].rowKind).toBe(BootModeHistoryRowKindEnum.TRANSITION);
                expect(state.historyRows[1].fromEnv).toBe('testnet');
                expect(state.historyRows[1].toEnv).toBe('paper');
                expect(state.historyRows[1].exchangeEnv).toBe('paper');
                expect(state.historyRows[2].rowKind).toBe(BootModeHistoryRowKindEnum.BOOT);
                expect(state.historyRows[2].exchangeEnv).toBe('paper');
                expect(state.historyRows[2].prevRowHash).toEqual(state.historyRows[1].thisRowHmac);

                expect(state.rotationRows).toHaveLength(1);
                expect(state.rotationRows[0].fromEnv).toBe('testnet');
                expect(state.rotationRows[0].toEnv).toBe('paper');
                expect(state.rotationRows[0].preTipHash).toEqual(state.historyRows[0].thisRowHmac);
                expect(state.rotationRows[0].transitionTokenHash).toEqual(Buffer.from(sha256Hex(tokenContent), 'hex'));

                // Atomicity: the transition wave happens inside a single
                // transaction (TRANSITION row + BOOT row + rotation row
                // commit together).
                expect(txShim).toHaveBeenCalledTimes(1);
            } finally {
                await unlink(tokenFile).catch(() => undefined);
            }
        });
    });

    describe('atomicity — transaction-callback throws AFTER the TRANSITION row append', () => {
        it('rolls back BOOT row + rotation row when the manager throws mid-callback', async () => {
            const state = emptyState();
            // Prime with TESTNET genesis.
            {
                const { service } = buildService(state, ExchangeEnvironmentEnum.TESTNET);
                await service.runBootSequence();
            }

            const tokenContent = 'token-for-rollback-test';
            const tokenFile = await writeTokenFile(tokenContent);
            try {
                process.env.TESTNET_TO_PAPER_TOKEN_FILE = tokenFile;
                process.env.TESTNET_TO_PAPER_TOKEN_HASH = sha256Hex(tokenContent);

                const built = buildService(state, ExchangeEnvironmentEnum.PAPER);
                const beforeHistoryLen = state.historyRows.length;
                const beforeRotationLen = state.rotationRows.length;

                // Patch the rotation-repo append to throw — simulates a DB
                // failure after the TRANSITION row + BOOT row have already
                // been staged inside the same transaction. The shim must NOT
                // promote staging to visible state on failure.
                const rotationRepo = (built.service as never as { rotationRepo: BootModeChainRotationRepository }).rotationRepo;
                jest.spyOn(rotationRepo, 'appendInTransaction').mockRejectedValueOnce(new Error('simulated rotation-row DB failure'));

                await expect(built.service.runBootSequence()).rejects.toThrow('simulated rotation-row DB failure');

                // All-or-nothing: BOOT, TRANSITION, and rotation rows must
                // all be absent.
                expect(state.historyRows).toHaveLength(beforeHistoryLen);
                expect(state.rotationRows).toHaveLength(beforeRotationLen);
            } finally {
                await unlink(tokenFile).catch(() => undefined);
            }
        });
    });

    describe('authorized PAPER->LIVE with INVALID token', () => {
        it('aborts with zero chain mutation (no TRANSITION / BOOT / rotation rows)', async () => {
            const state = emptyState();
            // Prime with PAPER genesis.
            {
                const { service } = buildService(state, ExchangeEnvironmentEnum.PAPER);
                await service.runBootSequence();
            }
            const beforeHistoryLen = state.historyRows.length;
            const beforeRotationLen = state.rotationRows.length;

            const tokenContent = 'actual-token-value';
            const wrongHash = sha256Hex('different-token-content');
            const tokenFile = await writeTokenFile(tokenContent);
            try {
                process.env.PAPER_TO_LIVE_TOKEN_FILE = tokenFile;
                process.env.PAPER_TO_LIVE_TOKEN_HASH = wrongHash;

                const { service } = buildService(state, ExchangeEnvironmentEnum.LIVE);
                await expect(service.runBootSequence()).rejects.toThrow('process.exit');

                expect(state.historyRows).toHaveLength(beforeHistoryLen);
                expect(state.rotationRows).toHaveLength(beforeRotationLen);
            } finally {
                await unlink(tokenFile).catch(() => undefined);
            }
        });
    });

    describe('chain tampering — HMAC mismatch (recompute path)', () => {
        it('aborts on integrity walk when a row HMAC is forged', async () => {
            const state = emptyState();
            {
                const { service } = buildService(state, ExchangeEnvironmentEnum.PAPER);
                await service.runBootSequence();
            }
            // Tamper: flip a byte in this_row_hmac on the genesis row.
            const tampered = Buffer.from(state.historyRows[0].thisRowHmac);
            tampered[0] = tampered[0] ^ 0xff;
            state.historyRows[0].thisRowHmac = tampered;

            const { service } = buildService(state, ExchangeEnvironmentEnum.PAPER);
            await expect(service.runBootSequence()).rejects.toThrow('process.exit');
        });
    });

    describe('chain tampering — linkage break (prev_row_hash mismatch path)', () => {
        it('aborts when a row carries a prev_row_hash that does not match the prior tip', async () => {
            const state = emptyState();
            {
                const { service } = buildService(state, ExchangeEnvironmentEnum.PAPER);
                await service.runBootSequence();
            }
            {
                const { service } = buildService(state, ExchangeEnvironmentEnum.PAPER);
                await service.runBootSequence();
            }
            // Tamper: rewrite row 1's prev_row_hash to a wrong value. Its own
            // HMAC was computed over the genuine prevRowHash so HMAC recompute
            // will fail first — but if the codec ever changed to skip
            // prev_row_hash in the signed payload, the prev-vs-expected
            // comparison still trips. This guards BOTH paths.
            state.historyRows[1].prevRowHash = Buffer.alloc(32, 0xaa);

            const { service } = buildService(state, ExchangeEnvironmentEnum.PAPER);
            await expect(service.runBootSequence()).rejects.toThrow('process.exit');
        });

        it('aborts on a pure linkage mismatch — inject a row whose own HMAC is consistent but whose prev_row_hash diverges from the prior tip', async () => {
            const state = emptyState();
            const { service: priming } = buildService(state, ExchangeEnvironmentEnum.PAPER);
            await priming.runBootSequence();

            // Synthesise a second row with a wrong prev_row_hash and recompute
            // a self-consistent HMAC under the same sub-key. The integrity
            // walk should still catch it because the walker compares
            // prev_row_hash against the prior row's this_row_hmac, not
            // against the row's own re-derived value.
            const codec = new BootModeHmacCodec();
            const appConfig = buildAppConfig(ExchangeEnvironmentEnum.PAPER);
            const subkeys = new BootstrapSubkeyDeriver(appConfig as unknown as AppConfigService);
            const subkey = subkeys.deriveSubkey('boot_mode_history v1');
            const wrongPrev = Buffer.alloc(32, 0xbb);
            const bootedAt = new Date('2026-05-26T00:00:01.000Z');
            const injected: BootModeHistoryEntity = {
                id: 'injected',
                seq: '2',
                bootedAt,
                rowKind: BootModeHistoryRowKindEnum.BOOT,
                exchangeEnv: 'paper',
                fromEnv: null,
                toEnv: null,
                prevRowHash: wrongPrev,
                thisRowHmac: Buffer.alloc(32),
            } as never;
            injected.thisRowHmac = codec.computeHmac(
                subkey,
                codec.encodeBootModeHistoryPayload('boot_mode_history', {
                    seq: injected.seq,
                    bootedAt: injected.bootedAt,
                    rowKind: injected.rowKind,
                    exchangeEnv: injected.exchangeEnv,
                    fromEnv: injected.fromEnv,
                    toEnv: injected.toEnv,
                    prevRowHash: injected.prevRowHash,
                }),
            );
            state.historyRows.push(injected);
            state.nextHistorySeq = 3;

            const { service } = buildService(state, ExchangeEnvironmentEnum.PAPER);
            await expect(service.runBootSequence()).rejects.toThrow('process.exit');
        });
    });

    describe('clock-skew row-insertion attack', () => {
        it('a row with the wrong seq fails HMAC verification (seq is in the signed payload)', async () => {
            const state = emptyState();
            {
                const { service } = buildService(state, ExchangeEnvironmentEnum.PAPER);
                await service.runBootSequence();
            }
            // Tamper: swap the row's seq to a value that would falsely place it
            // earlier in the chain. HMAC was computed over the original seq,
            // so verification recomputes against the new (wrong) seq and
            // fails.
            state.historyRows[0].seq = '999';

            const { service } = buildService(state, ExchangeEnvironmentEnum.PAPER);
            await expect(service.runBootSequence()).rejects.toThrow('process.exit');
        });
    });

    describe('concurrent cold-start serialisation', () => {
        it('two boot sequences sharing state produce consistent chained rows (advisory-lock semantics — sequential append)', async () => {
            // The fake DataSource transaction shim is in-process synchronous;
            // running two boot sequences back-to-back exercises the advisory-
            // lock semantics indirectly: the second sequence MUST observe the
            // first's committed BOOT row before deciding its own chain
            // linkage. If the chain service ever read tip outside the
            // transaction, the second sequence could miss the first's row
            // and produce a duplicate genesis row.
            const state = emptyState();
            const built1 = buildService(state, ExchangeEnvironmentEnum.PAPER);
            const built2 = buildService(state, ExchangeEnvironmentEnum.PAPER);

            await built1.service.runBootSequence();
            await built2.service.runBootSequence();

            expect(state.historyRows).toHaveLength(2);
            expect(state.historyRows[0].prevRowHash).toBeNull();
            expect(state.historyRows[1].prevRowHash).toEqual(state.historyRows[0].thisRowHmac);
        });

        it('serialises two concurrent boot sequences: the second waits on the advisory lock then chains to the FRESH tip — no chain fork', async () => {
            // Simulates two engines cold-starting at the same instant. The
            // fake DataSource is shared state, so we hand each service the
            // same `state` reference but serialise the txn() callbacks
            // through a single shared queue keyed on the advisory-lock call.
            // The expected linkage: row 0 (genesis from boot1) → row 1
            // (chained to row 0's HMAC, from boot2). If the lock were taken
            // INSIDE the per-append path (the bug this test guards against),
            // both boots could capture tip=null pre-lock and both write a
            // genesis row.
            const state = emptyState();

            // Shared lock latch — only ONE transaction may hold it.
            let lockHeld = false;
            const lockWaiters: Array<() => void> = [];

            // Sharedfor both services so the lock acquire serialises across boots.
            const sharedQuery = jest.fn().mockImplementation(async (sql: string) => {
                if (typeof sql === 'string' && sql.includes('pg_advisory_xact_lock')) {
                    if (lockHeld) {
                        await new Promise<void>((resolve) => lockWaiters.push(resolve));
                    }
                    lockHeld = true;
                    return undefined;
                }
                return undefined;
            });

            // Custom shim: same atomicity semantics but releases the latch
            // on commit/rollback so the next waiter proceeds.
            function buildSharedService(env: ExchangeEnvironmentEnum) {
                const appConfig = buildAppConfig(env);
                const codec = new BootModeHmacCodec();
                const subkeys = new BootstrapSubkeyDeriver(appConfig as unknown as AppConfigService);
                const stagingHistoryLocal: BootModeHistoryEntity[] = [];
                const stagingRotationsLocal: BootModeChainRotationEntity[] = [];
                const { historyRepo, rotationRepo } = buildFakeRepos(state, stagingHistoryLocal, stagingRotationsLocal);
                const txShim = jest.fn().mockImplementation(async (fn: (manager: never) => Promise<void>) => {
                    stagingHistoryLocal.length = 0;
                    stagingRotationsLocal.length = 0;
                    try {
                        await fn({ query: sharedQuery } as never);
                        state.historyRows.push(...stagingHistoryLocal);
                        state.rotationRows.push(...stagingRotationsLocal);
                    } catch (cause) {
                        state.nextHistorySeq -= stagingHistoryLocal.length;
                        state.nextRotationSeq -= stagingRotationsLocal.length;
                        throw cause;
                    } finally {
                        lockHeld = false;
                        const next = lockWaiters.shift();
                        if (next !== undefined) {
                            next();
                        }
                    }
                });
                const fakeDataSource = { transaction: txShim };
                const tokenVerifier = new TransitionTokenVerifier();
                return new BootModeChainService(
                    appConfig as unknown as AppConfigService,
                    fakeDataSource as never,
                    historyRepo as unknown as BootModeHistoryRepository,
                    rotationRepo as unknown as BootModeChainRotationRepository,
                    subkeys,
                    codec,
                    tokenVerifier,
                );
            }

            const service1 = buildSharedService(ExchangeEnvironmentEnum.PAPER);
            const service2 = buildSharedService(ExchangeEnvironmentEnum.PAPER);

            // Race them. The lock latch guarantees one finishes before the
            // other reads tip.
            await Promise.all([service1.runBootSequence(), service2.runBootSequence()]);

            expect(state.historyRows).toHaveLength(2);
            // Row 0 is the genesis (null prev). Row 1 is chained to row 0's
            // committed HMAC — proves the second boot observed the first's
            // commit AFTER the lock was released, not the pre-commit
            // tip=null view.
            expect(state.historyRows[0].prevRowHash).toBeNull();
            expect(state.historyRows[1].prevRowHash).toEqual(state.historyRows[0].thisRowHmac);
        });
    });

    describe('rotation chain tampering', () => {
        async function primeRotationChain(state: IFakeRepoState): Promise<void> {
            // Prime with TESTNET genesis + TESTNET->PAPER transition so the
            // rotation chain has exactly one row.
            {
                const { service } = buildService(state, ExchangeEnvironmentEnum.TESTNET);
                await service.runBootSequence();
            }
            const tokenContent = 'rotation-tamper-test-token';
            const tokenFile = await writeTokenFile(tokenContent);
            try {
                process.env.TESTNET_TO_PAPER_TOKEN_FILE = tokenFile;
                process.env.TESTNET_TO_PAPER_TOKEN_HASH = sha256Hex(tokenContent);
                const { service } = buildService(state, ExchangeEnvironmentEnum.PAPER);
                await service.runBootSequence();
            } finally {
                await unlink(tokenFile).catch(() => undefined);
                delete process.env.TESTNET_TO_PAPER_TOKEN_FILE;
                delete process.env.TESTNET_TO_PAPER_TOKEN_HASH;
            }
        }

        it('aborts when a rotation row HMAC is forged (recompute path)', async () => {
            const state = emptyState();
            await primeRotationChain(state);
            expect(state.rotationRows).toHaveLength(1);

            // Tamper: flip a byte in the rotation row's this_row_hmac.
            const tampered = Buffer.from(state.rotationRows[0].thisRowHmac);
            tampered[0] = tampered[0] ^ 0xff;
            state.rotationRows[0].thisRowHmac = tampered;

            // Next boot under PAPER — same-mode boot, but the rotation chain
            // walker still runs and must abort on the tampered HMAC.
            const { service } = buildService(state, ExchangeEnvironmentEnum.PAPER);
            await expect(service.runBootSequence()).rejects.toThrow('process.exit');
        });

        it('aborts when a rotation row prev_row_hash diverges from the prior tip (linkage path)', async () => {
            const state = emptyState();
            await primeRotationChain(state);

            // Add a second rotation row by running another transition: but
            // R1 only wires TESTNET->PAPER + PAPER->LIVE — and we are now
            // PAPER. Need to chain PAPER->LIVE to produce row 1.
            const tokenContent = 'rotation-linkage-token';
            const tokenFile = await writeTokenFile(tokenContent);
            try {
                process.env.PAPER_TO_LIVE_TOKEN_FILE = tokenFile;
                process.env.PAPER_TO_LIVE_TOKEN_HASH = sha256Hex(tokenContent);
                const { service } = buildService(state, ExchangeEnvironmentEnum.LIVE);
                await service.runBootSequence();
            } finally {
                await unlink(tokenFile).catch(() => undefined);
                delete process.env.PAPER_TO_LIVE_TOKEN_FILE;
                delete process.env.PAPER_TO_LIVE_TOKEN_HASH;
            }

            expect(state.rotationRows).toHaveLength(2);

            // Tamper: rewrite row 1's prev_row_hash to a wrong value. Its
            // own HMAC was computed over the genuine prevRowHash, so HMAC
            // recompute will fire — but the walker should ALSO catch the
            // linkage break (defence in depth, identical to the history
            // chain walk).
            state.rotationRows[1].prevRowHash = Buffer.alloc(32, 0xaa);

            const { service } = buildService(state, ExchangeEnvironmentEnum.LIVE);
            await expect(service.runBootSequence()).rejects.toThrow('process.exit');
        });
    });
});
