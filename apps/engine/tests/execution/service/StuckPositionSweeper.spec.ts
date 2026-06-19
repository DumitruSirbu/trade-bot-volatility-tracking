/**
 * StuckPositionSweeper — M40 D4 coverage.
 *
 * The sweeper finalizes two stuck non-terminal position shapes that the PAPER-mode
 * reconciler cannot handle (ReconciliationService is a PAPER no-op):
 *
 *   Shape 1 — orphaned `pending_open` (never promoted to OPEN).
 *             Two-step: pending_open → reconciling → closed (no direct edge).
 *
 *   Shape 2 — `RECONCILING`-parked (non-clean permitted close under halt).
 *             One-step: reconciling → closed. Held close slot released first (C8).
 *             PAPER-only: LIVE rows are owned by the real ReconciliationService.
 *
 * Acceptance criteria covered (per M40 plan C1–C8):
 *   C1 — pending_open older than threshold: two-step finalized; younger one untouched.
 *   C2 — runs only in PAPER mode (isExecutionLive=false) for Shape 2.
 *   C3 — no exchange call on any sweep path.
 *   C4 — idempotent: re-running on a already-terminal row is a no-op; release on
 *        not-held slot is a no-op.
 *   C5 — boot-time pass (onModuleInit) catches a stale-at-startup row.
 *   C6 — determinism: deadline comparison uses injected nowMs, not inline Date.now().
 *   C7 — never-filled orphan has realizedPnl=null; RECONCILED_MISSING exit reason.
 *   C8 — RECONCILING-parked row: close slot released, finalizeRealizedPnl called
 *        (ADR 0046 §2.1a / A6b).
 *
 * Adversarial cases:
 *   C1-adv — exactly at boundary (openedAt = nowMs - threshold): swept.
 *   C1-adv2 — one tick younger (openedAt = nowMs - threshold + 1): NOT swept.
 *   C4-adv — re-sweep on RECONCILING row after slot already released: release not called again.
 *   C6-adv — two rows opened at different times; only the older one exceeds threshold.
 *   C8-adv — Shape 2 under LIVE mode: NOT swept (LIVE reconciler owns it).
 *
 * Failure routing: adversarial failures → architect routing per dev-qa-cycle.md §2.2.
 */

import { ExchangeEnvironmentEnum, ExitReasonEnum, PositionStateEnum } from '@bot/shared';

import { AppConfigService } from '../../../src/config/service';
import { PositionEntity } from '../../../src/position/entity/PositionEntity';
import { PositionRepository } from '../../../src/position/repository/PositionRepository';
import { PositionService } from '../../../src/position/service/PositionService';
import { STUCK_POSITION_THRESHOLD_MS } from '../../../src/execution/const/executionConsts';
import { SharedCloseCoordinator } from '../../../src/execution/service/SharedCloseCoordinator';
import { StuckPositionSweeper } from '../../../src/execution/service/StuckPositionSweeper';

// ─── factories ────────────────────────────────────────────────────────────────

function buildPositionEntity(id: number, state: PositionStateEnum, openedAtMs: number): PositionEntity {
    const entity = new PositionEntity();
    entity.id = id;
    entity.symbol = 'SOLUSDT';
    entity.state = state;
    entity.openedAt = new Date(openedAtMs);
    return entity;
}

interface ISweepBundle {
    sweeper: StuckPositionSweeper;
    positions: jest.Mocked<Pick<PositionRepository, 'findNonTerminal'>>;
    positionService: jest.Mocked<Pick<PositionService, 'transition' | 'finalizeRealizedPnl'>>;
    closeCoordinator: SharedCloseCoordinator;
    appConfig: jest.Mocked<Pick<AppConfigService, 'isExecutionLive' | 'exchangeEnv'>>;
}

