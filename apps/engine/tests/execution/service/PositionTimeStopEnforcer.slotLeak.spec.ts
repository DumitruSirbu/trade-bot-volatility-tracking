/**
 * PositionTimeStopEnforcer — M33 R1-Fix-A slot-leak safety net.
 *
 * `enforceTimeStop` runs as a floating `void` call after the slot is acquired synchronously on the
 * price hot-path. Before R1-Fix-A, an unexpected throw from any `await` inside it (DB candidate
 * re-read, gate evaluate) leaked the held slot forever — the position became permanently
 * uncloseable for that run. These tests assert the try/catch safety net releases the slot.
 *
 *   D-CO-3-adv slot-leak: a DB throw inside enforceTimeStop releases the slot.
 *   D-CO-3-adv slot-leak: a gate throw inside enforceTimeStop releases the slot.
 */

import { PositionSideEnum, PositionSlotEnum, PositionStateEnum } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Money } from '../../../src/common/utils/money';
import { PositionTimeStopEnforcer } from '../../../src/execution/service/PositionTimeStopEnforcer';
import { SharedCloseCoordinator } from '../../../src/execution/service/SharedCloseCoordinator';
import { PositionEntity } from '../../../src/position/entity';
import { PositionRepository } from '../../../src/position/repository/PositionRepository';
import { RiskGateService } from '../../../src/risk/service';

const SYMBOL = 'BTCUSDT';
const DEADLINE_MS = 1_700_000_000_000;
const POSITION_ID = 42;
const PAST_DEADLINE_MS = DEADLINE_MS + 60_000;

function buildRow(): PositionEntity {
    return {
        id: POSITION_ID,
        symbol: SYMBOL,
        side: PositionSideEnum.LONG,
        state: PositionStateEnum.OPEN,
        qty: new Money('0.01'),
        entryPrice: new Money('30000'),
        leverage: new Money('5'),
        positionSlot: PositionSlotEnum.A,
        strategyVersionId: 1,
        correlationMode: null,
        coinTier: null,
        flowTypeAtEntry: null,
        stopLossPrice: new Money('29000'),
        takeProfitPrice: new Money('31000'),
        timeStopAt: new Date(DEADLINE_MS),
    } as unknown as PositionEntity;
}

// Chained microtasks so the floating `void enforceTimeStop(...)` chain settles before assertions.
async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
}

describe('PositionTimeStopEnforcer slot-leak safety net', () => {
    it('D-CO-3-adv slot-leak: a DB throw inside enforceTimeStop releases the slot', async () => {
        // BUILD
        const row = buildRow();
        const findCandidates = jest
            .fn()
            .mockResolvedValueOnce([row]) // onModuleInit index build succeeds
            .mockRejectedValue(new Error('db down')); // the hot-path re-read throws

        const repository = {
            findTimeStopCandidatesBySymbol: findCandidates,
            findOpen: jest.fn().mockResolvedValue([row]),
        } as unknown as PositionRepository;

        const gate = { evaluate: jest.fn() } as unknown as RiskGateService;
        const events = new EventEmitter2();
        const coordinator = new SharedCloseCoordinator();
        const enforcer = new PositionTimeStopEnforcer(repository, gate, events, coordinator);

        await enforcer.onModuleInit();

        // OPERATE
        enforcer.onPriceUpdate({ symbol: SYMBOL, price: '30000', timestampMs: PAST_DEADLINE_MS });
        await flush();

        // CHECK
        expect(coordinator.isHeld(POSITION_ID)).toBe(false);
    });

    it('D-CO-3-adv slot-leak: a gate throw inside enforceTimeStop releases the slot', async () => {
        // BUILD
        const row = buildRow();
        const findCandidates = jest.fn().mockResolvedValue([row]);

        const repository = {
            findTimeStopCandidatesBySymbol: findCandidates,
            findOpen: jest.fn().mockResolvedValue([row]),
        } as unknown as PositionRepository;

        const evaluate = jest.fn().mockRejectedValue(new Error('gate exploded'));
        const gate = { evaluate } as unknown as RiskGateService;
        const events = new EventEmitter2();
        const coordinator = new SharedCloseCoordinator();
        const enforcer = new PositionTimeStopEnforcer(repository, gate, events, coordinator);

        await enforcer.onModuleInit();

        // OPERATE
        enforcer.onPriceUpdate({ symbol: SYMBOL, price: '30000', timestampMs: PAST_DEADLINE_MS });
        await flush();

        // CHECK
        expect(evaluate).toHaveBeenCalledTimes(1);
        expect(coordinator.isHeld(POSITION_ID)).toBe(false);
    });
});
