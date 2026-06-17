/**
 * VirtualPositionLedgerService — M39 W1: force_close streak exclusion
 *
 * Surfaces under test:
 *
 *   FC1 — N ≥ 3 force_close exits (all negative PnL) → streak = 0.
 *          force_close is neither an arming loss nor a streak reset.
 *
 *   FC2 — sl loss → force_close loss → sl loss → streak = 2.
 *          An interleaved force_close neither breaks the chain nor resets it.
 *
 *   FC3 — Two sl losses → streak = 2 (sl still arms normally, regression guard).
 *
 *   FC4 — sl loss → tp win → sl loss → streak = 1 (tp win resets, force_close absent).
 *
 * Test structure: BUILD → OPERATE → CHECK
 * No real DB, no NestJS DI. VirtualPositionLedgerService is constructed directly.
 * Factory functions keep each test independent.
 */

import { VirtualPositionLedgerService } from '../VirtualPositionLedgerService';
import { SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL, VIRTUAL_LEDGER_CONSECUTIVE_LOSS_HALT_THRESHOLD } from '../../const';

// ─── fixture constants ────────────────────────────────────────────────────────

const RISK_DAY = '2026-07-10';
const DAY_START_MS = new Date(`${RISK_DAY}T00:00:00.000Z`).getTime();

const T1_MS = DAY_START_MS + 1_800_000; // 00:30 UTC
const T2_MS = DAY_START_MS + 3_600_000; // 01:00 UTC
const T3_MS = DAY_START_MS + 5_400_000; // 01:30 UTC
const T4_MS = DAY_START_MS + 7_200_000; // 02:00 UTC

const ENTRY_PRICE = '50000';
const STOP_LOSS = '48000';
const TAKE_PROFIT = '52000';
const EXIT_PRICE_LOSS = '49000'; // exit < entry → negative PnL on a LONG
const EXIT_PRICE_WIN = '51000'; // exit > entry → positive PnL on a LONG

// ─── factory helpers ──────────────────────────────────────────────────────────

function buildLedger(): VirtualPositionLedgerService {
    return new VirtualPositionLedgerService();
}

