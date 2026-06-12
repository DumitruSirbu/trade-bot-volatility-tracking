import { ExchangeEnvironmentEnum, PositionStateEnum, ProtectiveOrderTypeEnum, RetainReasonEnum } from '@bot/shared';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { Money, MoneyValue } from '../../common/utils/money';
import { AppConfigService } from '../../config/service';
import { LocalProtectiveMonitor } from '../../execution/service/LocalProtectiveMonitor';
import { SubscriptionRetainer } from '../../market-data/service/SubscriptionRetainer';
import { PaperReconciliationAdapter } from '../../paper-mode/service/PaperReconciliationAdapter';
import { PositionEntity } from '../../position/entity';
import { AccountSnapshotRepository } from '../../position/repository/AccountSnapshotRepository';
import { PositionRepository } from '../../position/repository/PositionRepository';
import { ACCOUNT_SNAPSHOT_DRIFT_TOLERANCE_USDT, AccountSnapshotWriter } from '../../position/service/AccountSnapshotWriter';
import { PositionInstrumentor } from '../../position/service/PositionInstrumentor';
import { ReconciliationService } from '../../position/service/ReconciliationService';
import { RiskGateService } from '../../risk/service/RiskGateService';

// M6 W8 (ADR 0014). The ordered ten-phase boot pipeline that re-associates
// post-restart state with the exchange truth before the orchestrator opens.
// Phases are strictly sequential — phase N+1 starts only after phase N
// resolves (ADR §1, §9 reviewer rule).
//
// Composition-root: this service now lives in its own `BootstrapModule` which
// sits structurally ABOVE PositionModule, ExecutionModule, and RiskModule. That
// placement is what lets every dependency be injected plainly — no `forwardRef`
// is needed because BootstrapModule has no consumers (it self-runs through
// `OnApplicationBootstrap`), so it never re-enters a cycle. Previously this
// class lived in `position/service/` and used three `forwardRef`s to reach
// ReconciliationService, LocalProtectiveMonitor, and RiskGateService.
//
// Phase 0 happens implicitly during NestJS DI (module init); this service's
// `OnApplicationBootstrap` hook runs after DI completes, kicking off phases
// 1–9. The risk gate stays closed (`RECOVERY_IN_PROGRESS` reject) until phase
// 9 calls `riskGate.markRecoveryComplete()`.
//
// Failure handling: any phase that throws aborts the boot WITHOUT flipping
// the ready flag. The orchestrator stays closed permanently in that process;
// operator must investigate logs + restart. ADR §9: "no partial-ready" — a
// half-recovered engine is structurally worse than a fully-blocked one.
//
// Reuse contract (per W8 dispatch): the bootstrap service composes
// already-shipped wave artifacts (`ReconciliationService.forceTick`,
// `LocalProtectiveMonitor.arm`, `PositionInstrumentor.onPositionOpened`,
// `AccountSnapshotWriter.writeNow`) — it does not re-implement them. The
// only new domain logic here is the orchestration + the open_exposure
// rebuild (ADR §4a authoritative leaked-reservation release).
//
// Deterministic clock: every phase reads `nowMs` from the parameter passed
// down by `boot()`. In live, `boot()` reads `Date.now()` once at the
// entry — the boundary read. In M7 backtest replay, `boot()` is called
// with the replay tick T (ADR §8).
@Injectable()
export class EngineBootstrapService implements OnApplicationBootstrap {
    private readonly logger = new Logger(EngineBootstrapService.name);

    private booted = false;

