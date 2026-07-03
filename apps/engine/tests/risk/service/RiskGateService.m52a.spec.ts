/**
 * RiskGateService — ADR 0051 §M52a-4 / §M52a-5 (M52 force-close retry, stacked-veto fix).
 *
 * Coverage:
 *   M52a-4 — `isCooldownActive` exempts `isRetryEntry: true` intents from cooldown-after-loss,
 *            without widening the exemption to any other check (a retry still fails every other
 *            stateful-limit / tier-filter reject it should fail, including the consecutive-loss
 *            halt from M52a-5).
 *   M52a-5 — `isConsecutiveLossHalt` filters `exitReason === ExitReasonEnum.FORCE_CLOSE` legs out
 *            of the streak derivation entirely (neither increments nor resets it), while a `null`
 *            exitReason is kept (fail toward preserving the halt).
 *
 * These fixes correct the regression the live M52 soak exposed: RIF/MAGMA/XPL force-closed in one
 * manual rebalance cycle, and the naive cooldown exemption alone just moved the veto down one
 * check to a worse, global, persisted consecutive-loss halt (ADR 0051 §M52a-1).
 */

import { CoinTierEnum, CorrelationModeEnum, ExitReasonEnum, OrderIntentActionEnum, PositionSideEnum, RejectReasonEnum, RiskOutcomeEnum } from '@bot/shared';

import { Money } from '../../../src/common/utils/money';
import { COIN_DEPTH_FLOOR_10BPS_USDT } from '../../../src/risk/const';
import { IRiskGateContext } from '../../../src/risk/interface';
import { IClosedPositionView } from '../../../src/risk/interface/IOpenPositionsPort';
import { ReservationLedger } from '../../../src/risk/service/ReservationLedger';
import { RiskGateService } from '../../../src/risk/service/RiskGateService';
import { SlotManager } from '../../../src/risk/service/SlotManager';
import { StressHaltEvaluator } from '../../../src/risk/service/StressHaltEvaluator';
import {
    buildGateContext,
    buildClosedPositionView,
    buildOpenPositionsPort,
    buildOrderIntent,
    buildProposedExit,
    buildRiskStateDay,
    buildRiskStatePort,
    buildSizing,
} from '../support/fixtures';
import { buildSnapshot } from '../../strategy/support/fixtures';

const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
const COOLDOWN_MS = 15 * 60_000;

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeGate(overrides: { paperRelaxConsecutiveLossHalt?: boolean } = {}): { gate: RiskGateService } {
    const ledger = new ReservationLedger();
    const slotManager = new SlotManager();
    const stress = new StressHaltEvaluator();
    const positions = { findById: jest.fn().mockResolvedValue(null) };
    const riskStateRepo = { findByDate: jest.fn().mockResolvedValue(null), upsertDay: jest.fn() };
    const events = { emit: jest.fn() };
    const appConfig = {
        marketStressAutoResumeEnabled: false,
        paperRelaxConsecutiveLossHalt: overrides.paperRelaxConsecutiveLossHalt ?? false,
    };
    const gate = new RiskGateService(ledger, slotManager, stress, positions as never, riskStateRepo as never, events as never, appConfig as never);
    gate.markRecoveryComplete();

    return { gate };
}

function buildPassingContext(overrides: Partial<IRiskGateContext> = {}): IRiskGateContext {
    return buildGateContext({ nowMs: NOW_MS, ...overrides });
}

function buildPassingIntent(overrides = {}) {
    return buildOrderIntent({
        intentAction: OrderIntentActionEnum.OPEN,
        correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
        idiosyncrasyScore: 0.9,
        coinTier: CoinTierEnum.TIER_1,
        proposedExit: buildProposedExit({ timeStopAtMs: NOW_MS + 30 * 60_000 }),
        sizing: buildSizing({ leverage: new Money('1') }),
        entryPrice: new Money('30000'),
        tradeSide: PositionSideEnum.SHORT,
        symbol: 'BTCUSDT',
        ...overrides,
    });
}

function buildForceCloseWithinCooldown(overrides: Partial<IClosedPositionView> = {}): IClosedPositionView {
    return buildClosedPositionView({
        symbol: 'BTCUSDT',
        realizedPnl: new Money('-0.2'),
        closedAtMs: NOW_MS - COOLDOWN_MS / 3, // 5 min ago — well inside the 15-min cooldown
        exitReason: ExitReasonEnum.FORCE_CLOSE,
        ...overrides,
    });
}

