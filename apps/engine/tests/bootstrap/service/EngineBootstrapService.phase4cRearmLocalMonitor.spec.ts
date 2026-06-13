/**
 * EngineBootstrapService.phase4cRearmLocalMonitor — M33 Task 5 / Fix 2 restart (HIGH L3).
 *
 * The in-memory local-monitor arm is lost on restart, so phase 4c must re-arm from the persisted
 * SL/TP. M33 widens the original LOCAL_FALLBACK-only re-arm to also cover PENDING_OPEN rows (all
 * envs — the monitor is their only protection pre-attach) and paper EXCHANGE_SIDE rows (paper has
 * no exchange matching engine; the local monitor is the SL/TP enforcer). LIVE/TESTNET EXCHANGE_SIDE
 * rows are NOT re-armed (the exchange holds protection).
 *
 *   D-PP-6: paper EXCHANGE_SIDE row is re-armed from persisted SL/TP on boot.
 *   D-PP-7: live EXCHANGE_SIDE row is NOT re-armed.
 *   D-PP-8: PENDING_OPEN row is re-armed in all envs.
 *   D-PP-6 (Composer A6): re-arm uses the CURRENT DB qty after a pre-restart partial reduce.
 */

import { ExchangeEnvironmentEnum, PositionSideEnum, PositionStateEnum, ProtectiveOrderTypeEnum } from '@bot/shared';

import { Money } from '../../../src/common/utils/money';
import { AppConfigService } from '../../../src/config/service';
import { EngineBootstrapService } from '../../../src/bootstrap/service/EngineBootstrapService';
import { LocalProtectiveMonitor } from '../../../src/execution/service/LocalProtectiveMonitor';
import { PositionEntity } from '../../../src/position/entity';

interface IRowOpts {
    id?: number;
    state?: PositionStateEnum;
    protectiveOrderType?: ProtectiveOrderTypeEnum;
    qty?: string;
}

function buildRow(opts: IRowOpts = {}): PositionEntity {
    return {
        id: opts.id ?? 1,
        symbol: 'BTCUSDT',
        side: PositionSideEnum.LONG,
        state: opts.state ?? PositionStateEnum.OPEN,
        protectiveOrderType: opts.protectiveOrderType ?? ProtectiveOrderTypeEnum.EXCHANGE_SIDE,
        qty: new Money(opts.qty ?? '0.01'),
        entryPrice: new Money('30000'),
        leverage: new Money('5'),
        stopLossPrice: new Money('29000'),
        takeProfitPrice: new Money('31000'),
    } as unknown as PositionEntity;
}

function buildService(exchangeEnv: ExchangeEnvironmentEnum): { service: EngineBootstrapService; monitor: LocalProtectiveMonitor; armSpy: jest.SpyInstance } {
    const monitor = { arm: jest.fn(), isArmed: jest.fn() } as unknown as LocalProtectiveMonitor;
    const armSpy = jest.spyOn(monitor, 'arm');

    const appConfig = { exchangeEnv } as unknown as AppConfigService;

    const service = new EngineBootstrapService(
        {} as never, // positions
        {} as never, // reconciliation
        monitor,
        {} as never, // instrumentor
        {} as never, // retainer
        {} as never, // riskGate
        {} as never, // snapshotWriter
        {} as never, // accountSnapshots
        appConfig,
        {} as never, // paperReconciliation
    );

    return { service, monitor, armSpy };
}

describe('EngineBootstrapService.phase4cRearmLocalMonitor', () => {
    it('paper exchange_side row is re-armed from persisted SL/TP on boot (D-PP-6)', () => {
        // BUILD
        const { service, armSpy } = buildService(ExchangeEnvironmentEnum.PAPER);
        const row = buildRow({ id: 4, protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE });

        // OPERATE
        service.phase4cRearmLocalMonitor([row]);

        // CHECK: armed from the persisted prices on the row.
        expect(armSpy).toHaveBeenCalledTimes(1);
        expect(armSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                positionId: 4,
                stopLossPrice: expect.objectContaining({}),
                takeProfitPrice: expect.objectContaining({}),
            }),
        );
        expect(armSpy.mock.calls[0][0].stopLossPrice.toFixed()).toBe(new Money('29000').toFixed());
        expect(armSpy.mock.calls[0][0].takeProfitPrice.toFixed()).toBe(new Money('31000').toFixed());
    });

    it('live exchange_side row is NOT re-armed (D-PP-7)', () => {
        // BUILD: same EXCHANGE_SIDE row, but in LIVE the exchange holds protection.
        const { service, armSpy } = buildService(ExchangeEnvironmentEnum.LIVE);
        const row = buildRow({ id: 5, protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE });

        // OPERATE
        service.phase4cRearmLocalMonitor([row]);

        // CHECK
        expect(armSpy).not.toHaveBeenCalled();
    });

    it('PENDING_OPEN row is re-armed in all envs (D-PP-8)', () => {
        // BUILD: a PENDING_OPEN EXCHANGE_SIDE row in LIVE — the pre-attach window, the monitor is
        // the only protection regardless of env.
        const { service, armSpy } = buildService(ExchangeEnvironmentEnum.LIVE);
        const row = buildRow({ id: 6, state: PositionStateEnum.PENDING_OPEN, protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE });

        // OPERATE
        service.phase4cRearmLocalMonitor([row]);

        // CHECK
        expect(armSpy).toHaveBeenCalledTimes(1);
        expect(armSpy.mock.calls[0][0].positionId).toBe(6);
    });

    it('re-arm uses current DB qty after a pre-restart partial reduce (D-PP-6 Composer A6)', () => {
        // BUILD: a paper EXCHANGE_SIDE row whose qty was reduced before the restart to 0.004.
        // The armed struct carries only prices (qty is re-read at breach time via findById), so we
        // assert that a reduced-but-positive qty still arms and that the original open size is NOT
        // baked into the arm payload.
        const { service, armSpy } = buildService(ExchangeEnvironmentEnum.PAPER);
        const reducedRow = buildRow({ id: 7, qty: '0.004', protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE });

        // OPERATE
        service.phase4cRearmLocalMonitor([reducedRow]);

        // CHECK: re-armed (qty > 0); the arm payload carries no qty field — the monitor re-reads the
        // current row qty at breach time, so the remaining 0.004 (not an original open size) is closed.
        expect(armSpy).toHaveBeenCalledTimes(1);
        expect(armSpy.mock.calls[0][0]).not.toHaveProperty('qty');
    });

    it('flat (qty=0) row is skipped even when paper exchange_side', () => {
        // BUILD
        const { service, armSpy } = buildService(ExchangeEnvironmentEnum.PAPER);
        const flatRow = buildRow({ id: 8, qty: '0', protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE });

        // OPERATE
        service.phase4cRearmLocalMonitor([flatRow]);

        // CHECK: nothing to protect on a flat row.
        expect(armSpy).not.toHaveBeenCalled();
    });
});
