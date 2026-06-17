// M11a W3 — VirtualPositionLedgerService adversarial coverage (ADR 0029 §2.1).
//
// Covers gate boundary cases that the W0.6.1 happy-path suite does not reach:
//   B5  — max_open_positions=1 exact boundary
//   B6  — max_trades_per_day=3 exact boundary
//   B7  — max_trades_per_day resets at UTC midnight rollover
//   B8  — halt_after_consecutive_losses=2 exact boundary
//   B9  — loss-streak broken by a win does NOT halt
//   B10 — force_close PnL sign governs win/loss classification
//   A3  — mid-event crash before persistence: replay of a non-persisted open eventId is a no-op
//   D17 — virtualSlotStateSnapshot reflects pre-mutation ledger state at gate-evaluation time
//
// BUILD→OPERATE→CHECK throughout. No shared mutable state across tests.

import { IVirtualCloseInput, IVirtualGateInput, IVirtualOpenInput } from '@bot/shared';

import { VirtualPositionLedgerService } from '../../../src/strategy/service/VirtualPositionLedgerService';

// ─── Constants ───────────────────────────────────────────────────────────────

const RISK_DAY = '2026-05-30';
// 2026-05-30 12:00:00 UTC
const NOW_MS = Date.UTC(2026, 4, 30, 12, 0, 0);
// 2026-05-30 23:59:59 UTC — last second of the same risk day
const END_OF_DAY_MS = Date.UTC(2026, 4, 30, 23, 59, 59);
// 2026-05-31 00:00:01 UTC — first second of the next risk day
const NEXT_DAY_MS = Date.UTC(2026, 4, 31, 0, 0, 1);
const NEXT_DAY = '2026-05-31';

// ─── Factories ───────────────────────────────────────────────────────────────

