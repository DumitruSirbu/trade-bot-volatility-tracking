/**
 * RiskGateService — M9 W6.1 bus-emit side-channel.
 *
 * The risk gate must publish two bus events the W6 alert listeners are
 * subscribed to:
 *   - RISK_HALT_TRIGGERED_EVENT (market-stress halt engage)
 *   - MODEL_DIVERGENCE_TRIGGERED_EVENT (divergence kill-switch first engage)
 *
 * Adversarial coverage:
 *   - emit fires once on the engage transition
 *   - emit does NOT re-fire on subsequent re-entry rejections while halted
 *     (market-stress: gated by DB-canonical risk_state.isHalted; divergence:
 *     gated by an in-memory transition flag that resets when the context
 *     signal clears)
 *   - both sources fire independently (one does not suppress the other)
 *   - payload shape matches IRiskHaltEvent / IModelDivergenceEvent contracts
 *     declared in @bot/shared
 *   - the gate's reject/accept verdict is byte-identical to the pre-W6.1
 *     behavior (the emit is read-only)
 */

import {
    CoinTierEnum,
    CorrelationModeEnum,
    HaltSourceEnum,
    IModelDivergenceEvent,
    IRiskHaltEvent,
    OrderIntentActionEnum,
    PositionSideEnum,
    RejectReasonEnum,
} from '@bot/shared';

import { MODEL_DIVERGENCE_TRIGGERED_EVENT, RISK_HALT_TRIGGERED_EVENT } from '../../src/alert/const/alertEvents';
import { Money } from '../../src/common/utils/money';
import { IRiskGateContext } from '../../src/risk/interface';
import { ReservationLedger } from '../../src/risk/service/ReservationLedger';
import { RiskGateService } from '../../src/risk/service/RiskGateService';
import { SlotManager } from '../../src/risk/service/SlotManager';
import { StressHaltEvaluator } from '../../src/risk/service/StressHaltEvaluator';
import { buildGateContext, buildOrderIntent, buildProposedExit, buildRiskStateDay, buildRiskStatePort, buildSizing } from './support/fixtures';
import { buildSnapshot } from '../strategy/support/fixtures';

interface IEmittedEvent {
    name: string;
    payload: unknown;
}

function makeGate(): { gate: RiskGateService; emitted: IEmittedEvent[]; upsertSpy: jest.Mock } {
    const ledger = new ReservationLedger();
    const slotManager = new SlotManager();
    const stress = new StressHaltEvaluator();
    const positions = { findById: jest.fn().mockResolvedValue(null) };
    const upsertSpy = jest.fn();
    const riskState = { findByDate: jest.fn().mockResolvedValue(null), upsertDay: upsertSpy };
    const emitted: IEmittedEvent[] = [];
    const events = {
        emit: jest.fn().mockImplementation((name: string, payload: unknown) => {
            emitted.push({ name, payload });

            return true;
        }),
    };
    const gate = new RiskGateService(
        ledger,
        slotManager,
        stress,
        positions as never,
        riskState as never,
        events as never,
        { marketStressAutoResumeEnabled: false } as never,
    );
    gate.markRecoveryComplete();

    return { gate, emitted, upsertSpy };
}

const NOW_MS = 1_716_307_200_000 + 5 * 60_000;