    constructor(
        private readonly positions: PositionRepository,
        private readonly reconciliation: ReconciliationService,
        private readonly localProtectiveMonitor: LocalProtectiveMonitor,
        private readonly instrumentor: PositionInstrumentor,
        private readonly retainer: SubscriptionRetainer,
        private readonly riskGate: RiskGateService,
        private readonly snapshotWriter: AccountSnapshotWriter,
        private readonly accountSnapshots: AccountSnapshotRepository,
        // M11a R2d Item 3 (ADR 0032 §D12 + amended ADR 0014 phase 1).
        // PAPER branch of phase 2-3 reads from `paper_account_state` via
        // `PaperReconciliationAdapter` instead of the live exchange. The
        // existing live `ReconciliationService.forceTick` already env-gates
        // to a no-op under PAPER; the additional paper-adapter call here
        // drives the in-memory-vs-persisted diff into the boot pipeline so
        // a crash-and-restart with diverged state halts the engine BEFORE
        // phase 9 opens the orchestrator. PaperAccountStateService's own
        // `OnApplicationBootstrap` hook hydrates the in-memory store from
        // `paper_account_state` first; this adapter call then reconciles
        // that hydration against the persisted projection.
        private readonly appConfig: AppConfigService,
        private readonly paperReconciliation: PaperReconciliationAdapter,
    ) {}

    // NestJS lifecycle entry point. Fires after every module's `onModuleInit`
    // completes — i.e. after every provider in the dep graph has been
    // constructed (phase 0 of ADR §1). We catch errors at this top boundary
    // because an unhandled rejection in `OnApplicationBootstrap` crashes the
    // app, and we want the operator to see the structured log line first.
    async onApplicationBootstrap(): Promise<void> {
        try {
            await this.boot(Date.now());
        } catch (cause) {
            this.logger.error(`boot pipeline FAILED — orchestrator stays closed: ${this.describe(cause)}`);
        }
    }

    // Public for tests + M7 backtest replay (ADR §8). The `nowMs` parameter
    // pins the clock for every downstream call — phase 7 boot-snapshot, phase
    // 8 scheduler kickoff, phase 4a exposure rebuild all read it.
    async boot(nowMs: number): Promise<void> {
        if (this.booted) {
            this.logger.warn('boot() called twice — second call is a no-op');

            return;
        }

        this.logger.warn('engine boot pipeline START');

        // Phase 0 has implicitly completed (NestJS DI). Phases 1–9 below.
        // Each is a discrete public method so tests can drive them in
        // isolation without re-running the whole pipeline.
        const phase1 = await this.phase1LoadDurableState();
        await this.phase2And3DriftSweep(nowMs);
        const positions = await this.phase4RebuildCaches(nowMs);
        this.phase5RebuildRetainer(positions);
        // Phase 6 is conceptual — market-data subscriptions activate as part
        // of the market-data module's own startup; the contract guarantee is
        // that phase 4c (monitor re-arm) completes before any `price.update`
        // can fire. NestJS lifecycle ordering of OnApplicationBootstrap
        // (this service) vs MarketDataService streaming start is the
        // structural enforcement; documented for the reviewer rule.
        await this.phase7BootSnapshot(nowMs, phase1.latestSnapshotBalance);
        // Phase 8 is the scheduler kickoff — `@Interval`/`@Cron` decorators on
        // ReconciliationService / PositionInstrumentor / AccountSnapshotWriter
        // are already registered by Nest's ScheduleModule once the providers
        // exist; nothing to do here beyond the implicit "they will run."
        this.phase9OpenOrchestrator();

        this.booted = true;
        this.logger.warn('engine boot pipeline COMPLETE — orchestrator open');
    }

    // ─── phase 1 ───────────────────────────────────────────────────────────

    // Reads the durable state needed by later phases. ADR §2: "no state
    // transitions happen yet." Returns the latest pre-crash account snapshot
    // balance for the phase-7 equity-drift comparison.
    async phase1LoadDurableState(): Promise<{ latestSnapshotBalance: MoneyValue | null }> {
        this.logger.log('phase 1: loading durable state');

        const latestSnapshot = await this.accountSnapshots.findLatest();

        return { latestSnapshotBalance: latestSnapshot?.balance ?? null };
    }

    // ─── phases 2–3 ────────────────────────────────────────────────────────

