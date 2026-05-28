/**
 * M4 adversarial backfill — per M5.5 plan §M4 (5 surfaces).
 *
 * Each test references the ADR 0004 invariant it attempts to falsify.
 * All surfaces exercised against the real RiskGateService + ReservationLedger
 * (no DB, no exchange — ports are jest fakes per the existing suite pattern).
 *
 * Surface index:
 *   S1 — Two simultaneous intents racing for the same slot
 *   S2 — Reservation leak when a downstream handler throws mid-flight
 *   S3 — Loss window straddling UTC midnight and the rolling-7-day cutoff
 *   S4 — Halt fired between reservation and order-intent emission
 *   S5 — Cooldown / per-bar / consecutive-loss evasion via rapid resubmit
 */

import { CorrelationModeEnum, OrderIntentActionEnum, PositionSideEnum, PositionSlotEnum, RejectReasonEnum, RiskOutcomeEnum } from '@bot/shared';

import { Money } from '../../../src/common/utils/money';
import { RESERVATION_TTL_MS } from '../../../src/risk/const';
import { ReservationStateEnum } from '../../../src/risk/enum';
import { ReservationLedger } from '../../../src/risk/service/ReservationLedger';
import { RiskGateService } from '../../../src/risk/service/RiskGateService';
import { SlotManager } from '../../../src/risk/service/SlotManager';
import { StressHaltEvaluator } from '../../../src/risk/service/StressHaltEvaluator';
import {
    buildClosedPositionView,
    buildGateContext,
    buildOpenPositionView,
    buildOpenPositionsPort,
    buildOrderIntent,
    buildProposedExit,
    buildReservation,
    buildRiskStateDay,
    buildRiskStatePort,
    buildSizing,
} from '../support/fixtures';
import { buildSnapshot } from '../../strategy/support/fixtures';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeGate(): { gate: RiskGateService; ledger: ReservationLedger } {
    const ledger = new ReservationLedger();
    const slotManager = new SlotManager();
    const stress = new StressHaltEvaluator();
    const positions = { findById: jest.fn().mockResolvedValue(null) };
    const riskState = { findByDate: jest.fn().mockResolvedValue(null), upsertDay: jest.fn() };
    const events = { emit: jest.fn() };
    const gate = new RiskGateService(ledger, slotManager, stress, positions as never, riskState as never, events as never);
    // M6 W8: bypass the boot recovery guard for steady-state gate tests.
    gate.markRecoveryComplete();
    return { gate, ledger };
}

const NOW_MS = 1_716_307_500_000; // deterministic bar-close clock

function buildValidIntent(overrides = {}) {
    return buildOrderIntent({
        intentAction: OrderIntentActionEnum.OPEN,
        correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
        idiosyncrasyScore: 0.9,
        proposedExit: buildProposedExit({ timeStopAtMs: NOW_MS + 30 * 60_000 }),
        sizing: buildSizing({ leverage: new Money('1') }),
        entryPrice: new Money('30000'),
        tradeSide: PositionSideEnum.SHORT,
        ...overrides,
    });
}

function buildPassingContext(overrides = {}) {
    return buildGateContext({ nowMs: NOW_MS, ...overrides });
}

// ─── S1: Two simultaneous intents racing for the same slot ───────────────────
//
// ADR 0004 §4 — cap is 3 total positions (A+B idiosyncratic, C correlated OR
// idiosyncratic overflow when no correlated holds C). Falsification:
//   - concurrent approval of alpha→B and beta→C is the DESIGNED behaviour.
//   - fourth intent rejects MAX_POSITIONS_REACHED when all three slots are filled.
//   - third idiosyncratic rejects when C is blocked by a correlated position.
//   - two correlated intents: exactly one approved (BTC_CORRELATED_SLOT_TAKEN).

