import { RiskStateLifecycleListener } from '../../src/risk/listener/RiskStateLifecycleListener';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { RiskStateRepository } from '../../src/risk/repository/RiskStateRepository';
import { Money } from '../../src/common/utils/money';

// M31 Wave B (Defect 3, Task 4). The lifecycle listener recomputes risk_state accounting
// (open_exposure / realized_pnl_day / trades_count) on every POSITION_OPENED / POSITION_CLOSED
// event via SELECT-then-upsert (Option R — idempotent by construction).
//
// Covers:
//   - open event recomputes from the live-risk + closed-today aggregates
//   - close event uses the same recompute path
//   - open_exposure is the residual aggregate, NOT entry_notional
//   - the closed-today predicate is scoped to the current UTC day start (half-open)
//   - duplicate events are idempotent (re-derive identical totals)
//
// M31 R1: the listener now calls the column-scoped `upsertAccountingForDay(date, data)` and
// never reads `findByDate` — halt SoT (is_halted / halt_reason) is owned exclusively by the
// halt-gate paths, so the listener no longer carries those fields.

interface IMocks {
    listener: RiskStateLifecycleListener;
    findLiveRiskAggregates: jest.Mock;
    findClosedTodayAggregates: jest.Mock;
    upsertAccountingForDay: jest.Mock;
}

function buildListener(): IMocks {
    const findLiveRiskAggregates = jest.fn().mockResolvedValue({ openExposure: new Money('800') });
    const findClosedTodayAggregates = jest.fn().mockResolvedValue({ realizedPnlDay: new Money('12.5'), tradesCount: 3 });
    const upsertAccountingForDay = jest.fn().mockResolvedValue(undefined);

    const positions = { findLiveRiskAggregates, findClosedTodayAggregates } as unknown as PositionRepository;
    const riskState = { upsertAccountingForDay } as unknown as RiskStateRepository;

    const listener = new RiskStateLifecycleListener(positions, riskState);

    return { listener, findLiveRiskAggregates, findClosedTodayAggregates, upsertAccountingForDay };
}

function todayUtcDateString(): string {
    const now = new Date();

    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
}

describe('RiskStateLifecycleListener — recompute-on-lifecycle (Option R)', () => {
    it('onPositionOpened recomputes open_exposure + realized + trades from the aggregates', async () => {
        const mocks = buildListener();

        await mocks.listener.onPositionOpened();

        expect(mocks.upsertAccountingForDay).toHaveBeenCalledTimes(1);
        const date = mocks.upsertAccountingForDay.mock.calls[0][0];
        const day = mocks.upsertAccountingForDay.mock.calls[0][1];
        expect(day.openExposure.toFixed()).toBe('800');
        expect(day.realizedPnlDay.toFixed()).toBe('12.5');
        expect(day.tradesCount).toBe(3);
        expect(date).toBe(todayUtcDateString());
    });

    it('onPositionClosed uses the same recompute path', async () => {
        const mocks = buildListener();

        await mocks.listener.onPositionClosed();

        expect(mocks.findLiveRiskAggregates).toHaveBeenCalledTimes(1);
        expect(mocks.findClosedTodayAggregates).toHaveBeenCalledTimes(1);
        expect(mocks.upsertAccountingForDay).toHaveBeenCalledTimes(1);
    });

    it('scopes the closed-today aggregate to the current UTC day start (midnight UTC)', async () => {
        const mocks = buildListener();

        await mocks.listener.onPositionClosed();

        const dayStart = mocks.findClosedTodayAggregates.mock.calls[0][0] as Date;
        expect(dayStart.getUTCHours()).toBe(0);
        expect(dayStart.getUTCMinutes()).toBe(0);
        expect(dayStart.getUTCSeconds()).toBe(0);
        expect(dayStart.getUTCMilliseconds()).toBe(0);
        expect(dayStart.toISOString().slice(0, 10)).toBe(todayUtcDateString());
    });

    it('is idempotent: two identical events re-derive identical upsert payloads (no double-book)', async () => {
        const mocks = buildListener();

        await mocks.listener.onPositionOpened();
        await mocks.listener.onPositionOpened();

        const first = mocks.upsertAccountingForDay.mock.calls[0][1];
        const second = mocks.upsertAccountingForDay.mock.calls[1][1];
        expect(second.openExposure.toFixed()).toBe(first.openExposure.toFixed());
        expect(second.realizedPnlDay.toFixed()).toBe(first.realizedPnlDay.toFixed());
        expect(second.tradesCount).toBe(first.tradesCount);
    });
});