function buildIntent() {
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

// Market-stress context: an OI shock well over STRESS_OI_CHANGE_5M_PCT.
function buildStressedContext(overrides: Partial<IRiskGateContext> = {}): IRiskGateContext {
    return buildGateContext({
        nowMs: NOW_MS,
        snapshot: buildSnapshot({
            bid_ask_spread_pct: 0.05,
            open_interest: '5000000000.00',
            open_interest_change_5m_pct: 12, // > STRESS_OI_CHANGE_5M_PCT (5)
            same_bar_trigger_count: 1,
            market_breadth_5m_up_pct: 55.0,
            btc_1m_move_pct: -0.2,
            eth_5m_move_pct: -0.4,
            funding_rate: 0.0001,
            funding_rate_annualized: 0.0365,
            book_depth_10bps_usdt: '20000000.00',
            vwap_deviation_pct: -1.0,
        }),
        ...overrides,
    });
}

describe('RiskGateService — M9 W6.1 bus emit (market-stress)', () => {
    it('emits RISK_HALT_TRIGGERED_EVENT exactly once on the engage transition', async () => {
        const { gate, emitted } = makeGate();

        const result = await gate.evaluate(buildIntent(), buildStressedContext());

        expect(result.rejectReason).toBe(RejectReasonEnum.MARKET_STRESS);

        const stressEmits = emitted.filter((e) => e.name === RISK_HALT_TRIGGERED_EVENT);
        expect(stressEmits).toHaveLength(1);
    });

    it('payload shape matches IRiskHaltEvent contract', async () => {
        const { gate, emitted } = makeGate();

        await gate.evaluate(buildIntent(), buildStressedContext());

        const stressEmits = emitted.filter((e) => e.name === RISK_HALT_TRIGGERED_EVENT);
        const payload = stressEmits[0]!.payload as IRiskHaltEvent;

        expect(payload.source).toBe(HaltSourceEnum.MARKET_STRESS);
        expect(payload.reason).toBe(RejectReasonEnum.MARKET_STRESS);
        expect(payload.engagedAt).toBe(new Date(NOW_MS).toISOString());
        expect(typeof payload.metrics).toBe('object');
        // every metric value is a string per the contract
        for (const value of Object.values(payload.metrics)) {
            expect(typeof value).toBe('string');
        }
        expect(payload.metrics.oiChange5mPct).toBe('12');
    });

    it('does NOT re-emit while risk_state.isHalted is already true for the day', async () => {
        const { gate, emitted } = makeGate();

        const alreadyHaltedContext = buildStressedContext({
            riskState: buildRiskStatePort({
                day: buildRiskStateDay({ isHalted: true, haltReason: RejectReasonEnum.MARKET_STRESS }),
            }),
        });

        const result = await gate.evaluate(buildIntent(), alreadyHaltedContext);

        // Re-entry rejection path: gate returns GLOBAL_HALT (isHalted check fires
        // before the stress check), and no bus event fires for either source.
        expect(result.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
        expect(emitted.filter((e) => e.name === RISK_HALT_TRIGGERED_EVENT)).toHaveLength(0);
    });

    it('does not emit when stress does not trip', async () => {
        const { gate, emitted } = makeGate();

        // Default buildGateContext is non-stressed.
        await gate.evaluate(buildIntent(), buildGateContext());

        expect(emitted.filter((e) => e.name === RISK_HALT_TRIGGERED_EVENT)).toHaveLength(0);
    });
});

describe('RiskGateService — M9 W6.1 bus emit (model-divergence)', () => {
    it('emits MODEL_DIVERGENCE_TRIGGERED_EVENT exactly once on the engage transition', async () => {
        const { gate, emitted } = makeGate();

        const result = await gate.evaluate(buildIntent(), buildGateContext({ modelDivergenceDetected: true }));

        expect(result.rejectReason).toBe(RejectReasonEnum.MODEL_DIVERGENCE_HALT);
        expect(emitted.filter((e) => e.name === MODEL_DIVERGENCE_TRIGGERED_EVENT)).toHaveLength(1);
    });

    it('does NOT re-fire on a second rejection while divergence is still detected', async () => {
        const { gate, emitted } = makeGate();

        await gate.evaluate(buildIntent(), buildGateContext({ modelDivergenceDetected: true }));
        await gate.evaluate(buildIntent(), buildGateContext({ modelDivergenceDetected: true }));

        expect(emitted.filter((e) => e.name === MODEL_DIVERGENCE_TRIGGERED_EVENT)).toHaveLength(1);
    });

    it('re-fires after the divergence signal clears and then trips again', async () => {
        const { gate, emitted } = makeGate();

        await gate.evaluate(buildIntent(), buildGateContext({ modelDivergenceDetected: true }));
        // Signal clears (some unrelated reject path runs; the gate notes the clear).
        await gate.evaluate(buildIntent(), buildGateContext({ modelDivergenceDetected: false }));
        // Trips again.
        await gate.evaluate(buildIntent(), buildGateContext({ modelDivergenceDetected: true }));

        expect(emitted.filter((e) => e.name === MODEL_DIVERGENCE_TRIGGERED_EVENT)).toHaveLength(2);
    });

    it('payload shape matches IModelDivergenceEvent contract', async () => {
        const { gate, emitted } = makeGate();

        await gate.evaluate(buildIntent(), buildGateContext({ modelDivergenceDetected: true }));

        const payload = emitted.find((e) => e.name === MODEL_DIVERGENCE_TRIGGERED_EVENT)!.payload as IModelDivergenceEvent;

        expect(payload.reason).toBe(RejectReasonEnum.MODEL_DIVERGENCE_HALT);
        expect(payload.engagedAt).toBe(new Date(NOW_MS).toISOString());
        // ADR 0022 §2.3.1 — slippage figures are null when sampleCount===0
        // (M11 detector will swap them to real strings once it surfaces them
        // on IRiskGateContext). Null distinguishes "unknown" from "0 bps".
        expect(payload.observedSlippageBps).toBeNull();
        expect(payload.modeledSlippageBps).toBeNull();
        expect(typeof payload.sampleCount).toBe('number');
        expect(payload.sampleCount).toBe(0);
    });
});

describe('RiskGateService — M9 W6.1 bus emit (independence)', () => {
    it('market-stress emit and model-divergence emit fire independently', async () => {
        // Divergence first, then a separate stressed evaluation should still fire
        // RISK_HALT_TRIGGERED_EVENT (the two transition flags are independent).
        const { gate, emitted } = makeGate();

        await gate.evaluate(buildIntent(), buildGateContext({ modelDivergenceDetected: true }));
        // Clear divergence flag in-memory by evaluating with a non-divergent
        // context, then trip stress.
        await gate.evaluate(buildIntent(), buildStressedContext({ modelDivergenceDetected: false }));

        expect(emitted.filter((e) => e.name === MODEL_DIVERGENCE_TRIGGERED_EVENT)).toHaveLength(1);
        expect(emitted.filter((e) => e.name === RISK_HALT_TRIGGERED_EVENT)).toHaveLength(1);
    });
});
