/**
 * Adversarial tests for the M11a R2d Item 1 PaperReconciliationAdapter
 * (ADR 0032 §D12). Asserts the in-memory-vs-persisted diff classifies
 * every drift class, halts CRITICAL on first drift, suppresses re-halt on
 * subsequent ticks (no telegram-spam), and short-circuits under
 * EXCHANGE_ENV !== PAPER.
 *
 * The harness fakes only the boundary collaborators
 * (PaperAccountStateService.getOpenPositions + PaperAccountStateRepository.findAllOpen);
 * real EventEmitter2 + HaltFlagService instances are used so the event
 * + halt-flag wiring is exercised end-to-end.
 */

import {
    AlertSeverityEnum,
    AlertTypeEnum,
    DriftCaseEnum,
    ExchangeEnvironmentEnum,
    IAlertPayload,
    IReconciliationDriftDetectedEvent,
    PositionSideEnum,
} from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { IAlertSink } from '../../alert/sink/AlertSinkModule';
import { HaltFlagService } from '../../common/service/HaltFlagService';
import { parseMoney } from '../../common/utils';
import { AppConfigService } from '../../config/service';
import { HaltService } from '../../control/HaltService';
import { RECONCILIATION_DRIFT_DETECTED_EVENT } from '../../position/const';
import { PaperAccountStateEntity } from '../entity/PaperAccountStateEntity';
import { IPaperPositionView } from '../interface';
import { PaperAccountStateRepository } from '../repository/PaperAccountStateRepository';
import { PaperAccountStateService } from '../service/PaperAccountStateService';
import { PaperReconciliationAdapter } from '../service/PaperReconciliationAdapter';

function buildAppConfig(env: ExchangeEnvironmentEnum = ExchangeEnvironmentEnum.PAPER): AppConfigService {
    return {
        exchangeEnv: env,
        paperNullityProbeIntervalMs: 60_000,
        paperNullityProbeBackoffMaxMs: 3_600_000,
    } as unknown as AppConfigService;
}

function buildPosition(overrides: Partial<IPaperPositionView> = {}): IPaperPositionView {
    return {
        id: overrides.id ?? 'pos-id-1',
        clientOrderId: overrides.clientOrderId ?? 'coid-1',
        symbol: overrides.symbol ?? 'BTCUSDT',
        side: overrides.side ?? PositionSideEnum.LONG,
        entryPrice: overrides.entryPrice ?? parseMoney('30000'),
        size: overrides.size ?? parseMoney('0.5'),
        leverage: overrides.leverage ?? 5,
        openedAt: overrides.openedAt ?? new Date(),
    };
}

function buildEntity(overrides: Partial<PaperAccountStateEntity> = {}): PaperAccountStateEntity {
    return {
        id: 'pos-id-1',
        clientOrderId: 'coid-1',
        symbol: 'BTCUSDT',
        side: PositionSideEnum.LONG,
        entryPrice: parseMoney('30000'),
        size: parseMoney('0.5'),
        leverage: 5,
        openedAt: new Date(),
        mode: 'paper',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    } as PaperAccountStateEntity;
}

function buildAdapter(args: {
    env?: ExchangeEnvironmentEnum;
    inMemory: readonly IPaperPositionView[];
    persisted: readonly PaperAccountStateEntity[];
    alertSink?: IAlertSink;
}) {
    const events = new EventEmitter2();
    const halt = new HaltFlagService();
    const haltService = { notePragmaticTransition: jest.fn() } as unknown as HaltService;
    const accountState = {
        getOpenPositions: jest.fn(() => [...args.inMemory]),
    } as unknown as PaperAccountStateService;
    const stateRepo = {
        findAllOpen: jest.fn(async () => [...args.persisted]),
    } as unknown as PaperAccountStateRepository;
    const alertSink: IAlertSink = args.alertSink ?? {
        publish: jest.fn(async () => undefined),
    };

    const adapter = new PaperReconciliationAdapter(buildAppConfig(args.env), accountState, stateRepo, halt, haltService, events, alertSink);

    return { adapter, events, halt, haltService, alertSink, accountState, stateRepo };
}