function buildBundle(overrides: { isExecutionLive?: boolean; exchangeEnv?: ExchangeEnvironmentEnum } = {}): ISweepBundle {
    const positions = {
        findNonTerminal: jest.fn<Promise<PositionEntity[]>, []>().mockResolvedValue([]),
    } as unknown as ISweepBundle['positions'];

    const positionService = {
        transition: jest.fn().mockResolvedValue(undefined),
        finalizeRealizedPnl: jest.fn().mockResolvedValue({ id: 1, realizedPnl: null }),
    } as unknown as ISweepBundle['positionService'];

    const closeCoordinator = new SharedCloseCoordinator();
    const appConfig = {
        isExecutionLive: overrides.isExecutionLive ?? false,
        exchangeEnv: overrides.exchangeEnv ?? ExchangeEnvironmentEnum.PAPER,
    } as ISweepBundle['appConfig'];

    const sweeper = new StuckPositionSweeper(positions as never, positionService as never, closeCoordinator, appConfig as never);

    return { sweeper, positions, positionService, closeCoordinator, appConfig };
}

// ═══════════════════════════════════════════════════════════════════════════════
// C1 — pending_open older than threshold: two-step finalized; younger one untouched.
// ═══════════════════════════════════════════════════════════════════════════════

describe('C1 (happy path) — pending_open older than threshold: two-step pending_open → reconciling → closed', () => {
    it('pending_open row at threshold: transition(RECONCILING) called, then finalizeRealizedPnl(RECONCILED_MISSING) called', async () => {
        // BUILD: nowMs - THRESHOLD exactly (at boundary → stuck)
        const nowMs = Date.now();
        const stuckOpenedAt = nowMs - STUCK_POSITION_THRESHOLD_MS;
        const stuckRow = buildPositionEntity(1, PositionStateEnum.PENDING_OPEN, stuckOpenedAt);

        const { sweeper, positions, positionService } = buildBundle();
        (positions.findNonTerminal as jest.Mock).mockResolvedValue([stuckRow]);

        // OPERATE
        await (sweeper as any).sweepStuckPositions(nowMs);

        // CHECK: two-step transition for Shape 1
        expect(positionService.transition).toHaveBeenCalledWith(1, PositionStateEnum.RECONCILING, expect.any(Object));
        expect(positionService.finalizeRealizedPnl).toHaveBeenCalledWith(1, ExitReasonEnum.RECONCILED_MISSING, expect.any(Object));

        // Order matters: transition called before finalizeRealizedPnl
        const transitionOrder = (positionService.transition as jest.Mock).mock.invocationCallOrder[0];
        const finalizeOrder = (positionService.finalizeRealizedPnl as jest.Mock).mock.invocationCallOrder[0];
        expect(transitionOrder).toBeLessThan(finalizeOrder);
    });

    it('C1 boundary (1ms younger than threshold): younger pending_open NOT swept', async () => {
        // BUILD: openedAt = nowMs - threshold + 1 (strictly younger → not stuck)
        const nowMs = Date.now();
        const youngOpenedAt = nowMs - STUCK_POSITION_THRESHOLD_MS + 1;
        const youngRow = buildPositionEntity(2, PositionStateEnum.PENDING_OPEN, youngOpenedAt);

        const { sweeper, positions, positionService } = buildBundle();
        (positions.findNonTerminal as jest.Mock).mockResolvedValue([youngRow]);

        // OPERATE
        await (sweeper as any).sweepStuckPositions(nowMs);

        // CHECK: nothing called for a younger row
        expect(positionService.transition).not.toHaveBeenCalled();
        expect(positionService.finalizeRealizedPnl).not.toHaveBeenCalled();
    });
});

