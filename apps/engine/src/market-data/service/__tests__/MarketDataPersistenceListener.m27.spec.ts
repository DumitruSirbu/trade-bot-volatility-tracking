/**
 * MarketDataPersistenceListener — M27 book snapshot writer tests (A5/A6)
 *
 * Tests:
 *   M27-MDL-1  — Written row joins decision by event_id (field populated on the entity)
 *   M27-MDL-2  — UNIQUE index idempotency: writing the same event_id twice → second write is
 *                silently swallowed (no throw to caller)
 *   M27-MDL-3  — Writer is best-effort: a repository save failure does NOT throw into the caller
 *   M27-MDL-4  — spread/depth fields (bidAskSpreadPct, bookDepth10bpsUsdt, bookDepth50bpsUsdt)
 *                are populated on the saved entity
 *   M27-MDL-5  — No event_id on event → writer skips (no save called)
 *   M27-MDL-6  — Empty string event_id → writer skips (trimmed to falsy)
 *   M27-MDL-7  — Whitespace-only event_id → writer skips (trimmed to falsy)
 *   M27-MDL-8  — Non-duplicate save error is swallowed with a warn log (not thrown)
 */

import { IVolatilityDetectedEvent } from '@bot/shared';

import { BookSnapshotRepository } from '../../repository/BookSnapshotRepository';
import { MarketDataPersistenceListener } from '../MarketDataPersistenceListener';
import { CandleRepository } from '../../repository/CandleRepository';
import { FundingRateRepository } from '../../repository/FundingRateRepository';
import { InstrumentRepository } from '../../repository/InstrumentRepository';
import { OpenInterestRepository } from '../../repository/OpenInterestRepository';
import { TickAggregateRepository } from '../../repository/TickAggregateRepository';
import { UniverseMembershipRepository } from '../../repository/UniverseMembershipRepository';

// ─── constants ─────────────────────────────────────────────────────────────────

const BAR_OPEN_MS = new Date('2026-06-01T12:00:00.000Z').getTime();
const EVENT_ID = 'ETHUSDT:1748779200000';
const SYMBOL = 'ETHUSDT';

// ─── event factory ─────────────────────────────────────────────────────────────

function buildVolatilityEvent(overrides: Partial<IVolatilityDetectedEvent> = {}): IVolatilityDetectedEvent {
    return {
        symbol: SYMBOL,
        side: 'above' as any,
        entryCandleOpenTime: BAR_OPEN_MS,
        eventId: EVENT_ID,
        vwapSession: '3000',
        vwap20bar: '3000',
        vwapAnchorType: 'session' as any,
        vwapDeviationPct: 2.5,
        vwapDeviationSigma: 2.1,
        volumeRatio: 2.0,
        volume20barAvg: '500000',
        atr14: '80',
        adx14: 28,
        adxDiPlus: 22,
        adxDiMinus: 12,
        rsi14: 60,
        bollingerUpper: '3100',
        bollingerLower: '2900',
        bollingerPctB: 0.8,
        btc5mMovePct: 0.2,
        btc1mMovePct: 0.1,
        eth5mMovePct: 2.0,
        idiosyncrasyScore: 0.7,
        coinTier: 'tier_1' as any,
        coinVolumeRank: 2,
        symbolUniverseAgeHours: 150,
        fundingRate: 0.0001,
        fundingRateAnnualized: 0.07,
        bidAskSpreadPct: 0.02,
        bookDepth10bpsUsdt: '25000',
        bookDepth50bpsUsdt: '100000',
        regimeLabel: 'trending_up' as any,
        marketBreadth5mUpPct: 55,
        sameBarTriggerCount: 1,
        openInterest: '300000000',
        openInterestChange5mPct: 0.2,
        openInterestChange15mPct: 0.4,
        aggTradeBuyVolumeRatio: 0.65,
        flowType: 'trend_initiation' as any,
        ...overrides,
    };
}

// ─── service factory ───────────────────────────────────────────────────────────

interface IListenerContext {
    listener: MarketDataPersistenceListener;
    bookSnapshotsMock: jest.MockedObject<BookSnapshotRepository>;
    loggerWarnSpy: jest.SpyInstance;
    loggerDebugSpy: jest.SpyInstance;
}

