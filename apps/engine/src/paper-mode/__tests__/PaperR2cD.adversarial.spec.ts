/**
 * Adversarial tests for the four R2c.D wave additions (ADR 0032 §D4 / §D5 /
 * §D6 / §D11 / §D15):
 *
 *   1. PaperMarkPriceSubscriptionBridge — dispatches each tick to BOTH the
 *      MTM throttle and the streaming-adapter intra-bar evaluator. Releases
 *      the subscription on shutdown.
 *   2. PaperDrawdownAbortHandler — engages the halt flag + writes the audit
 *      row + fires the CRITICAL alert when drawdownAbortTripped fires.
 *      Second event suppressed (no alert spam) while already tripped.
 *   3. PaperFundingAccrualService — signs the funding amount correctly per
 *      side (LONG / SHORT × positive / negative rate), skips positions
 *      opened AFTER the funding timestamp, and routes cap breaches through
 *      a FUNDING_CAP_BREACH audit row + CRITICAL alert.
 *   4. Chain-integrity walker (PaperAccountStateService.hydrateOnBoot) —
 *      a clean chain boots without throwing; a tampered HMAC aborts with
 *      PaperAccountStateBootException.
 *
 * The harness mirrors PaperAccountStateService.atomicity.spec.ts (in-memory
 * fake repos + jest-mock DataSource.transaction) so the same staging /
 * promotion semantics apply.
 */

import {
    AlertSeverityEnum,
    AlertTypeEnum,
    ExchangeEnvironmentEnum,
    IPriceUpdateEvent,
    PositionSideEnum,
} from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';

import { IAlertSink } from '../../alert/sink/AlertSinkModule';
import { BootstrapSubkeyDeriver } from '../../boot-mode-history/service/BootstrapSubkeyDeriver';
import { HaltFlagService } from '../../common/service/HaltFlagService';
import { PRICE_UPDATE_EVENT } from '../../common/const';
import { parseMoney } from '../../common/utils';
import { AppConfigService } from '../../config/service';
import { HaltService } from '../../control/HaltService';
import { IFundingRateObservedEvent } from '../../market-data/interface';
import { PaperAccountSnapshotEntity } from '../entity/PaperAccountSnapshotEntity';
import { PaperAccountStateEntity } from '../entity/PaperAccountStateEntity';
import { PaperAccountStateHistoryEntity } from '../entity/PaperAccountStateHistoryEntity';
import { PaperAccountStateMetaEntity } from '../entity/PaperAccountStateMetaEntity';
import { PaperStateAuditEntity } from '../entity/PaperStateAuditEntity';
import { MutationKindEnum } from '../enum';
import { PaperAccountStateBootException } from '../exception';
import { PaperAccountSnapshotRepository } from '../repository/PaperAccountSnapshotRepository';
import { PaperAccountStateHistoryRepository } from '../repository/PaperAccountStateHistoryRepository';
import { PaperAccountStateMetaRepository } from '../repository/PaperAccountStateMetaRepository';
import { PaperAccountStateRepository } from '../repository/PaperAccountStateRepository';
import { PaperStateAuditRepository } from '../repository/PaperStateAuditRepository';
import { PaperAccountStateService } from '../service/PaperAccountStateService';
import { PaperDrawdownAbortHandler } from '../service/PaperDrawdownAbortHandler';
import { PaperFundingAccrualService } from '../service/PaperFundingAccrualService';
import { PaperMarkPriceSubscriptionBridge } from '../service/PaperMarkPriceSubscriptionBridge';
import { PaperStateAuditHmacCodec } from '../service/PaperStateAuditHmacCodec';
import { StreamingFillAdapter } from '../service/StreamingFillAdapter';

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

function buildAppConfig(env: ExchangeEnvironmentEnum = ExchangeEnvironmentEnum.PAPER): AppConfigService {
    return {
        authBootstrapSecret: BOOTSTRAP_SECRET,
        paperStartingEquityUsdt: STARTING_EQUITY,
        exchangeEnv: env,
    } as unknown as AppConfigService;
}

