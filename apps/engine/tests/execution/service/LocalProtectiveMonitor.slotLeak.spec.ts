/**
 * LocalProtectiveMonitor — M33 R1-Fix-A slot-leak safety net.
 *
 * `handleBreach` acquires the shared close slot synchronously, then awaits `findById` and the gate
 * evaluate. Before R1-Fix-A, an unexpected throw from either await leaked the held slot forever —
 * the position became structurally unprotected for that run. This test asserts the try/catch safety
 * net releases the slot.
 *
 *   D-CO-3-adv slot-leak: a gate throw inside handleBreach releases the slot.
 */

import { PositionSideEnum, PositionStateEnum } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Money } from '../../../src/common/utils/money';
import { LocalProtectiveMonitor } from '../../../src/execution/service/LocalProtectiveMonitor';
import { SharedCloseCoordinator } from '../../../src/execution/service/SharedCloseCoordinator';
import { PositionEntity } from '../../../src/position/entity';
import { PositionRepository } from '../../../src/position/repository/PositionRepository';
import { RiskGateService } from '../../../src/risk/service';

const POSITION_ID = 42;
const SYMBOL = 'BTCUSDT';

function buildRow(): PositionEntity {
    return {
        id: POSITION_ID,
        symbol: SYMBOL,
        side: PositionSideEnum.LONG,
        state: PositionStateEnum.OPEN,
        entryPrice: new Money('30000'),
        qty: new Money('0.01'),
        leverage: new Money('5'),
        positionSlot: 'A' as any,
        strategyVersionId: 1,
        correlationMode: null,
        coinTier: null,
        flowTypeAtEntry: null,
    } as unknown as PositionEntity;
}

describe('LocalProtectiveMonitor slot-leak safety net', () => {
    it('D-CO-3-adv slot-leak: a gate throw inside handleBreach releases the slot', async () => {
        // BUILD
        const repository = {
            findById: jest.fn().mockResolvedValue(buildRow()),
        } as unknown as PositionRepository;

        const evaluate = jest.fn().mockRejectedValue(new Error('gate exploded'));
        const gate = { evaluate } as unknown as RiskGateService;
        const events = new EventEmitter2();
        const coordinator = new SharedCloseCoordinator();
        const monitor = new LocalProtectiveMonitor(repository, gate, events, coordinator);

        monitor.arm({
            positionId: POSITION_ID,
            symbol: SYMBOL,
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29000'),
            takeProfitPrice: new Money('31000'),
        });

        // OPERATE — a tick at/below SL breaches and routes through the gate, which throws.
        await monitor.onPriceUpdate({ symbol: SYMBOL, price: '28000', timestampMs: 1_700_000_000_000 });

        // CHECK
        expect(evaluate).toHaveBeenCalledTimes(1);
        expect(coordinator.isHeld(POSITION_ID)).toBe(false);
    });
});