function buildListener(bookSnapshotsImpl: { record: jest.Mock }): IListenerContext {
    const candlesMock = { upsertClosed: jest.fn().mockResolvedValue(undefined) } as unknown as CandleRepository;
    const tickAggregatesMock = { recordSample: jest.fn().mockResolvedValue(undefined) } as unknown as TickAggregateRepository;
    const openInterestMock = { recordSample: jest.fn().mockResolvedValue(undefined) } as unknown as OpenInterestRepository;
    const fundingRatesMock = { recordObservation: jest.fn().mockResolvedValue(undefined) } as unknown as FundingRateRepository;
    const instrumentsMock = { upsertBySymbol: jest.fn().mockResolvedValue(undefined) } as unknown as InstrumentRepository;
    const membershipMock = {
        openMembership: jest.fn().mockResolvedValue(undefined),
        closeOpenMembership: jest.fn().mockResolvedValue(undefined),
        changeTier: jest.fn().mockResolvedValue(undefined),
    } as unknown as UniverseMembershipRepository;

    const bookSnapshotsMock = bookSnapshotsImpl as unknown as jest.MockedObject<BookSnapshotRepository>;

    const listener = new MarketDataPersistenceListener(
        candlesMock,
        tickAggregatesMock,
        openInterestMock,
        fundingRatesMock,
        instrumentsMock,
        membershipMock,
        bookSnapshotsMock,
    );

    const loggerWarnSpy = jest.spyOn((listener as any).logger, 'warn').mockImplementation(() => undefined);
    const loggerDebugSpy = jest.spyOn((listener as any).logger, 'debug').mockImplementation(() => undefined);

    jest.spyOn((listener as any).logger, 'log').mockImplementation(() => undefined);
    jest.spyOn((listener as any).logger, 'error').mockImplementation(() => undefined);

    return { listener, bookSnapshotsMock, loggerWarnSpy, loggerDebugSpy };
}

// ─── M27-MDL-1: Written row joins decision by event_id ────────────────────────

describe('MarketDataPersistenceListener M27 — M27-MDL-1: written row carries the event_id for decision rejoin', () => {
    it('record() is called with eventId matching the volatility event eventId', async () => {
        const recordMock = jest.fn().mockResolvedValue({ id: 1 });
        const { listener } = buildListener({ record: recordMock });

        await listener.onVolatilityDetected(buildVolatilityEvent());

        expect(recordMock).toHaveBeenCalledTimes(1);
        const [savedPayload] = recordMock.mock.calls[0];
        expect(savedPayload.eventId).toBe(EVENT_ID);
    });

    it('record() is called with the correct symbol', async () => {
        const recordMock = jest.fn().mockResolvedValue({ id: 1 });
        const { listener } = buildListener({ record: recordMock });

        await listener.onVolatilityDetected(buildVolatilityEvent());

        const [savedPayload] = recordMock.mock.calls[0];
        expect(savedPayload.symbol).toBe(SYMBOL);
    });
});

// ─── M27-MDL-2: UNIQUE idempotency — duplicate key is swallowed ───────────────

describe('MarketDataPersistenceListener M27 — M27-MDL-2: duplicate event_id write is silently swallowed', () => {
    it('a duplicate-key error does NOT throw to the caller', async () => {
        const duplicateError = new Error('duplicate key value violates unique constraint "idx_book_snapshots_event_id"');
        const recordMock = jest.fn().mockRejectedValue(duplicateError);
        const { listener } = buildListener({ record: recordMock });

        // Must not throw
        await expect(listener.onVolatilityDetected(buildVolatilityEvent())).resolves.toBeUndefined();
    });

    it('a duplicate-key error produces a debug log, not a warn/error', async () => {
        const duplicateError = new Error('duplicate key violates unique constraint on event_id');
        const recordMock = jest.fn().mockRejectedValue(duplicateError);
        const { listener, loggerDebugSpy } = buildListener({ record: recordMock });

        await listener.onVolatilityDetected(buildVolatilityEvent());

        expect(loggerDebugSpy).toHaveBeenCalledTimes(1);
        const debugMessage = loggerDebugSpy.mock.calls[0][0] as string;
        expect(debugMessage).toContain(EVENT_ID);
    });

    it('a unique-constraint error variant is also swallowed', async () => {
        const uniqueConstraintError = new Error('unique constraint "uk_book_snapshots_event_id" violated');
        const recordMock = jest.fn().mockRejectedValue(uniqueConstraintError);
        const { listener } = buildListener({ record: recordMock });

        await expect(listener.onVolatilityDetected(buildVolatilityEvent())).resolves.toBeUndefined();
    });
});

// ─── M27-MDL-3: Best-effort — save failure does not throw ────────────────────

describe('MarketDataPersistenceListener M27 — M27-MDL-3: writer is best-effort — save failure does not throw', () => {
    it('a generic database error is swallowed and does not propagate to the caller', async () => {
        const dbError = new Error('connection timeout during book_snapshots insert');
        const recordMock = jest.fn().mockRejectedValue(dbError);
        const { listener } = buildListener({ record: recordMock });

        await expect(listener.onVolatilityDetected(buildVolatilityEvent())).resolves.toBeUndefined();
    });

    it('a non-duplicate error produces a warn log (not error or throw)', async () => {
        const dbError = new Error('database write error (non-duplicate)');
        const recordMock = jest.fn().mockRejectedValue(dbError);
        const { listener, loggerWarnSpy } = buildListener({ record: recordMock });

        await listener.onVolatilityDetected(buildVolatilityEvent());

        expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
        const warnMessage = loggerWarnSpy.mock.calls[0][0] as string;
        expect(warnMessage).toContain(EVENT_ID);
    });

    it('even on error, the event handler resolves (never rejects)', async () => {
        const recordMock = jest.fn().mockRejectedValue(new Error('disk full'));
        const { listener } = buildListener({ record: recordMock });

        const result = listener.onVolatilityDetected(buildVolatilityEvent());

        await expect(result).resolves.toBeUndefined();
    });
});