    // Phases 2 (pull exchange truth) and 3 (apply drift policy) are bundled
    // into a single `ReconciliationService.forceTick(nowMs)` call — that
    // method already does exactly: fetchPositions + fetchOpenOrders + diff
    // against `findOpen` + per-drift-case handlers (ADR 0010 §1a–§1f).
    // `forceTick` bypasses the `RECONCILIATION_MIN_INTERVAL_MS` lower bound
    // so the boot path always gets a fresh sweep.
    //
    // ADR §7 reviewer rule: "phase 3 MUST NOT call exchange.createOrder."
    // The recon sweep's case-(b) precise handler routes through
    // `riskGate.reconcileClose(positionId)` — which decrements
    // `open_exposure` but does NOT place an order. Compliant.
    async phase2And3DriftSweep(nowMs: number): Promise<void> {
        this.logger.log('phase 2-3: boot drift sweep (reconciliation forceTick)');

        await this.reconciliation.forceTick(nowMs);

        // M11a R2d Item 3 (ADR 0032 §D12 + amended ADR 0014 phase 1). PAPER
        // boot path: the live `ReconciliationService.forceTick` above is a
        // no-op (env-gated since R2a Item 2). The paper-state reconciliation
        // — in-memory `PaperAccountStateService` vs persisted
        // `paper_account_state` — runs here so any divergence introduced by
        // a crash mid-mutation halts the engine BEFORE the orchestrator opens
        // (phase 9). Under LIVE/TESTNET the adapter's forceTick short-
        // circuits (env-gated).
        if (this.appConfig.exchangeEnv === ExchangeEnvironmentEnum.PAPER) {
            this.logger.log('phase 2-3: PAPER branch — invoking PaperReconciliationAdapter.forceTick');
            await this.paperReconciliation.forceTick(nowMs);
        }
    }

    // ─── phase 4 ───────────────────────────────────────────────────────────

    // Rebuilds in-memory caches from the now-authoritative DB state. Sub-phases
    // §4a (exposure), §4b (cooldown), §4c (monitor arms), §4d (instrumentor
    // seed). §4b's cooldown rebuild is W7's `releaseExpiredCooldownRetentions`
    // when the reconciler ticks; on boot the retainer is empty so a positive
    // refresh isn't needed — phase 5 rebuilds the retainer from positions
    // (which is what ADR §5 actually prescribes).
    //
    // Returns the loaded position list so phase 5 can reuse it without a
    // second DB roundtrip.
    async phase4RebuildCaches(nowMs: number): Promise<readonly PositionEntity[]> {
        this.logger.log('phase 4: rebuilding in-memory caches');

        const positions = await this.positions.findOpen();
        const nonClosed = positions.filter((p) => p.state !== PositionStateEnum.CLOSED);

        await this.phase4aRebuildOpenExposure(nonClosed, nowMs);
        this.phase4cRearmLocalMonitor(nonClosed);
        this.phase4dSeedInstrumentor(nonClosed);

        return nonClosed;
    }

    // §4a: `open_exposure := SUM(qty * entry_price)` over non-closed positions,
    // excluding `MANUAL_ADOPTED_UNMANAGED` rows (foreign adopted, no slot impact
    // until operator-ack — ADR 0010 §1a, ADR 0014 §4a revised).
    //
    // M6 R1.2.2 (ADR 0014 §4a revised): exclusion key is now `state`, not
    // `correlationMode`. The prior `correlationMode === null` exclusion was too
    // broad — once an operator acks a MANUAL_ADOPTED_UNMANAGED position into
    // OPEN (R1.2.2 also wires the ack to assign correlationMode=CORRELATED),
    // that position MUST contribute to exposure. State-keyed exclusion ensures
    // post-ack positions are counted; pre-ack ones are not.
    //
    // ADR 0014 §4a amended: two corrections.
    //   (1) Residual formula `qty * entry_price` — NOT `entry_notional`, which is
    //       immutable after ADDs and not reduced on partial reduces, so it
    //       overstates exposure for any post-ADD/post-reduce row. This matches
    //       the decrement in `RiskGateService.reconcileClose`.
    //   (2) Exclude `qty <= 0` rows. A flat row contributes zero real exposure;
    //       summing its notional is exactly what produced the `1508.35` post-deploy
    //       artefact. Explicit qty guard for defence-in-depth even though the
    //       residual formula already zeroes a flat row.
    async phase4aRebuildOpenExposure(positions: readonly PositionEntity[], nowMs: number): Promise<void> {
        let total = new Money(0);

        for (const position of positions) {
            if (position.state === PositionStateEnum.MANUAL_ADOPTED_UNMANAGED) {
                continue; // foreign adopted, awaiting operator ack — no slot impact
            }

            if (position.qty.lessThanOrEqualTo(0)) {
                continue; // flat lifecycle residue — no live exposure to rebuild
            }

            total = total.plus(position.qty.times(position.entryPrice));
        }

        await this.riskGate.setOpenExposureFromBoot(total, nowMs);
        this.logger.log(
            `phase 4a: open_exposure rebuilt = ${total.toFixed()} (residual qty*entry_price from ${positions.length} non-closed rows, ` +
                `MANUAL_ADOPTED_UNMANAGED + qty<=0 excluded)`,
        );
    }

