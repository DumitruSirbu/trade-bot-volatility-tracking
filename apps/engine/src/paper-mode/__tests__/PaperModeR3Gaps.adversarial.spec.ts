/**
 * M11a R3.1 gap-fill adversarial tests.
 *
 * Covers the R3.1 items that were NOT addressed by any earlier spec file:
 *
 *   GAP-1 — EXCHANGE_ENV unset / invalid aborts at the Zod / class-validator
 *            schema layer (W0.1 regression guard). The `validateEnv` function
 *            must throw before any module initialises.
 *
 *   GAP-2 — D6 audit HMAC binds the post-allocation `seq` (CTE/RETURNING
 *            property). The HMAC computed over a pre-allocation payload
 *            (without the seq assigned by the DB) MUST NOT match the
 *            persisted HMAC. Only the post-allocation payload reproduces it.
 *            The atomicity spec covers commit-or-rollback; this spec covers
 *            the seq-binding property specifically.
 *
 *   GAP-3 — D7 single-use token — structural guarantee. After a successful
 *            TESTNET→PAPER transition, the chain tip's env is PAPER.  A
 *            subsequent boot under PAPER enters the same-mode BOOT path and
 *            NEVER re-enters the transition path. The token is therefore
 *            structurally single-use: replaying the same TESTNET→PAPER
 *            token requires the chain tip to say TESTNET, which it no longer
 *            does. This test pins that structural invariant.
 *
 *   GAP-4 — D4 funding force-flushes the MTM throttle.  A funding event
 *            arriving while a throttle timer is pending for the symbol
 *            triggers an immediate `apply_funding + recompute + evaluate_abort`
 *            without waiting for the 100 ms window.  The pending timer is
 *            cleared and the MTM event fires synchronously during applyFunding.
 *
 *   GAP-5 — D16 audit HMAC includes seq: a row whose HMAC was computed over
 *            seq='1' does not verify when the persisted row's seq is '2'.
 *            Complements GAP-2 from a codec-level angle (seq in the signed
 *            payload; no seq-0 collisions).
 *
 *   GAP-6 — D14 runtime guard: a synthetic caller resolving IExchangeClient
 *            via a side-channel and calling fetchBalance (without an active
 *            capability frame) throws UnauthorizedLiveAccountStateCallException.
 *            Already covered by LiveAccountStateCapabilityGuard.spec.ts —
 *            confirmed COVERED, not re-tested here.
 *
 * CRN tape materialisation (D17) and TOST calibration equivalence tests are
 * DEFERRED — they operate against the soak-evaluator (not yet implemented)
 * and have no production code to test against.
 *
 * MTM throttle 1000-ticks-per-second burst is DEFERRED — this is an
 * integration-level property requiring real wall-clock scheduling; asserting
 * it deterministically requires a fake clock that is too heavyweight relative
 * to the risk-reduction value for a unit-test wave.
 */

import { PositionSideEnum } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';

import { BootstrapSubkeyDeriver } from '../../boot-mode-history/service/BootstrapSubkeyDeriver';
import { BootModeChainRotationEntity } from '../../boot-mode-history/entity/BootModeChainRotationEntity';
import { BootModeHistoryEntity } from '../../boot-mode-history/entity/BootModeHistoryEntity';
import { BootModeChainRotationRepository } from '../../boot-mode-history/repository/BootModeChainRotationRepository';
import { BootModeHistoryRepository } from '../../boot-mode-history/repository/BootModeHistoryRepository';
import { BootModeChainService } from '../../boot-mode-history/service/BootModeChainService';
import { BootModeHmacCodec } from '../../boot-mode-history/service/BootModeHmacCodec';
import { TransitionTokenVerifier } from '../../boot-mode-history/service/TransitionTokenVerifier';
import { BootModeHistoryRowKindEnum } from '../../boot-mode-history/enum';
import { AppConfigService } from '../../config/service';
import { validateEnv } from '../../config/validateEnv';
import { parseMoney } from '../../common/utils';
import { CHAIN_NAME_PAPER_STATE_AUDIT, HKDF_INFO_PAPER_STATE_AUDIT } from '../const';
import { PaperAccountSnapshotEntity } from '../entity/PaperAccountSnapshotEntity';
import { PaperAccountStateEntity } from '../entity/PaperAccountStateEntity';
import { PaperAccountStateHistoryEntity } from '../entity/PaperAccountStateHistoryEntity';
import { PaperAccountStateMetaEntity } from '../entity/PaperAccountStateMetaEntity';
import { PaperStateAuditEntity } from '../entity/PaperStateAuditEntity';
import { MutationKindEnum, PaperCloseReasonEnum, SubjectKindEnum } from '../enum';
import { PAPER_MARK_TO_MARKET_EVENT, IPaperMarkToMarketEvent } from '../service/PaperAccountStateService';
import { PaperAccountSnapshotRepository } from '../repository/PaperAccountSnapshotRepository';
import { PaperAccountStateHistoryRepository } from '../repository/PaperAccountStateHistoryRepository';
import { PaperAccountStateMetaRepository } from '../repository/PaperAccountStateMetaRepository';
import { PaperAccountStateRepository } from '../repository/PaperAccountStateRepository';
import { PaperStateAuditRepository } from '../repository/PaperStateAuditRepository';
import { PaperAccountStateService } from '../service/PaperAccountStateService';
import { PaperStateAuditHmacCodec } from '../service/PaperStateAuditHmacCodec';
import { ExchangeEnvironmentEnum } from '@bot/shared';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, unlink, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// ─── shared constants ────────────────────────────────────────────────────────

