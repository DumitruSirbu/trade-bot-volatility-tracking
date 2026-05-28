/**
 * Adversarial tests for PaperAccountStateService (ADR 0032 §D6 / §D16).
 *
 * Covers:
 *   - openPosition writes the open-state row + audit row atomically.
 *   - A throw mid-transaction rolls back ALL writes (no audit row, no state
 *     row, no in-memory mutation).
 *   - closePosition writes the history row + delete + audit row atomically.
 *   - Duplicate clientOrderId on openPosition returns the existing row
 *     verbatim with NO second audit row.
 *   - PAPER_STARTING_EQUITY pin on fresh boot: balance + peakEquity ==
 *     PAPER_STARTING_EQUITY_USDT after hydrateOnBoot's META_INIT branch.
 *   - Drawdown abort boundary: equity = peak * 0.85 trips; equity =
 *     peak * 0.85001 does not (Decimal-precise; no float drift).
 *   - Simulator config hash mismatch on boot: throws
 *     PaperAccountStateBootException; refuses to set initial state.
 *
 * Atomicity strategy:
 *   The shim mirrors BootModeChainService.adversarial.spec.ts —
 *   `dataSource.transaction(fn)` is a jest.fn that promotes staging arrays
 *   into the visible store on success and discards them on throw. That gives
 *   a high-fidelity DB-atomicity test without a live Postgres process; the
 *   tests pass byte-equivalent to the real DataSource boundary for the
 *   commit-on-success / discard-on-throw semantics we are asserting.
 *   Documented choice — the M2/M6 migration-roundtrip tests cover real
 *   Postgres atomicity orthogonally.
 */

import { PositionSideEnum } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomUUID } from 'node:crypto';

import { BootstrapSubkeyDeriver } from '../../boot-mode-history/service/BootstrapSubkeyDeriver';
import { AppConfigService } from '../../config/service';
import { Money, parseMoney } from '../../common/utils';
import { PaperAccountSnapshotEntity } from '../entity/PaperAccountSnapshotEntity';
import { PaperAccountStateEntity } from '../entity/PaperAccountStateEntity';
import { PaperAccountStateHistoryEntity } from '../entity/PaperAccountStateHistoryEntity';
import { PaperAccountStateMetaEntity } from '../entity/PaperAccountStateMetaEntity';
import { PaperStateAuditEntity } from '../entity/PaperStateAuditEntity';
import { MutationKindEnum, PaperCloseReasonEnum, SubjectKindEnum } from '../enum';
import { PaperAccountStateBootException, PaperPositionNotFoundException } from '../exception';
import { PAPER_MARK_TO_MARKET_EVENT, IPaperMarkToMarketEvent } from '../service/PaperAccountStateService';
import { PaperAccountSnapshotRepository } from '../repository/PaperAccountSnapshotRepository';
import { PaperAccountStateHistoryRepository } from '../repository/PaperAccountStateHistoryRepository';
import { PaperAccountStateMetaRepository } from '../repository/PaperAccountStateMetaRepository';
import { PaperAccountStateRepository } from '../repository/PaperAccountStateRepository';
import { PaperStateAuditRepository } from '../repository/PaperStateAuditRepository';
import { PaperAccountStateService } from '../service/PaperAccountStateService';
import { PaperStateAuditHmacCodec } from '../service/PaperStateAuditHmacCodec';

const BOOTSTRAP_SECRET = 'a'.repeat(64);
const STARTING_EQUITY = 500;

interface IFakeStore {
    state: PaperAccountStateEntity[];
    history: PaperAccountStateHistoryEntity[];
    meta: PaperAccountStateMetaEntity[];
    snapshots: PaperAccountSnapshotEntity[];
    audit: PaperStateAuditEntity[];
    nextAuditSeq: number;
}

function emptyStore(): IFakeStore {
    return { state: [], history: [], meta: [], snapshots: [], audit: [], nextAuditSeq: 1 };
}

