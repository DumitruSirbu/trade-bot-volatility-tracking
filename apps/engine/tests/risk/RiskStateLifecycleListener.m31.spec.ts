/**
 * M31 — RiskStateLifecycleListener adversarial coverage (D3).
 *
 * The base happy-path suite lives in RiskStateLifecycleListener.spec.ts.
 * This file covers the adversarial cases added by M31:
 *
 *   D3          — open event → open_exposure = qty * entryPrice (residual, NOT entry_notional).
 *                 Close event → open_exposure = 0, trades_count = 1, realized_pnl_day set.
 *   D3-adv      — duplicate POSITION_CLOSED_EVENT: trades_count and realized_pnl_day do NOT
 *                 double-count (idempotent re-derive, not incremental accumulation).
 *   D3-residual — position with ADD (entry_notional > qty * entryPrice): after open, exposure
 *                 equals qty * entryPrice (residual), NOT entry_notional.
 */

import { RiskStateLifecycleListener } from '../../src/risk/listener/RiskStateLifecycleListener';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { RiskStateRepository } from '../../src/risk/repository/RiskStateRepository';
import { Money, MoneyValue } from '../../src/common/utils/money';

// ─── mock builder ─────────────────────────────────────────────────────────────
//
// M31 R1: the listener now calls the column-scoped `upsertAccountingForDay(date, data)` and
// never reads `findByDate` — the recompute payload lands in the second positional argument.

interface IMocks {
    listener: RiskStateLifecycleListener;
    findLiveRiskAggregates: jest.Mock;
    findClosedTodayAggregates: jest.Mock;
    upsertAccountingForDay: jest.Mock;
}

function buildListener(
    opts: {
        openExposure?: MoneyValue;
        realizedPnlDay?: MoneyValue;
        tradesCount?: number;
    } = {},
): IMocks {
    const openExposure = opts.openExposure ?? new Money('0');
    const realizedPnlDay = opts.realizedPnlDay ?? new Money('0');
    const tradesCount = opts.tradesCount ?? 0;

    const findLiveRiskAggregates = jest.fn().mockResolvedValue({ openExposure });
    const findClosedTodayAggregates = jest.fn().mockResolvedValue({ realizedPnlDay, tradesCount });
    const upsertAccountingForDay = jest.fn().mockResolvedValue(undefined);

    const positions = { findLiveRiskAggregates, findClosedTodayAggregates } as unknown as PositionRepository;
    const riskState = { upsertAccountingForDay } as unknown as RiskStateRepository;
    const listener = new RiskStateLifecycleListener(positions, riskState);

    return { listener, findLiveRiskAggregates, findClosedTodayAggregates, upsertAccountingForDay };
}

// ─── D3 — recompute-on-open and recompute-on-close within the same run ────────

describe('M31 D3 — RiskStateLifecycleListener recompute-on-lifecycle accounting', () => {
    it('open event sets open_exposure to the residual (qty * entryPrice) returned by findLiveRiskAggregates', async () => {
        // Simulate one live position with residual = 0.01 * 30000 = 300.
        const mocks = buildListener({ openExposure: new Money('300'), realizedPnlDay: new Money('0'), tradesCount: 0 });

        await mocks.listener.onPositionOpened();

        const upsertArg = mocks.upsertAccountingForDay.mock.calls[0][1];
        expect(upsertArg.openExposure.toFixed()).toBe('300');
    });

    it('close event sets open_exposure = 0, trades_count = 1, realized_pnl_day from aggregate', async () => {
        // After the close: no live positions → exposure = 0; one closed today.
        const mocks = buildListener({
            openExposure: new Money('0'),
            realizedPnlDay: new Money('7.25'),
            tradesCount: 1,
        });

        await mocks.listener.onPositionClosed();

        const upsertArg = mocks.upsertAccountingForDay.mock.calls[0][1];
        expect(upsertArg.openExposure.toFixed()).toBe('0');
        expect(upsertArg.tradesCount).toBe(1);
        expect(upsertArg.realizedPnlDay.toFixed()).toBe('7.25');
    });

    it('open event then close event — post-close upsert uses the aggregates at close-time', async () => {
        // Open: exposure = 300. Close: exposure drops to 0, trades_count = 1.
        const mocks = buildListener({ openExposure: new Money('0'), realizedPnlDay: new Money('5.5'), tradesCount: 1 });

        // Simulate the open event arriving first (exposure was 300 then).
        mocks.findLiveRiskAggregates.mockResolvedValueOnce({ openExposure: new Money('300') });
        mocks.findClosedTodayAggregates.mockResolvedValueOnce({ realizedPnlDay: new Money('0'), tradesCount: 0 });

        await mocks.listener.onPositionOpened();

        // Then the close event — now exposure = 0, 1 trade closed today.
        await mocks.listener.onPositionClosed();

        expect(mocks.upsertAccountingForDay).toHaveBeenCalledTimes(2);
        const afterClose = mocks.upsertAccountingForDay.mock.calls[1][1];
        expect(afterClose.openExposure.toFixed()).toBe('0');
        expect(afterClose.tradesCount).toBe(1);
        expect(afterClose.realizedPnlDay.toFixed()).toBe('5.5');
    });
});