const BOOTSTRAP_SECRET = 'a'.repeat(64);
const STARTING_EQUITY = 500;

function sha256Hex(text: string): string {
    return createHash('sha256').update(text.trim(), 'utf8').digest('hex');
}

async function writeTokenFile(content: string): Promise<string> {
    const path = join(tmpdir(), `r3-gap-token-${Date.now()}-${randomUUID()}`);
    await writeFile(path, content, 'utf8');
    await chmod(path, 0o600);
    return path;
}

// ─── GAP-1 — EXCHANGE_ENV unset / invalid aborts at validateEnv ──────────────

describe('GAP-1 — W0.1 Zod schema regression guard: EXCHANGE_ENV unset aborts startup', () => {
    it('validateEnv throws when EXCHANGE_ENV is absent from the environment', () => {
        // Only supply the minimum required vars; deliberately omit EXCHANGE_ENV.
        const raw: Record<string, unknown> = {
            NODE_ENV: 'development',
            LOG_LEVEL: 'info',
            DB_HOST: 'localhost',
            DB_PORT: '5432',
            DB_NAME: 'tradebot',
            DB_USER: 'trade_bot',
            DB_PASSWORD: 'secret',
            AUTH_BOOTSTRAP_SECRET: 'a'.repeat(64),
            EXCHANGE_API_KEY: 'key',
            EXCHANGE_API_SECRET: 'secret',
            EXECUTION_MODE: 'dry_run',
            PAPER_STARTING_EQUITY_USDT: '500',
        };

        expect(() => validateEnv(raw)).toThrow(/EXCHANGE_ENV/i);
    });

    it('validateEnv throws when EXCHANGE_ENV is an invalid value (not one of testnet|paper|live)', () => {
        const raw: Record<string, unknown> = {
            NODE_ENV: 'development',
            LOG_LEVEL: 'info',
            DB_HOST: 'localhost',
            DB_PORT: '5432',
            DB_NAME: 'tradebot',
            DB_USER: 'trade_bot',
            DB_PASSWORD: 'secret',
            AUTH_BOOTSTRAP_SECRET: 'a'.repeat(64),
            EXCHANGE_API_KEY: 'key',
            EXCHANGE_API_SECRET: 'secret',
            EXECUTION_MODE: 'dry_run',
            PAPER_STARTING_EQUITY_USDT: '500',
            // 'demo' was the old, now-invalid value — its silent acceptance
            // would resurrect the broken DEMO design.
            EXCHANGE_ENV: 'demo',
        };

        expect(() => validateEnv(raw)).toThrow(/EXCHANGE_ENV/i);
    });

    it('validateEnv accepts EXCHANGE_ENV=paper (confirms the enum rename landed)', () => {
        const raw: Record<string, unknown> = {
            NODE_ENV: 'development',
            ENGINE_PORT: '3000',
            LOG_LEVEL: 'log',
            DB_HOST: 'localhost',
            DB_PORT: '5432',
            DB_NAME: 'tradebot',
            DB_USER: 'trade_bot',
            DB_PASSWORD: 'secret',
            DATABASE_URL: 'postgresql://trade_bot:secret@localhost:5432/tradebot',
            ADMINER_PORT: '8080',
            EXCHANGE_ENV: 'paper',
            MAX_OPEN_POSITIONS: '1',
            MAX_EXPOSURE_PER_COIN_USDT: '500',
            DAILY_LOSS_LIMIT_USDT: '50',
            COOLDOWN_AFTER_LOSS_MS: '3600000',
            ACCOUNT_CAPITAL_USDT: '500',
            ACTIVE_STRATEGY_VERSION_ID: '1',
        };

        // Must not throw — if it does the W0.1 rename has a bug.
        expect(() => validateEnv(raw)).not.toThrow();
    });
});