function buildGateInput(overrides: Partial<IVirtualGateInput> = {}): IVirtualGateInput {
    return {
        eventId: 'evt-gate-1',
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

// Opens a position and immediately closes it with the given realizedPnl.
// The eventId and virtualOrderId suffix uniquely identify the trade pair.
function openAndClose(ledger: VirtualPositionLedgerService, suffix: string, realizedPnl: string, nowMs = NOW_MS): void {
    ledger.tryOpen(
        buildOpenInput({
            eventId: `o-${suffix}`,
            virtualOrderId: `vo-${suffix}`,
            nowMs,
            riskDayUtcDate: new Date(nowMs).toISOString().slice(0, 10),
        }),
    );
    ledger.tryClose(
        buildCloseInput({
            eventId: `c-${suffix}`,
            virtualOrderId: `vo-${suffix}`,
            nowMs: nowMs + 60_000,
            riskDayUtcDate: new Date(nowMs).toISOString().slice(0, 10),
            realizedPnl,
        }),
    );
}

// ─── B5: max_open_positions=1 exact boundary ─────────────────────────────────

describe('VirtualPositionLedgerService gate — max_open_positions=1 exact boundary (B5)', () => {
    it('allows first open when 0 positions are open (boundary: 0 < 1)', () => {
        const ledger = new VirtualPositionLedgerService();

        const outcome = ledger.evaluateGates(buildGateInput({ maxOpenPositions: 1 }));

        expect(outcome.allowed).toBe(true);
    });

    it('rejects second open attempt when exactly 1 position is already open (boundary: 1 >= 1)', () => {
        const ledger = new VirtualPositionLedgerService();
        ledger.tryOpen(buildOpenInput({ eventId: 'o1', virtualOrderId: 'vo-1' }));

        const outcome = ledger.evaluateGates(buildGateInput({ eventId: 'evt-2', maxOpenPositions: 1 }));

        expect(outcome).toEqual({ allowed: false, rejectReason: 'max_open_positions_reached' });
    });

    it('allows a new open once the single open position is closed (slot freed)', () => {
        const ledger = new VirtualPositionLedgerService();
        ledger.tryOpen(buildOpenInput({ eventId: 'o1', virtualOrderId: 'vo-1' }));
        ledger.tryClose(buildCloseInput({ eventId: 'c1', virtualOrderId: 'vo-1', realizedPnl: '+5.0' }));

        const outcome = ledger.evaluateGates(buildGateInput({ eventId: 'evt-new' }));

        // After close, openPositions.size === 0 — slot available again.
        // However, if two losses triggered a halt, the gate may reject with
        // 'halted' — but a single profitable close never halts.
        expect(outcome.allowed).toBe(true);
    });
});

// ─── B6: max_trades_per_day=3 exact boundary ─────────────────────────────────

describe('VirtualPositionLedgerService gate — max_trades_per_day=3 exact boundary (B6)', () => {
    it('allows the third open on the same risk day (boundary: 2 < 3 before third trade)', () => {
        const ledger = new VirtualPositionLedgerService();
        openAndClose(ledger, 'a', '+1.0');
        openAndClose(ledger, 'b', '+1.0');
        // At this point 2 trades have been opened today. A third attempt should be allowed.

        const outcome = ledger.evaluateGates(buildGateInput({ eventId: 'evt-third', maxTradesPerDay: 3 }));

        expect(outcome.allowed).toBe(true);
    });

    it('rejects a fourth open on the same risk day (boundary: 3 >= 3)', () => {
        const ledger = new VirtualPositionLedgerService();
        openAndClose(ledger, 'a', '+1.0');
        openAndClose(ledger, 'b', '+1.0');
        openAndClose(ledger, 'c', '+1.0');
        // 3 trades already opened today.

        const outcome = ledger.evaluateGates(buildGateInput({ eventId: 'evt-fourth', maxTradesPerDay: 3 }));

        expect(outcome).toEqual({ allowed: false, rejectReason: 'max_trades_per_day_reached' });
    });

    it('rejects when one position is still open and two have been closed (3 total opened today, cap hit before slot check)', () => {
        const ledger = new VirtualPositionLedgerService();
        // Open two, close two — 2 closed trades count toward today's cap.
        openAndClose(ledger, 'a', '+1.0');
        openAndClose(ledger, 'b', '+1.0');
        // Open third — not yet closed; it also counts toward cap (it's open today).
        ledger.tryOpen(buildOpenInput({ eventId: 'o-c', virtualOrderId: 'vo-c' }));

        // Gate checks trades-per-day BEFORE open-positions cap; 3 trades today >= 3 limit.
        const outcome = ledger.evaluateGates(buildGateInput({ eventId: 'evt-fourth', maxTradesPerDay: 3 }));

        expect(outcome).toEqual({ allowed: false, rejectReason: 'max_trades_per_day_reached' });
    });
});

// ─── B7: max_trades_per_day resets at UTC midnight rollover ──────────────────

describe('VirtualPositionLedgerService gate — max_trades_per_day resets at UTC midnight (B7)', () => {
    it('allows a fourth open after UTC midnight when three trades were opened the previous day', () => {
        const ledger = new VirtualPositionLedgerService();
        // Three profitable trades on 2026-05-30 (no halt risk).
        openAndClose(ledger, 'a', '+1.0', NOW_MS);
        openAndClose(ledger, 'b', '+1.0', NOW_MS + 60_000);
        openAndClose(ledger, 'c', '+1.0', NOW_MS + 120_000);
        // Confirm cap is hit for 2026-05-30.
        const sameDayOutcome = ledger.evaluateGates(
            buildGateInput({ eventId: 'evt-same-day', nowMs: END_OF_DAY_MS, riskDayUtcDate: RISK_DAY, maxTradesPerDay: 3 }),
        );
        expect(sameDayOutcome.allowed).toBe(false);
        expect(sameDayOutcome.rejectReason).toBe('max_trades_per_day_reached');

        // After midnight on 2026-05-31 — daily counter resets to 0.
        const nextDayOutcome = ledger.evaluateGates(
            buildGateInput({ eventId: 'evt-next-day', nowMs: NEXT_DAY_MS, riskDayUtcDate: NEXT_DAY, maxTradesPerDay: 3 }),
        );

        expect(nextDayOutcome.allowed).toBe(true);
    });
});

// ─── B8: halt_after_consecutive_losses=2 exact boundary ─────────────────────

describe('VirtualPositionLedgerService gate — halt_after_consecutive_losses=2 exact boundary (B8)', () => {
    it('does not halt after a single loss (1 < 2 — below threshold)', () => {
        const ledger = new VirtualPositionLedgerService();
        openAndClose(ledger, 'loss1', '-5.0');

        expect(ledger.isHalted(NOW_MS)).toBe(false);
        const outcome = ledger.evaluateGates(buildGateInput({ eventId: 'evt-second' }));
        expect(outcome.allowed).toBe(true);
    });

    it('arms halt and rejects gate after exactly two consecutive losses (boundary: 2 >= 2)', () => {
        const ledger = new VirtualPositionLedgerService();
        openAndClose(ledger, 'loss1', '-5.0');
        openAndClose(ledger, 'loss2', '-3.0');

        // The ledger is now halted.
        expect(ledger.isHalted(NOW_MS)).toBe(true);

        const outcome = ledger.evaluateGates(buildGateInput({ eventId: 'evt-third', haltAfterConsecutiveLosses: 2 }));
        // Either 'halted' (durable flag) or 'halt_after_consecutive_losses' (streak check) — both are rejections.
        expect(outcome.allowed).toBe(false);
        expect(['halted', 'halt_after_consecutive_losses']).toContain(outcome.rejectReason);
    });

    it('halt clears and allows gate on the next UTC risk day', () => {
        const ledger = new VirtualPositionLedgerService();
        openAndClose(ledger, 'loss1', '-5.0');
        openAndClose(ledger, 'loss2', '-3.0');

        // Halted today.
        expect(ledger.isHalted(NOW_MS)).toBe(true);

        // Next day — halt expired.
        const outcome = ledger.evaluateGates(buildGateInput({ eventId: 'evt-next-day', nowMs: NEXT_DAY_MS, riskDayUtcDate: NEXT_DAY }));
        expect(outcome.allowed).toBe(true);
    });
});

// ─── B9: loss-streak broken by a win does NOT halt ───────────────────────────

describe('VirtualPositionLedgerService gate — loss streak reset by a win (B9)', () => {
    it('does not halt after loss → win → loss (consecutive streak reset by win)', () => {
        // Three trades: loss, win, loss → streak = 1 after win reset; no halt.
        // maxTradesPerDay=10 so the daily cap does not interfere with the gate
        // evaluation being tested here (halt / consecutive-losses check).
        const freshLedger = new VirtualPositionLedgerService();
        openAndClose(freshLedger, 'loss1', '-5.0');
        openAndClose(freshLedger, 'win', '+8.0');
        openAndClose(freshLedger, 'loss2', '-2.0');

        // Streak after: loss, win (reset to 0), loss → current streak = 1. No halt.
        expect(freshLedger.isHalted(NOW_MS)).toBe(false);

        const outcome = freshLedger.evaluateGates(buildGateInput({ eventId: 'evt-next', maxTradesPerDay: 10 }));
        expect(outcome.allowed).toBe(true);
    });

    it('does not halt after exactly one trailing loss when preceded by a win (consecutive streak = 1)', () => {
        const ledger = new VirtualPositionLedgerService();
        openAndClose(ledger, 'loss1', '-5.0');
        openAndClose(ledger, 'loss2', '-3.0');
        // Two losses fire the halt — verify this sub-case first.
        expect(ledger.isHalted(NOW_MS)).toBe(true);

        // Fresh ledger: loss, win, loss → streak resets to 1 after the win.
        const fresh = new VirtualPositionLedgerService();
        openAndClose(fresh, 'a-loss', '-1.0');
        openAndClose(fresh, 'b-win', '+5.0');
        openAndClose(fresh, 'c-loss', '-2.0');

        expect(fresh.isHalted(NOW_MS)).toBe(false);
        expect(fresh.countConsecutiveLossesInRiskDay(RISK_DAY)).toBe(1);
    });
});

// ─── B10: force_close is skipped entirely from the consecutive-loss streak ────
// force_close exits are neither arming losses nor streak-resetting wins.
// They are skipped so N consecutive in-pass force-close exits never halt the
// shadow version, while genuine sl/tp/time_stop losses still arm the streak.

describe('VirtualPositionLedgerService gate — force_close PnL sign classification (B10)', () => {
    it('positive PnL force_close does NOT reset a pre-existing consecutive-loss streak', () => {
        const ledger = new VirtualPositionLedgerService();
        openAndClose(ledger, 'loss1', '-5.0');

        // force_close with positive PnL — skipped (not a win, not a reset).
        ledger.tryOpen(buildOpenInput({ eventId: 'o-fc', virtualOrderId: 'vo-fc' }));
        ledger.tryClose(
            buildCloseInput({
                eventId: 'c-fc',
                virtualOrderId: 'vo-fc',
                realizedPnl: '+2.0',
                closeReason: 'force_close',
            }),
        );

        // Streak: sl-loss → force_close (skipped) → streak stays at 1, no halt.
        expect(ledger.isHalted(NOW_MS)).toBe(false);
        expect(ledger.countConsecutiveLossesInRiskDay(RISK_DAY)).toBe(1);
    });

    it('negative PnL force_close does NOT advance the consecutive-loss streak', () => {
        const ledger = new VirtualPositionLedgerService();
        openAndClose(ledger, 'loss1', '-5.0');

        // force_close with negative PnL — skipped (not a loss, no streak arm).
        ledger.tryOpen(buildOpenInput({ eventId: 'o-fc', virtualOrderId: 'vo-fc' }));
        ledger.tryClose(
            buildCloseInput({
                eventId: 'c-fc',
                virtualOrderId: 'vo-fc',
                realizedPnl: '-1.0',
                closeReason: 'force_close',
            }),
        );

        // Streak: sl-loss → force_close (skipped) → streak = 1, NOT halted.
        expect(ledger.isHalted(NOW_MS)).toBe(false);
        expect(ledger.countConsecutiveLossesInRiskDay(RISK_DAY)).toBe(1);
    });
});

// ─── A3: mid-event crash before persistence ───────────────────────────────────
// Simulates: tryOpen succeeds (ledger mutated) but persistence did NOT write
// the shadow_decisions row. On restart the ledger is empty; replay calls
// tryOpen again with the same eventId and it succeeds (the processedEventIds set
// was cleared on restart). This is coherent: no durable row → no idempotency
// guard → normal open on re-processing.

describe('VirtualPositionLedgerService — pre-persistence crash coherence (A3)', () => {
    it('tryOpen succeeds on a fresh ledger for an eventId that never reached persistence (simulated crash before persist)', () => {
        // BUILD: "crash" is simulated by discarding the first ledger instance.
        const crashedLedger = new VirtualPositionLedgerService();
        crashedLedger.tryOpen(buildOpenInput({ eventId: 'crash-evt', virtualOrderId: 'vo-crash' }));
        // The persistence step never ran — discard this ledger (simulates restart).

        // OPERATE: rebuild with fresh in-memory ledger (no rows in DB to replay).
        const rebuiltLedger = new VirtualPositionLedgerService();
        const result = rebuiltLedger.tryOpen(buildOpenInput({ eventId: 'crash-evt', virtualOrderId: 'vo-crash' }));

        // CHECK: fresh ledger has no knowledge of 'crash-evt'; open succeeds.
        expect(result.success).toBe(true);
        expect(rebuiltLedger.countOpenPositions()).toBe(1);
    });
});

// ─── D17: snapshot reflects pre-mutation state ───────────────────────────────
// ADR 0029 §2.1.1: "snapshot for decision" is taken BEFORE evaluateGates / tryOpen
// mutates the ledger. The orchestrator calls snapshotForDecision(nowMs) before
// evaluateGates — the snapshot in the persisted row must reflect the pre-open
// ledger state (0 open positions before the first tryOpen).

describe('VirtualPositionLedgerService — snapshotForDecision captures pre-mutation state (D17)', () => {
    it('snapshot taken before tryOpen shows 0 open positions; snapshot taken after shows 1', () => {
        const ledger = new VirtualPositionLedgerService();

        // BUILD + OPERATE: take snapshot before and after mutating.
        const snapshotBefore = ledger.snapshotForDecision(NOW_MS);
        ledger.tryOpen(buildOpenInput({ eventId: 'evt-open', virtualOrderId: 'vo-d17' }));
        const snapshotAfter = ledger.snapshotForDecision(NOW_MS);

        // CHECK: pre-mutation snapshot has no open positions (the state the gate
        // evaluation would have seen at decision time per ADR 0029 §2.1.1).
        expect(snapshotBefore.openPositions).toHaveLength(0);
        expect(snapshotAfter.openPositions).toHaveLength(1);
        expect(snapshotBefore.lastEventIdProcessed).toBe('');
        expect(snapshotAfter.lastEventIdProcessed).toBe('evt-open');
    });

    it('snapshot taken before evaluateGates reflects halt state accurately before any mutation', () => {
        const ledger = new VirtualPositionLedgerService();
        openAndClose(ledger, 'loss1', '-5.0');
        openAndClose(ledger, 'loss2', '-3.0');
        // Ledger is halted.

        // Pre-gate snapshot captures the halted state as it exists at decision time.
        const snapshot = ledger.snapshotForDecision(NOW_MS);

        expect(snapshot.haltedUntilRiskDayUtcDate).toBe(RISK_DAY);
        // The subsequent gate call sees the same halt state.
        const outcome = ledger.evaluateGates(buildGateInput({ eventId: 'evt-post-halt' }));
        expect(outcome.allowed).toBe(false);
    });
});