function buildFakeRepos(store: IFakeStore) {
    const staging = {
        audit: [] as PaperStateAuditEntity[],
        meta: [] as PaperAccountStateMetaEntity[],
        state: [] as PaperAccountStateEntity[],
        history: [] as PaperAccountStateHistoryEntity[],
        snapshot: [] as PaperAccountSnapshotEntity[],
    };

    const stateRepo = {
        findByClientOrderId: jest.fn(async (clientOrderId: string) =>
            [...store.state, ...staging.state].find((r) => r.clientOrderId === clientOrderId) ?? null,
        ),
        findOpenBySymbol: jest.fn(async () => []),
        findAllOpen: jest.fn(async () => [...store.state, ...staging.state]),
        insertNew: jest.fn(async (draft) => {
            const entity = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), mode: 'paper', ...draft } as PaperAccountStateEntity;
            staging.state.push(entity);
            return entity;
        }),
        deleteByClientOrderId: jest.fn(),
    };

    const historyRepo = { appendClose: jest.fn(), findClosedBetween: jest.fn(), findByClientOrderId: jest.fn() };

    const metaRepo = {
        findBySoakStartId: jest.fn(),
        findLatest: jest.fn(async () => {
            const merged = [...store.meta, ...staging.meta];
            if (merged.length === 0) return null;
            return [...merged].sort((a, b) => b.soakStartTs.getTime() - a.soakStartTs.getTime())[0];
        }),
        insertNew: jest.fn(async (draft) => {
            const entity = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...draft } as PaperAccountStateMetaEntity;
            staging.meta.push(entity);
            return entity;
        }),
    };

    const snapshotRepo = {
        insertNew: jest.fn(),
        findLatest: jest.fn(async () => null),
        findTakenBetween: jest.fn(),
    };

    const auditRepo = {
        findTip: jest.fn(async () => {
            const merged = [...store.audit, ...staging.audit];
            if (merged.length === 0) return null;
            return [...merged].sort((a, b) => Number(b.seq) - Number(a.seq))[0];
        }),
        findOrderedAll: jest.fn(async () => [...store.audit, ...staging.audit].sort((a, b) => Number(a.seq) - Number(b.seq))),
        findBySubject: jest.fn(async () => []),
        appendInTransaction: jest.fn(async (_manager, params) => {
            const seq = String(store.nextAuditSeq++);
            const recordedAt = new Date();
            const hmac = params.computeHmac({ seq, recordedAt, mutationKind: params.mutationKind, subjectKind: params.subjectKind, subjectId: params.subjectId, payloadHash: params.payloadHash, prevRowHash: params.prevRowHash });
            const draft: PaperStateAuditEntity = {
                id: randomUUID(),
                seq,
                recordedAt,
                mutationKind: params.mutationKind,
                subjectKind: params.subjectKind,
                subjectId: params.subjectId,
                payloadHash: params.payloadHash,
                prevRowHash: params.prevRowHash,
                thisRowHmac: hmac,
            };
            staging.audit.push(draft);
            return draft;
        }),
    };

    return { stateRepo, historyRepo, metaRepo, snapshotRepo, auditRepo, staging };
}

function buildStateService(store: IFakeStore, appConfig: AppConfigService, emitter: EventEmitter2) {
    const { stateRepo, historyRepo, metaRepo, snapshotRepo, auditRepo, staging } = buildFakeRepos(store);

    const txShim = jest.fn().mockImplementation(async (fn: (manager: never) => Promise<unknown>) => {
        // Reset staging at the start of every transaction.
        staging.audit.length = 0;
        staging.meta.length = 0;
        staging.state.length = 0;
        staging.history.length = 0;
        staging.snapshot.length = 0;

        try {
            const result = await fn({ query: jest.fn().mockResolvedValue(undefined) } as never);
            store.audit.push(...staging.audit);
            store.meta.push(...staging.meta);
            store.state.push(...staging.state);
            store.history.push(...staging.history);
            store.snapshots.push(...staging.snapshot);
            return result;
        } catch (cause) {
            store.nextAuditSeq -= staging.audit.length;
            throw cause;
        }
    });

    const subkeys = new BootstrapSubkeyDeriver(appConfig);
    const codec = new PaperStateAuditHmacCodec();

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

    return { service, codec };
}

