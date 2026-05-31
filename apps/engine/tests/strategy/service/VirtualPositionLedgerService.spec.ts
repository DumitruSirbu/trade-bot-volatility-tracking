// M11a W0.6.1 — VirtualPositionLedgerService unit tests (paired with the
// W0.6.1 dispatch). Pure in-memory ledger; no DB. Each test asserts a single
// ADR-0029 contract bullet — gate composition, idempotent mutate, halt
// arming, restart-cursor monotonicity.

import { IVirtualCloseInput, IVirtualGateInput, IVirtualOpenInput } from '@bot/shared';
import Decimal from 'decimal.js';

import { VirtualPositionLedgerService } from '../../../src/strategy/service/VirtualPositionLedgerService';

const RISK_DAY = '2026-05-30';
const NOW_MS = Date.UTC(2026, 4, 30, 12, 0, 0); // 2026-05-30 12:00:00 UTC

function buildGateInput(overrides: Partial<IVirtualGateInput> = {}): IVirtualGateInput {
    return {
        eventId: 'evt-1',
        nowMs: NOW_MS,
        riskDayUtcDate: RISK_DAY,
        decision: { action: 'open' },
        maxOpenPositions: 1,
        maxTradesPerDay: 3,
        haltAfterConsecutiveLosses: 2,
        requireExhaustionConfirmation: true,
        skipMarketStress: true,
        marginMode: 'isolated',
        ...overrides,
    };
}

function buildOpenInput(overrides: Partial<IVirtualOpenInput> = {}): IVirtualOpenInput {
    return {
        eventId: 'evt-open-1',
        nowMs: NOW_MS,
        riskDayUtcDate: RISK_DAY,
        symbol: 'BTCUSDT',
        side: 'long',
        entryPrice: '50000.0',
        qty: '0.01',
        stopLoss: '49000.0',
        takeProfit: '51000.0',
        virtualOrderId: 'vo-1',
        ...overrides,
    };
}

function buildCloseInput(overrides: Partial<IVirtualCloseInput> = {}): IVirtualCloseInput {
    return {
        eventId: 'evt-close-1',
        nowMs: NOW_MS + 60_000,
        riskDayUtcDate: RISK_DAY,
        virtualOrderId: 'vo-1',
        exitPrice: '49000.0',
        closeReason: 'sl',
        realizedPnl: '-10.0',
        ...overrides,
    };
}

describe('VirtualPositionLedgerService — snapshot + gate', () => {
    it('snapshotForDecision derives riskDayUtcDate from nowMs via UTC ISO slice', () => {
        const ledger = new VirtualPositionLedgerService();

        const snapshot = ledger.snapshotForDecision(NOW_MS);

        // Same string v1's RiskGateService computes for the same nowMs (ADR 0029 §2.1.2).
        expect(snapshot.riskDayUtcDate).toBe(new Date(NOW_MS).toISOString().slice(0, 10));
        expect(snapshot.openPositions).toEqual([]);
        expect(snapshot.haltedUntilRiskDayUtcDate).toBeNull();
        expect(snapshot.lastEventIdProcessed).toBe('');
    });

    it('evaluateGates allows the first open under restricted profile', () => {
        const ledger = new VirtualPositionLedgerService();

        const outcome = ledger.evaluateGates(buildGateInput());

        expect(outcome.allowed).toBe(true);
        expect(outcome.rejectReason).toBeUndefined();
    });

    it('evaluateGates rejects when openPositions equals maxOpenPositions', () => {
        const ledger = new VirtualPositionLedgerService();
        ledger.tryOpen(buildOpenInput());

        const outcome = ledger.evaluateGates(buildGateInput({ eventId: 'evt-2', maxOpenPositions: 1 }));

        expect(outcome).toEqual({ allowed: false, rejectReason: 'max_open_positions_reached' });
    });

    it('evaluateGates rejects when consecutive losses reach haltAfterConsecutiveLosses', () => {
        const ledger = new VirtualPositionLedgerService();

        // Two losing trades on the same risk day arm the halt.
        ledger.tryOpen(buildOpenInput({ eventId: 'o1', virtualOrderId: 'vo-1' }));
        ledger.tryClose(buildCloseInput({ eventId: 'c1', virtualOrderId: 'vo-1', realizedPnl: '-5.0' }));
        ledger.tryOpen(buildOpenInput({ eventId: 'o2', virtualOrderId: 'vo-2' }));
        ledger.tryClose(buildCloseInput({ eventId: 'c2', virtualOrderId: 'vo-2', realizedPnl: '-7.0' }));

        const outcome = ledger.evaluateGates(buildGateInput({ eventId: 'evt-3' }));

        // First check that fires is `halted` (the arming flag is now set), which
        // is the canonical ADR §2.1.2 ledger halt — `halt_after_consecutive_losses`
        // is the streak check on the gate-input threshold, but once the durable
        // flag is armed `isHalted` short-circuits before the streak recount.
        expect(outcome.allowed).toBe(false);
        expect(['halted', 'halt_after_consecutive_losses']).toContain(outcome.rejectReason);
    });
});