describe('PaperReconciliationAdapter (ADR 0032 §D12)', () => {
    it('no drift when in-memory matches persisted state', async () => {
        const view = buildPosition();
        const entity = buildEntity();
        const { adapter, halt, alertSink } = buildAdapter({ inMemory: [view], persisted: [entity] });

        const pass = await adapter.forceTick(Date.now());

        expect(pass.driftCount).toBe(0);
        expect(halt.isHalted()).toBe(false);
        expect(alertSink.publish as jest.Mock).not.toHaveBeenCalled();
    });

    it('in-memory has position not in persisted → CRITICAL drift event + halt', async () => {
        const view = buildPosition({ clientOrderId: 'coid-mem-only' });
        const events: IReconciliationDriftDetectedEvent[] = [];
        const {
            adapter,
            events: bus,
            halt,
            alertSink,
            haltService,
        } = buildAdapter({
            inMemory: [view],
            persisted: [],
        });
        bus.on(RECONCILIATION_DRIFT_DETECTED_EVENT, (e: IReconciliationDriftDetectedEvent) => events.push(e));

        const pass = await adapter.forceTick(Date.now());

        expect(pass.driftCount).toBe(1);
        expect(halt.isHalted()).toBe(true);
        expect(haltService.notePragmaticTransition).toHaveBeenCalledTimes(1);
        expect(alertSink.publish as jest.Mock).toHaveBeenCalledTimes(1);
        const payload: IAlertPayload = (alertSink.publish as jest.Mock).mock.calls[0][0];
        expect(payload.severity).toBe(AlertSeverityEnum.CRITICAL);
        expect(payload.type).toBe(AlertTypeEnum.MODEL_DIVERGENCE_ENGAGED);
        expect(events).toHaveLength(1);
        expect(events[0].driftCase).toBe(DriftCaseEnum.EXCHANGE_NOT_IN_DB);
    });

    it('persisted has row not in in-memory → CRITICAL drift event + halt', async () => {
        const entity = buildEntity({ clientOrderId: 'coid-db-only' });
        const events: IReconciliationDriftDetectedEvent[] = [];
        const {
            adapter,
            events: bus,
            halt,
            alertSink,
        } = buildAdapter({
            inMemory: [],
            persisted: [entity],
        });
        bus.on(RECONCILIATION_DRIFT_DETECTED_EVENT, (e) => events.push(e));

        const pass = await adapter.forceTick(Date.now());

        expect(pass.driftCount).toBe(1);
        expect(halt.isHalted()).toBe(true);
        expect(alertSink.publish as jest.Mock).toHaveBeenCalledTimes(1);
        expect(events[0].driftCase).toBe(DriftCaseEnum.DB_OPEN_NOT_ON_EXCHANGE);
        expect(events[0].dbQty).toBe(entity.size.toFixed());
        expect(events[0].exchangeQty).toBeNull();
    });

    it('size drift on matched pair → CRITICAL halt', async () => {
        const view = buildPosition({ size: parseMoney('0.5') });
        const entity = buildEntity({ size: parseMoney('0.4') });
        const events: IReconciliationDriftDetectedEvent[] = [];
        const { adapter, events: bus, halt } = buildAdapter({ inMemory: [view], persisted: [entity] });
        bus.on(RECONCILIATION_DRIFT_DETECTED_EVENT, (e) => events.push(e));

        const pass = await adapter.forceTick(Date.now());

        expect(pass.driftCount).toBe(1);
        expect(halt.isHalted()).toBe(true);
        expect(events[0].driftCase).toBe(DriftCaseEnum.QTY_MISMATCH);
    });

    it('entry-price drift on matched pair → CRITICAL halt', async () => {
        const view = buildPosition({ entryPrice: parseMoney('30000') });
        const entity = buildEntity({ entryPrice: parseMoney('30100') });
        const { adapter, halt, alertSink } = buildAdapter({ inMemory: [view], persisted: [entity] });

        const pass = await adapter.forceTick(Date.now());

        expect(pass.driftCount).toBe(1);
        expect(halt.isHalted()).toBe(true);
        expect(alertSink.publish as jest.Mock).toHaveBeenCalledTimes(1);
    });

    it('side drift on matched pair → SIDE_MISMATCH drift case', async () => {
        const view = buildPosition({ side: PositionSideEnum.LONG });
        const entity = buildEntity({ side: PositionSideEnum.SHORT });
        const events: IReconciliationDriftDetectedEvent[] = [];
        const { adapter, events: bus, halt } = buildAdapter({ inMemory: [view], persisted: [entity] });
        bus.on(RECONCILIATION_DRIFT_DETECTED_EVENT, (e) => events.push(e));

        await adapter.forceTick(Date.now());

        expect(halt.isHalted()).toBe(true);
        expect(events[0].driftCase).toBe(DriftCaseEnum.SIDE_MISMATCH);
    });

    it('second drift in same process does NOT re-alert (one-shot latch)', async () => {
        const view = buildPosition({ clientOrderId: 'coid-mem-only' });
        const { adapter, alertSink } = buildAdapter({ inMemory: [view], persisted: [] });

        await adapter.forceTick(Date.now());
        await adapter.forceTick(Date.now());

        // Both ticks emit events for forensic visibility but only the FIRST
        // tick triggers the CRITICAL telegram alert.
        expect(alertSink.publish as jest.Mock).toHaveBeenCalledTimes(1);
    });

    it('forceTick short-circuits when EXCHANGE_ENV !== PAPER (defence in depth)', async () => {
        const view = buildPosition({ clientOrderId: 'coid-mem-only' });
        const { adapter, halt, alertSink, accountState } = buildAdapter({
            env: ExchangeEnvironmentEnum.TESTNET,
            inMemory: [view],
            persisted: [],
        });

        const pass = await adapter.forceTick(Date.now());

        expect(pass.driftCount).toBe(0);
        expect(halt.isHalted()).toBe(false);
        expect(alertSink.publish as jest.Mock).not.toHaveBeenCalled();
        // Should not even touch the in-memory state under non-PAPER.
        expect(accountState.getOpenPositions).not.toHaveBeenCalled();
    });

    it('scheduledTick returns null under non-PAPER (no-op)', async () => {
        const { adapter, accountState } = buildAdapter({
            env: ExchangeEnvironmentEnum.LIVE,
            inMemory: [],
            persisted: [],
        });

        const pass = await adapter.scheduledTick(Date.now());

        expect(pass).toBeNull();
        expect(accountState.getOpenPositions).not.toHaveBeenCalled();
    });

    it('multiple simultaneous drifts emit one event per drift', async () => {
        const memOnly = buildPosition({ clientOrderId: 'coid-mem' });
        const dbOnly = buildEntity({ clientOrderId: 'coid-db', id: 'pos-id-2' });
        const events: IReconciliationDriftDetectedEvent[] = [];
        const { adapter, events: bus } = buildAdapter({
            inMemory: [memOnly],
            persisted: [dbOnly],
        });
        bus.on(RECONCILIATION_DRIFT_DETECTED_EVENT, (e) => events.push(e));

        const pass = await adapter.forceTick(Date.now());

        expect(pass.driftCount).toBe(2);
        expect(events).toHaveLength(2);
    });
});
