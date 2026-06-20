import { ExchangeEnvironmentEnum, ExitReasonEnum, PositionStateEnum } from '@bot/shared';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { AppConfigService } from '../../config/service';
import { PositionEntity } from '../../position/entity';
import { PositionRepository } from '../../position/repository/PositionRepository';
import { IPositionTransitionContext, PositionService } from '../../position/service/PositionService';
import { STUCK_POSITION_SWEEP_INTERVAL_MS, STUCK_POSITION_THRESHOLD_MS, STUCK_SWEEP_EVENT_CLASS } from '../const';
import { SharedCloseCoordinator } from './SharedCloseCoordinator';

// M40 D4 — paper-safe stuck-position sweep. Two non-terminal shapes are unreachable by the
// reconciler under PAPER (ReconciliationService.runTickNow is a PAPER no-op), so a stuck row
// would otherwise sit forever:
//
//   Shape 1 — orphaned `pending_open` (the #38 ZEC zombie): a row whose
//   `pending_open → open` (`protective.attached`) promotion never fired. It holds NO close
//   slot and carries no exchange exposure (qty=0). Finalized via the two-step legal arrow
//   `pending_open → reconciling → closed` (ADR 0009 §3 — there is NO direct
//   `pending_open → closed` edge).
//
//   Shape 2 — `RECONCILING`-parked (ADR 0046 §2.1a / M40 A6b residual): a row driven to
//   RECONCILING by a non-clean permitted close under halt. Under PAPER it has no reconciliation
//   driver and STILL HOLDS the shared close slot (`handleReduceTerminal` non-clean releases only
//   the order reservation, never the slot). Finalized via the one-step legal arrow
//   `reconciling → closed`, releasing the held close slot FIRST. PAPER-only: in LIVE the real
//   ReconciliationService owns RECONCILING rows and this branch must not race it.
//
// Neither shape needs an order-reservation release: a never-filled `pending_open` never held a
// reservation, and a `RECONCILING`-parked row already released its reservation on the non-clean
// terminal. The only reclaimable slot is the close slot, and only for Shape 2.
//
// Both shapes finalize through `PositionService.finalizeRealizedPnl` with
// `ExitReasonEnum.RECONCILED_MISSING` — the same finalize contract reconciliation case-(b) uses.
// A never-filled row has no closing transactions, so finalize writes `realizedPnl = null` and is
// excluded from the trade-count / win-rate / drawdown denominators (C7). A partially-filled
// RECONCILING row's realized PnL follows the same aggregate contract (C8) — never forced to zero.
//
// Determinism: `Date.now()` is read ONCE at the `@Interval` boundary and injected downward — the
// same documented exception ReconciliationService and PositionTimeStopEnforcer use. The stale
// comparison is `openedAt.getTime() <= nowMs - threshold`. The schema carries no per-row
// last-transition timestamp, so `openedAt` is the reference for BOTH shapes; a RECONCILING-parked
// row was opened far earlier than it parked, so this is a strictly-conservative lower bound.
@Injectable()
export class StuckPositionSweeper implements OnModuleInit {
    private readonly logger = new Logger(StuckPositionSweeper.name);

    constructor(
        private readonly positions: PositionRepository,
        private readonly positionService: PositionService,
        private readonly closeCoordinator: SharedCloseCoordinator,
        private readonly appConfig: AppConfigService,
    ) {}

    // Boot pass (C5): a row already stale at startup (like ZEC #38) clears on the first boot
    // rather than waiting a full interval. BootstrapModule sits above ExecutionModule, so this
    // runs during DI before the trading loop starts.
    async onModuleInit(): Promise<void> {
        await this.sweepStuckPositions(Date.now());
    }

    // Periodic safety-net sweep. The clock is captured ONCE here and injected down so the stale
    // comparison is deterministic (replay-safe). The backtest never schedules this interval.
    @Interval(STUCK_POSITION_SWEEP_INTERVAL_MS)
    async sweepStuckPositionsOnInterval(): Promise<void> {
        await this.sweepStuckPositions(Date.now());
    }

    // The source-agnostic sweep body. Re-reads the authoritative non-terminal set (includes
    // qty=0 zombie rows) and finalizes any stuck `pending_open` (both modes) or `RECONCILING`
    // (PAPER only) row past the threshold.
    private async sweepStuckPositions(nowMs: number): Promise<void> {
        const candidates = await this.positions.findNonTerminal();

        for (const position of candidates) {
            await this.sweepIfStuck(position, nowMs);
        }
    }

    // Dispatches one row to its shape-specific finalize, or skips it (not stuck / not a swept
    // state / RECONCILING under LIVE).
    private async sweepIfStuck(position: PositionEntity, nowMs: number): Promise<void> {
        if (!this.isStuck(position, nowMs)) {
            return;
        }

        if (position.state === PositionStateEnum.PENDING_OPEN) {
            await this.sweepOrphanedPendingOpen(position, nowMs);

            return;
        }

        if (position.state === PositionStateEnum.RECONCILING && this.appConfig.exchangeEnv === ExchangeEnvironmentEnum.PAPER) {
            await this.sweepReconcilingParked(position, nowMs);
        }
    }

    // True when the row has sat past the stuck threshold (measured from `openedAt`). Younger rows
    // and rows in any non-swept state are left untouched (scope guard).
    private isStuck(position: PositionEntity, nowMs: number): boolean {
        return position.openedAt.getTime() <= nowMs - STUCK_POSITION_THRESHOLD_MS;
    }

    // Shape 1: orphaned `pending_open` → `reconciling` → `closed`. Holds no close slot, so no
    // slot release. Finalize writes null realized PnL for the never-filled row (C7).
    private async sweepOrphanedPendingOpen(position: PositionEntity, nowMs: number): Promise<void> {
        const context = this.buildSweepContext(nowMs);

        await this.positionService.transition(position.id, PositionStateEnum.RECONCILING, context);
        await this.positionService.finalizeRealizedPnl(position.id, ExitReasonEnum.RECONCILED_MISSING, context);

        this.logger.warn(
            `swept orphaned pending_open positionId=${position.id} symbol=${position.symbol} ` +
                `openedAt=${position.openedAt.getTime()} nowMs=${nowMs} - finalized via pending_open → reconciling → closed (RECONCILED_MISSING)`,
        );
    }

    // Shape 2 (PAPER-only): `RECONCILING` → `closed`. Releases the held close slot BEFORE the
    // finalize. The release is conditional + idempotent — a blind release on a not-held slot is a
    // no-op (C4), so a re-run after the slot is already freed never double-releases.
    private async sweepReconcilingParked(position: PositionEntity, nowMs: number): Promise<void> {
        if (this.closeCoordinator.isHeld(position.id)) {
            this.closeCoordinator.release(position.id);
        }

        const context = this.buildSweepContext(nowMs);

        await this.positionService.finalizeRealizedPnl(position.id, ExitReasonEnum.RECONCILED_MISSING, context);

        this.logger.warn(
            `swept RECONCILING-parked positionId=${position.id} symbol=${position.symbol} ` +
                `openedAt=${position.openedAt.getTime()} nowMs=${nowMs} - released close slot, finalized via reconciling → closed (RECONCILED_MISSING)`,
        );
    }

    // The transition context carried through both finalize paths. `nowMs` is the injected sweep
    // clock (determinism); `eventClass` labels the producer for downstream listeners.
    private buildSweepContext(nowMs: number): IPositionTransitionContext {
        return { nowMs, eventClass: STUCK_SWEEP_EVENT_CLASS };
    }
}