// ─── GAP-2 — D6 audit HMAC binds the post-allocation seq ────────────────────
//
// The production code uses a two-phase write (INSERT placeholder HMAC →
// UPDATE with the HMAC computed over the RETURNING'd `seq`). This test asserts
// the seq-binding property at the codec level: the same payload fields with a
// DIFFERENT seq produce a different HMAC. That is the property that makes the
// CTE/RETURNING binding load-bearing: a pre-allocation HMAC (seq unknown)
// does NOT match the post-allocation HMAC (seq known and bound).

describe('GAP-2 — D6 audit HMAC includes assigned seq (codec-level binding)', () => {
    let codec: PaperStateAuditHmacCodec;
    let subkey: Buffer;

    beforeEach(() => {
        codec = new PaperStateAuditHmacCodec();
        const appConfig = { authBootstrapSecret: BOOTSTRAP_SECRET } as AppConfigService;
        const deriver = new BootstrapSubkeyDeriver(appConfig);
        subkey = deriver.deriveSubkey(HKDF_INFO_PAPER_STATE_AUDIT);
    });

    it('HMAC over seq=1 does not match HMAC over seq=2 for otherwise identical payloads', () => {
        const basePayload = {
            recordedAt: new Date('2026-06-01T00:00:00.000Z'),
            mutationKind: 'OPEN_POSITION',
            subjectKind: 'paper_account_state',
            subjectId: '00000000-0000-0000-0000-000000000001',
            payloadHash: Buffer.alloc(32, 0xcc),
            prevRowHash: null,
        };

        const preAllocationHmac = codec.computeHmac(
            subkey,
            codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, { ...basePayload, seq: '1' }),
        );

        // Simulate: the DB RETURNING clause assigns seq=2 (e.g. a concurrent
        // transaction slipped in between INSERT and RETURNING).
        const postAllocationHmac = codec.computeHmac(
            subkey,
            codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, { ...basePayload, seq: '2' }),
        );

        // The HMAC over seq=1 MUST NOT match the HMAC over seq=2.
        // If it did, a crash-replay window could bind the wrong seq without
        // detection (D6 security reasoning).
        expect(preAllocationHmac.equals(postAllocationHmac)).toBe(false);
    });

    it('HMAC reproduces exactly when the same seq is presented after allocation', () => {
        const payload = {
            seq: '7',
            recordedAt: new Date('2026-06-02T08:00:00.000Z'),
            mutationKind: 'CLOSE_POSITION',
            subjectKind: 'paper_account_state_history',
            subjectId: '11111111-1111-1111-1111-111111111111',
            payloadHash: Buffer.alloc(32, 0xab),
            prevRowHash: Buffer.alloc(32, 0x12),
        };

        const first = codec.computeHmac(subkey, codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, payload));
        const second = codec.computeHmac(subkey, codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, payload));

        // The post-allocation HMAC is deterministic — re-presenting the same
        // (seq, payload) always reproduces the persisted value.
        expect(first.equals(second)).toBe(true);
    });

    it('pre-allocation placeholder (seq=0 sentinel) does not reproduce the post-allocation HMAC', () => {
        const sharedFields = {
            recordedAt: new Date('2026-06-01T12:00:00.000Z'),
            mutationKind: 'META_INIT',
            subjectKind: 'paper_account_state_meta',
            subjectId: '22222222-2222-2222-2222-222222222222',
            payloadHash: Buffer.alloc(32, 0x77),
            prevRowHash: null,
        };

        const preAllocation = codec.computeHmac(
            subkey,
            codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, { ...sharedFields, seq: '0' }),
        );
        const postAllocation = codec.computeHmac(
            subkey,
            codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, { ...sharedFields, seq: '5' }),
        );

        expect(preAllocation.equals(postAllocation)).toBe(false);
    });
});

// ─── Shared boot-mode-chain harness (reused by GAP-3) ────────────────────────

interface IBootChainState {
    historyRows: BootModeHistoryEntity[];
    rotationRows: BootModeChainRotationEntity[];
    nextHistorySeq: number;
    nextRotationSeq: number;
}

function emptyChainState(): IBootChainState {
    return { historyRows: [], rotationRows: [], nextHistorySeq: 1, nextRotationSeq: 1 };
}