function openPosition(ledger: VirtualPositionLedgerService, virtualOrderId: string, nowMs: number, symbol = 'BTCUSDT'): void {
    ledger.tryOpen({
        eventId: `open:${symbol}:${nowMs}`,
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

type CloseReason = 'sl' | 'tp' | 'force_close' | 'time_stop' | 'reverse_signal';

function closePosition(
    ledger: VirtualPositionLedgerService,
    virtualOrderId: string,
    nowMs: number,
    closeReason: CloseReason,
    exitPrice: string,
    symbol = 'BTCUSDT',
): void {
    ledger.tryClose({
        eventId: `close:${symbol}:${nowMs}`,
        nowMs,
        riskDayUtcDate: RISK_DAY,
        virtualOrderId,
        exitPrice,
        closeReason,
        realizedPnl: closeReason === 'tp' ? '1' : '-1',
        // Use the sentinel so these test-specific closes never arm the halt,
        // which would complicate streak-count assertions.
        consecutiveLossHaltThreshold: SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL,
    });
}

// ─── FC1: N force_close exits do NOT arm the streak ──────────────────────────

describe('VirtualPositionLedgerService M39 — FC1: multiple force_close exits leave streak at 0', () => {
    it('three force_close losses produce countConsecutiveLossesInRiskDay = 0', () => {
        // BUILD
        const ledger = buildLedger();

        openPosition(ledger, 'order-1', T1_MS, 'BTCUSDT');
        closePosition(ledger, 'order-1', T1_MS + 60_000, 'force_close', EXIT_PRICE_LOSS, 'BTCUSDT');

        openPosition(ledger, 'order-2', T2_MS, 'ETHUSDT');
        closePosition(ledger, 'order-2', T2_MS + 60_000, 'force_close', EXIT_PRICE_LOSS, 'ETHUSDT');

        openPosition(ledger, 'order-3', T3_MS, 'SOLUSDT');
        closePosition(ledger, 'order-3', T3_MS + 60_000, 'force_close', EXIT_PRICE_LOSS, 'SOLUSDT');

        // OPERATE
        const streak = ledger.countConsecutiveLossesInRiskDay(RISK_DAY);

        // CHECK — force_close exits are transparent to the streak counter
        expect(streak).toBe(0);
    });
});

// ─── FC2: force_close between sl losses does NOT reset the streak ─────────────

describe('VirtualPositionLedgerService M39 — FC2: force_close between sl losses does not reset the streak', () => {
    it('sl loss → force_close loss → sl loss produces streak = 2', () => {
        // BUILD
        const ledger = buildLedger();

        // First sl loss
        openPosition(ledger, 'order-1', T1_MS, 'BTCUSDT');
        closePosition(ledger, 'order-1', T1_MS + 60_000, 'sl', EXIT_PRICE_LOSS, 'BTCUSDT');

        // Interleaved force_close — must be invisible to the streak
        openPosition(ledger, 'order-2', T2_MS, 'ETHUSDT');
        closePosition(ledger, 'order-2', T2_MS + 60_000, 'force_close', EXIT_PRICE_LOSS, 'ETHUSDT');

        // Second sl loss
        openPosition(ledger, 'order-3', T3_MS, 'SOLUSDT');
        closePosition(ledger, 'order-3', T3_MS + 60_000, 'sl', EXIT_PRICE_LOSS, 'SOLUSDT');

        // OPERATE
        const streak = ledger.countConsecutiveLossesInRiskDay(RISK_DAY);

        // CHECK — the force_close is skipped; the two sl losses form a streak of 2
        expect(streak).toBe(2);
    });
});

// ─── FC3: sl losses still arm the streak normally ────────────────────────────

describe('VirtualPositionLedgerService M39 — FC3: sl losses arm the streak (regression guard)', () => {
    it('two sl losses produce streak = 2', () => {
        // BUILD
        const ledger = buildLedger();

        openPosition(ledger, 'order-1', T1_MS, 'BTCUSDT');
        closePosition(ledger, 'order-1', T1_MS + 60_000, 'sl', EXIT_PRICE_LOSS, 'BTCUSDT');

        openPosition(ledger, 'order-2', T2_MS, 'ETHUSDT');
        closePosition(ledger, 'order-2', T2_MS + 60_000, 'sl', EXIT_PRICE_LOSS, 'ETHUSDT');

        // OPERATE
        const streak = ledger.countConsecutiveLossesInRiskDay(RISK_DAY);

        // CHECK
        expect(streak).toBe(2);
    });
});

// ─── FC4: tp win resets the streak ───────────────────────────────────────────

describe('VirtualPositionLedgerService M39 — FC4: tp win resets the streak between sl losses', () => {
    it('sl loss → tp win → sl loss produces streak = 1', () => {
        // BUILD
        const ledger = buildLedger();

        // First sl loss
        openPosition(ledger, 'order-1', T1_MS, 'BTCUSDT');
        closePosition(ledger, 'order-1', T1_MS + 60_000, 'sl', EXIT_PRICE_LOSS, 'BTCUSDT');

        // tp win — resets the streak
        openPosition(ledger, 'order-2', T2_MS, 'ETHUSDT');
        closePosition(ledger, 'order-2', T2_MS + 60_000, 'tp', EXIT_PRICE_WIN, 'ETHUSDT');

        // Second sl loss — starts a new streak of 1
        openPosition(ledger, 'order-3', T3_MS, 'SOLUSDT');
        closePosition(ledger, 'order-3', T3_MS + 60_000, 'sl', EXIT_PRICE_LOSS, 'SOLUSDT');

        // OPERATE
        const streak = ledger.countConsecutiveLossesInRiskDay(RISK_DAY);

        // CHECK — only the final sl loss counts; the win reset the prior sl
        expect(streak).toBe(1);
    });
});

// ─── FC5: N≥3 consecutive force_close exits do NOT halt (real threshold) ─────

describe('VirtualPositionLedgerService M39 — FC5: N consecutive force_close exits do not halt with real threshold', () => {
    it('three consecutive force_close negative-PnL exits do not arm isHalted (halt threshold = 2)', () => {
        // BUILD — use the REAL halt threshold (2), not the sentinel, so the halt
        // can actually fire if the streak counter wrongly counts force_close losses.
        const ledger = buildLedger();

        for (let i = 0; i < 3; i++) {
            const nowMs = T1_MS + i * 120_000;
            const orderId = `order-fc-${i}`;
            const sym = `SYM${i}USDT`;
            ledger.tryOpen({
                eventId: `open:${sym}:${nowMs}`,
                nowMs,
                riskDayUtcDate: RISK_DAY,
                symbol: sym,
                side: 'long',
                entryPrice: ENTRY_PRICE,
                qty: '0.001',
                stopLoss: STOP_LOSS,
                takeProfit: TAKE_PROFIT,
                virtualOrderId: orderId,
            });
            ledger.tryClose({
                eventId: `close:${sym}:${nowMs}`,
                nowMs: nowMs + 60_000,
                riskDayUtcDate: RISK_DAY,
                virtualOrderId: orderId,
                exitPrice: EXIT_PRICE_LOSS,
                closeReason: 'force_close',
                realizedPnl: '-1.0',
                consecutiveLossHaltThreshold: VIRTUAL_LEDGER_CONSECUTIVE_LOSS_HALT_THRESHOLD,
            });
        }

        // CHECK — force_close entries are skipped; streak = 0, no halt
        expect(ledger.countConsecutiveLossesInRiskDay(RISK_DAY)).toBe(0);
        expect(ledger.isHalted(T1_MS + 400_000)).toBe(false);
    });
});

// ─── FC6: time_stop loss arms the streak ─────────────────────────────────────

describe('VirtualPositionLedgerService M39 — FC6: time_stop loss arms the streak like sl', () => {
    it('two time_stop losses produce streak = 2 and arm the halt (real threshold = 2)', () => {
        // BUILD
        const ledger = buildLedger();

        for (let i = 0; i < 2; i++) {
            const nowMs = T1_MS + i * 120_000;
            const orderId = `order-ts-${i}`;
            ledger.tryOpen({
                eventId: `open:ts:${nowMs}`,
                nowMs,
                riskDayUtcDate: RISK_DAY,
                symbol: 'BTCUSDT',
                side: 'long',
                entryPrice: ENTRY_PRICE,
                qty: '0.001',
                stopLoss: STOP_LOSS,
                takeProfit: TAKE_PROFIT,
                virtualOrderId: orderId,
            });
            ledger.tryClose({
                eventId: `close:ts:${nowMs}`,
                nowMs: nowMs + 60_000,
                riskDayUtcDate: RISK_DAY,
                virtualOrderId: orderId,
                exitPrice: EXIT_PRICE_LOSS,
                closeReason: 'time_stop',
                realizedPnl: '-1.0',
                consecutiveLossHaltThreshold: VIRTUAL_LEDGER_CONSECUTIVE_LOSS_HALT_THRESHOLD,
            });
        }

        // CHECK — time_stop losses arm the streak; 2 = halt threshold → halted
        expect(ledger.countConsecutiveLossesInRiskDay(RISK_DAY)).toBe(2);
        expect(ledger.isHalted(T1_MS + 400_000)).toBe(true);
    });
});

// ─── boundary: mixed force_close and sl does not over-count ──────────────────

describe('VirtualPositionLedgerService M39 — boundary: force_close entries are skipped across mixed history', () => {
    it('force_close → sl → force_close → sl produces streak = 2 (two uninterrupted sl losses)', () => {
        // BUILD
        const ledger = buildLedger();

        openPosition(ledger, 'order-1', T1_MS, 'BTCUSDT');
        closePosition(ledger, 'order-1', T1_MS + 60_000, 'force_close', EXIT_PRICE_LOSS, 'BTCUSDT');

        openPosition(ledger, 'order-2', T2_MS, 'ETHUSDT');
        closePosition(ledger, 'order-2', T2_MS + 60_000, 'sl', EXIT_PRICE_LOSS, 'ETHUSDT');

        openPosition(ledger, 'order-3', T3_MS, 'SOLUSDT');
        closePosition(ledger, 'order-3', T3_MS + 60_000, 'force_close', EXIT_PRICE_LOSS, 'SOLUSDT');

        openPosition(ledger, 'order-4', T4_MS, 'BNBUSDT');
        closePosition(ledger, 'order-4', T4_MS + 60_000, 'sl', EXIT_PRICE_LOSS, 'BNBUSDT');

        // OPERATE
        const streak = ledger.countConsecutiveLossesInRiskDay(RISK_DAY);

        // CHECK — the two sl losses are "adjacent" after skipping the force_close entries
        expect(streak).toBe(2);
    });
});