describe('VirtualPositionLedgerService — tryOpen idempotency', () => {
    it('tryOpen with a duplicate eventId returns success=false and does not mutate openPositions', () => {
        const ledger = new VirtualPositionLedgerService();
        const open = buildOpenInput();

        const first = ledger.tryOpen(open);
        const second = ledger.tryOpen(open);

        expect(first).toEqual({ success: true });
        expect(second.success).toBe(false);
        expect(second.reason).toBe('duplicate_event_id');
        expect(ledger.countOpenPositions()).toBe(1);
    });

    it('tryOpen with a duplicate virtualOrderId (distinct eventId) rejects', () => {
        const ledger = new VirtualPositionLedgerService();
        ledger.tryOpen(buildOpenInput({ eventId: 'o1', virtualOrderId: 'vo-same' }));

        const second = ledger.tryOpen(buildOpenInput({ eventId: 'o2', virtualOrderId: 'vo-same' }));

        expect(second).toEqual({ success: false, reason: 'duplicate_virtual_order_id' });
        expect(ledger.countOpenPositions()).toBe(1);
    });

    it('snapshotForDecision reflects the open position after tryOpen', () => {
        const ledger = new VirtualPositionLedgerService();
        ledger.tryOpen(buildOpenInput({ eventId: 'open-evt', virtualOrderId: 'vo-1' }));

        const snapshot = ledger.snapshotForDecision(NOW_MS);

        expect(snapshot.openPositions).toHaveLength(1);
        expect(snapshot.openPositions[0]?.virtualOrderId).toBe('vo-1');
        expect(snapshot.openPositions[0]?.entryPrice).toBe('50000.0');
        expect(snapshot.lastEventIdProcessed).toBe('open-evt');
    });
});

describe('VirtualPositionLedgerService — tryClose + halt arming', () => {
    it('tryClose on an unknown virtualOrderId returns success=false', () => {
        const ledger = new VirtualPositionLedgerService();

        const result = ledger.tryClose(buildCloseInput({ virtualOrderId: 'never-opened' }));

        expect(result).toEqual({ success: false, reason: 'no_open_position_for_virtual_order_id' });
    });

    it('tryClose with a duplicate eventId is a no-op', () => {
        const ledger = new VirtualPositionLedgerService();
        ledger.tryOpen(buildOpenInput({ eventId: 'o1', virtualOrderId: 'vo-1' }));
        ledger.tryClose(buildCloseInput({ eventId: 'c1', virtualOrderId: 'vo-1' }));

        const replay = ledger.tryClose(buildCloseInput({ eventId: 'c1', virtualOrderId: 'vo-1' }));

        expect(replay.success).toBe(false);
        expect(replay.reason).toBe('duplicate_event_id');
    });

    it('arms haltedUntilRiskDayUtcDate after two consecutive losses on the same risk day', () => {
        const ledger = new VirtualPositionLedgerService();

        ledger.tryOpen(buildOpenInput({ eventId: 'o1', virtualOrderId: 'vo-1' }));
        ledger.tryClose(buildCloseInput({ eventId: 'c1', virtualOrderId: 'vo-1', realizedPnl: '-1.0' }));

        // Halt not yet armed after a single loss.
        expect(ledger.isHalted(NOW_MS)).toBe(false);

        ledger.tryOpen(buildOpenInput({ eventId: 'o2', virtualOrderId: 'vo-2' }));
        ledger.tryClose(buildCloseInput({ eventId: 'c2', virtualOrderId: 'vo-2', realizedPnl: '-2.0' }));

        expect(ledger.isHalted(NOW_MS)).toBe(true);
        expect(ledger.snapshotForDecision(NOW_MS).haltedUntilRiskDayUtcDate).toBe(RISK_DAY);
    });

    it('halt clears on the next UTC day', () => {
        const ledger = new VirtualPositionLedgerService();
        ledger.tryOpen(buildOpenInput({ eventId: 'o1', virtualOrderId: 'vo-1' }));
        ledger.tryClose(buildCloseInput({ eventId: 'c1', virtualOrderId: 'vo-1', realizedPnl: '-1.0' }));
        ledger.tryOpen(buildOpenInput({ eventId: 'o2', virtualOrderId: 'vo-2' }));
        ledger.tryClose(buildCloseInput({ eventId: 'c2', virtualOrderId: 'vo-2', realizedPnl: '-2.0' }));

        const nextDayMs = NOW_MS + 24 * 60 * 60 * 1000;

        expect(ledger.isHalted(NOW_MS)).toBe(true);
        expect(ledger.isHalted(nextDayMs)).toBe(false);
    });

    it('does not arm halt when a win breaks the losing streak', () => {
        const ledger = new VirtualPositionLedgerService();
        ledger.tryOpen(buildOpenInput({ eventId: 'o1', virtualOrderId: 'vo-1' }));
        ledger.tryClose(buildCloseInput({ eventId: 'c1', virtualOrderId: 'vo-1', realizedPnl: '-1.0' }));
        ledger.tryOpen(buildOpenInput({ eventId: 'o2', virtualOrderId: 'vo-2' }));
        ledger.tryClose(buildCloseInput({ eventId: 'c2', virtualOrderId: 'vo-2', realizedPnl: '+3.0' }));
        ledger.tryOpen(buildOpenInput({ eventId: 'o3', virtualOrderId: 'vo-3' }));
        ledger.tryClose(buildCloseInput({ eventId: 'c3', virtualOrderId: 'vo-3', realizedPnl: '-1.0' }));

        // Streak: loss, win (resets), loss → 1 trailing loss → no halt.
        expect(ledger.isHalted(NOW_MS)).toBe(false);
    });
});