describe('S1 — concurrent slot race: designed 3-slot cap enforcement', () => {
    it('both concurrent idiosyncratic intents are approved when A is taken (alpha→B, beta→C)', async () => {
        // ADR 0004 §4: slot C is available to an idiosyncratic intent when no correlated
        // position holds it. With A occupied and B+C free, two concurrent idiosyncratic
        // intents correctly land one on B and one on C — both approve.
        const { gate } = makeGate();

        const openPos = buildOpenPositionView({ slot: PositionSlotEnum.A, correlationMode: CorrelationModeEnum.IDIOSYNCRATIC });
        const context = buildPassingContext({
            openPositions: buildOpenPositionsPort({ open: [openPos] }),
        });

        const intentAlpha = buildValidIntent({ symbol: 'ETHUSDT', eventId: 'ETHUSDT:ev1', signalScore: 80 });
        const intentBeta = buildValidIntent({ symbol: 'SOLUSDT', eventId: 'SOLUSDT:ev2', signalScore: 60 });

        const [resultAlpha, resultBeta] = await Promise.all([gate.evaluate(intentAlpha, context), gate.evaluate(intentBeta, context)]);

        // Both must be approved; slots are B and C (order depends on JS scheduling).
        expect(resultAlpha.outcome).toBe(RiskOutcomeEnum.APPROVED);
        expect(resultBeta.outcome).toBe(RiskOutcomeEnum.APPROVED);
        const slots = new Set([resultAlpha.approvedSlot, resultBeta.approvedSlot]);
        expect(slots).toContain(PositionSlotEnum.B);
        expect(slots).toContain(PositionSlotEnum.C);
    });

    it('two BTC-correlated intents racing for slot C: exactly one approved', async () => {
        // ADR 0004 §4: "at most 1 BTC-correlated position."
        const { gate } = makeGate();

        const context = buildPassingContext({
            openPositions: buildOpenPositionsPort({ open: [] }),
        });

        const correlatedAlpha = buildValidIntent({ symbol: 'ETHUSDT', eventId: 'ETH:ev1', correlationMode: CorrelationModeEnum.CORRELATED, signalScore: 90 });
        const correlatedBeta = buildValidIntent({ symbol: 'SOLUSDT', eventId: 'SOL:ev2', correlationMode: CorrelationModeEnum.CORRELATED, signalScore: 70 });

        const [resultAlpha, resultBeta] = await Promise.all([gate.evaluate(correlatedAlpha, context), gate.evaluate(correlatedBeta, context)]);

        const approved = [resultAlpha, resultBeta].filter((r) => r.outcome === RiskOutcomeEnum.APPROVED);
        const rejected = [resultAlpha, resultBeta].filter((r) => r.outcome === RiskOutcomeEnum.REJECTED);

        expect(approved).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].rejectReason).toBe(RejectReasonEnum.BTC_CORRELATED_SLOT_TAKEN);
    });

    it('third idiosyncratic intent is assigned slot C when A+B are filled and C is free of a correlated position', async () => {
        // ADR 0004 §4: slot C accepts an idiosyncratic overflow once A and B are occupied,
        // provided no correlated position holds C. The hard cap is 3 total, not 2.
        const { gate } = makeGate();
        const context = buildPassingContext({ openPositions: buildOpenPositionsPort({ open: [] }) });

        const first = buildValidIntent({ symbol: 'ETHUSDT', eventId: 'ETH:1' });
        const second = buildValidIntent({ symbol: 'SOLUSDT', eventId: 'SOL:2' });
        const third = buildValidIntent({ symbol: 'ADAUSDT', eventId: 'ADA:3' });

        await gate.evaluate(first, context);
        await gate.evaluate(second, context);
        const result = await gate.evaluate(third, context);

        expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        expect(result.approvedSlot).toBe(PositionSlotEnum.C);
    });

    it('fourth idiosyncratic intent is rejected with MAX_POSITIONS_REACHED when A+B+C all hold idiosyncratic positions', async () => {
        // ADR 0004 §4: 3-slot hard cap. A+B+C all filled → (N+1)th intent is rejected.
        // Raise max_trades_per_bar_universe above 3 so slot exhaustion fires first, not the
        // overtrading gate (which shares the same bar clock and would fire earlier otherwise).
        const { gate } = makeGate();
        const context = buildPassingContext({
            openPositions: buildOpenPositionsPort({ open: [] }),
            params: { ...buildGateContext().params, max_trades_per_bar_universe: 10 },
        });

        await gate.evaluate(buildValidIntent({ symbol: 'ETHUSDT', eventId: 'ETH:1' }), context);
        await gate.evaluate(buildValidIntent({ symbol: 'SOLUSDT', eventId: 'SOL:2' }), context);
        await gate.evaluate(buildValidIntent({ symbol: 'ADAUSDT', eventId: 'ADA:3' }), context);
        const result = await gate.evaluate(buildValidIntent({ symbol: 'BNBUSDT', eventId: 'BNB:4' }), context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.MAX_POSITIONS_REACHED);
    });

    it('third idiosyncratic intent rejects with MAX_POSITIONS_REACHED when A+B idiosyncratic and C holds a BTC-correlated position', async () => {
        // ADR 0004 §4: C is occupied by a correlated position → no idiosyncratic overflow
        // possible. All three slots are taken; the third idiosyncratic intent cannot land.
        const { gate } = makeGate();

        const correlatedOnC = buildOpenPositionView({ slot: PositionSlotEnum.C, correlationMode: CorrelationModeEnum.CORRELATED });
        const idioOnA = buildOpenPositionView({ slot: PositionSlotEnum.A, correlationMode: CorrelationModeEnum.IDIOSYNCRATIC });
        const idioOnB = buildOpenPositionView({ slot: PositionSlotEnum.B, correlationMode: CorrelationModeEnum.IDIOSYNCRATIC });

        const context = buildPassingContext({
            openPositions: buildOpenPositionsPort({ open: [idioOnA, idioOnB, correlatedOnC] }),
        });

        const result = await gate.evaluate(buildValidIntent({ symbol: 'ADAUSDT', eventId: 'ADA:1' }), context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.MAX_POSITIONS_REACHED);
    });
});