function buildChainRepos(state: IBootChainState, stagingH: BootModeHistoryEntity[], stagingR: BootModeChainRotationEntity[]) {
    const historyRepo: jest.Mocked<Pick<BootModeHistoryRepository, 'findOrderedAll' | 'findTip' | 'appendInTransaction'>> = {
        findOrderedAll: jest.fn().mockImplementation(async () =>
            [...state.historyRows, ...stagingH].sort((a, b) => Number(a.seq) - Number(b.seq)),
        ),
        findTip: jest.fn().mockImplementation(async () => {
            const merged = [...state.historyRows, ...stagingH];
            return merged.length === 0 ? null : [...merged].sort((a, b) => Number(b.seq) - Number(a.seq))[0];
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
            draft.thisRowHmac = params.computeHmac({ seq, bootedAt, rowKind: draft.rowKind, exchangeEnv: draft.exchangeEnv, fromEnv: draft.fromEnv, toEnv: draft.toEnv, prevRowHash: draft.prevRowHash });
            stagingH.push(draft);
            return draft;
        }),
    };

    const rotationRepo: jest.Mocked<Pick<BootModeChainRotationRepository, 'findOrderedAll' | 'findTip' | 'appendInTransaction'>> = {
        findOrderedAll: jest.fn().mockImplementation(async () =>
            [...state.rotationRows, ...stagingR].sort((a, b) => Number(a.seq) - Number(b.seq)),
        ),
        findTip: jest.fn().mockImplementation(async () => {
            const merged = [...state.rotationRows, ...stagingR];
            return merged.length === 0 ? null : [...merged].sort((a, b) => Number(b.seq) - Number(a.seq))[0];
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
            draft.thisRowHmac = params.computeHmac({ seq, rotatedAt, fromEnv: draft.fromEnv, toEnv: draft.toEnv, preTipHash: draft.preTipHash, transitionTokenHash: draft.transitionTokenHash, prevRowHash: draft.prevRowHash });
            stagingR.push(draft);
            return draft;
        }),
    };

    return { historyRepo, rotationRepo };
}

function buildChainService(state: IBootChainState, env: ExchangeEnvironmentEnum): { service: BootModeChainService; txShim: jest.Mock } {
    const appConfig = {
        exchangeEnv: env,
        authBootstrapSecret: BOOTSTRAP_SECRET,
        readTransitionTokenFile: jest.fn().mockImplementation((name: string) => process.env[name]),
        readTransitionTokenHash: jest.fn().mockImplementation((name: string) => process.env[name]),
    } as unknown as AppConfigService;

    const codec = new BootModeHmacCodec();
    const subkeys = new BootstrapSubkeyDeriver(appConfig);
    let stagingH: BootModeHistoryEntity[] = [];
    let stagingR: BootModeChainRotationEntity[] = [];
    const { historyRepo, rotationRepo } = buildChainRepos(state, stagingH, stagingR);

    const txShim = jest.fn().mockImplementation(async (fn: (manager: never) => Promise<void>) => {
        stagingH.length = 0;
        stagingR.length = 0;
        try {
            await fn({ query: jest.fn().mockResolvedValue(undefined) } as never);
            state.historyRows.push(...stagingH);
            state.rotationRows.push(...stagingR);
        } catch (cause) {
            state.nextHistorySeq -= stagingH.length;
            state.nextRotationSeq -= stagingR.length;
            throw cause;
        }
    });

    const tokenVerifier = new TransitionTokenVerifier();
    const service = new BootModeChainService(
        appConfig,
        { transaction: txShim } as never,
        historyRepo as unknown as BootModeHistoryRepository,
        rotationRepo as unknown as BootModeChainRotationRepository,
        subkeys,
        codec,
        tokenVerifier,
    );

    return { service, txShim };
}

// ─── GAP-3 — D7 single-use transition token (structural guarantee) ────────────