describe('VirtualPositionLedgerService — seedProcessedEventIds (W5a)', () => {
    // Pins the cold-restart idempotency seed: after rebuilding the ledger, a
    // redelivered live event id must not slip past the tryOpen duplicate guard.
    it('seeds processedEventIds so a subsequent tryOpen with the same eventId rejects as duplicate', () => {
        const ledger = new VirtualPositionLedgerService();

        ledger.seedProcessedEventIds(['evt-seeded']);

        const result = ledger.tryOpen(buildOpenInput({ eventId: 'evt-seeded', virtualOrderId: 'vo-1' }));

        expect(result).toEqual({ success: false, reason: 'duplicate_event_id' });
    });

    it('advances lastEventIdProcessed to the lexicographic max of seeded ids', () => {
        const ledger = new VirtualPositionLedgerService();

        ledger.seedProcessedEventIds(['evt-005', 'evt-099', 'evt-042']);

        expect(ledger.snapshotForDecision(NOW_MS).lastEventIdProcessed).toBe('evt-099');
    });
});

describe('VirtualPositionLedgerService — closeBySymbol (W5a)', () => {
    // Path A (reverse-signal close) and path B (force-close) both flow through
    // closeBySymbol. PnL accounting: (exit-entry) × qty × sideMultiplier - exitFee.
    it('closes a LONG position with positive PnL when exit > entry (fee subtracted)', () => {
        const ledger = new VirtualPositionLedgerService();
        ledger.tryOpen(buildOpenInput({ eventId: 'o1', virtualOrderId: 'vo-1', side: 'long', entryPrice: '100', qty: '1', stopLoss: '95', takeProfit: '110' }));

        const closed = ledger.closeBySymbol('BTCUSDT', '110', NOW_MS + 60_000, 'reverse_signal', 'evt-close-1');

        // gross PnL = (110-100) × 1 × 1 = 10; exitFee = 110 × 1 × 0.0004 = 0.044; net = 9.956.
        expect(closed).not.toBeNull();
        expect(closed?.closeReason).toBe('reverse_signal');
        expect(new Decimal(closed?.realizedPnl ?? '0').toString()).toBe('9.956');
        expect(ledger.countOpenPositions()).toBe(0);
    });

    it('returns null when no open position exists for the symbol', () => {
        const ledger = new VirtualPositionLedgerService();

        const closed = ledger.closeBySymbol('BTCUSDT', '100', NOW_MS, 'reverse_signal', 'evt-x');

        expect(closed).toBeNull();
    });
});

describe('VirtualPositionLedgerService — forceCloseAllPositions (W5a)', () => {
    // Path C: end-of-window force-close. Returns closed-trade log entries for
    // every symbol present in the exit-price map; positions absent from the
    // map stay open.
    it('force-closes only the positions whose symbols are keyed in the price map', () => {
        const ledger = new VirtualPositionLedgerService();
        ledger.tryOpen(buildOpenInput({ eventId: 'o1', virtualOrderId: 'vo-btc', symbol: 'BTCUSDT', side: 'long', entryPrice: '100', qty: '1' }));
        ledger.tryOpen(buildOpenInput({ eventId: 'o2', virtualOrderId: 'vo-eth', symbol: 'ETHUSDT', side: 'long', entryPrice: '50', qty: '1' }));

        const prices = new Map<string, string>([['BTCUSDT', '110']]);
        const closed = ledger.forceCloseAllPositions(prices, NOW_MS + 60_000, 'window-close-1');

        expect(closed).toHaveLength(1);
        expect(ledger.countOpenPositions()).toBe(1);
    });
});

