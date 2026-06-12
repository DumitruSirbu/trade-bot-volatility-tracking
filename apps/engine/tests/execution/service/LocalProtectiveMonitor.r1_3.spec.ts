/**
 * LocalProtectiveMonitor — R1.3.1b cleanup wave.
 *
 * Coverage (paired-per-fix, fail-before / pass-after):
 *   - `buildDeRiskContext` used to read `Date.now()`. The fix plumbs the
 *     originating IPriceUpdateEvent's `timestampMs` (exchange event time)
 *     down through `onPriceUpdate` → `handleBreach` → `buildDeRiskContext`.
 *     This test feeds two onPriceUpdate calls under a frozen wall clock
 *     advanced between runs but with the SAME event `timestampMs`. The gate
 *     receives identical `nowMs` and `utcDateString` inputs across the two
 *     runs (proves the wall clock no longer leaks in).
 */

import { ExitReasonEnum, IPriceUpdateEvent, OrderIntentActionEnum, PositionSideEnum, PositionSlotEnum, PositionStateEnum, RiskOutcomeEnum } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Money } from '../../../src/common/utils/money';
import { LocalProtectiveMonitor } from '../../../src/execution/service/LocalProtectiveMonitor';
import { SharedCloseCoordinator } from '../../../src/execution/service/SharedCloseCoordinator';
import { PositionEntity } from '../../../src/position/entity';
import { PositionRepository } from '../../../src/position/repository/PositionRepository';
import { IRiskGateContext } from '../../../src/risk/interface';
import { RiskGateService } from '../../../src/risk/service';

interface IHarness {
    monitor: LocalProtectiveMonitor;
    evaluateSpy: jest.Mock;
}

function buildHarness(): IHarness {
    const positionRow = {
        id: 42,
        symbol: 'BTCUSDT',
        side: PositionSideEnum.LONG,
        status: 'open',
        state: PositionStateEnum.OPEN,
        entryPrice: new Money('30000'),
        qty: new Money('0.01'),
        leverage: new Money('5'),
        positionSlot: PositionSlotEnum.A,
        strategyVersionId: 1,
        correlationMode: null,
        coinTier: null,
        flowTypeAtEntry: null,
    } as unknown as PositionEntity;

    const repository = { findById: jest.fn().mockResolvedValue(positionRow) } as unknown as PositionRepository;

    const evaluateSpy = jest.fn().mockResolvedValue({
        outcome: RiskOutcomeEnum.APPROVED,
        rejectReason: null,
        approvedSlot: PositionSlotEnum.A,
        approvedSizing: null,
        clampedExit: null,
        reservationId: null,
    });
    const gate = {
        evaluate: evaluateSpy,
        isRecoveryReady: jest.fn().mockReturnValue(true),
    } as unknown as RiskGateService;

    const events = new EventEmitter2();
    const monitor = new LocalProtectiveMonitor(repository, gate, events, new SharedCloseCoordinator());

    return { monitor, evaluateSpy };
}

const EVENT_TS_MS = 1_700_000_000_000;

function buildPriceUpdate(price: string): IPriceUpdateEvent {
    return { symbol: 'BTCUSDT', price, timestampMs: EVENT_TS_MS };
}

describe('LocalProtectiveMonitor — R1.3.1b determinism (buildDeRiskContext nowMs from event.timestampMs)', () => {
    it('two identical onPriceUpdate runs under different wall-clocks but same event.timestampMs pass identical context.nowMs to the gate', async () => {
        const dateNowSpy = jest.spyOn(Date, 'now');

        // Run A — wall clock arbitrary
        dateNowSpy.mockReturnValue(EVENT_TS_MS + 11_111);
        const harnessA = buildHarness();
        harnessA.monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29500'),
            takeProfitPrice: new Money('31000'),
        });

        await harnessA.monitor.onPriceUpdate(buildPriceUpdate('29400'));

        // Run B — wall clock advanced significantly
        dateNowSpy.mockReturnValue(EVENT_TS_MS + 9_999_999);
        const harnessB = buildHarness();
        harnessB.monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29500'),
            takeProfitPrice: new Money('31000'),
        });

        await harnessB.monitor.onPriceUpdate(buildPriceUpdate('29400'));

        dateNowSpy.mockRestore();

        expect(harnessA.evaluateSpy).toHaveBeenCalledTimes(1);
        expect(harnessB.evaluateSpy).toHaveBeenCalledTimes(1);

        const contextA = harnessA.evaluateSpy.mock.calls[0][1] as IRiskGateContext;
        const contextB = harnessB.evaluateSpy.mock.calls[0][1] as IRiskGateContext;

        // The load-bearing assertions: the gate's context received identical
        // time inputs across the two runs, proving Date.now() no longer leaks
        // into the de-risking context.
        expect(contextA.nowMs).toBe(EVENT_TS_MS);
        expect(contextB.nowMs).toBe(EVENT_TS_MS);
        expect(contextA.nowMs).toBe(contextB.nowMs);
        expect(contextA.utcDateString).toBe(contextB.utcDateString);

        // Sanity: the breach still fires correctly under the fix.
        const intentA = harnessA.evaluateSpy.mock.calls[0][0] as {
            intentAction: OrderIntentActionEnum;
            exitReason: ExitReasonEnum;
            tradeSide: PositionSideEnum;
        };
        expect(intentA.intentAction).toBe(OrderIntentActionEnum.CLOSE);
        expect(intentA.exitReason).toBe(ExitReasonEnum.STOP_LOSS);
        expect(intentA.tradeSide).toBe(PositionSideEnum.SHORT);
    });
});