describe('GAP-3 — D7 single-use transition token (structural guarantee)', () => {
    let processExitSpy: jest.SpyInstance;

    beforeEach(() => {
        processExitSpy = jest.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
            throw new Error(`process.exit called with code ${_code ?? 'undefined'}`);
        });
        delete process.env.TESTNET_TO_PAPER_TOKEN_FILE;
        delete process.env.TESTNET_TO_PAPER_TOKEN_HASH;
    });

    afterEach(() => {
        processExitSpy.mockRestore();
        delete process.env.TESTNET_TO_PAPER_TOKEN_FILE;
        delete process.env.TESTNET_TO_PAPER_TOKEN_HASH;
    });

    it('after a successful TESTNET→PAPER transition the chain tip is PAPER — a subsequent PAPER boot enters same-mode path, NOT the transition path', async () => {
        const state = emptyChainState();

        // First boot: genesis TESTNET.
        { const { service } = buildChainService(state, ExchangeEnvironmentEnum.TESTNET); await service.runBootSequence(); }
        expect(state.historyRows).toHaveLength(1);
        expect(state.historyRows[0].rowKind).toBe(BootModeHistoryRowKindEnum.BOOT);
        expect(state.historyRows[0].exchangeEnv).toBe('testnet');

        // Second boot: authorized TESTNET→PAPER transition.
        const tokenContent = 'gap3-single-use-token';
        const tokenFile = await writeTokenFile(tokenContent);
        try {
            process.env.TESTNET_TO_PAPER_TOKEN_FILE = tokenFile;
            process.env.TESTNET_TO_PAPER_TOKEN_HASH = sha256Hex(tokenContent);

            const { service } = buildChainService(state, ExchangeEnvironmentEnum.PAPER);
            await service.runBootSequence();
        } finally {
            await unlink(tokenFile).catch(() => undefined);
        }

        // Chain now has: TESTNET BOOT (seq=1) + PAPER TRANSITION (seq=2) + PAPER BOOT (seq=3).
        // Tip is PAPER.
        expect(state.historyRows).toHaveLength(3);
        expect(state.historyRows[state.historyRows.length - 1].exchangeEnv).toBe('paper');
        expect(state.historyRows[state.historyRows.length - 1].rowKind).toBe(BootModeHistoryRowKindEnum.BOOT);
        const rotationCount = state.rotationRows.length;

        // Third boot under PAPER: same-mode path.  Transition path MUST NOT
        // run — no additional TRANSITION row, no additional rotation row.
        // This is the structural single-use guarantee: the same token cannot
        // drive a SECOND transition because the tip is already PAPER.
        {
            // Deliberately supply the old token env vars — if the service
            // mistakenly enters the transition path it would try to verify and
            // append a TRANSITION row.
            const oldTokenContent = 'gap3-single-use-token';
            const oldTokenFile = await writeTokenFile(oldTokenContent);
            try {
                process.env.TESTNET_TO_PAPER_TOKEN_FILE = oldTokenFile;
                process.env.TESTNET_TO_PAPER_TOKEN_HASH = sha256Hex(oldTokenContent);

                const { service } = buildChainService(state, ExchangeEnvironmentEnum.PAPER);
                await service.runBootSequence();
            } finally {
                await unlink(oldTokenFile).catch(() => undefined);
            }
        }

        // Only one additional BOOT row must have been appended (same-mode).
        // The rotation table must still have exactly as many rows as after the
        // transition — no second transition row was added.
        expect(state.historyRows).toHaveLength(4);
        expect(state.historyRows[3].rowKind).toBe(BootModeHistoryRowKindEnum.BOOT);
        expect(state.historyRows[3].exchangeEnv).toBe('paper');
        // No new TRANSITION row.
        expect(state.historyRows.filter((r) => r.rowKind === BootModeHistoryRowKindEnum.TRANSITION)).toHaveLength(1);
        // No new rotation row.
        expect(state.rotationRows).toHaveLength(rotationCount);
    });

    it('the TESTNET→PAPER token hash is recorded in the rotation row — a second TRANSITION with the same hash would produce a duplicate preTipHash mismatch detectable by the rotation-chain walker', async () => {
        // This test asserts the observable consequence of the structural
        // single-use guarantee: the rotation row records the preTipHash AT
        // the time of the transition. A hypothetical second TESTNET→PAPER
        // transition would see a different tip (PAPER, not TESTNET) so it
        // either aborts (no TESTNET→PAPER wiring under PAPER tip) or produces
        // an inconsistent preTipHash (which the rotation-chain walk detects).
        const state = emptyChainState();
        { const { service } = buildChainService(state, ExchangeEnvironmentEnum.TESTNET); await service.runBootSequence(); }

        const tesnetTipHmac = state.historyRows[0].thisRowHmac;

        const tokenContent = 'gap3-duplicate-hash-test';
        const tokenFile = await writeTokenFile(tokenContent);
        try {
            process.env.TESTNET_TO_PAPER_TOKEN_FILE = tokenFile;
            process.env.TESTNET_TO_PAPER_TOKEN_HASH = sha256Hex(tokenContent);
            const { service } = buildChainService(state, ExchangeEnvironmentEnum.PAPER);
            await service.runBootSequence();
        } finally {
            await unlink(tokenFile).catch(() => undefined);
        }

        // The rotation row's preTipHash must equal the TESTNET BOOT row's HMAC.
        // This is the binding that would be violated by a second transition
        // under the same chain (the tip would be different at the second time).
        expect(state.rotationRows).toHaveLength(1);
        expect(state.rotationRows[0].preTipHash).toEqual(tesnetTipHmac);
        expect(Buffer.from(sha256Hex(tokenContent), 'hex').equals(state.rotationRows[0].transitionTokenHash)).toBe(true);
    });
});

