/**
 * VirtualPositionLedgerService — M36 consecutive-loss-halt relaxation
 *
 * Surfaces under test:
 *
 *   VL1 — Per-call gate relax ON: sentinel threshold → evaluateGates does NOT
 *          return halt_after_consecutive_losses after 2 losses in the same day.
 *
 *   VL2 — Durable arm relax ON (D4): sentinel threshold passed to tryClose →
 *          haltedUntilRiskDayUtcDate is NOT set after 2 consecutive losses.
 *
 *   VL3 — Durable arm relax ON: a subsequent evaluateGates call does NOT
 *          return { allowed: false, rejectReason: 'halted' }.
 *
 *   VL4 — Durable arm relax OFF (regression): default threshold (2) → after 2
 *          consecutive losses, haltedUntilRiskDayUtcDate IS set.
 *
 *   VL5 — Durable arm relax OFF (regression): subsequent evaluateGates returns
 *          { allowed: false, rejectReason: 'halted' }.
 *
 *   VL6 — Cold-restart replay parity: 2 losses with sentinel threshold replayed
 *          via tryClose → ledger is NOT halted; state matches a live run (no
 *          haltedUntilRiskDayUtcDate set).
 *
 * Test structure: BUILD → OPERATE → CHECK
 * No real DB, no real exchange. VirtualPositionLedgerService is instantiated
 * directly — all state is in-memory. Factory functions keep each test independent.
 */

import { SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL, VIRTUAL_LEDGER_CONSECUTIVE_LOSS_HALT_THRESHOLD } from '../../const';
import { VirtualPositionLedgerService } from '../VirtualPositionLedgerService';

// ─── fixture constants ────────────────────────────────────────────────────────

const RISK_DAY = '2026-07-08';
const DAY_START_MS = new Date(`${RISK_DAY}T00:00:00.000Z`).getTime();

// Timestamps within the same risk day
const T1_MS = DAY_START_MS + 3_600_000; // 01:00 UTC
const T2_MS = DAY_START_MS + 7_200_000; // 02:00 UTC
const T3_MS = DAY_START_MS + 10_800_000; // 03:00 UTC

const ENTRY_PRICE = '50000';
const EXIT_PRICE_LOSS = '49000'; // exit < entry → loss on a LONG
const STOP_LOSS = '48000';
const TAKE_PROFIT = '52000';

// ─── ledger factory ───────────────────────────────────────────────────────────

function buildLedger(): VirtualPositionLedgerService {
    return new VirtualPositionLedgerService();
}

// ─── position-lifecycle helpers ───────────────────────────────────────────────

function openPosition(ledger: VirtualPositionLedgerService, virtualOrderId: string, nowMs: number, symbol = 'BTCUSDT'): void {
    ledger.tryOpen({
        eventId: `${symbol}:open:${nowMs}`,
        nowMs,
        riskDayUtcDate: RISK_DAY,
        symbol,
        side: 'long',
        entryPrice: ENTRY_PRICE,
        qty: '0.001',
        stopLoss: STOP_LOSS,
        takeProfit: TAKE_PROFIT,
        virtualOrderId,
    });
}

function closePositionWithLoss(
    ledger: VirtualPositionLedgerService,
    virtualOrderId: string,
    nowMs: number,
    symbol = 'BTCUSDT',
    consecutiveLossHaltThreshold = VIRTUAL_LEDGER_CONSECUTIVE_LOSS_HALT_THRESHOLD,
): void {
    ledger.tryClose({
        eventId: `${symbol}:close:${nowMs}`,
        nowMs,
        riskDayUtcDate: RISK_DAY,
        virtualOrderId,
        exitPrice: EXIT_PRICE_LOSS,
        closeReason: 'reverse_signal',
        // LONG exit below entry → negative PnL (loss)
        realizedPnl: '-1',
        consecutiveLossHaltThreshold,
    });
}

function buildGateInput(nowMs = T3_MS) {
    return {
        eventId: `gate-check:${nowMs}`,
        nowMs,
        riskDayUtcDate: RISK_DAY,
        decision: { action: 'open' },
        maxOpenPositions: 3,
        maxTradesPerDay: 10,
        haltAfterConsecutiveLosses: VIRTUAL_LEDGER_CONSECUTIVE_LOSS_HALT_THRESHOLD,
        requireExhaustionConfirmation: false,
        skipMarketStress: false,
        marginMode: 'isolated' as const,
    };
}