function buildFakeRepos(
    store: IFakeStore,
    stagingAudit: PaperStateAuditEntity[],
    stagingMeta: PaperAccountStateMetaEntity[],
    stagingState: PaperAccountStateEntity[],
    stagingHistory: PaperAccountStateHistoryEntity[],
    stagingSnap: PaperAccountSnapshotEntity[],
) {
    const stateRepo: Pick<PaperAccountStateRepository, 'findByClientOrderId' | 'findOpenBySymbol' | 'findAllOpen' | 'insertNew' | 'deleteByClientOrderId'> = {
        findByClientOrderId: jest.fn(async (clientOrderId: string) => {
            const merged = [...store.state, ...stagingState];
            return merged.find((r) => r.clientOrderId === clientOrderId) ?? null;
        }),
        findOpenBySymbol: jest.fn(async () => []),
        findAllOpen: jest.fn(async () => [...store.state, ...stagingState]),
        insertNew: jest.fn(async (draft) => {
            const entity = {
                id: randomUUID(),
                createdAt: new Date(),
                updatedAt: new Date(),
                mode: 'paper',
                ...draft,
            } as PaperAccountStateEntity;
            stagingState.push(entity);
            return entity;
        }),
        deleteByClientOrderId: jest.fn(async (clientOrderId: string) => {
            // Remove from staging or committed (both — semantics: "by close
            // commit the deletion is observable").
            const idxStaged = stagingState.findIndex((r) => r.clientOrderId === clientOrderId);
            if (idxStaged >= 0) stagingState.splice(idxStaged, 1);
            const idxStore = store.state.findIndex((r) => r.clientOrderId === clientOrderId);
            // Move the committed row INTO a staging "to-delete" by recording
            // the index; cleanest fake: copy + flag for rollback. For our
            // tests, closePosition's caller has the row OPEN before the
            // transaction starts so it's always committed; on rollback we
            // restore it.
            if (idxStore >= 0) {
                const row = store.state.splice(idxStore, 1)[0];
                const marked = row as PaperAccountStateEntity & { __toRestore?: true };
                marked.__toRestore = true;
                stagingState.push(marked);
            }
        }),
    };

    const historyRepo: Pick<PaperAccountStateHistoryRepository, 'appendClose' | 'findClosedBetween' | 'findByClientOrderId'> = {
        appendClose: jest.fn(async (draft) => {
            const entity = {
                id: randomUUID(),
                createdAt: new Date(),
                mode: 'paper',
                ...draft,
            } as PaperAccountStateHistoryEntity;
            stagingHistory.push(entity);
            return entity;
        }),
        findClosedBetween: jest.fn(async () => []),
        findByClientOrderId: jest.fn(async () => []),
    };

    const metaRepo: Pick<PaperAccountStateMetaRepository, 'findBySoakStartId' | 'findLatest' | 'insertNew'> = {
        findBySoakStartId: jest.fn(async () => null),
        findLatest: jest.fn(async () => {
            const merged = [...store.meta, ...stagingMeta];
            if (merged.length === 0) return null;
            return [...merged].sort((a, b) => b.soakStartTs.getTime() - a.soakStartTs.getTime())[0];
        }),
        insertNew: jest.fn(async (draft) => {
            const entity = {
                id: randomUUID(),
                createdAt: new Date(),
                updatedAt: new Date(),
                ...draft,
            } as PaperAccountStateMetaEntity;
            stagingMeta.push(entity);
            return entity;
        }),
    };

    const snapshotRepo: Pick<PaperAccountSnapshotRepository, 'insertNew' | 'findLatest' | 'findTakenBetween'> = {
        insertNew: jest.fn(async (draft) => {
            const entity = {
                id: randomUUID(),
                createdAt: new Date(),
                mode: 'paper',
                ...draft,
            } as PaperAccountSnapshotEntity;
            stagingSnap.push(entity);
            return entity;
        }),
        findLatest: jest.fn(async () => {
            const merged = [...store.snapshots, ...stagingSnap];
            if (merged.length === 0) return null;
            return [...merged].sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime())[0];
        }),
        findTakenBetween: jest.fn(async () => []),
    };

    const auditRepo: Pick<PaperStateAuditRepository, 'findTip' | 'findOrderedAll' | 'findBySubject' | 'appendInTransaction'> = {
        findTip: jest.fn(async () => {
            const merged = [...store.audit, ...stagingAudit];
            if (merged.length === 0) return null;
            return [...merged].sort((a, b) => Number(b.seq) - Number(a.seq))[0];
        }),
        findOrderedAll: jest.fn(async () => [...store.audit, ...stagingAudit].sort((a, b) => Number(a.seq) - Number(b.seq))),
        findBySubject: jest.fn(async (subjectKind: SubjectKindEnum, subjectId: string) => {
            return [...store.audit, ...stagingAudit].filter((r) => r.subjectKind === subjectKind && r.subjectId === subjectId);
        }),
        appendInTransaction: jest.fn(async (_manager, params) => {
            const seq = String(store.nextAuditSeq++);
            const recordedAt = new Date();
            const draft: PaperStateAuditEntity = {
                id: randomUUID(),
                seq,
                recordedAt,
                mutationKind: params.mutationKind,
                subjectKind: params.subjectKind,
                subjectId: params.subjectId,
                payloadHash: params.payloadHash,
                prevRowHash: params.prevRowHash,
                thisRowHmac: Buffer.alloc(32, 0xff),
            };
            draft.thisRowHmac = params.computeHmac({
                seq,
                recordedAt,
                mutationKind: draft.mutationKind,
                subjectKind: draft.subjectKind,
                subjectId: draft.subjectId,
                payloadHash: draft.payloadHash,
                prevRowHash: draft.prevRowHash,
            });
            stagingAudit.push(draft);
            return draft;
        }),
    };

    return { stateRepo, historyRepo, metaRepo, snapshotRepo, auditRepo };
}