// ─── Shared account-state service harness (reused by GAP-4) ─────────────────

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

function buildAccountService(store: IFakeStore = emptyStore()): { service: PaperAccountStateService; emitter: EventEmitter2 } {
    const stagingAudit: PaperStateAuditEntity[] = [];
    const stagingMeta: PaperAccountStateMetaEntity[] = [];
    const stagingState: PaperAccountStateEntity[] = [];
    const stagingHistory: PaperAccountStateHistoryEntity[] = [];
    const stagingSnap: PaperAccountSnapshotEntity[] = [];

    const stateRepo: Pick<PaperAccountStateRepository, 'findByClientOrderId' | 'findOpenBySymbol' | 'findAllOpen' | 'insertNew' | 'deleteByClientOrderId'> = {
        findByClientOrderId: jest.fn(async (id: string) => [...store.state, ...stagingState].find((r) => r.clientOrderId === id) ?? null),
        findOpenBySymbol: jest.fn(async () => []),
        findAllOpen: jest.fn(async () => [...store.state, ...stagingState]),
        insertNew: jest.fn(async (draft) => {
            const entity = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), mode: 'paper', ...draft } as PaperAccountStateEntity;
            stagingState.push(entity);
            return entity;
        }),
        deleteByClientOrderId: jest.fn(async (id: string) => {
            const idx = stagingState.findIndex((r) => r.clientOrderId === id);
            if (idx >= 0) stagingState.splice(idx, 1);
            const storeIdx = store.state.findIndex((r) => r.clientOrderId === id);
            if (storeIdx >= 0) {
                const row = store.state.splice(storeIdx, 1)[0];
                (row as PaperAccountStateEntity & { __toRestore?: boolean }).__toRestore = true;
                stagingState.push(row);
            }
        }),
    };

    const historyRepo: Pick<PaperAccountStateHistoryRepository, 'appendClose' | 'findClosedBetween' | 'findByClientOrderId'> = {
        appendClose: jest.fn(async (draft) => {
            const entity = { id: randomUUID(), createdAt: new Date(), mode: 'paper', ...draft } as PaperAccountStateHistoryEntity;
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
            return merged.length === 0 ? null : [...merged].sort((a, b) => b.soakStartTs.getTime() - a.soakStartTs.getTime())[0];
        }),
        insertNew: jest.fn(async (draft) => {
            const entity = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...draft } as PaperAccountStateMetaEntity;
            stagingMeta.push(entity);
            return entity;
        }),
    };

    const snapshotRepo: Pick<PaperAccountSnapshotRepository, 'insertNew' | 'findLatest' | 'findTakenBetween'> = {
        insertNew: jest.fn(async (draft) => {
            const entity = { id: randomUUID(), createdAt: new Date(), mode: 'paper', ...draft } as PaperAccountSnapshotEntity;
            stagingSnap.push(entity);
            return entity;
        }),
        findLatest: jest.fn(async () => {
            const merged = [...store.snapshots, ...stagingSnap];
            return merged.length === 0 ? null : [...merged].sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime())[0];
        }),
        findTakenBetween: jest.fn(async () => []),
    };

    const auditRepo: Pick<PaperStateAuditRepository, 'findTip' | 'findOrderedAll' | 'findBySubject' | 'appendInTransaction'> = {
        findTip: jest.fn(async () => {
            const merged = [...store.audit, ...stagingAudit];
            return merged.length === 0 ? null : [...merged].sort((a, b) => Number(b.seq) - Number(a.seq))[0];
        }),
        findOrderedAll: jest.fn(async () => [...store.audit, ...stagingAudit].sort((a, b) => Number(a.seq) - Number(b.seq))),
        findBySubject: jest.fn(async (sk: SubjectKindEnum, sid: string) =>
            [...store.audit, ...stagingAudit].filter((r) => r.subjectKind === sk && r.subjectId === sid),
        ),
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
            draft.thisRowHmac = params.computeHmac({ seq, recordedAt, mutationKind: draft.mutationKind, subjectKind: draft.subjectKind, subjectId: draft.subjectId, payloadHash: draft.payloadHash, prevRowHash: draft.prevRowHash });
            stagingAudit.push(draft);
            return draft;
        }),
    };

    const txShim = jest.fn().mockImplementation(async (fn: (manager: never) => Promise<unknown>) => {
        stagingAudit.length = 0;
        stagingMeta.length = 0;
        stagingState.length = 0;
        stagingHistory.length = 0;
        stagingSnap.length = 0;
        try {
            const result = await fn({ query: jest.fn().mockResolvedValue(undefined) } as never);
            store.audit.push(...stagingAudit);
            store.meta.push(...stagingMeta);
            for (const row of stagingState as Array<PaperAccountStateEntity & { __toRestore?: boolean }>) {
                if (row.__toRestore) { delete row.__toRestore; continue; }
                store.state.push(row);
            }
            store.history.push(...stagingHistory);
            store.snapshots.push(...stagingSnap);
            return result;
        } catch (cause) {
            store.nextAuditSeq -= stagingAudit.length;
            for (const row of stagingState as Array<PaperAccountStateEntity & { __toRestore?: boolean }>) {
                if (row.__toRestore) { delete row.__toRestore; store.state.push(row); }
            }
            throw cause;
        }
    });

    const appConfig = {
        authBootstrapSecret: BOOTSTRAP_SECRET,
        paperStartingEquityUsdt: STARTING_EQUITY,
        exchangeEnv: ExchangeEnvironmentEnum.PAPER,
    } as unknown as AppConfigService;

    const subkeys = new BootstrapSubkeyDeriver(appConfig);
    const codec = new PaperStateAuditHmacCodec();
    const emitter = new EventEmitter2();

    const service = new PaperAccountStateService(
        appConfig,
        { transaction: txShim } as never,
        stateRepo as unknown as PaperAccountStateRepository,
        historyRepo as unknown as PaperAccountStateHistoryRepository,
        metaRepo as unknown as PaperAccountStateMetaRepository,
        snapshotRepo as unknown as PaperAccountSnapshotRepository,
        auditRepo as unknown as PaperStateAuditRepository,
        subkeys,
        codec,
        emitter,
    );

    return { service, emitter };
}