// ===== Item 1 — PaperMarkPriceSubscriptionBridge =====

describe('PaperMarkPriceSubscriptionBridge — R2c.D Item 1', () => {
    let emitter: EventEmitter2;
    let accountStateMock: jest.Mocked<Pick<PaperAccountStateService, 'notifyMarkPrice'>>;
    let streamingAdapterMock: jest.Mocked<Pick<StreamingFillAdapter, 'notifyTick'>>;
    let bridge: PaperMarkPriceSubscriptionBridge;

    beforeEach(() => {
        emitter = new EventEmitter2();
        accountStateMock = { notifyMarkPrice: jest.fn() };
        streamingAdapterMock = { notifyTick: jest.fn() };
        bridge = new PaperMarkPriceSubscriptionBridge(
            buildAppConfig(),
            emitter,
            accountStateMock as unknown as PaperAccountStateService,
            streamingAdapterMock as unknown as StreamingFillAdapter,
        );
    });

    afterEach(() => bridge.onApplicationShutdown());

    it('dispatches every PRICE_UPDATE_EVENT to BOTH notifyMarkPrice AND notifyTick', () => {
        bridge.onApplicationBootstrap();

        const event: IPriceUpdateEvent = { symbol: 'BTCUSDT', price: '30000.5', timestampMs: 1_700_000_000_000 };
        emitter.emit(PRICE_UPDATE_EVENT, event);

        expect(accountStateMock.notifyMarkPrice).toHaveBeenCalledTimes(1);
        expect(accountStateMock.notifyMarkPrice).toHaveBeenCalledWith({
            symbol: 'BTCUSDT',
            markPrice: expect.any(Object),
            observedAt: new Date(1_700_000_000_000),
        });
        expect(streamingAdapterMock.notifyTick).toHaveBeenCalledTimes(1);
        expect(streamingAdapterMock.notifyTick).toHaveBeenCalledWith('BTCUSDT', expect.objectContaining({
            bid: '30000.5',
            ask: '30000.5',
            last: '30000.5',
            mark: '30000.5',
            ts: 1_700_000_000_000,
        }));
    });

    it('releases the subscription on shutdown — subsequent events fire NEITHER side', () => {
        bridge.onApplicationBootstrap();
        bridge.onApplicationShutdown();

        emitter.emit(PRICE_UPDATE_EVENT, { symbol: 'ETHUSDT', price: '2000', timestampMs: 1 } as IPriceUpdateEvent);

        expect(accountStateMock.notifyMarkPrice).not.toHaveBeenCalled();
        expect(streamingAdapterMock.notifyTick).not.toHaveBeenCalled();
    });

    it('does NOT subscribe when EXCHANGE_ENV !== PAPER (defence-in-depth)', () => {
        const liveBridge = new PaperMarkPriceSubscriptionBridge(
            buildAppConfig(ExchangeEnvironmentEnum.LIVE),
            emitter,
            accountStateMock as unknown as PaperAccountStateService,
            streamingAdapterMock as unknown as StreamingFillAdapter,
        );
        liveBridge.onApplicationBootstrap();

        emitter.emit(PRICE_UPDATE_EVENT, { symbol: 'BTCUSDT', price: '1', timestampMs: 1 } as IPriceUpdateEvent);

        expect(accountStateMock.notifyMarkPrice).not.toHaveBeenCalled();
        expect(streamingAdapterMock.notifyTick).not.toHaveBeenCalled();
    });
});

// ===== Item 2 — PaperDrawdownAbortHandler =====

