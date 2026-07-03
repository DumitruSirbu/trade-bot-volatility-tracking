/**
 * RiskGateService — M45 D3a halt-isolation tests (C1).
 *
 * Coverage:
 *   C1 — persistHalt routes through upsertHaltForDay (column-scoped writer) and
 *        does NOT call upsertDay (full-row writer). Verified for both market-stress
 *        and consecutive-loss-halt trigger paths.
 *
 * Design: the gate's `persistHalt` calls `context.riskState.upsertHaltForDay`
 * (not `this.riskState.upsertDay`). This file asserts the isolation: when a new
 * halt fires, the full-row writer is never touched.
 */

import { CoinTierEnum, CorrelationModeEnum, ExitReasonEnum, OrderIntentActionEnum, PositionSideEnum, RejectReasonEnum, RiskOutcomeEnum } from '@bot/shared';

import { Money } from '../../../src/common/utils/money';
import { HALT_LEG_BTC_SHOCK } from '../../../src/risk/const';
import { ReservationLedger } from '../../../src/risk/service/ReservationLedger';
import { RiskGateService } from '../../../src/risk/service/RiskGateService';
import { SlotManager } from '../../../src/risk/service/SlotManager';
import { StressHaltEvaluator } from '../../../src/risk/service/StressHaltEvaluator';
import {
    buildGateContext,
    buildOpenPositionsPort,
    buildOrderIntent,
    buildProposedExit,
    buildRiskStateDay,
    buildRiskStatePort,
    buildSizing,
} from '../support/fixtures';
import { buildSnapshot } from '../../strategy/support/fixtures';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeGate(): { gate: RiskGateService } {
    const ledger = new ReservationLedger();
    const slotManager = new SlotManager();
    const stress = new StressHaltEvaluator();
    const positions = { findById: jest.fn().mockResolvedValue(null) };
    // this.riskState — the injected RiskStateRepository (not the port used by persistHalt)
    const riskStateRepo = { findByDate: jest.fn().mockResolvedValue(null), upsertDay: jest.fn() };
    const events = { emit: jest.fn() };
    const appConfig = { marketStressAutoResumeEnabled: false, paperRelaxConsecutiveLossHalt: false };

    const gate = new RiskGateService(ledger, slotManager, stress, positions as never, riskStateRepo as never, events as never, appConfig as never);
    gate.markRecoveryComplete();

    return { gate };
}

function buildPassingIntent() {
    const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
    return buildOrderIntent({
        intentAction: OrderIntentActionEnum.OPEN,
        correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
        idiosyncrasyScore: 0.9,
        coinTier: CoinTierEnum.TIER_1,
        proposedExit: buildProposedExit({ timeStopAtMs: NOW_MS + 30 * 60_000 }),
        sizing: buildSizing({ leverage: new Money('1') }),
        entryPrice: new Money('30000'),
        tradeSide: PositionSideEnum.SHORT,
    });
}

// ─── C1: market-stress halt — upsertHaltForDay called, upsertDay NOT called ──

describe('RiskGateService M45 D3a — C1: market-stress persistHalt uses upsertHaltForDay only', () => {
    it('calls upsertHaltForDay with isHalted=true and the correct halt reason', async () => {
        const { gate } = makeGate();
        const riskStatePort = buildRiskStatePort({ day: buildRiskStateDay({ isHalted: false }) });
        const context = buildGateContext({
            snapshot: buildSnapshot({ btc_5m_move_pct: 3.0 }), // above STRESS_BTC_5M_SHOCK_PCT=1.5
            riskState: riskStatePort,
        });

        await gate.evaluate(buildPassingIntent(), context);

        expect(riskStatePort.upsertHaltForDay).toHaveBeenCalledTimes(1);
        expect(riskStatePort.upsertHaltForDay).toHaveBeenCalledWith(expect.any(String), true, `${RejectReasonEnum.MARKET_STRESS}:${HALT_LEG_BTC_SHOCK}`);
    });

    it('does NOT call upsertDay when market-stress halt fires', async () => {
        const { gate } = makeGate();
        const riskStatePort = buildRiskStatePort({ day: buildRiskStateDay({ isHalted: false }) });
        const context = buildGateContext({
            snapshot: buildSnapshot({ btc_5m_move_pct: 3.0 }),
            riskState: riskStatePort,
        });

        await gate.evaluate(buildPassingIntent(), context);

        // upsertDay (full-row writer) must NOT be called — the halt writes only the
        // is_halted/halt_reason columns via upsertHaltForDay (ADR M45 D3a invariant)
        expect(riskStatePort.upsertDay).not.toHaveBeenCalled();
    });

    it('gate returns REJECTED with MARKET_STRESS outcome after the halt fires', async () => {
        const { gate } = makeGate();
        const context = buildGateContext({
            snapshot: buildSnapshot({ btc_5m_move_pct: 3.0 }),
            riskState: buildRiskStatePort({ day: buildRiskStateDay({ isHalted: false }) }),
        });

        const result = await gate.evaluate(buildPassingIntent(), context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.MARKET_STRESS);
    });
});

// ─── C1b: consecutive-loss halt — upsertHaltForDay called, upsertDay NOT called

describe('RiskGateService M45 D3a — C1b: consecutive-loss persistHalt uses upsertHaltForDay only', () => {
    const NOW_MS = 1_716_307_200_000 + 5 * 60_000;

    function buildTwoConsecutiveLossContext(riskStatePort: ReturnType<typeof buildRiskStatePort>) {
        const closedToday = [
            { symbol: 'ETHUSDT', realizedPnl: new Money('-5'), closedAtMs: NOW_MS - 120_000, exitReason: ExitReasonEnum.STOP_LOSS },
            { symbol: 'SOLUSDT', realizedPnl: new Money('-3'), closedAtMs: NOW_MS - 60_000, exitReason: ExitReasonEnum.STOP_LOSS },
        ];
        return buildGateContext({
            nowMs: NOW_MS,
            riskState: riskStatePort,
            openPositions: buildOpenPositionsPort({ closed: closedToday }),
        });
    }

    it('calls upsertHaltForDay with isHalted=true when consecutive-loss halt fires', async () => {
        const { gate } = makeGate();
        const riskStatePort = buildRiskStatePort({ day: buildRiskStateDay({ isHalted: false }) });

        await gate.evaluate(buildPassingIntent(), buildTwoConsecutiveLossContext(riskStatePort));

        expect(riskStatePort.upsertHaltForDay).toHaveBeenCalledTimes(1);
        expect(riskStatePort.upsertHaltForDay).toHaveBeenCalledWith(expect.any(String), true, RejectReasonEnum.CONSECUTIVE_LOSS_HALT);
    });

    it('does NOT call upsertDay when consecutive-loss halt fires', async () => {
        const { gate } = makeGate();
        const riskStatePort = buildRiskStatePort({ day: buildRiskStateDay({ isHalted: false }) });

        await gate.evaluate(buildPassingIntent(), buildTwoConsecutiveLossContext(riskStatePort));

        expect(riskStatePort.upsertDay).not.toHaveBeenCalled();
    });
});