// ─── VL1: per-call gate relax ON ─────────────────────────────────────────────

describe('VirtualPositionLedgerService M36 — VL1: sentinel threshold → evaluateGates allows after 2 losses', () => {
    it('evaluateGates with sentinel haltAfterConsecutiveLosses does NOT return halt_after_consecutive_losses', () => {
        // BUILD
        const ledger = buildLedger();
        openPosition(ledger, 'order-1', T1_MS);
        closePositionWithLoss(ledger, 'order-1', T1_MS + 60_000, 'BTCUSDT', SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL);

        openPosition(ledger, 'order-2', T2_MS, 'ETHUSDT');
        closePositionWithLoss(ledger, 'order-2', T2_MS + 60_000, 'ETHUSDT', SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL);

        // OPERATE — evaluateGates with the sentinel threshold (relax mode)
        const outcome = ledger.evaluateGates({
            ...buildGateInput(),
            haltAfterConsecutiveLosses: SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL,
        });

        // CHECK — sentinel is unreachable; the per-call gate must not fire
        expect(outcome.allowed).toBe(true);
        expect(outcome.rejectReason).not.toBe('halt_after_consecutive_losses');
    });
});

// ─── VL2: durable arm relax ON ───────────────────────────────────────────────

describe('VirtualPositionLedgerService M36 — VL2: sentinel threshold in tryClose → haltedUntilRiskDayUtcDate NOT set', () => {
    it('after 2 consecutive losses with sentinel threshold, snapshot.haltedUntilRiskDayUtcDate is null', () => {
        // BUILD
        const ledger = buildLedger();
        openPosition(ledger, 'order-1', T1_MS);
        closePositionWithLoss(ledger, 'order-1', T1_MS + 60_000, 'BTCUSDT', SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL);

        openPosition(ledger, 'order-2', T2_MS, 'ETHUSDT');
        closePositionWithLoss(ledger, 'order-2', T2_MS + 60_000, 'ETHUSDT', SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL);

        // OPERATE
        const snapshot = ledger.snapshotForDecision(T3_MS);

        // CHECK — durable halt flag must remain unset
        expect(snapshot.haltedUntilRiskDayUtcDate).toBeNull();
    });
});

// ─── VL3: subsequent gate call with sentinel does not return 'halted' ─────────

describe('VirtualPositionLedgerService M36 — VL3: after sentinel closes, subsequent evaluateGates does NOT return halted', () => {
    it('evaluateGates on T3 with sentinel threshold does not return { allowed: false, rejectReason: halted }', () => {
        // BUILD
        const ledger = buildLedger();
        openPosition(ledger, 'order-1', T1_MS);
        closePositionWithLoss(ledger, 'order-1', T1_MS + 60_000, 'BTCUSDT', SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL);

        openPosition(ledger, 'order-2', T2_MS, 'ETHUSDT');
        closePositionWithLoss(ledger, 'order-2', T2_MS + 60_000, 'ETHUSDT', SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL);

        // OPERATE
        const outcome = ledger.evaluateGates({
            ...buildGateInput(T3_MS),
            haltAfterConsecutiveLosses: SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL,
        });

        // CHECK — isHalted() must return false because haltedUntilRiskDayUtcDate is null
        expect(outcome.rejectReason).not.toBe('halted');
    });
});

// ─── VL4: durable arm relax OFF (regression) ─────────────────────────────────

describe('VirtualPositionLedgerService M36 — VL4: default threshold (2) → 2 consecutive losses set haltedUntilRiskDayUtcDate', () => {
    it('after 2 consecutive losses with default threshold, haltedUntilRiskDayUtcDate equals the risk day', () => {
        // BUILD
        const ledger = buildLedger();
        openPosition(ledger, 'order-1', T1_MS);
        closePositionWithLoss(ledger, 'order-1', T1_MS + 60_000, 'BTCUSDT', VIRTUAL_LEDGER_CONSECUTIVE_LOSS_HALT_THRESHOLD);

        openPosition(ledger, 'order-2', T2_MS, 'ETHUSDT');
        closePositionWithLoss(ledger, 'order-2', T2_MS + 60_000, 'ETHUSDT', VIRTUAL_LEDGER_CONSECUTIVE_LOSS_HALT_THRESHOLD);

        // OPERATE
        const snapshot = ledger.snapshotForDecision(T3_MS);

        // CHECK — halt must be armed for today
        expect(snapshot.haltedUntilRiskDayUtcDate).toBe(RISK_DAY);
    });
});