function buildAppConfig(overrides: Partial<AppConfigService> = {}): AppConfigService {
    return {
        authBootstrapSecret: BOOTSTRAP_SECRET,
        paperStartingEquityUsdt: STARTING_EQUITY,
        ...overrides,
    } as unknown as AppConfigService;
}

interface IBuilt {
    service: PaperAccountStateService;
    store: IFakeStore;
    txShim: jest.Mock;
    emitter: EventEmitter2;
}

function buildService(store: IFakeStore = emptyStore(), appConfig: AppConfigService = buildAppConfig()): IBuilt {
    const stagingAudit: PaperStateAuditEntity[] = [];
    const stagingMeta: PaperAccountStateMetaEntity[] = [];
    const stagingState: PaperAccountStateEntity[] = [];
    const stagingHistory: PaperAccountStateHistoryEntity[] = [];
    const stagingSnap: PaperAccountSnapshotEntity[] = [];

    const { stateRepo, historyRepo, metaRepo, snapshotRepo, auditRepo } = buildFakeRepos(
        store,
        stagingAudit,
        stagingMeta,
        stagingState,
        stagingHistory,
        stagingSnap,
    );

    const txShim = jest.fn().mockImplementation(async (fn: (manager: never) => Promise<unknown>) => {
        // Reset staging at the start of every transaction so a failed
        // attempt's rows never leak forward.
        stagingAudit.length = 0;
        stagingMeta.length = 0;
        stagingState.length = 0;
        stagingHistory.length = 0;
        stagingSnap.length = 0;

        try {
            const result = await fn({ query: jest.fn().mockResolvedValue(undefined) } as never);
            // Success: promote staging into the visible store.
            store.audit.push(...stagingAudit);
            store.meta.push(...stagingMeta);
            for (const row of stagingState as Array<PaperAccountStateEntity & { __toRestore?: true }>) {
                if (row.__toRestore === true) {
                    // The "to-restore" rows are committed deletions — they
                    // stay out of the visible store on success.
                    delete row.__toRestore;
                    continue;
                }
                store.state.push(row);
            }
            store.history.push(...stagingHistory);
            store.snapshots.push(...stagingSnap);

            return result;
        } catch (cause) {
            // Rollback: discard staging. Restore any committed-row deletions
            // that the failed transaction had staged (the "__toRestore"
            // markers were carried in stagingState).
            store.nextAuditSeq -= stagingAudit.length;
            for (const row of stagingState as Array<PaperAccountStateEntity & { __toRestore?: true }>) {
                if (row.__toRestore === true) {
                    delete row.__toRestore;
                    store.state.push(row);
                }
            }

            throw cause;
        }
    });

    const fakeDataSource = { transaction: txShim };
    const subkeys = new BootstrapSubkeyDeriver(appConfig);
    const codec = new PaperStateAuditHmacCodec();
    const emitter = new EventEmitter2();

    const service = new PaperAccountStateService(
        appConfig,
        fakeDataSource as never,
        stateRepo as unknown as PaperAccountStateRepository,
        historyRepo as unknown as PaperAccountStateHistoryRepository,
        metaRepo as unknown as PaperAccountStateMetaRepository,
        snapshotRepo as unknown as PaperAccountSnapshotRepository,
        auditRepo as unknown as PaperStateAuditRepository,
        subkeys,
        codec,
        emitter,
    );

    return { service, store, txShim, emitter };
}