// ─── M52a-4: retry-entry exemption from cooldown-after-loss ──────────────────

describe('ADR 0051 M52a-4 — isCooldownActive retry-entry exemption', () => {
    it('does NOT reject cooldown_active for a retry-flagged intent whose last close is a negative force_close within the cooldown window', async () => {
        const { gate } = makeGate();
        const context = buildPassingContext({
            openPositions: buildOpenPositionsPort({ lastClose: buildForceCloseWithinCooldown() }),
        });

        const result = await gate.evaluate(buildPassingIntent({ isRetryEntry: true }), context);

        expect(result.rejectReason).not.toBe(RejectReasonEnum.COOLDOWN_ACTIVE);
        expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
    });

    it('still rejects cooldown_active for a non-retry intent with the same recent negative close (discretionary path unchanged)', async () => {
        const { gate } = makeGate();
        const context = buildPassingContext({
            openPositions: buildOpenPositionsPort({ lastClose: buildForceCloseWithinCooldown() }),
        });

        const result = await gate.evaluate(buildPassingIntent(), context);

        expect(result.rejectReason).toBe(RejectReasonEnum.COOLDOWN_ACTIVE);
    });

    it('still rejects coin_book_too_thin for a retry-flagged intent — the exemption is scoped to cooldown only', async () => {
        const { gate } = makeGate();
        const thinDepth = COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_1] - 1;
        const context = buildPassingContext({
            snapshot: buildSnapshot({ book_depth_10bps_usdt: String(thinDepth) }),
            openPositions: buildOpenPositionsPort({ lastClose: buildForceCloseWithinCooldown() }),
        });

        const result = await gate.evaluate(buildPassingIntent({ isRetryEntry: true, coinTier: CoinTierEnum.TIER_1 }), context);

        expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });

    it('still rejects consecutive_loss_halt for a retry-flagged intent when two real thesis losses precede it — not a blanket gate bypass', async () => {
        const { gate } = makeGate();
        const closedToday = [
            buildClosedPositionView({ symbol: 'ETHUSDT', realizedPnl: new Money('-5'), closedAtMs: NOW_MS - 120_000, exitReason: ExitReasonEnum.STOP_LOSS }),
            buildClosedPositionView({ symbol: 'SOLUSDT', realizedPnl: new Money('-3'), closedAtMs: NOW_MS - 60_000, exitReason: ExitReasonEnum.STOP_LOSS }),
        ];
        const context = buildPassingContext({
            openPositions: buildOpenPositionsPort({ closed: closedToday, lastClose: null }),
        });

        const result = await gate.evaluate(buildPassingIntent({ isRetryEntry: true }), context);

        expect(result.rejectReason).toBe(RejectReasonEnum.CONSECUTIVE_LOSS_HALT);
    });
});

// ─── M52a-5: consecutive-loss halt excludes force_close legs ─────────────────