    // §4c: re-arm `LocalProtectiveMonitor` for every position whose protective
    // type is LOCAL_FALLBACK. After phase 2-3, the recon sweep has already
    // flipped any EXCHANGE_SIDE row whose SL/TP went missing on the exchange
    // to LOCAL_FALLBACK (case-e handler in W4a, ADR 0010 §1e). So this loop
    // catches BOTH pre-crash LOCAL_FALLBACK rows AND post-recon-drift flips.
    //
    // Side / SL / TP must be on the row at this point. ADR 0011 §7 added
    // `stop_loss_price` and `take_profit_price` columns precisely for boot
    // re-arm. A null SL/TP on a LOCAL_FALLBACK row is degraded protection;
    // arm anyway — the monitor handles nulls gracefully (ADR 0011 §1) and
    // case-e retry on the next recon tick may re-attach exchange-side.
    phase4cRearmLocalMonitor(positions: readonly PositionEntity[]): void {
        let armed = 0;

        for (const position of positions) {
            // Skip terminal-ish states. CLOSING is included because a partial-
            // reduce mid-flight still needs the monitor for the remainder
            // until the close transition fires.
            if (position.state === PositionStateEnum.RECONCILING || position.state === PositionStateEnum.MANUAL_ADOPTED_UNMANAGED) {
                continue;
            }

            // Skip flat lifecycle residue. A qty=0 position has nothing to protect; arming it
            // creates a dead armed entry that can fire a spurious SL/TP breach against zero
            // quantity.
            if (position.qty.lessThanOrEqualTo(0)) {
                continue;
            }

            if (position.protectiveOrderType !== ProtectiveOrderTypeEnum.LOCAL_FALLBACK) {
                continue; // EXCHANGE_SIDE is alive — monitor stays disarmed
            }

            this.localProtectiveMonitor.arm({
                positionId: position.id,
                symbol: position.symbol,
                side: position.side,
                stopLossPrice: position.stopLossPrice ?? null,
                takeProfitPrice: position.takeProfitPrice ?? null,
            });
            armed++;
        }

        this.logger.log(`phase 4c: re-armed LocalProtectiveMonitor for ${armed} LOCAL_FALLBACK positions`);
    }

    // §4d: seed the instrumentor's in-memory accumulator from the persisted
    // MAE/MFE/etc. columns. ADR 0013 §5 reviewer rule: "MUST seed from
    // positions.mae_pct etc. on bootstrap, not from defaults. Re-seeding a
    // halfway-trade with defaults would forget prior MAE/MFE."
    //
    // The instrumentor's `onPositionOpened` reads exactly those columns off
    // the row and sets the accumulator's mutable fields to them, so this loop
    // is the canonical seed path.
    phase4dSeedInstrumentor(positions: readonly PositionEntity[]): void {
        let seeded = 0;

        for (const position of positions) {
            if (position.state === PositionStateEnum.RECONCILING || position.state === PositionStateEnum.MANUAL_ADOPTED_UNMANAGED) {
                continue; // drift state not instrumented (ADR 0013 §2)
            }

            this.instrumentor.onPositionOpened(position);
            seeded++;
        }

        this.logger.log(`phase 4d: seeded PositionInstrumentor for ${seeded} positions`);
    }