describe('PaperAccountStateService — atomicity', () => {
    describe('fresh boot — META_INIT branch', () => {
        it('seeds balance + peakEquity to PAPER_STARTING_EQUITY_USDT and writes one META_INIT audit row', async () => {
            const { service, store } = buildService();

            await service.onApplicationBootstrap();

            expect(store.meta).toHaveLength(1);
            expect(store.audit).toHaveLength(1);
            expect(store.audit[0].mutationKind).toBe(MutationKindEnum.META_INIT);
            expect(store.audit[0].subjectKind).toBe(SubjectKindEnum.PAPER_ACCOUNT_STATE_META);

            const balance = service.getBalance();
            expect(balance.balanceUsdt.toFixed()).toBe('500');
            expect(balance.peakEquity.toFixed()).toBe('500');
            expect(balance.realisedPnlCumulative.toFixed()).toBe('0');
            expect(balance.fundingAccruedCumulative.toFixed()).toBe('0');
        });
    });

    describe('openPosition — atomic three-write', () => {
        it('commits state row + audit row in a single transaction', async () => {
            const { service, store } = buildService();
            await service.onApplicationBootstrap();
            const auditBefore = store.audit.length;
            const stateBefore = store.state.length;

            await service.openPosition({
                clientOrderId: 'tbvt-open-1',
                symbol: 'BTCUSDT',
                side: PositionSideEnum.LONG,
                entryPrice: parseMoney('30000'),
                size: parseMoney('0.01'),
                leverage: 5,
                openedAt: new Date('2026-06-01T00:00:00Z'),
            });

            expect(store.state).toHaveLength(stateBefore + 1);
            expect(store.audit).toHaveLength(auditBefore + 1);
            expect(store.audit[store.audit.length - 1].mutationKind).toBe(MutationKindEnum.OPEN_POSITION);

            const positions = service.getOpenPositions();
            expect(positions).toHaveLength(1);
            expect(positions[0].clientOrderId).toBe('tbvt-open-1');
        });

        it('rolls back ALL writes (state, audit, in-memory) when the transaction body throws', async () => {
            const { service, store } = buildService();
            await service.onApplicationBootstrap();
            const auditBefore = store.audit.length;
            const stateBefore = store.state.length;

            // Force the audit append to throw — simulates a CHECK constraint
            // violation or a network blip mid-transaction.
            const auditRepoSpy = jest.spyOn((service as unknown as { auditRepo: PaperStateAuditRepository }).auditRepo, 'appendInTransaction');
            auditRepoSpy.mockRejectedValueOnce(new Error('simulated audit-append failure'));

            await expect(
                service.openPosition({
                    clientOrderId: 'tbvt-open-2',
                    symbol: 'BTCUSDT',
                    side: PositionSideEnum.LONG,
                    entryPrice: parseMoney('30000'),
                    size: parseMoney('0.01'),
                    leverage: 5,
                    openedAt: new Date('2026-06-01T00:01:00Z'),
                }),
            ).rejects.toThrow('simulated audit-append failure');

            expect(store.state).toHaveLength(stateBefore);
            expect(store.audit).toHaveLength(auditBefore);
            expect(service.getOpenPositions()).toHaveLength(0);
        });

        it('duplicate clientOrderId returns existing row verbatim with NO second audit row', async () => {
            const { service, store } = buildService();
            await service.onApplicationBootstrap();

            const first = await service.openPosition({
                clientOrderId: 'tbvt-dup',
                symbol: 'BTCUSDT',
                side: PositionSideEnum.LONG,
                entryPrice: parseMoney('30000'),
                size: parseMoney('0.01'),
                leverage: 5,
                openedAt: new Date('2026-06-01T00:00:00Z'),
            });

            const auditAfterFirst = store.audit.length;
            const stateAfterFirst = store.state.length;

            const second = await service.openPosition({
                clientOrderId: 'tbvt-dup',
                symbol: 'BTCUSDT',
                side: PositionSideEnum.LONG,
                entryPrice: parseMoney('30000'),
                size: parseMoney('0.01'),
                leverage: 5,
                openedAt: new Date('2026-06-01T00:00:00Z'),
            });

            expect(second.id).toBe(first.id);
            expect(store.audit).toHaveLength(auditAfterFirst);
            expect(store.state).toHaveLength(stateAfterFirst);
        });
    });

    describe('closePosition — atomic three-write', () => {
        it('appends history + deletes state + writes audit row in one transaction', async () => {
            const { service, store } = buildService();
            await service.onApplicationBootstrap();

            await service.openPosition({
                clientOrderId: 'tbvt-close-1',
                symbol: 'BTCUSDT',
                side: PositionSideEnum.LONG,
                entryPrice: parseMoney('30000'),
                size: parseMoney('0.01'),
                leverage: 5,
                openedAt: new Date('2026-06-01T00:00:00Z'),
            });

            const auditBefore = store.audit.length;
            const stateBefore = store.state.length;
            const historyBefore = store.history.length;

            const closed = await service.closePosition({
                clientOrderId: 'tbvt-close-1',
                exitPrice: parseMoney('30100'),
                closedAt: new Date('2026-06-01T01:00:00Z'),
                closeReason: PaperCloseReasonEnum.TP,
            });

            expect(closed.realisedPnl.toFixed()).toBe('1'); // (30100-30000)*0.01*1 = 1
            expect(store.state).toHaveLength(stateBefore - 1);
            expect(store.history).toHaveLength(historyBefore + 1);
            expect(store.audit).toHaveLength(auditBefore + 1);
            expect(store.audit[store.audit.length - 1].mutationKind).toBe(MutationKindEnum.CLOSE_POSITION);

            expect(service.getOpenPositions()).toHaveLength(0);
            expect(service.getRealisedPnlCumulative().toFixed()).toBe('1');
        });
    });

    describe('drawdown abort boundary (Decimal-precise)', () => {
        it('equity = peak * 0.85 trips abort', async () => {
            const { service } = buildService();
            await service.onApplicationBootstrap();

            // peakEquity = 500 (META_INIT). 500 * 0.85 = 425 exactly.
            const equityAtBoundary = parseMoney('425');
            expect(service.evaluateDrawdownAbort(equityAtBoundary)).toBe(true);
        });

        it('equity = peak * 0.85001 does NOT trip abort', async () => {
            const { service } = buildService();
            await service.onApplicationBootstrap();

            // 500 * 0.85001 = 425.005 — above the 425 threshold.
            const equityJustAbove = parseMoney('425.005');
            expect(service.evaluateDrawdownAbort(equityJustAbove)).toBe(false);
        });
    });

    describe('simulator config hash mismatch', () => {
        it('refuses to start when the persisted hash differs from the current build', async () => {
            const store = emptyStore();
            // Pre-seed a meta row with a bogus hash so hydrateOnBoot's
            // validateMetaOrThrow branch fires.
            const stale: PaperAccountStateMetaEntity = {
                id: randomUUID(),
                soakStartId: randomUUID(),
                soakStartTs: new Date('2026-05-01T00:00:00Z'),
                seedVersionLabel: 'paper_simulator_seed v1',
                hkdfInfoVersion: 'v1',
                simulatorConfigHash: 'deadbeef'.repeat(8),
                bootstrapAtStartFingerprint: '00'.repeat(32),
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            store.meta.push(stale);

            const { service } = buildService(store);

            await expect(service.onApplicationBootstrap()).rejects.toBeInstanceOf(PaperAccountStateBootException);
        });
    });

    describe('recompute helpers', () => {
        it('recomputeUnrealisedPnl returns 0 when no marks provided', async () => {
            const { service } = buildService();
            await service.onApplicationBootstrap();
            await service.openPosition({
                clientOrderId: 'tbvt-mtm-1',
                symbol: 'BTCUSDT',
                side: PositionSideEnum.LONG,
                entryPrice: parseMoney('30000'),
                size: parseMoney('0.01'),
                leverage: 5,
                openedAt: new Date(),
            });

            const total = service.recomputeUnrealisedPnl(new Map());
            expect(total.toFixed()).toBe('0');
        });

        it('recomputeUnrealisedPnl computes (mark-entry)*size*side for long', async () => {
            const { service } = buildService();
            await service.onApplicationBootstrap();
            await service.openPosition({
                clientOrderId: 'tbvt-mtm-2',
                symbol: 'BTCUSDT',
                side: PositionSideEnum.LONG,
                entryPrice: parseMoney('30000'),
                size: parseMoney('0.01'),
                leverage: 5,
                openedAt: new Date(),
            });

            const marks = new Map([['BTCUSDT', parseMoney('30100')]]);
            const total = service.recomputeUnrealisedPnl(marks);
            expect(total.toFixed()).toBe('1');
        });

        it('recomputeUnrealisedPnl negates the delta for short', async () => {
            const { service } = buildService();
            await service.onApplicationBootstrap();
            await service.openPosition({
                clientOrderId: 'tbvt-mtm-3',
                symbol: 'BTCUSDT',
                side: PositionSideEnum.SHORT,
                entryPrice: parseMoney('30000'),
                size: parseMoney('0.01'),
                leverage: 5,
                openedAt: new Date(),
            });

            const marks = new Map([['BTCUSDT', parseMoney('30100')]]);
            const total = service.recomputeUnrealisedPnl(marks);
            expect(total.toFixed()).toBe('-1');
        });
    });

    describe('R2b-fix Item 2 — drawdown threshold is Decimal-precise', () => {
        it('trips at a non-binary-exact boundary (peak * 0.85 with peak = 73)', async () => {
            // 73 * 0.85 = 62.05 — has no exact binary float representation;
            // a float subtraction (1 - 0.15) leaks into the threshold and
            // mis-evaluates the boundary. Pinned here so the constant
            // change ever regresses to float math is caught.
            const { service } = buildService();
            await service.onApplicationBootstrap();
            (service as unknown as { peakEquity: ReturnType<typeof parseMoney> }).peakEquity = parseMoney('73');

            expect(service.evaluateDrawdownAbort(parseMoney('62.05'))).toBe(true);
            expect(service.evaluateDrawdownAbort(parseMoney('62.0500000001'))).toBe(false);
        });
    });

    describe('R2b-fix Item 3 — orphan-state boot guard', () => {
        it('throws PaperAccountStateBootException when meta is empty but paper_account_state has rows', async () => {
            const store = emptyStore();
            store.state.push({
                id: randomUUID(),
                clientOrderId: 'orphan-1',
                symbol: 'BTCUSDT',
                side: 'long',
                entryPrice: parseMoney('30000'),
                size: parseMoney('0.01'),
                leverage: 5,
                openedAt: new Date('2026-06-01T00:00:00Z'),
                mode: 'paper',
                createdAt: new Date(),
                updatedAt: new Date(),
            } as unknown as PaperAccountStateEntity);

            const { service } = buildService(store);

            const error = await service.onApplicationBootstrap().catch((cause) => cause);
            expect(error).toBeInstanceOf(PaperAccountStateBootException);
            expect((error as Error).message).toMatch(/paper_account_state/);
        });

        it('throws when meta is empty but paper_account_snapshots has rows', async () => {
            const store = emptyStore();
            store.snapshots.push({
                id: randomUUID(),
                takenAt: new Date('2026-06-01T00:00:00Z'),
                balance: parseMoney('500'),
                equity: parseMoney('500'),
                realisedPnlCumulative: parseMoney('0'),
                fundingAccruedCumulative: parseMoney('0'),
                unrealisedPnlTotal: parseMoney('0'),
                peakEquity: parseMoney('500'),
                openPositionsCount: 0,
                mode: 'paper',
                createdAt: new Date(),
            } as unknown as PaperAccountSnapshotEntity);

            const { service } = buildService(store);

            const error = await service.onApplicationBootstrap().catch((cause) => cause);
            expect(error).toBeInstanceOf(PaperAccountStateBootException);
            expect((error as Error).message).toMatch(/paper_account_snapshots/);
        });

        it('initialises fresh meta normally when meta + state + snapshots are all empty', async () => {
            const { service, store } = buildService();
            await service.onApplicationBootstrap();
            expect(store.meta).toHaveLength(1);
        });
    });

    describe('R2b-fix Item 4 — warm restart without snapshot but with positions', () => {
        it('resets peak_equity to PAPER_STARTING_EQUITY_USDT and zeros cumulatives + WARNs', async () => {
            const store = emptyStore();
            // Pre-existing meta (so we hit the restoreFromPersisted branch,
            // not the orphan guard).
            store.meta.push({
                id: randomUUID(),
                soakStartId: randomUUID(),
                soakStartTs: new Date('2026-05-01T00:00:00Z'),
                seedVersionLabel: 'paper_simulator_seed v1',
                hkdfInfoVersion: 'v1',
                // Hash MUST match the service's computed sentinel hash so
                // validateMetaOrThrow passes. The sentinel is stable across
                // boots so we compute it the same way here.
                simulatorConfigHash: createHash('sha256')
                    .update(Buffer.from('paper_simulator_config_hash:R2b-pending-architect-adjudication', 'utf8'))
                    .digest('hex'),
                bootstrapAtStartFingerprint: '00'.repeat(32),
                createdAt: new Date(),
                updatedAt: new Date(),
            } as unknown as PaperAccountStateMetaEntity);
            store.state.push({
                id: randomUUID(),
                clientOrderId: 'warm-1',
                symbol: 'BTCUSDT',
                side: 'long',
                entryPrice: parseMoney('30000'),
                size: parseMoney('0.01'),
                leverage: 5,
                openedAt: new Date('2026-06-01T00:00:00Z'),
                mode: 'paper',
                createdAt: new Date(),
                updatedAt: new Date(),
            } as unknown as PaperAccountStateEntity);

            const { service } = buildService(store);
            const warnSpy = jest.spyOn((service as unknown as { logger: { warn: jest.Mock } }).logger, 'warn');

            await service.onApplicationBootstrap();

            const bal = service.getBalance();
            expect(bal.peakEquity.toFixed()).toBe('500');
            expect(bal.balanceUsdt.toFixed()).toBe('500');
            expect(bal.realisedPnlCumulative.toFixed()).toBe('0');
            expect(bal.fundingAccruedCumulative.toFixed()).toBe('0');
            expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/persisted open position.*no paper_account_snapshots/));
        });
    });

    describe('R2b-fix Item 5 — closePosition convergent fixes', () => {
        it('defaults fundingAccrued to the in-memory position value when input.fundingAccrued is undefined', async () => {
            const { service, store } = buildService();
            await service.onApplicationBootstrap();

            await service.openPosition({
                clientOrderId: 'fund-default-1',
                symbol: 'BTCUSDT',
                side: PositionSideEnum.LONG,
                entryPrice: parseMoney('30000'),
                size: parseMoney('0.01'),
                leverage: 5,
                openedAt: new Date('2026-06-01T00:00:00Z'),
            });

            await service.applyFunding({
                clientOrderId: 'fund-default-1',
                symbol: 'BTCUSDT',
                fundingTs: new Date('2026-06-01T00:30:00Z'),
                fundingAmountUsdt: parseMoney('0.5'),
            });

            const closed = await service.closePosition({
                clientOrderId: 'fund-default-1',
                exitPrice: parseMoney('30100'),
                closedAt: new Date('2026-06-01T01:00:00Z'),
                closeReason: PaperCloseReasonEnum.TP,
                // fundingAccrued intentionally omitted
            });

            // History row should carry the in-memory accrued amount.
            expect(closed.fundingAccrued.toFixed()).toBe('0.5');
            expect(store.history[0].fundingAccrued.toFixed()).toBe('0.5');
            // Balance updated with funding included: 500 + (1 - 0) + 0.5 = 501.5
            expect(service.getBalance().balanceUsdt.toFixed()).toBe('501.5');
        });

        it('throws PaperPositionNotFoundException when no open position matches', async () => {
            const { service } = buildService();
            await service.onApplicationBootstrap();

            await expect(
                service.closePosition({
                    clientOrderId: 'no-such-position',
                    exitPrice: parseMoney('30000'),
                    closedAt: new Date(),
                    closeReason: PaperCloseReasonEnum.SL,
                }),
            ).rejects.toBeInstanceOf(PaperPositionNotFoundException);
        });

        it('settles balance as realised - fees + fundingAccrued (D4 inclusive form)', async () => {
            const { service } = buildService();
            await service.onApplicationBootstrap();

            await service.openPosition({
                clientOrderId: 'settle-1',
                symbol: 'BTCUSDT',
                side: PositionSideEnum.LONG,
                entryPrice: parseMoney('30000'),
                size: parseMoney('0.01'),
                leverage: 5,
                openedAt: new Date('2026-06-01T00:00:00Z'),
            });

            await service.closePosition({
                clientOrderId: 'settle-1',
                exitPrice: parseMoney('30100'),
                closedAt: new Date('2026-06-01T01:00:00Z'),
                closeReason: PaperCloseReasonEnum.TP,
                fees: parseMoney('0.1'),
                fundingAccrued: parseMoney('0.25'),
            });

            // realised = (30100-30000)*0.01 = 1. balance = 500 + 1 - 0.1 + 0.25 = 501.15
            expect(service.getBalance().balanceUsdt.toFixed()).toBe('501.15');
        });
    });

    describe('R2b-fix Item 5 — flushMtmForSymbol uses last-mark cache across all positions', () => {
        it('computes equity using the cached mark for every held symbol when ticking one of them', async () => {
            const { service, emitter } = buildService();
            await service.onApplicationBootstrap();

            await service.openPosition({
                clientOrderId: 'mtm-btc',
                symbol: 'BTCUSDT',
                side: PositionSideEnum.LONG,
                entryPrice: parseMoney('30000'),
                size: parseMoney('0.01'),
                leverage: 5,
                openedAt: new Date(),
            });
            await service.openPosition({
                clientOrderId: 'mtm-eth',
                symbol: 'ETHUSDT',
                side: PositionSideEnum.LONG,
                entryPrice: parseMoney('2000'),
                size: parseMoney('0.1'),
                leverage: 5,
                openedAt: new Date(),
            });

            // Warm the ETH cache via notifyMarkPrice (then force-flush).
            service.notifyMarkPrice({ symbol: 'ETHUSDT', markPrice: parseMoney('2010'), observedAt: new Date() });
            service.flushMtmForSymbolIfPending('ETHUSDT');

            const captured: IPaperMarkToMarketEvent[] = [];
            emitter.on(PAPER_MARK_TO_MARKET_EVENT, (e: IPaperMarkToMarketEvent) => captured.push(e));

            // Now a BTC tick fires; the equity must include BOTH BTC + ETH
            // unrealised PnL contributions because the ETH mark is cached.
            service.notifyMarkPrice({ symbol: 'BTCUSDT', markPrice: parseMoney('30200'), observedAt: new Date() });
            service.flushMtmForSymbolIfPending('BTCUSDT');

            // BTC: (30200-30000)*0.01 = 2. ETH: (2010-2000)*0.1 = 1. Sum = 3.
            // equity = balance(500) + 3 = 503.
            expect(captured).toHaveLength(1);
            expect(captured[0].equity.toFixed()).toBe('503');
        });
    });

    describe('R2b-fix Item 5 — appendAuditRow byte-length guard', () => {
        it('throws when payloadHash byteLength is not 32', async () => {
            const { service } = buildService();
            await service.onApplicationBootstrap();

            // Monkey-patch the codec to return a wrong-width buffer.
            const codec = (service as unknown as { codec: { hashOrderedPayload: (...args: unknown[]) => Buffer } }).codec;
            const original = codec.hashOrderedPayload.bind(codec);
            codec.hashOrderedPayload = () => Buffer.alloc(16, 0);

            await expect(
                service.openPosition({
                    clientOrderId: 'bad-hash-1',
                    symbol: 'BTCUSDT',
                    side: PositionSideEnum.LONG,
                    entryPrice: parseMoney('30000'),
                    size: parseMoney('0.01'),
                    leverage: 5,
                    openedAt: new Date(),
                }),
            ).rejects.toThrow(/payloadHash byteLength=16/);

            codec.hashOrderedPayload = original;
        });
    });

    describe('R2b-fix Item 1 — withAuditedTransaction discipline', () => {
        it('does NOT run in-memory mutation when the audited body throws', async () => {
            const { service, store } = buildService();
            await service.onApplicationBootstrap();
            const balanceBefore = service.getBalance().balanceUsdt.toFixed();

            await service.openPosition({
                clientOrderId: 'discipline-1',
                symbol: 'BTCUSDT',
                side: PositionSideEnum.LONG,
                entryPrice: parseMoney('30000'),
                size: parseMoney('0.01'),
                leverage: 5,
                openedAt: new Date(),
            });

            // Now force the close's audit append to fail. The in-memory map
            // must still hold the open position; balance must NOT advance.
            const auditRepoSpy = jest.spyOn((service as unknown as { auditRepo: PaperStateAuditRepository }).auditRepo, 'appendInTransaction');
            auditRepoSpy.mockRejectedValueOnce(new Error('simulated close-audit failure'));

            await expect(
                service.closePosition({
                    clientOrderId: 'discipline-1',
                    exitPrice: parseMoney('30100'),
                    closedAt: new Date(),
                    closeReason: PaperCloseReasonEnum.TP,
                }),
            ).rejects.toThrow('simulated close-audit failure');

            expect(service.getOpenPositions()).toHaveLength(1);
            expect(service.getBalance().balanceUsdt.toFixed()).toBe(balanceBefore);
            // store.state still contains the open row (rollback restored it).
            expect(store.state.find((r) => r.clientOrderId === 'discipline-1')).toBeDefined();
        });
    });

    describe('Money type sanity', () => {
        it('parseMoney returns a Money instance compatible with arithmetic helpers', () => {
            const a = parseMoney('1');
            const b = parseMoney('2');
            expect(a.plus(b).toFixed()).toBe('3');
            expect(a instanceof Money).toBe(true);
        });
    });
});