// ─── VL5: subsequent gate returns 'halted' with default threshold ─────────────

describe('VirtualPositionLedgerService M36 — VL5: after default-threshold closes, evaluateGates returns halted (regression)', () => {
    it('evaluateGates returns { allowed: false, rejectReason: halted } after 2 default-threshold losses', () => {
        // BUILD
        const ledger = buildLedger();
        openPosition(ledger, 'order-1', T1_MS);
        closePositionWithLoss(ledger, 'order-1', T1_MS + 60_000, 'BTCUSDT', VIRTUAL_LEDGER_CONSECUTIVE_LOSS_HALT_THRESHOLD);

        openPosition(ledger, 'order-2', T2_MS, 'ETHUSDT');
        closePositionWithLoss(ledger, 'order-2', T2_MS + 60_000, 'ETHUSDT', VIRTUAL_LEDGER_CONSECUTIVE_LOSS_HALT_THRESHOLD);

        // OPERATE
        const outcome = ledger.evaluateGates({
            ...buildGateInput(T3_MS),
            haltAfterConsecutiveLosses: VIRTUAL_LEDGER_CONSECUTIVE_LOSS_HALT_THRESHOLD,
        });

        // CHECK
        expect(outcome.allowed).toBe(false);
        expect(outcome.rejectReason).toBe('halted');
    });
});

// ─── VL6: cold-restart replay parity ─────────────────────────────────────────

describe('VirtualPositionLedgerService M36 — VL6: cold-restart replay with sentinel produces same unhalted state', () => {
    it('replaying 2 loss closes via tryClose with sentinel threshold produces haltedUntilRiskDayUtcDate=null', () => {
        // BUILD — simulate what cold-restart rebuild does: replay the same events
        // in event order via tryClose with the sentinel threshold. The end state
        // must match a fresh live run (no haltedUntilRiskDayUtcDate set).
        const ledger = buildLedger();

        // Replay open + close for position 1
        openPosition(ledger, 'replay-order-1', T1_MS);
        closePositionWithLoss(ledger, 'replay-order-1', T1_MS + 60_000, 'BTCUSDT', SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL);

        // Replay open + close for position 2
        openPosition(ledger, 'replay-order-2', T2_MS, 'ETHUSDT');
        closePositionWithLoss(ledger, 'replay-order-2', T2_MS + 60_000, 'ETHUSDT', SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL);

        // OPERATE
        const snapshot = ledger.snapshotForDecision(T3_MS);

        // CHECK — replayed state must be identical to a fresh live run: no halt
        expect(snapshot.haltedUntilRiskDayUtcDate).toBeNull();
        // Both opens were processed and then closed; no open positions remain
        expect(snapshot.openPositions).toHaveLength(0);
    });

    it('sentinel threshold passed to closeBySymbol also leaves haltedUntilRiskDayUtcDate null', () => {
        // BUILD — closeBySymbol is the orchestrator-facing API; it must honour the sentinel
        const ledger = buildLedger();

        openPosition(ledger, 'sym-order-1', T1_MS);
        ledger.closeBySymbol(
            'BTCUSDT',
            EXIT_PRICE_LOSS,
            T1_MS + 60_000,
            'reverse_signal',
            `BTCUSDT:close:${T1_MS + 60_000}`,
            SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL,
        );

        openPosition(ledger, 'sym-order-2', T2_MS, 'ETHUSDT');
        ledger.closeBySymbol(
            'ETHUSDT',
            EXIT_PRICE_LOSS,
            T2_MS + 60_000,
            'reverse_signal',
            `ETHUSDT:close:${T2_MS + 60_000}`,
            SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL,
        );

        // OPERATE
        const snapshot = ledger.snapshotForDecision(T3_MS);

        // CHECK
        expect(snapshot.haltedUntilRiskDayUtcDate).toBeNull();
    });
});
