/**
 * ExecutionService — force_close ATR-unit drift persistence (M52 D3, ADR 0051 §6).
 *
 * When the ADR 0045 fill-acceptance guard force-closes an OPEN momentum fill, unwindRejectedFill must
 * persist the guard's measured ATR-unit drift onto the row (positions.force_close_atr_units_drift) so
 * the D4 threshold-calibration query can read its distribution. The value MUST be the exact output of
 * computeGeometryAnchorDrift — the same number logGeometryAnchorDrift logs and the force_close report
 * event carries — with NO second/independent drift computation.
 *
 *   - persists force_close_atr_units_drift = computeGeometryAnchorDrift(ctx).atrUnits
 *   - the persisted drift equals the drift on the emitted MOMENTUM_FILL_FORCE_CLOSED_EVENT (single
 *     source, no double-compute divergence)
 *   - a fill with no reconstructable geometry anchor persists nothing (NULL)
 */

import { ExchangeEnvironmentEnum, ExitReasonEnum, PositionSideEnum } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { MOMENTUM_FILL_FORCE_CLOSED_EVENT } from '../../../src/common/const';
import { Money, MoneyValue } from '../../../src/common/utils/money';
import { ExecutionService } from '../../../src/execution/service/ExecutionService';

// fill=105, ref=100, atr_14=10 → driftPct = 5.0, atrUnits = 0.5. A single fixture drives both the
// persisted column and the report event so a divergence between the two would fail the equality check.
const REFERENCE_PRICE = '100';
const FILL_PRICE = '105';
const ATR_14 = '10';
const EXPECTED_ATR_UNITS = '0.5';

interface IHarness {
    service: ExecutionService;
    updateDriftSpy: jest.Mock;
    emitSyntheticCloseSpy: jest.Mock;
    events: EventEmitter2;
}

function makeHarness(): IHarness {
    const updateDriftSpy = jest.fn().mockResolvedValue(undefined);
    const emitSyntheticCloseSpy = jest.fn().mockResolvedValue(undefined);
    const events = new EventEmitter2();

    const positions = {
        updateForceCloseAtrUnitsDrift: updateDriftSpy,
    } as never;

    const service = new ExecutionService(
        { isExecutionLive: false, exchangeEnv: ExchangeEnvironmentEnum.PAPER } as never,
        {} as never, // policyRouter
        {} as never, // clientOrderIdFactory
        {} as never, // submitter
        {} as never, // fillAccumulator
        {} as never, // protectiveAttacher
        {} as never, // localProtectiveMonitor
        positions,
        {} as never, // positionService
        {} as never, // transactions
        {} as never, // strategyVersions
        { releaseReservation: jest.fn() } as never, // riskGate
        {} as never, // haltFlag
        { emitSyntheticClose: emitSyntheticCloseSpy } as never, // fillAcceptanceUnwind
        {} as never, // exchangeClient
        events,
        {} as never, // accounting
        {} as never, // instrumentor seed
    );

    return { service, updateDriftSpy, emitSyntheticCloseSpy, events };
}

// A minimal fill-acceptance context whose computeGeometryAnchorDrift is reconstructable (entrySnapshot
// + geometryParams + atr_14 present). rebalanceCycleId/rank present so the momentum report also fires.
// reservationId=null makes releaseReservationSafely a no-op (no gate needed).
function buildCtx(overrides: { entrySnapshot?: unknown } = {}): unknown {
    return {
        event: {
            intent: {
                symbol: 'WLDUSDT',
                referencePrice: new Money(REFERENCE_PRICE),
                tradeSide: PositionSideEnum.LONG,
                flowType: 'trend_initiation',
                rebalanceCycleId: 'xmom-cycle-1000-scheduled',
                rank: 2,
            },
            strategyVersionId: 20,
            reservationId: null,
            approvedSlot: 'slot_a',
            entrySnapshot: 'entrySnapshot' in overrides ? overrides.entrySnapshot : { atr_14: ATR_14 },
            geometryParams: { some: 'params' },
        },
        positionRow: { id: 42, symbol: 'WLDUSDT' },
        fillSummary: { avgFillPrice: new Money(FILL_PRICE) },
        resolvedTakeProfitPrice: new Money('120'),
    };
}

describe('ExecutionService.unwindRejectedFill — force_close drift persistence (M52 D3)', () => {
    it('persists force_close_atr_units_drift = computeGeometryAnchorDrift(ctx).atrUnits', async () => {
        const { service, updateDriftSpy } = makeHarness();

        await (service as never as { unwindRejectedFill(ctx: unknown, reason?: string): Promise<void> }).unwindRejectedFill(buildCtx(), 'sl_below_floor');

        expect(updateDriftSpy).toHaveBeenCalledTimes(1);
        expect(updateDriftSpy.mock.calls[0][0]).toBe(42);
        expect((updateDriftSpy.mock.calls[0][1] as MoneyValue).toFixed()).toBe(new Money(EXPECTED_ATR_UNITS).toFixed());
    });

    it('persists the SAME drift the momentum force_close report carries (single source, no double compute)', async () => {
        const { service, updateDriftSpy, events } = makeHarness();
        const reportSpy = jest.fn();
        events.on(MOMENTUM_FILL_FORCE_CLOSED_EVENT, reportSpy);

        await (service as never as { unwindRejectedFill(ctx: unknown, reason?: string): Promise<void> }).unwindRejectedFill(buildCtx(), 'sl_below_floor');

        expect(reportSpy).toHaveBeenCalledTimes(1);

        const persistedDrift = (updateDriftSpy.mock.calls[0][1] as MoneyValue).toFixed();
        const reportedDrift = (reportSpy.mock.calls[0][0].atrUnitsDrift as MoneyValue).toFixed();

        expect(persistedDrift).toBe(reportedDrift);
        expect(persistedDrift).toBe(new Money(EXPECTED_ATR_UNITS).toFixed());
    });

    it('persists the FORCE_CLOSE exit through the synthetic close (unwind still fires)', async () => {
        const { service, emitSyntheticCloseSpy } = makeHarness();

        await (service as never as { unwindRejectedFill(ctx: unknown, reason?: string): Promise<void> }).unwindRejectedFill(buildCtx(), 'sl_below_floor');

        expect(emitSyntheticCloseSpy).toHaveBeenCalledTimes(1);
        expect(emitSyntheticCloseSpy.mock.calls[0][0].exitReason).toBe(ExitReasonEnum.FORCE_CLOSE);
    });

    it('persists NOTHING when the fill has no reconstructable geometry anchor (NULL column)', async () => {
        const { service, updateDriftSpy } = makeHarness();

        // entrySnapshot undefined → computeGeometryAnchorDrift returns null → no drift write.
        await (service as never as { unwindRejectedFill(ctx: unknown, reason?: string): Promise<void> }).unwindRejectedFill(
            buildCtx({ entrySnapshot: undefined }),
            'sl_below_floor',
        );

        expect(updateDriftSpy).not.toHaveBeenCalled();
    });
});