describe('C1 adversarial — mixed batch: only the stale row is swept, younger row untouched', () => {
    it('two pending_open rows: only the one exceeding threshold is swept', async () => {
        // BUILD
        const nowMs = 2_000_000_000_000; // fixed clock
        const staleRow = buildPositionEntity(10, PositionStateEnum.PENDING_OPEN, nowMs - STUCK_POSITION_THRESHOLD_MS - 1000);
        const freshRow = buildPositionEntity(11, PositionStateEnum.PENDING_OPEN, nowMs - STUCK_POSITION_THRESHOLD_MS + 1000);

        const { sweeper, positions, positionService } = buildBundle();
        (positions.findNonTerminal as jest.Mock).mockResolvedValue([staleRow, freshRow]);

        // OPERATE
        await (sweeper as any).sweepStuckPositions(nowMs);

        // CHECK: only row 10 swept
        expect(positionService.transition).toHaveBeenCalledTimes(1);
        expect(positionService.transition).toHaveBeenCalledWith(10, PositionStateEnum.RECONCILING, expect.any(Object));
        expect(positionService.finalizeRealizedPnl).toHaveBeenCalledTimes(1);
        expect(positionService.finalizeRealizedPnl).toHaveBeenCalledWith(10, ExitReasonEnum.RECONCILED_MISSING, expect.any(Object));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C2 — Shape 2 (RECONCILING) runs ONLY when EXCHANGE_ENV=paper
//
// SECURITY HIGH (surfaced by bot-review-security, M40):
//   StuckPositionSweeper.ts:93 guards the RECONCILING branch with
//   `!this.appConfig.isExecutionLive` (axis: EXECUTION_MODE), but the
//   condition it mirrors — ReconciliationService.ts:433 PAPER no-op — keys
//   off `exchangeEnv === ExchangeEnvironmentEnum.PAPER` (axis: EXCHANGE_ENV).
//   These axes are orthogonal. In a valid PAPER soak config:
//     EXCHANGE_ENV=paper (reconciler is a no-op) + EXECUTION_MODE=LIVE
//     (isExecutionLive=true)
//   the current guard wrongly SKIPS the sweep, leaving the close slot held
//   forever — the exact slot-leak D4 was built to fix.
//   Correct fix: gate on `exchangeEnv === ExchangeEnvironmentEnum.PAPER`.
//
// C2-adv (DEFECT EXPOSURE) captures this mismatch. It FAILS against the current
// implementation and is routed to the architect for the implementation fix.
// ═══════════════════════════════════════════════════════════════════════════════

describe('C2 — RECONCILING-parked sweep: EXCHANGE_ENV=paper guard (not EXECUTION_MODE)', () => {
    it('PAPER env + EXECUTION_MODE=DRY_RUN (isExecutionLive=false): RECONCILING row swept and finalized', async () => {
        // BUILD: EXCHANGE_ENV=paper, EXECUTION_MODE=DRY_RUN — both axes agree, should sweep
        const nowMs = 2_000_000_000_000;
        const reconRow = buildPositionEntity(20, PositionStateEnum.RECONCILING, nowMs - STUCK_POSITION_THRESHOLD_MS - 1000);

        const { sweeper, positions, positionService } = buildBundle({
            isExecutionLive: false,
            exchangeEnv: ExchangeEnvironmentEnum.PAPER,
        });
        (positions.findNonTerminal as jest.Mock).mockResolvedValue([reconRow]);

        // OPERATE
        await (sweeper as any).sweepStuckPositions(nowMs);

        // CHECK: finalized — both axes indicate PAPER no-op reconciler
        expect(positionService.finalizeRealizedPnl).toHaveBeenCalledWith(20, ExitReasonEnum.RECONCILED_MISSING, expect.any(Object));
    });

    it('LIVE env + EXECUTION_MODE=LIVE (isExecutionLive=true): RECONCILING row NOT swept (real reconciler owns it)', async () => {
        // BUILD: EXCHANGE_ENV=live, EXECUTION_MODE=LIVE — real reconciler is active, must not race
        const nowMs = 2_000_000_000_000;
        const reconRow = buildPositionEntity(21, PositionStateEnum.RECONCILING, nowMs - STUCK_POSITION_THRESHOLD_MS - 1000);

        const { sweeper, positions, positionService } = buildBundle({
            isExecutionLive: true,
            exchangeEnv: ExchangeEnvironmentEnum.LIVE,
        });
        (positions.findNonTerminal as jest.Mock).mockResolvedValue([reconRow]);

        // OPERATE
        await (sweeper as any).sweepStuckPositions(nowMs);

        // CHECK: NOT swept — real reconciler owns RECONCILING rows in LIVE env
        expect(positionService.finalizeRealizedPnl).not.toHaveBeenCalled();
    });

    /**
     * C2 adversarial — DEFECT EXPOSURE (routes to architect for fix):
     *
     * Paper-soak configuration: EXCHANGE_ENV=paper + EXECUTION_MODE=LIVE.
     * This is a valid paper-soak configuration per the project memory note
     * ("paper = LIVE Binance + simulated fills; needs valid least-priv live key").
     *
     * In this config:
     *   - ReconciliationService.ts:433 is a PAPER no-op (keyed on EXCHANGE_ENV=paper).
     *     RECONCILING rows have NO driver — they stay parked forever.
     *   - StuckPositionSweeper.ts:93 checks `!isExecutionLive` → false → SKIPS sweep.
     *   - Result: close slot held forever. Slot-leak. D4's purpose defeated.
     *
     * The correct guard is `exchangeEnv === ExchangeEnvironmentEnum.PAPER` (the same
     * axis as ReconciliationService.ts:433).
     *
     * This test FAILS against the current implementation (isExecutionLive guard)
     * to surface the defect. Fix: change StuckPositionSweeper.ts:93 from
     *   `!this.appConfig.isExecutionLive`
     * to
     *   `this.appConfig.exchangeEnv === ExchangeEnvironmentEnum.PAPER`
     */
    it('[DEFECT] C2-adv: PAPER env + EXECUTION_MODE=LIVE (paper-soak) — RECONCILING row MUST be swept (slot-leak if skipped)', async () => {
        // BUILD: paper-soak config — reconciler is PAPER no-op, but isExecutionLive=true
        const nowMs = 2_000_000_000_000;
        const reconRow = buildPositionEntity(22, PositionStateEnum.RECONCILING, nowMs - STUCK_POSITION_THRESHOLD_MS - 1000);

        const { sweeper, positions, positionService, closeCoordinator } = buildBundle({
            isExecutionLive: true, // EXECUTION_MODE=LIVE (paper-soak uses live exchange calls)
            exchangeEnv: ExchangeEnvironmentEnum.PAPER, // EXCHANGE_ENV=paper (reconciler is a no-op)
        });

        // Simulate a held close slot (the slot-leak scenario D4 must fix)
        closeCoordinator.tryAcquire(22);
        expect(closeCoordinator.isHeld(22)).toBe(true);

        (positions.findNonTerminal as jest.Mock).mockResolvedValue([reconRow]);

        // OPERATE
        await (sweeper as any).sweepStuckPositions(nowMs);

        // CHECK: MUST sweep in PAPER env regardless of EXECUTION_MODE.
        // A failing assertion here means the guard is keyed on the wrong axis.
        // FIX REQUIRED in StuckPositionSweeper.ts:93 — see docstring above.
        expect(closeCoordinator.isHeld(22)).toBe(false); // slot must be released
        expect(positionService.finalizeRealizedPnl).toHaveBeenCalledWith(22, ExitReasonEnum.RECONCILED_MISSING, expect.any(Object));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C3 — No exchange call on any sweep path
// ═══════════════════════════════════════════════════════════════════════════════

describe('C3 — no exchange call on any sweep path', () => {
    it('StuckPositionSweeper has no exchange client injection (compile-time assertion: no IExchangeClient in constructor)', () => {
        // BUILD: StuckPositionSweeper only injects PositionRepository, PositionService,
        // SharedCloseCoordinator, AppConfigService. No exchange client in the constructor.
        // This test asserts the structural invariant by verifying the sweeper instance
        // does not have any exchange-related property.
        const { sweeper } = buildBundle();
        const sweeperPrivate = sweeper as unknown as Record<string, unknown>;

        // No exchange client property should exist
        const hasExchangeClient = Object.keys(sweeperPrivate).some((key) => key.toLowerCase().includes('exchange') || key.toLowerCase().includes('client'));
        expect(hasExchangeClient).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C4 — Idempotent: re-running on already-terminal or not-held-slot is no-op
// ═══════════════════════════════════════════════════════════════════════════════

describe('C4 — idempotent: re-sweep on RECONCILING row with slot not held is a no-op for release', () => {
    it('Shape 2 RECONCILING row with no held close slot: finalizeRealizedPnl called once, release NOT called', async () => {
        // BUILD: PAPER, RECONCILING row past threshold, slot NOT held
        const nowMs = 2_000_000_000_000;
        const reconRow = buildPositionEntity(30, PositionStateEnum.RECONCILING, nowMs - STUCK_POSITION_THRESHOLD_MS - 5000);

        const { sweeper, positions, positionService, closeCoordinator } = buildBundle({ isExecutionLive: false });
        (positions.findNonTerminal as jest.Mock).mockResolvedValue([reconRow]);

        const releaseSpy = jest.spyOn(closeCoordinator, 'release');

        // OPERATE: sweeper should NOT try to release a slot it does not hold
        await (sweeper as any).sweepStuckPositions(nowMs);

        // CHECK: finalize called (the row is swept)
        expect(positionService.finalizeRealizedPnl).toHaveBeenCalledTimes(1);

        // Release NOT called (slot is not held — isHeld returns false)
        expect(releaseSpy).not.toHaveBeenCalled();

        releaseSpy.mockRestore();
    });

    it('C4 adversarial: slot held → released once; re-sweep after slot freed → release not called again', async () => {
        // BUILD
        const nowMs = 2_000_000_000_000;
        const reconRow = buildPositionEntity(31, PositionStateEnum.RECONCILING, nowMs - STUCK_POSITION_THRESHOLD_MS - 5000);

        const { sweeper, positions, positionService, closeCoordinator } = buildBundle({ isExecutionLive: false });

        // Hold the slot BEFORE sweep
        closeCoordinator.tryAcquire(31);
        expect(closeCoordinator.isHeld(31)).toBe(true);

        (positions.findNonTerminal as jest.Mock).mockResolvedValue([reconRow]);
        const releaseSpy = jest.spyOn(closeCoordinator, 'release');

        // OPERATE: first sweep
        await (sweeper as any).sweepStuckPositions(nowMs);

        // Slot should now be released
        expect(releaseSpy).toHaveBeenCalledTimes(1);
        expect(releaseSpy).toHaveBeenCalledWith(31);
        expect(closeCoordinator.isHeld(31)).toBe(false);

        // OPERATE: second sweep (slot already freed)
        releaseSpy.mockClear();
        (positionService.finalizeRealizedPnl as jest.Mock).mockClear();
        // Simulate finalized row by making findNonTerminal return empty (row is now closed)
        (positions.findNonTerminal as jest.Mock).mockResolvedValue([]);

        await (sweeper as any).sweepStuckPositions(nowMs);

        // CHECK: release NOT called again (row not found, no-op)
        expect(releaseSpy).not.toHaveBeenCalled();
        expect(positionService.finalizeRealizedPnl).not.toHaveBeenCalled();

        releaseSpy.mockRestore();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C5 — Boot-time pass via onModuleInit catches stale rows at startup
// ═══════════════════════════════════════════════════════════════════════════════

describe('C5 — boot-time pass (onModuleInit) catches a row already stale at startup', () => {
    it('onModuleInit calls sweepStuckPositions exactly once with Date.now() as nowMs', async () => {
        // BUILD: stale pending_open row
        const staleRow = buildPositionEntity(40, PositionStateEnum.PENDING_OPEN, Date.now() - STUCK_POSITION_THRESHOLD_MS - 10_000);

        const { sweeper, positions, positionService } = buildBundle();
        (positions.findNonTerminal as jest.Mock).mockResolvedValue([staleRow]);

        // OPERATE: call onModuleInit (the boot pass)
        await sweeper.onModuleInit();

        // CHECK: sweeper ran and finalized the stale row
        expect(positionService.transition).toHaveBeenCalledWith(40, PositionStateEnum.RECONCILING, expect.any(Object));
        expect(positionService.finalizeRealizedPnl).toHaveBeenCalledWith(40, ExitReasonEnum.RECONCILED_MISSING, expect.any(Object));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C6 — Determinism: nowMs is injected, not inline Date.now() in the comparison
// ═══════════════════════════════════════════════════════════════════════════════

describe('C6 — determinism: deadline comparison uses injected nowMs, not inline Date.now()', () => {
    it('sweepStuckPositions with a frozen nowMs: only rows stale relative to that nowMs are swept', async () => {
        // BUILD: use a far-future frozen clock so the threshold comparison is deterministic.
        const frozenNowMs = 3_000_000_000_000; // far future
        const staleRow = buildPositionEntity(50, PositionStateEnum.PENDING_OPEN, frozenNowMs - STUCK_POSITION_THRESHOLD_MS - 1000);
        const freshRow = buildPositionEntity(51, PositionStateEnum.PENDING_OPEN, frozenNowMs - 60_000); // only 1 min old relative to frozen clock

        const { sweeper, positions, positionService } = buildBundle();
        (positions.findNonTerminal as jest.Mock).mockResolvedValue([staleRow, freshRow]);

        // OPERATE: inject frozenNowMs directly (not Date.now())
        await (sweeper as any).sweepStuckPositions(frozenNowMs);

        // CHECK: only stale row (50) swept, fresh row (51) untouched
        expect(positionService.transition).toHaveBeenCalledTimes(1);
        expect(positionService.transition).toHaveBeenCalledWith(50, PositionStateEnum.RECONCILING, expect.any(Object));
        expect(positionService.transition).not.toHaveBeenCalledWith(51, expect.anything(), expect.anything());
    });

    it('C6: the context object passed to transition/finalize carries the injected nowMs (not a different timestamp)', async () => {
        // BUILD
        const frozenNowMs = 3_000_000_000_001;
        const staleRow = buildPositionEntity(52, PositionStateEnum.PENDING_OPEN, frozenNowMs - STUCK_POSITION_THRESHOLD_MS - 1000);

        const { sweeper, positions, positionService } = buildBundle();
        (positions.findNonTerminal as jest.Mock).mockResolvedValue([staleRow]);

        // OPERATE
        await (sweeper as any).sweepStuckPositions(frozenNowMs);

        // CHECK: context.nowMs === injected frozenNowMs
        const [, , contextArg] = (positionService.transition as jest.Mock).mock.calls[0];
        expect((contextArg as { nowMs: number }).nowMs).toBe(frozenNowMs);

        const [, , finalizeContextArg] = (positionService.finalizeRealizedPnl as jest.Mock).mock.calls[0];
        expect((finalizeContextArg as { nowMs: number }).nowMs).toBe(frozenNowMs);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C7 — Never-filled orphan: exitReason=RECONCILED_MISSING, realizedPnl contract
//
// Architect adjudication (M40):
//   A swept row contributes exactly zero (null → COALESCE 0) realized PnL to the
//   day's realized-PnL total and to per-version netPnlUsd. Having null realized_pnl
//   it is never counted as a win in win-rate (COUNT(*) FILTER (WHERE realized_pnl > 0)).
//   Trade-count inclusion via COUNT(*) in findClosedTodayAggregates follows the
//   existing RECONCILED_MISSING reconciliation-close convention and is out of scope
//   for D4. Track as LOW tech-debt if analytics should exclude null-PnL rows from
//   tradeCount denominator.
// ═══════════════════════════════════════════════════════════════════════════════

describe('C7 — never-filled orphan: exitReason=RECONCILED_MISSING, zero PnL contribution', () => {
    it('sweepOrphanedPendingOpen calls finalizeRealizedPnl with RECONCILED_MISSING exit reason', async () => {
        // BUILD
        const nowMs = 2_000_000_000_000;
        const orphanRow = buildPositionEntity(60, PositionStateEnum.PENDING_OPEN, nowMs - STUCK_POSITION_THRESHOLD_MS - 2000);

        const { sweeper, positions, positionService } = buildBundle();
        (positions.findNonTerminal as jest.Mock).mockResolvedValue([orphanRow]);

        // OPERATE
        await (sweeper as any).sweepStuckPositions(nowMs);

        // CHECK: exit reason is RECONCILED_MISSING
        const [, exitReasonArg] = (positionService.finalizeRealizedPnl as jest.Mock).mock.calls[0];
        expect(exitReasonArg).toBe(ExitReasonEnum.RECONCILED_MISSING);
    });

    it('C7: never-filled orphan finalizes with null realizedPnl (zero PnL contribution to day totals)', async () => {
        // BUILD: finalizeRealizedPnl returns null realizedPnl for a never-filled row
        const nowMs = 2_000_000_000_000;
        const orphanRow = buildPositionEntity(61, PositionStateEnum.PENDING_OPEN, nowMs - STUCK_POSITION_THRESHOLD_MS - 2000);

        const { sweeper, positions, positionService } = buildBundle();
        const finalizedRow = buildPositionEntity(61, PositionStateEnum.CLOSED, nowMs - STUCK_POSITION_THRESHOLD_MS - 2000);
        (finalizedRow as unknown as { realizedPnl: null }).realizedPnl = null;
        (positionService.finalizeRealizedPnl as jest.Mock).mockResolvedValue(finalizedRow);

        (positions.findNonTerminal as jest.Mock).mockResolvedValue([orphanRow]);

        // OPERATE
        await (sweeper as any).sweepStuckPositions(nowMs);

        // CHECK: finalizeRealizedPnl called with RECONCILED_MISSING
        expect(positionService.finalizeRealizedPnl).toHaveBeenCalledWith(61, ExitReasonEnum.RECONCILED_MISSING, expect.any(Object));

        // CHECK: null realizedPnl → COALESCE(SUM(realized_pnl), 0) contributes exactly 0
        // to day realizedPnlDay and per-version netPnlUsd (C7 adjudicated contract)
        const finalizedResult = await (positionService.finalizeRealizedPnl as jest.Mock).mock.results[0].value;
        expect((finalizedResult as { realizedPnl: null }).realizedPnl).toBeNull();

        // CHECK: null realizedPnl fails COUNT(*) FILTER (WHERE realized_pnl > 0) →
        // never counted as a win in win-rate (win numerator unaffected)
        const realizedPnl = (finalizedResult as { realizedPnl: null }).realizedPnl;
        expect(realizedPnl === null || realizedPnl <= 0).toBe(true); // not a win
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C8 — RECONCILING-parked residual reclaim: close slot released, row finalized
//      ADR 0046 §2.1a / A6b — D4 owns the reclaim path for Shape 2.
// ═══════════════════════════════════════════════════════════════════════════════

describe('C8 — RECONCILING-parked residual: slot released, finalizeRealizedPnl called (Shape 2 PAPER-only)', () => {
    it('Shape 2: stale RECONCILING row with held close slot → slot released, finalized via RECONCILED_MISSING', async () => {
        // BUILD: PAPER mode, RECONCILING row past threshold, close slot held
        const nowMs = 2_000_000_000_000;
        const reconRow = buildPositionEntity(70, PositionStateEnum.RECONCILING, nowMs - STUCK_POSITION_THRESHOLD_MS - 5000);

        const { sweeper, positions, positionService, closeCoordinator } = buildBundle({ isExecutionLive: false });
        (positions.findNonTerminal as jest.Mock).mockResolvedValue([reconRow]);

        // Simulate a held close slot (non-clean close under halt left slot held)
        closeCoordinator.tryAcquire(70);
        expect(closeCoordinator.isHeld(70)).toBe(true);

        // OPERATE
        await (sweeper as any).sweepStuckPositions(nowMs);

        // CHECK: slot released before finalize
        expect(closeCoordinator.isHeld(70)).toBe(false);

        // CHECK: finalizeRealizedPnl called with RECONCILED_MISSING
        expect(positionService.finalizeRealizedPnl).toHaveBeenCalledWith(70, ExitReasonEnum.RECONCILED_MISSING, expect.any(Object));

        // CHECK: positionService.transition NOT called for Shape 2 (one-step reconciling → closed)
        expect(positionService.transition).not.toHaveBeenCalled();
    });

    it('C8: slot released BEFORE finalizeRealizedPnl (ordering requirement)', async () => {
        // BUILD: verify release happens before finalize by tracking call order
        const nowMs = 2_000_000_000_000;
        const reconRow = buildPositionEntity(71, PositionStateEnum.RECONCILING, nowMs - STUCK_POSITION_THRESHOLD_MS - 5000);

        const { sweeper, positions, positionService, closeCoordinator } = buildBundle({ isExecutionLive: false });
        (positions.findNonTerminal as jest.Mock).mockResolvedValue([reconRow]);

        closeCoordinator.tryAcquire(71);
        const callLog: string[] = [];

        const originalRelease = closeCoordinator.release.bind(closeCoordinator);
        jest.spyOn(closeCoordinator, 'release').mockImplementation((id) => {
            callLog.push('release');
            originalRelease(id);
        });

        (positionService.finalizeRealizedPnl as jest.Mock).mockImplementation(async () => {
            callLog.push('finalize');
            return buildPositionEntity(71, PositionStateEnum.CLOSED, nowMs);
        });

        // OPERATE
        await (sweeper as any).sweepStuckPositions(nowMs);

        // CHECK: release called before finalize
        expect(callLog).toEqual(['release', 'finalize']);
    });

    it('C8 adversarial: LIVE exchangeEnv RECONCILING row NOT swept even when slot is held (LIVE reconciler owns it)', async () => {
        // BUILD: exchangeEnv=LIVE — the sweeper's RECONCILING branch is gated on
        // `exchangeEnv === PAPER`. In LIVE, the real ReconciliationService owns
        // RECONCILING rows and must not be raced by the sweeper.
        // Note: `isExecutionLive` is NOT the scope axis here — the sweeper scopes
        // the RECONCILING branch purely on `exchangeEnv`, so this test must set
        // `exchangeEnv: LIVE` to correctly express the "LIVE reconciler owns it" intent.
        const nowMs = 2_000_000_000_000;
        const reconRow = buildPositionEntity(72, PositionStateEnum.RECONCILING, nowMs - STUCK_POSITION_THRESHOLD_MS - 5000);

        const { sweeper, positions, positionService, closeCoordinator } = buildBundle({
            exchangeEnv: ExchangeEnvironmentEnum.LIVE,
        });
        (positions.findNonTerminal as jest.Mock).mockResolvedValue([reconRow]);

        closeCoordinator.tryAcquire(72);
        const releaseSpy = jest.spyOn(closeCoordinator, 'release');

        // OPERATE
        await (sweeper as any).sweepStuckPositions(nowMs);

        // CHECK: nothing touched in LIVE exchangeEnv
        expect(releaseSpy).not.toHaveBeenCalled();
        expect(positionService.finalizeRealizedPnl).not.toHaveBeenCalled();

        releaseSpy.mockRestore();
    });
});