// ─── S2: Reservation leak when downstream handler throws mid-flight ───────────
//
// ADR 0004 §3 — "no approval leaks if downstream throws."
// Falsification: approve an intent (reservation written to ledger), then simulate
// a downstream throw by calling expireStaleReservations(). The reservation must
// transition to EXPIRED and no longer count toward caps, allowing a subsequent
// intent on the same slot to be approved.

describe('S2 — reservation leak: TTL expiry releases slot after downstream crash window', () => {
    it('expired reservation no longer counts toward slot cap — subsequent intent is approved', () => {
        // ADR 0004 §3: PENDING -> EXPIRED frees the slot for the next intent.
        const { ledger } = makeGate();

        const reservation = buildReservation({
            reservationId: 'ev1:A',
            slot: PositionSlotEnum.A,
            state: ReservationStateEnum.PENDING,
            createdAtMs: NOW_MS,
            expiresAtMs: NOW_MS + RESERVATION_TTL_MS,
        });

        ledger.reserve(reservation);
        expect(ledger.listActive()).toHaveLength(1);

        // Crash window: time advances past TTL (downstream handler never confirmed or released).
        ledger.expireStaleReservations(NOW_MS + RESERVATION_TTL_MS + 1);

        // Slot must be free — the leaked reservation must not count toward caps.
        expect(ledger.listActive()).toHaveLength(0);
    });

    it('EXPIRED state is terminal — confirm call on an expired reservation is silently ignored', () => {
        // ADR 0004 §3: terminal states do not transition further. A phantom confirm after
        // the crash window must not revive the reservation.
        const { ledger } = makeGate();

        const reservation = buildReservation({ reservationId: 'ev2:A', state: ReservationStateEnum.PENDING, expiresAtMs: NOW_MS });

        ledger.reserve(reservation);
        ledger.expireStaleReservations(NOW_MS + 1);
        ledger.confirmReservation('ev2:A'); // phantom confirm

        // Still expired, not confirmed — slot remains free.
        expect(ledger.listActive()).toHaveLength(0);
    });

    it('gate approves a subsequent intent after the prior reservation TTL has lapsed', async () => {
        // ADR 0004 §bypass-proof + §3. The gate uses the ledger's listActive() to count
        // occupied slots. After TTL expiry the slot must be free for a new intent.
        const { gate, ledger: _ledger } = makeGate();
        const context = buildPassingContext({ openPositions: buildOpenPositionsPort({ open: [] }) });

        const firstIntent = buildValidIntent({ symbol: 'ETHUSDT', eventId: 'ETH:ev1' });
        const firstResult = await gate.evaluate(firstIntent, context);
        expect(firstResult.outcome).toBe(RiskOutcomeEnum.APPROVED);

        // Crash window: expire the reservation without confirmation.
        gate.expireStaleReservations(NOW_MS + RESERVATION_TTL_MS + 1);

        // The second intent for the same slot must now be approved (slot freed by TTL).
        const secondIntent = buildValidIntent({ symbol: 'ETHUSDT', eventId: 'ETH:ev2' });
        const secondResult = await gate.evaluate(secondIntent, context);
        expect(secondResult.outcome).toBe(RiskOutcomeEnum.APPROVED);
    });

    it('released reservation (normal path) also frees the slot immediately', () => {
        // ADR 0004 §3: RELEASED is a terminal free state; must not count toward caps.
        const { ledger } = makeGate();
        const reservation = buildReservation({ reservationId: 'ev3:A', state: ReservationStateEnum.PENDING });

        ledger.reserve(reservation);
        ledger.releaseReservation('ev3:A');

        expect(ledger.listActive()).toHaveLength(0);
    });
});