describe('PaperDrawdownAbortHandler — R2c.D Item 2', () => {
    let haltFlag: HaltFlagService;
    let haltService: jest.Mocked<Pick<HaltService, 'notePragmaticTransition'>>;
    let alertSink: jest.Mocked<IAlertSink>;
    let stateService: jest.Mocked<Pick<PaperAccountStateService, 'appendStandaloneAuditRow'>>;
    let handler: PaperDrawdownAbortHandler;

    beforeEach(() => {
        haltFlag = new HaltFlagService();
        haltService = { notePragmaticTransition: jest.fn() };
        alertSink = { publish: jest.fn().mockResolvedValue(undefined) };
        stateService = { appendStandaloneAuditRow: jest.fn().mockResolvedValue(undefined) };
        handler = new PaperDrawdownAbortHandler(
            buildAppConfig(),
            haltFlag,
            haltService as unknown as HaltService,
            stateService as unknown as PaperAccountStateService,
            new PaperStateAuditHmacCodec(),
            alertSink,
        );
    });

    function trippedEvent() {
        return {
            evaluatedAt: new Date('2026-06-01T00:00:00Z'),
            equity: parseMoney('400'),
            peakEquity: parseMoney('500'),
            drawdownPct: 0.2,
            drawdownAbortTripped: true,
        };
    }

    it('first drawdown event flips halt flag + writes DRAWDOWN_ABORT audit row + fires CRITICAL alert', async () => {
        await handler.onMarkToMarket(trippedEvent());

        expect(haltFlag.isHalted()).toBe(true);
        expect(haltService.notePragmaticTransition).toHaveBeenCalledTimes(1);
        expect(stateService.appendStandaloneAuditRow).toHaveBeenCalledTimes(1);
        expect(stateService.appendStandaloneAuditRow).toHaveBeenCalledWith(
            expect.objectContaining({ mutationKind: MutationKindEnum.DRAWDOWN_ABORT }),
        );
        expect(alertSink.publish).toHaveBeenCalledTimes(1);
        const alertCall = alertSink.publish.mock.calls[0][0];
        expect(alertCall.severity).toBe(AlertSeverityEnum.CRITICAL);
        expect(alertCall.type).toBe(AlertTypeEnum.MODEL_DIVERGENCE_ENGAGED);
    });

    it('second drawdown event while already tripped — INFO log only; no second alert and no second audit row', async () => {
        await handler.onMarkToMarket(trippedEvent());
        await handler.onMarkToMarket(trippedEvent());

        expect(alertSink.publish).toHaveBeenCalledTimes(1);
        expect(stateService.appendStandaloneAuditRow).toHaveBeenCalledTimes(1);
    });

    it('non-tripped events are no-ops', async () => {
        await handler.onMarkToMarket({
            ...trippedEvent(),
            drawdownAbortTripped: false,
        });

        expect(haltFlag.isHalted()).toBe(false);
        expect(alertSink.publish).not.toHaveBeenCalled();
        expect(stateService.appendStandaloneAuditRow).not.toHaveBeenCalled();
    });

    it('does nothing when EXCHANGE_ENV !== PAPER (defence-in-depth)', async () => {
        const liveHandler = new PaperDrawdownAbortHandler(
            buildAppConfig(ExchangeEnvironmentEnum.LIVE),
            haltFlag,
            haltService as unknown as HaltService,
            stateService as unknown as PaperAccountStateService,
            new PaperStateAuditHmacCodec(),
            alertSink,
        );

        await liveHandler.onMarkToMarket(trippedEvent());

        expect(haltFlag.isHalted()).toBe(false);
        expect(alertSink.publish).not.toHaveBeenCalled();
    });
});

// ===== Item 3 — PaperFundingAccrualService =====

