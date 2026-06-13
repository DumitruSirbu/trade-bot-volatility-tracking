import { ExitReasonEnum, PositionSideEnum, PositionSlotEnum } from '@bot/shared';

import { IPositionClosedEvent } from '../../src/common/interface/IPositionClosedEvent';
import { IPositionOpenedEvent } from '../../src/common/interface/IPositionOpenedEvent';
import { formatDuration, formatPositionClosedBody, formatPositionOpenedBody } from '../../src/alert/format/positionAlertText';
import { Money } from '../../src/common/utils/money';

// M32 §4.4 — pure formatter unit tests. No I/O, no clock; timestamps are passed in.

const OPENED_AT = new Date('2026-06-01T10:00:00.000Z');

function buildOpened(overrides: Partial<IPositionOpenedEvent> = {}): IPositionOpenedEvent {
    return {
        positionId: 42,
        symbol: 'BTC/USDT:USDT',
        side: PositionSideEnum.SHORT,
        leverage: new Money('3'),
        entryPrice: new Money('64250'),
        entryNotional: new Money('750'),
        strategyVersionId: 3,
        ...overrides,
    };
}

function buildClosed(overrides: Partial<IPositionClosedEvent> = {}): IPositionClosedEvent {
    return {
        positionId: 42,
        symbol: 'BTC/USDT:USDT',
        side: PositionSideEnum.SHORT,
        exitReason: ExitReasonEnum.TAKE_PROFIT,
        realizedPnl: new Money('12.18'),
        closedAt: new Date('2026-06-01T11:42:00.000Z'),
        entryPrice: new Money('64250'),
        exitPrice: new Money('63900'),
        leverage: new Money('3'),
        strategyVersionId: 3,
        openedAt: OPENED_AT,
        positionSlot: PositionSlotEnum.A,
        ...overrides,
    };
}

describe('formatPositionOpenedBody', () => {
    it('renders side, leverage as Nx, entry price, notional, and strat version', () => {
        const body = formatPositionOpenedBody(buildOpened());

        expect(body).toBe('SHORT 3x @ $64,250.00  ·  notional $750.00  ·  strat v3');
    });

    it('renders leverage as a multiplier, never through the dollar formatter', () => {
        const body = formatPositionOpenedBody(buildOpened({ leverage: new Money('10') }));

        expect(body).toContain('10x');
        expect(body).not.toContain('$10.00');
    });

    it('renders a sub-cent entry price with adaptive precision, never $0.00', () => {
        const body = formatPositionOpenedBody(buildOpened({ symbol: 'SHIB/USDT:USDT', entryPrice: new Money('0.00001823') }));

        expect(body).toContain('$0.00001823');
        expect(body).not.toContain('@ $0.00 ');
    });

    it('renders a sub-dollar (>= 1c) entry price at 4dp', () => {
        const body = formatPositionOpenedBody(buildOpened({ entryPrice: new Money('0.4321') }));

        expect(body).toContain('$0.4321');
    });

    it('renders notional at 2dp with grouped thousands', () => {
        const body = formatPositionOpenedBody(buildOpened({ entryNotional: new Money('1234567.5') }));

        expect(body).toContain('notional $1,234,567.50');
    });

    it('upcases the side label for LONG', () => {
        const body = formatPositionOpenedBody(buildOpened({ side: PositionSideEnum.LONG }));

        expect(body.startsWith('LONG ')).toBe(true);
    });
});

describe('formatPositionClosedBody', () => {
    it('renders a winning close with a + signed realized PnL and (net) label', () => {
        const body = formatPositionClosedBody(buildClosed());

        expect(body).toBe('SHORT 3x  ·  entry $64,250.00 → exit $63,900.00\n' + 'realized +$12.18 (net)  ·  held 1h 42m  ·  exit: take_profit  ·  strat v3');
    });

    it('renders a losing close with a − (minus) signed realized PnL', () => {
        const body = formatPositionClosedBody(
            buildClosed({
                side: PositionSideEnum.LONG,
                exitReason: ExitReasonEnum.STOP_LOSS,
                realizedPnl: new Money('-8.40'),
                entryPrice: new Money('3420'),
                exitPrice: null,
                leverage: new Money('2'),
                strategyVersionId: 2,
                closedAt: new Date('2026-06-01T10:23:00.000Z'),
            }),
        );

        expect(body).toContain('realized −$8.40 (net)');
        expect(body).toContain('LONG 2x');
        expect(body).toContain('exit: stop_loss');
        expect(body).toContain('strat v2');
    });

    it('renders null exitPrice as n/a, never $0.00', () => {
        const body = formatPositionClosedBody(buildClosed({ exitPrice: null }));

        expect(body).toContain('→ exit n/a');
        expect(body).not.toContain('exit $0.00');
    });

    it('renders null realizedPnl as n/a, never a fabricated $0.00', () => {
        const body = formatPositionClosedBody(buildClosed({ realizedPnl: null }));

        expect(body).toContain('realized n/a (net)');
        expect(body).not.toContain('realized +$0.00');
    });

    it('renders zero PnL with a + sign (zero is not negative)', () => {
        const body = formatPositionClosedBody(buildClosed({ realizedPnl: new Money('0') }));

        expect(body).toContain('realized +$0.00 (net)');
    });

    it('renders an undefined exitReason as unknown', () => {
        const body = formatPositionClosedBody(buildClosed({ exitReason: undefined }));

        expect(body).toContain('exit: unknown');
    });

    it('includes the (net) label always', () => {
        expect(formatPositionClosedBody(buildClosed())).toContain('(net)');
    });

    it('renders a sub-cent entry/exit price with adaptive precision', () => {
        const body = formatPositionClosedBody(buildClosed({ entryPrice: new Money('0.00001823'), exitPrice: new Money('0.00001750') }));

        expect(body).toContain('entry $0.00001823 → exit $0.00001750');
    });
});