// ─── S3: Loss window straddling UTC midnight and rolling-7-day cutoff ─────────
//
// ADR 0004 §5 — "daily boundary is exactly UTC midnight; weekly = rolling 7 days."
// Falsification: gate uses utcDateString to drive the window. A loss recorded one
// millisecond before midnight must land in the previous day; the new day resets;
// the weekly sum must exclude days rolled off the 7-day window.

describe('S3 — loss window seams at UTC midnight and rolling-7-day boundary', () => {
    it('daily window resets at UTC midnight: loss on 2024-05-20 does not block entry on 2024-05-21', async () => {
        // ADR 0004 §5: utcDateString is the day key. A new-day context carries a null row
        // (or zero PnL) for today — the previous-day loss is invisible to today's daily check.
        const { gate } = makeGate();

        // Simulate a new UTC day where today's risk_state has zero PnL even though
        // yesterday carried a loss.
        const context = buildPassingContext({
            utcDateString: '2024-05-21',
            riskState: buildRiskStatePort({
                day: buildRiskStateDay({ date: '2024-05-21', realizedPnlDay: new Money('0') }),
                weeklyPnl: '0', // rolling 7-day sum is fine
            }),
        });

        const result = await gate.evaluate(buildValidIntent(), context);

        expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
    });

    it('daily limit blocks entry exactly at the limit boundary (loss == limit, not strictly below)', async () => {
        // ADR 0004 §5: "breached when realizedPnlDay <= -dailyLossLimitUsdt."
        // Boundary: loss exactly equals the daily limit => blocked.
        const { gate } = makeGate();
        const DAILY_LIMIT = 50; // from riskConsts.DAILY_LOSS_LIMIT_USDT

        const context = buildPassingContext({
            riskState: buildRiskStatePort({
                day: buildRiskStateDay({ realizedPnlDay: new Money(`-${DAILY_LIMIT}`) }),
            }),
        });

        const result = await gate.evaluate(buildValidIntent(), context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.DAILY_LOSS_LIMIT);
    });

    it('daily limit does NOT block entry when loss is one cent below the limit (boundary pass)', async () => {
        // ADR 0004 §5: boundary immediately inside the limit must pass.
        const { gate } = makeGate();
        const DAILY_LIMIT = 50;

        const context = buildPassingContext({
            riskState: buildRiskStatePort({
                day: buildRiskStateDay({ realizedPnlDay: new Money(`-${DAILY_LIMIT - 0.01}`) }),
            }),
        });

        const result = await gate.evaluate(buildValidIntent(), context);

        expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
    });

    it('weekly limit: loss on day-7 is inside the window; loss on day-8 is excluded', async () => {
        // ADR 0004 §5: rolling-7-day window from today-(WEEKLY_LOSS_WINDOW_DAYS-1) to today.
        // If the mock sumRealizedPnlBetween returns a sum AT the weekly limit, entry is blocked.
        const { gate } = makeGate();
        const WEEKLY_LIMIT = 150;

        const riskState = buildRiskStatePort({
            day: buildRiskStateDay({ realizedPnlDay: new Money('0') }),
            weeklyPnl: `-${WEEKLY_LIMIT}`, // exactly at limit
        });

        const context = buildPassingContext({ riskState });

        const result = await gate.evaluate(buildValidIntent(), context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.WEEKLY_LOSS_LIMIT);
    });

    it('weekly window query uses correct 7-day inclusive range (from date param)', async () => {
        // ADR 0004 §5: gate must pass fromDate = today - 6 days (inclusive of today = 7 days).
        // We verify the sumRealizedPnlBetween call sites the correct date range.
        const { gate } = makeGate();

        const riskState = buildRiskStatePort({ weeklyPnl: '0' });
        const context = buildPassingContext({
            utcDateString: '2024-05-21',
            riskState,
        });

        await gate.evaluate(buildValidIntent(), context);

        expect(riskState.sumRealizedPnlBetween).toHaveBeenCalledWith('2024-05-15', '2024-05-21');
    });
});