describe('PaperFundingAccrualService — R2c.D Item 3', () => {
    let alertSink: jest.Mocked<IAlertSink>;
    let stateService: jest.Mocked<Pick<PaperAccountStateService, 'getOpenPositions' | 'getLastMarkPrice' | 'applyFunding' | 'appendStandaloneAuditRow'>>;
    let service: PaperFundingAccrualService;

    function buildPosition(side: PositionSideEnum, openedAt: Date = new Date('2026-06-01T00:00:00Z')) {
        return {
            id: 'pos-1',
            clientOrderId: 'tbvt-funding-1',
            symbol: 'BTCUSDT',
            side,
            entryPrice: parseMoney('30000'),
            size: parseMoney('0.01'),
            leverage: 5,
            openedAt,
        };
    }

    beforeEach(() => {
        alertSink = { publish: jest.fn().mockResolvedValue(undefined) };
        stateService = {
            getOpenPositions: jest.fn(),
            getLastMarkPrice: jest.fn().mockReturnValue(parseMoney('30000')),
            applyFunding: jest.fn().mockResolvedValue(undefined),
            appendStandaloneAuditRow: jest.fn().mockResolvedValue(undefined),
        };
        service = new PaperFundingAccrualService(
            buildAppConfig(),
            stateService as unknown as PaperAccountStateService,
            new PaperStateAuditHmacCodec(),
            alertSink,
        );
    });

    function makeFundingEvent(rate: string, fundingTimeMs: number = Date.parse('2026-06-01T08:00:00Z')): IFundingRateObservedEvent {
        return { symbol: 'BTCUSDT', fundingTimeMs, rate: parseMoney(rate) };
    }

    it('LONG + positive rate → negative funding amount (long pays)', async () => {
        stateService.getOpenPositions.mockReturnValue([buildPosition(PositionSideEnum.LONG)] as never);

        await service.onFundingObserved(makeFundingEvent('0.0001'));

        expect(stateService.applyFunding).toHaveBeenCalledTimes(1);
        const call = stateService.applyFunding.mock.calls[0][0];
        // notional = 0.01 * 30000 = 300; funding = -300 * 0.0001 * 1 = -0.03
        expect(call.fundingAmountUsdt.toFixed()).toBe('-0.03');
    });

    it('SHORT + positive rate → positive funding amount (short receives)', async () => {
        stateService.getOpenPositions.mockReturnValue([buildPosition(PositionSideEnum.SHORT)] as never);

        await service.onFundingObserved(makeFundingEvent('0.0001'));

        const call = stateService.applyFunding.mock.calls[0][0];
        expect(call.fundingAmountUsdt.toFixed()).toBe('0.03');
    });

    it('LONG + negative rate → positive funding amount (long receives)', async () => {
        stateService.getOpenPositions.mockReturnValue([buildPosition(PositionSideEnum.LONG)] as never);

        await service.onFundingObserved(makeFundingEvent('-0.0001'));

        const call = stateService.applyFunding.mock.calls[0][0];
        expect(call.fundingAmountUsdt.toFixed()).toBe('0.03');
    });

    it('position opened AFTER funding ts → no accrual', async () => {
        const fundingTs = Date.parse('2026-06-01T08:00:00Z');
        stateService.getOpenPositions.mockReturnValue([
            buildPosition(PositionSideEnum.LONG, new Date(fundingTs + 60_000)),
        ] as never);

        await service.onFundingObserved(makeFundingEvent('0.0001', fundingTs));

        expect(stateService.applyFunding).not.toHaveBeenCalled();
    });

    it('rate above cap → applies anyway + writes FUNDING_CAP_BREACH audit row + CRITICAL alert', async () => {
        stateService.getOpenPositions.mockReturnValue([buildPosition(PositionSideEnum.LONG)] as never);

        // 0.01 > 0.0075 cap
        await service.onFundingObserved(makeFundingEvent('0.01'));

        expect(stateService.applyFunding).toHaveBeenCalledTimes(1);
        expect(stateService.appendStandaloneAuditRow).toHaveBeenCalledTimes(1);
        expect(stateService.appendStandaloneAuditRow).toHaveBeenCalledWith(
            expect.objectContaining({ mutationKind: MutationKindEnum.FUNDING_CAP_BREACH }),
        );
        expect(alertSink.publish).toHaveBeenCalledTimes(1);
        expect(alertSink.publish.mock.calls[0][0].severity).toBe(AlertSeverityEnum.CRITICAL);
    });

    it('no open positions → silent no-op', async () => {
        stateService.getOpenPositions.mockReturnValue([]);

        await service.onFundingObserved(makeFundingEvent('0.0001'));

        expect(stateService.applyFunding).not.toHaveBeenCalled();
        expect(alertSink.publish).not.toHaveBeenCalled();
    });

    it('falls back to entryPrice when no cached mark is available', async () => {
        stateService.getOpenPositions.mockReturnValue([buildPosition(PositionSideEnum.LONG)] as never);
        stateService.getLastMarkPrice.mockReturnValue(null);

        await service.onFundingObserved(makeFundingEvent('0.0001'));

        // entryPrice = 30000 → notional 300 → -0.03
        expect(stateService.applyFunding.mock.calls[0][0].fundingAmountUsdt.toFixed()).toBe('-0.03');
    });

    it('does nothing when EXCHANGE_ENV !== PAPER (defence-in-depth)', async () => {
        const liveService = new PaperFundingAccrualService(
            buildAppConfig(ExchangeEnvironmentEnum.LIVE),
            stateService as unknown as PaperAccountStateService,
            new PaperStateAuditHmacCodec(),
            alertSink,
        );

        await liveService.onFundingObserved(makeFundingEvent('0.01'));

        expect(stateService.applyFunding).not.toHaveBeenCalled();
        expect(stateService.appendStandaloneAuditRow).not.toHaveBeenCalled();
    });
});