// ─── M27-MDL-4: spread/depth fields are populated ────────────────────────────

describe('MarketDataPersistenceListener M27 — M27-MDL-4: spread/depth aggregates are populated on the saved entity', () => {
    it('spread, depth10bps, depth50bps are passed to record() from the event fields', async () => {
        const recordMock = jest.fn().mockResolvedValue({ id: 1 });
        const { listener } = buildListener({ record: recordMock });

        const event = buildVolatilityEvent({
            bidAskSpreadPct: 0.03,
            bookDepth10bpsUsdt: '30000',
            bookDepth50bpsUsdt: '150000',
        });

        await listener.onVolatilityDetected(event);

        expect(recordMock).toHaveBeenCalledTimes(1);
        const [payload] = recordMock.mock.calls[0];

        // spread is populated (derived from bidAskSpreadPct)
        expect(payload.spread).toBeDefined();
        // depth10bps is populated (derived from bookDepth10bpsUsdt)
        expect(payload.depth10bps).toBeDefined();
        // depth50bps is populated (derived from bookDepth50bpsUsdt)
        expect(payload.depth50bps).toBeDefined();
    });

    it('midAtTrigger is null because bid/ask are not on the event (ADR 0005 deferred)', async () => {
        const recordMock = jest.fn().mockResolvedValue({ id: 1 });
        const { listener } = buildListener({ record: recordMock });

        await listener.onVolatilityDetected(buildVolatilityEvent());

        const [payload] = recordMock.mock.calls[0];
        expect(payload.midAtTrigger).toBeNull();
    });
});

// ─── M27-MDL-5: No event_id → writer skips ───────────────────────────────────

describe('MarketDataPersistenceListener M27 — M27-MDL-5: no event_id on event → record() is not called', () => {
    it('when eventId is undefined, record() is never called', async () => {
        const recordMock = jest.fn().mockResolvedValue({ id: 1 });
        const { listener } = buildListener({ record: recordMock });

        const eventWithoutId = buildVolatilityEvent({ eventId: undefined as any });

        await listener.onVolatilityDetected(eventWithoutId);

        expect(recordMock).not.toHaveBeenCalled();
    });

    it('when eventId is null, record() is never called', async () => {
        const recordMock = jest.fn().mockResolvedValue({ id: 1 });
        const { listener } = buildListener({ record: recordMock });

        const eventWithNullId = buildVolatilityEvent({ eventId: null as any });

        await listener.onVolatilityDetected(eventWithNullId);

        expect(recordMock).not.toHaveBeenCalled();
    });
});

// ─── M27-MDL-6: Empty string event_id → writer skips ────────────────────────

describe('MarketDataPersistenceListener M27 — M27-MDL-6: empty-string event_id is treated as absent', () => {
    it('when eventId is an empty string, record() is never called', async () => {
        const recordMock = jest.fn().mockResolvedValue({ id: 1 });
        const { listener } = buildListener({ record: recordMock });

        await listener.onVolatilityDetected(buildVolatilityEvent({ eventId: '' }));

        expect(recordMock).not.toHaveBeenCalled();
    });
});

// ─── M27-MDL-7: Whitespace-only event_id → writer skips ─────────────────────

describe('MarketDataPersistenceListener M27 — M27-MDL-7: whitespace-only event_id is treated as absent after trim', () => {
    it('when eventId is only whitespace, record() is never called', async () => {
        const recordMock = jest.fn().mockResolvedValue({ id: 1 });
        const { listener } = buildListener({ record: recordMock });

        await listener.onVolatilityDetected(buildVolatilityEvent({ eventId: '   ' }));

        expect(recordMock).not.toHaveBeenCalled();
    });
});

// ─── M27-MDL-8: Non-duplicate error is swallowed with warn ───────────────────

describe('MarketDataPersistenceListener M27 — M27-MDL-8: non-duplicate save failure is swallowed with warn log', () => {
    it('a constraint-violation error that is NOT duplicate key produces a warn log', async () => {
        const otherError = new Error('check constraint violation: spread must be non-negative');
        const recordMock = jest.fn().mockRejectedValue(otherError);
        const { listener, loggerWarnSpy } = buildListener({ record: recordMock });

        await listener.onVolatilityDetected(buildVolatilityEvent());

        expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    });

    it('caller does not receive the error even on a constraint violation', async () => {
        const otherError = new Error('foreign key constraint violation');
        const recordMock = jest.fn().mockRejectedValue(otherError);
        const { listener } = buildListener({ record: recordMock });

        await expect(listener.onVolatilityDetected(buildVolatilityEvent())).resolves.toBeUndefined();
    });
});