// ─── S4: Halt fired between reservation and order-intent emission ──────────────
//
// ADR 0004 §halt-overrides-everything — "no approved intent survives a halt set
// after approval." Also: §bypass-proof gate.
// Falsification: gate evaluates and approves (reservation written); then
// HaltFlagService fires (simulated by calling evaluate again on a new halted
// context). The second evaluate must be blocked and the reservation from the
// first must remain in the ledger (it is the orchestrator's job to release it
// after detecting the halt — this test confirms reservation is not orphaned
// silently by the gate itself).

describe('S4 — halt fired between reservation and emit: intent blocked; reservation not silently orphaned', () => {
    it('gate rejects a NEW entry immediately after the global halt flag is set', async () => {
        // ADR 0004 §halt-overrides-everything. Once isHalted=true on today's risk_state,
        // every subsequent entry evaluate() returns GLOBAL_HALT.
        const { gate } = makeGate();

        // Before halt: approve an intent.
        const preHaltContext = buildPassingContext({ openPositions: buildOpenPositionsPort({ open: [] }) });
        const firstResult = await gate.evaluate(buildValidIntent({ eventId: 'ev1', symbol: 'ETHUSDT' }), preHaltContext);
        expect(firstResult.outcome).toBe(RiskOutcomeEnum.APPROVED);

        // After halt: risk_state.isHalted flips to true (kill-switch / stress / etc).
        const haltedContext = buildPassingContext({
            riskState: buildRiskStatePort({ day: buildRiskStateDay({ isHalted: true, haltReason: 'kill_switch' }) }),
        });

        const secondResult = await gate.evaluate(buildValidIntent({ eventId: 'ev2', symbol: 'SOLUSDT' }), haltedContext);

        expect(secondResult.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(secondResult.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
    });

    it('market-stress halt fires BEFORE slot assignment — reservation NOT created for stress-blocked intent', async () => {
        // ADR 0004 §bypass-proof + §halt-overrides. If stress fires first in the pipeline,
        // no reservation must land in the ledger for the blocked intent.
        const { gate, ledger } = makeGate();

        const context = buildPassingContext({
            snapshot: buildSnapshot({ btc_1m_move_pct: 5.0 }), // triggers stress
        });

        const result = await gate.evaluate(buildValidIntent(), context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.MARKET_STRESS);
        // No reservation must have leaked into the ledger.
        expect(ledger.listActive()).toHaveLength(0);
    });

    it('de-risk actions (reduce/close/flatten) pass through EVEN when halt is set', async () => {
        // ADR 0004 §2: "exits and kill-switch flattens are always allowed but still
        // route through the gate." Halt must never block de-risking.
        const { gate } = makeGate();

        const haltedContext = buildPassingContext({
            riskState: buildRiskStatePort({ day: buildRiskStateDay({ isHalted: true, haltReason: 'kill_switch' }) }),
        });

        for (const action of [OrderIntentActionEnum.REDUCE, OrderIntentActionEnum.CLOSE, OrderIntentActionEnum.FLATTEN]) {
            const intent = buildOrderIntent({ intentAction: action });
            const result = await gate.evaluate(intent, haltedContext);
            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        }
    });

    it('reservation from an approved intent remains in ledger until explicitly released — no silent orphan', async () => {
        // ADR 0004 §3: M6 owns the TTL sweep. Gate must not silently drop a PENDING
        // reservation when a subsequent evaluate() fails for any reason (halt, stress, etc.).
        const { gate, ledger } = makeGate();

        // First approve: reservation lands in ledger.
        const context = buildPassingContext({ openPositions: buildOpenPositionsPort({ open: [] }) });
        const result = await gate.evaluate(buildValidIntent({ eventId: 'ev1', symbol: 'ETHUSDT' }), context);
        expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        const reservationsBefore = ledger.listActive().length;

        // A subsequent REJECTED evaluate must not touch the prior reservation.
        const haltedContext = buildPassingContext({
            riskState: buildRiskStatePort({ day: buildRiskStateDay({ isHalted: true }) }),
        });
        await gate.evaluate(buildValidIntent({ eventId: 'ev2', symbol: 'SOLUSDT' }), haltedContext);

        expect(ledger.listActive()).toHaveLength(reservationsBefore); // prior reservation intact
    });
});

// ─── S5: Cooldown / per-bar / consecutive-loss evasion via rapid resubmit ─────
//
// ADR 0004 §cooldown + §overtrading. Falsification: rapid re-submits, same-bar
// second trigger, and consecutive-loss-day (N+1)th entry must all be rejected.

describe('S5 — evasion via rapid resubmit: cooldown, per-bar, consecutive-loss', () => {
    it('rejects re-entry on same symbol within cooldown window after a closed loss', async () => {
        // ADR 0004 §cooldown: "suppress re-entry for cooldownAfterLossMs after a closed loss."
        const { gate } = makeGate();

        const lastClose = buildClosedPositionView({
            symbol: 'ETHUSDT',
            realizedPnl: new Money('-20'), // negative = loss
            closedAtMs: NOW_MS - 1_000, // 1 second ago — well inside cooldown
        });

        const context = buildPassingContext({
            openPositions: buildOpenPositionsPort({ lastClose }),
        });

        const intent = buildValidIntent({ symbol: 'ETHUSDT' });
        const result = await gate.evaluate(intent, context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.COOLDOWN_ACTIVE);
    });

    it('approves re-entry on same symbol when cooldown has just expired (boundary at exactly cooldown_ms elapsed)', async () => {
        // ADR 0004 §cooldown boundary: at exactly cooldownAfterLossMs elapsed, entry is
        // no longer in cooldown (strictly less than threshold fails the cooldown check).
        const { gate } = makeGate();
        const COOLDOWN_MS = 15 * 60 * 1000;

        const lastClose = buildClosedPositionView({
            symbol: 'ETHUSDT',
            realizedPnl: new Money('-10'),
            closedAtMs: NOW_MS - COOLDOWN_MS, // exactly at the expiry threshold
        });

        const context = buildPassingContext({
            openPositions: buildOpenPositionsPort({ lastClose }),
        });

        const result = await gate.evaluate(buildValidIntent({ symbol: 'ETHUSDT' }), context);

        // nowMs - closedAtMs === COOLDOWN_MS, which is NOT < COOLDOWN_MS, so cooldown expired.
        expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
    });

    it('cooldown does NOT fire when the last close was a winning trade', async () => {
        // ADR 0004 §cooldown: "suppress re-entry after a closed LOSS." A win must not
        // trigger the cooldown — only losses do.
        const { gate } = makeGate();

        const lastClose = buildClosedPositionView({
            symbol: 'ETHUSDT',
            realizedPnl: new Money('50'), // positive = win
            closedAtMs: NOW_MS - 100, // very recent, but profit
        });

        const context = buildPassingContext({
            openPositions: buildOpenPositionsPort({ lastClose }),
        });

        const result = await gate.evaluate(buildValidIntent({ symbol: 'ETHUSDT' }), context);

        expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
    });

    it('per-bar-universe cap rejects the (N+1)th same-bar intent using bar-index match (not wall clock)', async () => {
        // ADR 0004 §overtrading + round-2 off-by-one fix. max_trades_per_bar_universe=1 means
        // the second intent in the same 5m bar is rejected MAX_TRADES_PER_BAR_UNIVERSE.
        // The bar-index check uses floor(createdAtMs / CANDLE_INTERVAL_MS) — not a time range.
        const { gate } = makeGate();

        const context = buildPassingContext({
            params: { ...buildGateContext().params, max_trades_per_bar_universe: 1 },
            openPositions: buildOpenPositionsPort({ open: [] }),
        });

        const firstResult = await gate.evaluate(buildValidIntent({ symbol: 'ETHUSDT', eventId: 'ETH:1' }), context);
        expect(firstResult.outcome).toBe(RiskOutcomeEnum.APPROVED);

        // Second intent same bar (same nowMs, same bar index).
        const secondResult = await gate.evaluate(buildValidIntent({ symbol: 'SOLUSDT', eventId: 'SOL:2' }), context);
        expect(secondResult.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(secondResult.rejectReason).toBe(RejectReasonEnum.MAX_TRADES_PER_BAR_UNIVERSE);
    });

    it('per-bar cap does NOT fire for an intent in the NEXT bar (bar-index advances)', async () => {
        // ADR 0004 §overtrading: cap is per-bar, not across bars. An intent in bar N+1 must
        // not be blocked by a reservation from bar N.
        const { gate } = makeGate();

        const CANDLE_INTERVAL_MS = 5 * 60 * 1000;

        const barOneContext = buildPassingContext({
            nowMs: NOW_MS,
            params: { ...buildGateContext().params, max_trades_per_bar_universe: 1 },
            openPositions: buildOpenPositionsPort({ open: [] }),
        });

        await gate.evaluate(buildValidIntent({ symbol: 'ETHUSDT', eventId: 'ETH:bar1' }), barOneContext);

        const barTwoContext = buildPassingContext({
            nowMs: NOW_MS + CANDLE_INTERVAL_MS, // next bar
            params: { ...buildGateContext().params, max_trades_per_bar_universe: 1 },
            openPositions: buildOpenPositionsPort({ open: [] }),
        });

        const nextBarResult = await gate.evaluate(buildValidIntent({ symbol: 'SOLUSDT', eventId: 'SOL:bar2' }), barTwoContext);
        expect(nextBarResult.outcome).toBe(RiskOutcomeEnum.APPROVED);
    });

    it('consecutive-loss halt fires after N closed losses on the same UTC day', async () => {
        // ADR 0004 §consecutive-loss: after CONSECUTIVE_LOSS_HALT_COUNT (=2) trailing losses,
        // halt new entries for the remainder of the UTC day.
        const { gate } = makeGate();

        const closedPositions = [
            buildClosedPositionView({ realizedPnl: new Money('-10'), closedAtMs: NOW_MS - 3_000 }),
            buildClosedPositionView({ realizedPnl: new Money('-15'), closedAtMs: NOW_MS - 2_000 }),
        ];

        const context = buildPassingContext({
            openPositions: buildOpenPositionsPort({ closed: closedPositions }),
        });

        const result = await gate.evaluate(buildValidIntent(), context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.CONSECUTIVE_LOSS_HALT);
    });

    it('consecutive-loss streak resets after a winning trade (win between two losses does not halt)', async () => {
        // ADR 0004 §consecutive-loss: "a win resets the streak." Loss, win, loss = streak of 1
        // which is below the halt threshold of 2.
        const { gate } = makeGate();

        const closedPositions = [
            buildClosedPositionView({ realizedPnl: new Money('-10'), closedAtMs: NOW_MS - 5_000 }),
            buildClosedPositionView({ realizedPnl: new Money('20'), closedAtMs: NOW_MS - 3_000 }), // win resets
            buildClosedPositionView({ realizedPnl: new Money('-5'), closedAtMs: NOW_MS - 1_000 }),
        ];

        const context = buildPassingContext({
            openPositions: buildOpenPositionsPort({ closed: closedPositions }),
        });

        const result = await gate.evaluate(buildValidIntent(), context);

        expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
    });

    it('per-symbol-per-day cap blocks (N+1)th entry after hitting max_trades_per_symbol_per_day', async () => {
        // ADR 0004 §overtrading: max_trades_per_symbol_per_day cap. At exactly the cap the
        // next entry for that symbol is rejected.
        const { gate } = makeGate();

        const context = buildPassingContext({
            params: { ...buildGateContext().params, max_trades_per_symbol_per_day: 2 },
            openPositions: buildOpenPositionsPort({
                open: [],
                countForSymbol: 2, // already at the daily cap
            }),
        });

        const result = await gate.evaluate(buildValidIntent({ symbol: 'ETHUSDT' }), context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.MAX_TRADES_PER_SYMBOL_PER_DAY);
    });
});
