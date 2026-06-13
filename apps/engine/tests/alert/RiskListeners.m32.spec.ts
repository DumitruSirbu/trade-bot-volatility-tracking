/**
 * RiskListeners — M32 position-event listener wiring (§4.3 + §4.4)
 *
 * Surfaces under test:
 *   RL_M32_1 — onPositionOpened builds a body with side uppercased, leverage as Nx,
 *              and entry price; publishes an POSITION_OPENED alert.
 *   RL_M32_2 — onPositionClosed builds a body with (net), exit reason, hold duration,
 *              and leverage as Nx; publishes a POSITION_CLOSED alert.
 *   RL_M32_3 — onPositionClosed with null exitPrice and null realizedPnl → body
 *              contains 'n/a' for both fields; does NOT contain '$0.00'.
 *   RL_M32_4 — publishSafe swallows a thrown error from IAlertSink.publish so
 *              neither onPositionOpened nor onPositionClosed propagates the rejection.
 */

import { AlertTypeEnum, ExitReasonEnum, IAlertPayload, PositionSideEnum, PositionSlotEnum } from '@bot/shared';

import { HaltFlagService } from '../../src/common/service/HaltFlagService';
import { RiskListeners } from '../../src/alert/listeners/RiskListeners';
import { IPositionOpenedEvent } from '../../src/common/interface/IPositionOpenedEvent';
import { IPositionClosedEvent } from '../../src/common/interface/IPositionClosedEvent';
import { Money } from '../../src/common/utils/money';
import { IAlertSink } from '../../src/alert/sink/AlertSinkModule';

// ─── fixture helpers ──────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-06-10T14:00:00.000Z');
const OPENED_AT = new Date('2026-06-10T12:00:00.000Z');
const CLOSED_AT = new Date('2026-06-10T13:30:00.000Z');

function buildOpened(overrides: Partial<IPositionOpenedEvent> = {}): IPositionOpenedEvent {
    return {
        positionId: 7,
        symbol: 'ETH/USDT:USDT',
        side: PositionSideEnum.LONG,
        leverage: new Money('5'),
        entryPrice: new Money('3800.50'),
        entryNotional: new Money('950'),
        strategyVersionId: 2,
        ...overrides,
    };
}

function buildClosed(overrides: Partial<IPositionClosedEvent> = {}): IPositionClosedEvent {
    return {
        positionId: 7,
        symbol: 'ETH/USDT:USDT',
        side: PositionSideEnum.LONG,
        exitReason: ExitReasonEnum.TAKE_PROFIT,
        realizedPnl: new Money('14.25'),
        closedAt: CLOSED_AT,
        entryPrice: new Money('3800.50'),
        exitPrice: new Money('3857.00'),
        leverage: new Money('5'),
        strategyVersionId: 2,
        openedAt: OPENED_AT,
        positionSlot: PositionSlotEnum.A,
        ...overrides,
    };
}

type RecordingAlerts = IAlertSink & { published: IAlertPayload[] };

function buildListeners(publishImpl?: () => Promise<void>): {
    listeners: RiskListeners;
    alerts: RecordingAlerts;
    haltFlag: HaltFlagService;
} {
    const published: IAlertPayload[] = [];

    const alerts: RecordingAlerts = {
        published,
        async publish(payload: IAlertPayload): Promise<void> {
            if (publishImpl) {
                await publishImpl();
            }
            published.push(payload);
        },
    };

    const haltFlag = new HaltFlagService();
    const haltServiceStub = {
        notePragmaticTransition: jest.fn(),
        notePragmaticAutoClear: jest.fn(),
    };
    const clock = { now: () => FIXED_NOW };

    const listeners = new RiskListeners(haltFlag, alerts as any, clock as any, haltServiceStub as any);

    return { listeners, alerts, haltFlag };
}

// ─── RL_M32_1: onPositionOpened payload content ───────────────────────────────

describe('RiskListeners M32 — RL_M32_1: onPositionOpened builds enriched alert body', () => {
    it('publishes a POSITION_OPENED alert', async () => {
        const { listeners, alerts } = buildListeners();

        await listeners.onPositionOpened(buildOpened());

        expect(alerts.published).toHaveLength(1);
        expect(alerts.published[0]!.type).toBe(AlertTypeEnum.POSITION_OPENED);
    });

    it('alert body contains the side in uppercase', async () => {
        const { listeners, alerts } = buildListeners();

        await listeners.onPositionOpened(buildOpened({ side: PositionSideEnum.LONG }));

        expect(alerts.published[0]!.body).toContain('LONG');
    });

    it('alert body contains leverage as Nx, not as a dollar amount', async () => {
        const { listeners, alerts } = buildListeners();

        await listeners.onPositionOpened(buildOpened({ leverage: new Money('5') }));

        expect(alerts.published[0]!.body).toContain('5x');
        expect(alerts.published[0]!.body).not.toContain('$5.00');
    });

    it('alert body contains the entry price', async () => {
        const { listeners, alerts } = buildListeners();

        await listeners.onPositionOpened(buildOpened({ entryPrice: new Money('3800.50') }));

        expect(alerts.published[0]!.body).toContain('$3,800.50');
    });

    it('alert title contains the symbol', async () => {
        const { listeners, alerts } = buildListeners();

        await listeners.onPositionOpened(buildOpened({ symbol: 'ETH/USDT:USDT' }));

        expect(alerts.published[0]!.title).toContain('ETH/USDT:USDT');
    });

    it('alert body contains the strategy version', async () => {
        const { listeners, alerts } = buildListeners();

        await listeners.onPositionOpened(buildOpened({ strategyVersionId: 3 }));

        expect(alerts.published[0]!.body).toContain('strat v3');
    });
});