describe('ADR 0051 M52a-5 — isConsecutiveLossHalt excludes force_close legs', () => {
    it('does NOT halt on a day with two negative force_close closes and nothing else', async () => {
        const { gate } = makeGate();
        const riskState = buildRiskStatePort({ day: buildRiskStateDay({ isHalted: false }) });
        const closedToday = [
            buildClosedPositionView({ symbol: 'RIF', realizedPnl: new Money('-0.159'), closedAtMs: NOW_MS - 120_000, exitReason: ExitReasonEnum.FORCE_CLOSE }),
            buildClosedPositionView({ symbol: 'MAGMA', realizedPnl: new Money('-0.203'), closedAtMs: NOW_MS - 60_000, exitReason: ExitReasonEnum.FORCE_CLOSE }),
        ];
        const context = buildPassingContext({
            riskState,
            openPositions: buildOpenPositionsPort({ closed: closedToday }),
        });

        const result = await gate.evaluate(buildPassingIntent(), context);

        expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        expect(riskState.upsertHaltForDay).not.toHaveBeenCalled();
    });

    it('halts at streak 2 for stop_loss -> force_close -> stop_loss — the force_close is filtered out, not treated as a reset', async () => {
        const { gate } = makeGate();
        const closedToday = [
            buildClosedPositionView({ symbol: 'ETHUSDT', realizedPnl: new Money('-5'), closedAtMs: NOW_MS - 180_000, exitReason: ExitReasonEnum.STOP_LOSS }),
            buildClosedPositionView({ symbol: 'RIF', realizedPnl: new Money('-0.2'), closedAtMs: NOW_MS - 120_000, exitReason: ExitReasonEnum.FORCE_CLOSE }),
            buildClosedPositionView({ symbol: 'SOLUSDT', realizedPnl: new Money('-3'), closedAtMs: NOW_MS - 60_000, exitReason: ExitReasonEnum.STOP_LOSS }),
        ];
        const context = buildPassingContext({
            openPositions: buildOpenPositionsPort({ closed: closedToday }),
        });

        const result = await gate.evaluate(buildPassingIntent(), context);

        // A naive "treat force_close as a win" mis-fix would reset the streak here and approve;
        // the correct fix removes the leg entirely, so the two real losses still trip the halt.
        expect(result.rejectReason).toBe(RejectReasonEnum.CONSECUTIVE_LOSS_HALT);
    });

    it('still halts at streak 2 for two real stop_loss closes with no force_close involved (regression)', async () => {
        const { gate } = makeGate();
        const closedToday = [
            buildClosedPositionView({ symbol: 'ETHUSDT', realizedPnl: new Money('-5'), closedAtMs: NOW_MS - 120_000, exitReason: ExitReasonEnum.STOP_LOSS }),
            buildClosedPositionView({ symbol: 'SOLUSDT', realizedPnl: new Money('-3'), closedAtMs: NOW_MS - 60_000, exitReason: ExitReasonEnum.STOP_LOSS }),
        ];
        const context = buildPassingContext({
            openPositions: buildOpenPositionsPort({ closed: closedToday }),
        });

        const result = await gate.evaluate(buildPassingIntent(), context);

        expect(result.rejectReason).toBe(RejectReasonEnum.CONSECUTIVE_LOSS_HALT);
    });

    it('keeps a null exitReason in the streak — fail-safe toward preserving the halt, not suppressing it', async () => {
        const { gate } = makeGate();
        const closedToday = [
            buildClosedPositionView({ symbol: 'ETHUSDT', realizedPnl: new Money('-5'), closedAtMs: NOW_MS - 120_000, exitReason: null }),
            buildClosedPositionView({ symbol: 'SOLUSDT', realizedPnl: new Money('-3'), closedAtMs: NOW_MS - 60_000, exitReason: null }),
        ];
        const context = buildPassingContext({
            openPositions: buildOpenPositionsPort({ closed: closedToday }),
        });

        const result = await gate.evaluate(buildPassingIntent(), context);

        expect(result.rejectReason).toBe(RejectReasonEnum.CONSECUTIVE_LOSS_HALT);
    });

    it('exercises the exit-reason-aware derivation with paperRelaxConsecutiveLossHalt OFF — force_close legs still do not halt', async () => {
        const { gate } = makeGate({ paperRelaxConsecutiveLossHalt: false });
        const closedToday = [
            buildClosedPositionView({ symbol: 'RIF', realizedPnl: new Money('-0.159'), closedAtMs: NOW_MS - 180_000, exitReason: ExitReasonEnum.FORCE_CLOSE }),
            buildClosedPositionView({
                symbol: 'MAGMA',
                realizedPnl: new Money('-0.203'),
                closedAtMs: NOW_MS - 120_000,
                exitReason: ExitReasonEnum.FORCE_CLOSE,
            }),
            buildClosedPositionView({ symbol: 'XPL', realizedPnl: new Money('-0.200'), closedAtMs: NOW_MS - 60_000, exitReason: ExitReasonEnum.FORCE_CLOSE }),
        ];
        const context = buildPassingContext({
            openPositions: buildOpenPositionsPort({ closed: closedToday }),
        });

        // With the relax flag OFF, checkLossWindows runs isConsecutiveLossHalt directly (no early
        // return) — this exercises the streak-derivation fix itself, not the relax short-circuit.
        const result = await gate.evaluate(buildPassingIntent(), context);

        expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
    });
});