// ─── D3-adv — idempotency: duplicate event cannot double-count ───────────────

describe('M31 D3-adv — duplicate POSITION_CLOSED_EVENT cannot double-count (idempotent re-derive)', () => {
    it('two identical closed events produce the same upsert payload both times', async () => {
        const mocks = buildListener({
            openExposure: new Money('0'),
            realizedPnlDay: new Money('12.5'),
            tradesCount: 3,
        });

        await mocks.listener.onPositionClosed();
        await mocks.listener.onPositionClosed();

        expect(mocks.upsertAccountingForDay).toHaveBeenCalledTimes(2);
        const first = mocks.upsertAccountingForDay.mock.calls[0][1];
        const second = mocks.upsertAccountingForDay.mock.calls[1][1];

        // Both calls must produce identical totals — no accumulation.
        expect(second.openExposure.toFixed()).toBe(first.openExposure.toFixed());
        expect(second.tradesCount).toBe(first.tradesCount);
        expect(second.realizedPnlDay.toFixed()).toBe(first.realizedPnlDay.toFixed());
    });

    it('duplicate events never produce negative exposure', async () => {
        const mocks = buildListener({ openExposure: new Money('0'), realizedPnlDay: new Money('5'), tradesCount: 1 });

        await mocks.listener.onPositionClosed();
        await mocks.listener.onPositionClosed();

        for (const call of mocks.upsertAccountingForDay.mock.calls) {
            const arg = call[1] as { openExposure: MoneyValue };
            expect(arg.openExposure.greaterThanOrEqualTo(0)).toBe(true);
        }
    });

    it('duplicate open events produce the same open_exposure both times', async () => {
        const mocks = buildListener({ openExposure: new Money('800'), realizedPnlDay: new Money('0'), tradesCount: 0 });

        await mocks.listener.onPositionOpened();
        await mocks.listener.onPositionOpened();

        const first = mocks.upsertAccountingForDay.mock.calls[0][1];
        const second = mocks.upsertAccountingForDay.mock.calls[1][1];
        expect(second.openExposure.toFixed()).toBe(first.openExposure.toFixed());
    });
});

// ─── D3-residual — residual uses qty * entryPrice, NOT entry_notional ─────────

describe('M31 D3-residual — open_exposure is residual (qty * entryPrice), NOT entry_notional', () => {
    /**
     * After an ADD, entry_notional accumulates to the sum of all entries (>= qty * entryPrice).
     * The listener reads from findLiveRiskAggregates which is defined as SUM(qty * entry_price)
     * over live rows — the residual formula. This test verifies the listener passes through
     * whatever the aggregate returns without substituting entry_notional.
     *
     * Scenario: a position opened at 0.01 BTC @ 30000 (notional=300), then ADDed 0.005 BTC
     * @ 30000 (entry_notional becomes 450). Current qty=0.015, residual=0.015*30000=450.
     * But if there was a partial reduce, qty might be 0.010, residual=300, entry_notional still 450.
     * The listener must expose residual=300, NOT 450.
     */
    it('when entry_notional > qty * entryPrice, open_exposure equals residual (qty * entryPrice)', async () => {
        // Aggregate represents: qty=0.010, entryPrice=30000 → residual = 300.
        // entry_notional would be 450 (after an ADD that is no longer fully open).
        const residualExposure = new Money('300');
        // entry_notional is NOT what the listener receives — it only calls findLiveRiskAggregates.
        const mocks = buildListener({ openExposure: residualExposure });

        await mocks.listener.onPositionOpened();

        const upsertArg = mocks.upsertAccountingForDay.mock.calls[0][1];
        // Must be residual (300), NOT the hypothetical entry_notional (450).
        expect(upsertArg.openExposure.toFixed()).toBe('300');
    });

    it('findLiveRiskAggregates is called (not any entry_notional source) on the open event', async () => {
        const mocks = buildListener({ openExposure: new Money('150') });

        await mocks.listener.onPositionOpened();

        // The only source of exposure data must be the residual aggregate.
        expect(mocks.findLiveRiskAggregates).toHaveBeenCalledTimes(1);
    });

    it('findLiveRiskAggregates is called (not any entry_notional source) on the close event', async () => {
        const mocks = buildListener({ openExposure: new Money('0') });

        await mocks.listener.onPositionClosed();

        expect(mocks.findLiveRiskAggregates).toHaveBeenCalledTimes(1);
    });
});