// ─── RL_M32_2: onPositionClosed payload content ──────────────────────────────

describe('RiskListeners M32 — RL_M32_2: onPositionClosed builds enriched alert body', () => {
    it('publishes a POSITION_CLOSED alert', async () => {
        const { listeners, alerts } = buildListeners();

        await listeners.onPositionClosed(buildClosed());

        expect(alerts.published).toHaveLength(1);
        expect(alerts.published[0]!.type).toBe(AlertTypeEnum.POSITION_CLOSED);
    });

    it('alert body contains the (net) label', async () => {
        const { listeners, alerts } = buildListeners();

        await listeners.onPositionClosed(buildClosed());

        expect(alerts.published[0]!.body).toContain('(net)');
    });

    it('alert body contains the exit reason', async () => {
        const { listeners, alerts } = buildListeners();

        await listeners.onPositionClosed(buildClosed({ exitReason: ExitReasonEnum.STOP_LOSS }));

        expect(alerts.published[0]!.body).toContain('exit: stop_loss');
    });

    it('alert body contains the hold duration derived from openedAt and closedAt', async () => {
        // OPENED_AT=12:00, CLOSED_AT=13:30 → 1h 30m
        const { listeners, alerts } = buildListeners();

        await listeners.onPositionClosed(buildClosed({ openedAt: OPENED_AT, closedAt: CLOSED_AT }));

        expect(alerts.published[0]!.body).toContain('held 1h 30m');
    });

    it('alert body contains leverage as Nx, not as a dollar amount', async () => {
        const { listeners, alerts } = buildListeners();

        await listeners.onPositionClosed(buildClosed({ leverage: new Money('5') }));

        expect(alerts.published[0]!.body).toContain('5x');
        expect(alerts.published[0]!.body).not.toContain('$5.00');
    });

    it('alert title contains the symbol', async () => {
        const { listeners, alerts } = buildListeners();

        await listeners.onPositionClosed(buildClosed({ symbol: 'ETH/USDT:USDT' }));

        expect(alerts.published[0]!.title).toContain('ETH/USDT:USDT');
    });
});

// ─── RL_M32_3: onPositionClosed with null exit fields ────────────────────────

describe('RiskListeners M32 — RL_M32_3: onPositionClosed with null exitPrice and null realizedPnl', () => {
    it('alert body shows n/a for exit price, not $0.00', async () => {
        const { listeners, alerts } = buildListeners();

        await listeners.onPositionClosed(buildClosed({ exitPrice: null }));

        expect(alerts.published[0]!.body).toContain('exit n/a');
        expect(alerts.published[0]!.body).not.toContain('exit $0.00');
    });

    it('alert body shows n/a for realized PnL, not a fabricated amount', async () => {
        const { listeners, alerts } = buildListeners();

        await listeners.onPositionClosed(buildClosed({ realizedPnl: null }));

        expect(alerts.published[0]!.body).toContain('realized n/a (net)');
        expect(alerts.published[0]!.body).not.toContain('realized +$0.00');
    });

    it('alert body shows n/a for hold duration when closedAt is null', async () => {
        const { listeners, alerts } = buildListeners();

        await listeners.onPositionClosed(buildClosed({ closedAt: null }));

        expect(alerts.published[0]!.body).toContain('held n/a');
    });

    it('alert is still published even when all nullable fields are null', async () => {
        const { listeners, alerts } = buildListeners();

        await listeners.onPositionClosed(buildClosed({ exitPrice: null, realizedPnl: null, closedAt: null }));

        expect(alerts.published).toHaveLength(1);
        expect(alerts.published[0]!.type).toBe(AlertTypeEnum.POSITION_CLOSED);
    });
});

// ─── RL_M32_4: publishSafe is fire-and-forget — never propagates errors ───────

describe('RiskListeners M32 — RL_M32_4: publishSafe swallows IAlertSink.publish errors', () => {
    it('onPositionOpened does not propagate a rejection from IAlertSink.publish', async () => {
        const throwingPublish = jest.fn().mockRejectedValue(new Error('telegram unavailable'));
        const haltFlag = new HaltFlagService();
        const alerts = { publish: throwingPublish };
        const haltServiceStub = { notePragmaticTransition: jest.fn(), notePragmaticAutoClear: jest.fn() };
        const clock = { now: () => FIXED_NOW };

        const listeners = new RiskListeners(haltFlag, alerts as any, clock as any, haltServiceStub as any);

        await expect(listeners.onPositionOpened(buildOpened())).resolves.toBeUndefined();
    });

    it('onPositionClosed does not propagate a rejection from IAlertSink.publish', async () => {
        const throwingPublish = jest.fn().mockRejectedValue(new Error('telegram unavailable'));
        const haltFlag = new HaltFlagService();
        const alerts = { publish: throwingPublish };
        const haltServiceStub = { notePragmaticTransition: jest.fn(), notePragmaticAutoClear: jest.fn() };
        const clock = { now: () => FIXED_NOW };

        const listeners = new RiskListeners(haltFlag, alerts as any, clock as any, haltServiceStub as any);

        await expect(listeners.onPositionClosed(buildClosed())).resolves.toBeUndefined();
    });
});