// ===== Item 4 — Chain-integrity walker =====

describe('PaperAccountStateService.hydrateOnBoot — R2c.D Item 4 chain walker', () => {
    it('clean chain → boots without throwing', async () => {
        const store = emptyStore();
        const { service } = buildStateService(store, buildAppConfig(), new EventEmitter2());

        await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
        // The META_INIT row written by the fresh-soak branch carries a valid
        // HMAC (computed by the fake repo using the service's own codec) so
        // subsequent boots over the same store re-verify cleanly.
        expect(store.audit.length).toBeGreaterThan(0);
    });

    it('tampered HMAC → PaperAccountStateBootException at boot', async () => {
        // First boot to populate the chain.
        const store = emptyStore();
        const { service: first } = buildStateService(store, buildAppConfig(), new EventEmitter2());
        await first.onApplicationBootstrap();
        expect(store.audit).toHaveLength(1);

        // Tamper with the HMAC.
        store.audit[0].thisRowHmac = Buffer.alloc(32, 0xab);

        // Second boot must abort.
        const { service: second } = buildStateService(store, buildAppConfig(), new EventEmitter2());

        await expect(second.onApplicationBootstrap()).rejects.toThrow(PaperAccountStateBootException);
    });

    it('tampered prev_row_hash linkage → PaperAccountStateBootException at boot', async () => {
        // Build a two-row chain by booting + opening a position.
        const store = emptyStore();
        const emitter = new EventEmitter2();
        const { service: first } = buildStateService(store, buildAppConfig(), emitter);
        await first.onApplicationBootstrap();
        await first.openPosition({
            clientOrderId: 'tbvt-walker-1',
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            entryPrice: parseMoney('30000'),
            size: parseMoney('0.01'),
            leverage: 5,
            openedAt: new Date('2026-06-01T00:00:00Z'),
        });
        expect(store.audit).toHaveLength(2);

        // Break the linkage on the second row WITHOUT re-signing.
        store.audit[1].prevRowHash = Buffer.alloc(32, 0x77);

        const { service: second } = buildStateService(store, buildAppConfig(), new EventEmitter2());
        await expect(second.onApplicationBootstrap()).rejects.toThrow(PaperAccountStateBootException);
    });
});