describe('formatDuration', () => {
    it('renders null closedAt as n/a', () => {
        expect(formatDuration(null, OPENED_AT)).toBe('n/a');
    });

    it('renders undefined closedAt as n/a', () => {
        expect(formatDuration(undefined, OPENED_AT)).toBe('n/a');
    });

    it('renders a zero delta as 0s', () => {
        expect(formatDuration(OPENED_AT, OPENED_AT)).toBe('0s');
    });

    it('renders a negative delta (clock skew) as 0s', () => {
        const before = new Date(OPENED_AT.getTime() - 5_000);

        expect(formatDuration(before, OPENED_AT)).toBe('0s');
    });

    it('renders sub-minute durations as Xs', () => {
        const closed = new Date(OPENED_AT.getTime() + 45_000);

        expect(formatDuration(closed, OPENED_AT)).toBe('45s');
    });

    it('renders minute durations as Xm Ys', () => {
        const closed = new Date(OPENED_AT.getTime() + 3 * 60_000 + 20_000);

        expect(formatDuration(closed, OPENED_AT)).toBe('3m 20s');
    });

    it('renders hour durations as Xh Ym', () => {
        const closed = new Date(OPENED_AT.getTime() + 60 * 60_000 + 5 * 60_000);

        expect(formatDuration(closed, OPENED_AT)).toBe('1h 5m');
    });

    it('renders multi-day durations as Xd Yh', () => {
        const closed = new Date(OPENED_AT.getTime() + 2 * 24 * 60 * 60_000 + 3 * 60 * 60_000);

        expect(formatDuration(closed, OPENED_AT)).toBe('2d 3h');
    });
});

// ---------------------------------------------------------------------------
// Total-function contract — formatPositionOpenedBody and formatPositionClosedBody
// must never throw and must always return a non-empty string for any valid input.
// ---------------------------------------------------------------------------

describe('formatPositionOpenedBody — total-function contract', () => {
    it('does not throw and returns a non-empty string for a very large notional', () => {
        const body = formatPositionOpenedBody(buildOpened({ entryNotional: new Money('999999.99') }));

        expect(typeof body).toBe('string');
        expect(body.length).toBeGreaterThan(0);
        expect(body).toContain('notional $999,999.99');
    });

    it('does not throw and returns a non-empty string for a micro-priced coin', () => {
        const body = formatPositionOpenedBody(buildOpened({ entryPrice: new Money('0.00000001') }));

        expect(typeof body).toBe('string');
        expect(body.length).toBeGreaterThan(0);
        expect(body).not.toContain('@ $0.00 ');
    });
});

describe('formatPositionClosedBody — total-function contract', () => {
    it('does not throw and returns a non-empty string for zero realized PnL', () => {
        const body = formatPositionClosedBody(buildClosed({ realizedPnl: new Money('0') }));

        expect(typeof body).toBe('string');
        expect(body.length).toBeGreaterThan(0);
    });

    it('does not throw and returns a non-empty string for a very large notional with null exit fields', () => {
        const body = formatPositionClosedBody(
            buildClosed({
                entryPrice: new Money('999999.99'),
                exitPrice: null,
                realizedPnl: null,
                closedAt: null,
            }),
        );

        expect(typeof body).toBe('string');
        expect(body.length).toBeGreaterThan(0);
        expect(body).toContain('n/a');
    });

    it('does not throw and returns a non-empty string for a sub-cent entry price', () => {
        const body = formatPositionClosedBody(buildClosed({ entryPrice: new Money('0.00001823'), exitPrice: new Money('0.00001750') }));

        expect(typeof body).toBe('string');
        expect(body.length).toBeGreaterThan(0);
        // Adaptive precision must preserve all significant digits — neither price
        // should be flattened to exactly two decimal places.
        expect(body).toContain('$0.00001823');
        expect(body).toContain('$0.00001750');
    });
});