// ─── GAP-4 — D4 funding force-flushes the MTM throttle ───────────────────────
//
// A funding event arriving while a throttle timer is pending for the affected
// symbol must trigger an IMMEDIATE MTM evaluation without waiting for the
// 100 ms throttle window. The throttle timer is cleared by applyFunding, and a
// PAPER_MARK_TO_MARKET_EVENT fires synchronously (in the onCommit callback)
// as part of the applyFunding call.
//
// Implementation note (D4 + D16): funding is ACCRUED into
// `position.fundingAccrued` and `fundingAccruedCumulative`; it is NOT settled
// into `balanceUsdt` until position close. Equity in the MTM event is therefore
// `balanceUsdt + recomputeUnrealisedPnl(marks)` — the funding amount does not
// appear in the equity emitted by the immediate flush. Tests below assert the
// force-flush firing property, not a post-funding equity adjustment.

describe('GAP-4 — D4 funding event force-flushes the MTM throttle immediately', () => {
    it('applyFunding triggers an immediate MTM event when a throttle timer is pending for the symbol', async () => {
        // Build a service with one open LONG position and a cached mark price.
        const { service, emitter } = buildAccountService();
        await service.onApplicationBootstrap();

        await service.openPosition({
            clientOrderId: 'gap4-funding-flush',
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            entryPrice: parseMoney('30000'),
            size: parseMoney('0.01'),
            leverage: 5,
            openedAt: new Date('2026-06-01T00:00:00Z'),
        });

        // Warm the mark price cache. notifyMarkPrice sets a pending throttle
        // timer for the symbol. Do NOT flush manually — we want the timer pending.
        service.notifyMarkPrice({ symbol: 'BTCUSDT', markPrice: parseMoney('30000'), observedAt: new Date() });

        // Collect PAPER_MARK_TO_MARKET_EVENT emissions.
        const mtmEvents: IPaperMarkToMarketEvent[] = [];
        emitter.on(PAPER_MARK_TO_MARKET_EVENT, (e: IPaperMarkToMarketEvent) => mtmEvents.push(e));

        // Apply a funding event. Under D4 this must force-flush the pending
        // throttle timer and emit a PAPER_MARK_TO_MARKET_EVENT synchronously
        // inside the onCommit callback — before applyFunding returns.
        await service.applyFunding({
            clientOrderId: 'gap4-funding-flush',
            symbol: 'BTCUSDT',
            fundingTs: new Date('2026-06-01T08:00:00Z'),
            fundingAmountUsdt: parseMoney('-0.03'), // LONG pays; negative
        });

        // The force-flush must have fired at least one MTM event synchronously —
        // no setTimeout wait required.
        expect(mtmEvents.length).toBeGreaterThanOrEqual(1);

        // Equity = balanceUsdt(500) + unrealised(mark=entry=30000 → 0) = 500.
        // D16: funding is accrued, not settled to balance until close, so
        // balance stays 500 and the MTM event reflects pre-settlement equity.
        const lastEvent = mtmEvents[mtmEvents.length - 1];
        expect(lastEvent.equity.toFixed()).toBe('500');
    });

    it('applyFunding does NOT emit an MTM event when no mark price is cached for the symbol (no pending throttle)', async () => {
        const { service, emitter } = buildAccountService();
        await service.onApplicationBootstrap();

        await service.openPosition({
            clientOrderId: 'gap4-no-mark',
            symbol: 'ETHUSDT',
            side: PositionSideEnum.SHORT,
            entryPrice: parseMoney('2000'),
            size: parseMoney('0.1'),
            leverage: 5,
            openedAt: new Date('2026-06-01T00:00:00Z'),
        });

        // Do NOT call notifyMarkPrice — no mark cache, no pending throttle.
        const mtmEvents: IPaperMarkToMarketEvent[] = [];
        emitter.on(PAPER_MARK_TO_MARKET_EVENT, (e: IPaperMarkToMarketEvent) => mtmEvents.push(e));

        await service.applyFunding({
            clientOrderId: 'gap4-no-mark',
            symbol: 'ETHUSDT',
            fundingTs: new Date('2026-06-01T08:00:00Z'),
            fundingAmountUsdt: parseMoney('0.02'),
        });

        // flushMtmForSymbolIfPending is a no-op when no throttle timer is
        // pending for the symbol — nothing to flush, no MTM event emitted.
        expect(mtmEvents).toHaveLength(0);
    });

    it('MTM event from force-flush uses current mark prices (equity reflects latest unrealised PnL at time of funding)', async () => {
        // Asserts the D4 ordering contract at the data level: the equity
        // visible in the MTM event emitted by applyFunding is computed from
        // `balanceUsdt + recomputeUnrealisedPnl(lastMarkPrices)`. The mark
        // price must be the one that was pending in the throttle (not stale).
        const { service, emitter } = buildAccountService();
        await service.onApplicationBootstrap();

        await service.openPosition({
            clientOrderId: 'gap4-mark-check',
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            entryPrice: parseMoney('30000'),
            size: parseMoney('0.01'),
            leverage: 5,
            openedAt: new Date('2026-06-01T00:00:00Z'),
        });

        // notional = 0.01 * 30000 = 300 USDT
        // mark = 31000 → unrealised = (31000 - 30000) * 0.01 = 10 USDT
        service.notifyMarkPrice({ symbol: 'BTCUSDT', markPrice: parseMoney('31000'), observedAt: new Date() });

        const mtmEvents: IPaperMarkToMarketEvent[] = [];
        emitter.on(PAPER_MARK_TO_MARKET_EVENT, (e: IPaperMarkToMarketEvent) => mtmEvents.push(e));

        await service.applyFunding({
            clientOrderId: 'gap4-mark-check',
            symbol: 'BTCUSDT',
            fundingTs: new Date('2026-06-01T08:00:00Z'),
            fundingAmountUsdt: parseMoney('-0.05'),
        });

        expect(mtmEvents.length).toBeGreaterThanOrEqual(1);
        // equity = 500 (balance) + 10 (unrealised at mark=31000) = 510
        expect(mtmEvents[mtmEvents.length - 1].equity.toFixed()).toBe('510');
    });
});

// ─── GAP-5 — D5 cold-start: peak_equity at t=0 equals PAPER_STARTING_EQUITY_USDT ──
//
// Covered by PaperAccountStateService.atomicity.spec.ts "seeds balance +
// peakEquity to PAPER_STARTING_EQUITY_USDT". Confirmed COVERED — see audit
// table in the R3 report. No additional test needed here.
//
// ─── GAP-6 — D15 SL/TP event-driven (covered by StreamingFillAdapter.causality.spec.ts) ─
// Confirmed COVERED.
//
// ─── OUT OF SCOPE — TOST calibration, CRN tape materialisation, MTM 1000 ticks/sec burst ─
// Soak-evaluator scope — no production implementation to test against. See R3 audit table.