describe('VirtualPositionLedgerService — W5b FIX 1: countTradesOpenedOnRiskDay by open day', () => {
    // Pins FIX 1: trades count toward the risk day on which they were OPENED,
    // not the day they happened to close. A trade opened yesterday and closed
    // today must NOT count toward today's opens cap (which would double-count
    // when a fresh open today fires).
    it('counts a trade opened yesterday and closed today against yesterday, not today', () => {
        const ledger = new VirtualPositionLedgerService();
        const yesterday = '2026-05-29';
        const today = '2026-05-30';
        const yesterdayNoonMs = Date.UTC(2026, 4, 29, 12, 0, 0);
        const todayNoonMs = Date.UTC(2026, 4, 30, 12, 0, 0);

        // Open yesterday.
        ledger.tryOpen(buildOpenInput({ eventId: 'o-y', virtualOrderId: 'vo-y', nowMs: yesterdayNoonMs, riskDayUtcDate: yesterday }));
        // Close today.
        ledger.tryClose(buildCloseInput({ eventId: 'c-y', virtualOrderId: 'vo-y', nowMs: todayNoonMs, riskDayUtcDate: today, realizedPnl: '+1.0' }));
        // Fresh open today.
        ledger.tryOpen(buildOpenInput({ eventId: 'o-t', virtualOrderId: 'vo-t', nowMs: todayNoonMs, riskDayUtcDate: today }));

        // Today's opens = 1 (just the fresh open). Yesterday's opens = 1 (the closed one).
        expect(ledger.countTradesOpenedOnRiskDay(today)).toBe(1);
        expect(ledger.countTradesOpenedOnRiskDay(yesterday)).toBe(1);
    });
});

describe('VirtualPositionLedgerService — W5b FIX 2: isHalted self-clears stale field after rollover', () => {
    // Pins FIX 2: once the risk day rolls past `haltedUntilRiskDayUtcDate`,
    // `isHalted` returns false AND clears the stored field so the snapshot
    // no longer exposes an expired halt date.
    it('clears haltedUntilRiskDayUtcDate after the risk day rolls over', () => {
        const ledger = new VirtualPositionLedgerService();

        // Arm the halt by triggering two consecutive losses today.
        ledger.tryOpen(buildOpenInput({ eventId: 'o1', virtualOrderId: 'vo-1' }));
        ledger.tryClose(buildCloseInput({ eventId: 'c1', virtualOrderId: 'vo-1', realizedPnl: '-1.0' }));
        ledger.tryOpen(buildOpenInput({ eventId: 'o2', virtualOrderId: 'vo-2' }));
        ledger.tryClose(buildCloseInput({ eventId: 'c2', virtualOrderId: 'vo-2', realizedPnl: '-2.0' }));

        expect(ledger.snapshotForDecision(NOW_MS).haltedUntilRiskDayUtcDate).toBe(RISK_DAY);

        // Roll forward to the next UTC day and re-check the halt.
        const nextDayMs = NOW_MS + 24 * 60 * 60 * 1000;

        expect(ledger.isHalted(nextDayMs)).toBe(false);

        // Field MUST be cleared so the snapshot is honest, not stale.
        expect(ledger.snapshotForDecision(nextDayMs).haltedUntilRiskDayUtcDate).toBeNull();
    });
});

describe('VirtualPositionLedgerService — lastEventIdProcessed cursor', () => {
    it('advances monotonically (string-lexicographic max wins) across tryOpen/tryClose', () => {
        const ledger = new VirtualPositionLedgerService();
        ledger.tryOpen(buildOpenInput({ eventId: 'evt-002', virtualOrderId: 'vo-1' }));

        expect(ledger.snapshotForDecision(NOW_MS).lastEventIdProcessed).toBe('evt-002');

        // A lexicographically earlier eventId must NOT regress the cursor.
        ledger.tryOpen(buildOpenInput({ eventId: 'evt-001', virtualOrderId: 'vo-2' }));

        expect(ledger.snapshotForDecision(NOW_MS).lastEventIdProcessed).toBe('evt-002');

        ledger.tryClose(buildCloseInput({ eventId: 'evt-099', virtualOrderId: 'vo-1' }));

        expect(ledger.snapshotForDecision(NOW_MS).lastEventIdProcessed).toBe('evt-099');
    });
});