    // ─── phase 5 ───────────────────────────────────────────────────────────

    // ADR 0011 §5 "Cleanup invariant" — rebuild retainer entries from the
    // current position rows. Each state maps to a specific retain reason.
    // The retainer is empty pre-call (in-memory at boot); the post-call set
    // is the union of every non-closed position's symbol + its state-matched
    // reason. Cooldowns are NOT seeded here — ADR §5 prescribes that, but
    // the engine's cooldown is duration-derivative (W4a / W2 design), not a
    // separate persisted ledger. The next reconciliation tick's
    // `releaseExpiredCooldownRetentions` sweep handles cleanup if any
    // stale COOLDOWN_ACTIVE entry sneaks in via a transition.
    phase5RebuildRetainer(positions: readonly PositionEntity[]): void {
        let retained = 0;

        for (const position of positions) {
            const reason = this.retainReasonForState(position.state);

            if (reason === null) {
                continue;
            }

            this.retainer.retain(position.symbol, reason);
            retained++;
        }

        this.logger.log(`phase 5: SubscriptionRetainer rebuilt with ${retained} entries`);
    }

    private retainReasonForState(state: PositionStateEnum): RetainReasonEnum | null {
        if (state === PositionStateEnum.PENDING_OPEN || state === PositionStateEnum.OPEN || state === PositionStateEnum.CLOSING) {
            return RetainReasonEnum.OPEN_POSITION;
        }

        if (state === PositionStateEnum.RECONCILING) {
            return RetainReasonEnum.PENDING_RECONCILE;
        }

        if (state === PositionStateEnum.MANUAL_ADOPTED_UNMANAGED) {
            return RetainReasonEnum.FOREIGN_ADOPTED;
        }

        return null; // CLOSED — no retention
    }

    // ─── phase 7 ───────────────────────────────────────────────────────────

    // ADR 0012 §6: "On boot: one snapshot is written immediately after the
    // boot-time reconciliation pass completes." Same-minute skip is bypassed
    // by the 'boot' trigger so a scheduler tick aligning with phase 7 doesn't
    // double-write.
    //
    // Equity-drift alert (ADR §6 final paragraph + W7 carry-forward #2):
    // compare the post-boot snapshot's balance to the latest pre-crash
    // snapshot. Outside-tolerance delta raises a warn — operator may want to
    // investigate external transfers / unaccounted fills.
    async phase7BootSnapshot(nowMs: number, latestPreCrashBalance: MoneyValue | null): Promise<void> {
        const row = await this.snapshotWriter.writeNow(nowMs, 'boot');

        if (row === null) {
            this.logger.warn('phase 7: boot snapshot write failed (see snapshot-writer error log)');

            return;
        }

        this.logger.log(`phase 7: boot snapshot written — balance=${row.balance.toFixed()} equity=${row.equity.toFixed()}`);

        if (latestPreCrashBalance === null) {
            return; // first-ever boot, no prior snapshot to compare
        }

        const delta = row.balance.minus(latestPreCrashBalance).abs();

        if (delta.greaterThan(ACCOUNT_SNAPSHOT_DRIFT_TOLERANCE_USDT)) {
            this.logger.error(
                `phase 7: EQUITY DRIFT detected — pre-crash balance=${latestPreCrashBalance.toFixed()} ` +
                    `boot balance=${row.balance.toFixed()} delta=${delta.toFixed()} > tolerance=${ACCOUNT_SNAPSHOT_DRIFT_TOLERANCE_USDT.toFixed()} — ` +
                    `operator should investigate (external transfers / unaccounted fills)`,
            );
        }
    }

    // ─── phase 9 ───────────────────────────────────────────────────────────

    phase9OpenOrchestrator(): void {
        this.riskGate.markRecoveryComplete();
        this.logger.log('phase 9: orchestrator OPEN');
    }

    // ─── helpers ───────────────────────────────────────────────────────────

    private describe(cause: unknown): string {
        if (cause instanceof Error) {
            return `${cause.name}: ${cause.message}`;
        }

        return String(cause);
    }
}
