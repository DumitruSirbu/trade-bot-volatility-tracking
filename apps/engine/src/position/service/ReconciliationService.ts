import {
    CoinTierEnum,
    CorrelationModeEnum,
    DriftCaseEnum,
    ExchangeEnvironmentEnum,
    ExitReasonEnum,
    FlowTypeEnum,
    IAccountStateSource,
    IFunding,
    IOrder,
    IPosition,
    IPositionAdoptedEvent,
    IPositionAdoptionVanishedEvent,
    IReconciliationDriftDetectedEvent,
    IReconciliationResolvedEvent,
    OrderIntentActionEnum,
    PositionSideEnum,
    PositionSlotEnum,
    PositionStateEnum,
    ProtectiveOrderTypeEnum,
    QtyAdjustmentReasonEnum,
    ReconciliationOutcomeEnum,
    RetainReasonEnum,
    RiskOutcomeEnum,
    StopTypeEnum,
} from '@bot/shared';
import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';

import { ORDER_INTENT_APPROVED_EVENT, ORDER_INTENT_EXPIRED_EVENT, ORDER_INTENT_UNKNOWN_EVENT } from '../../common/const';
import { IOrderIntentUnknownEvent } from '../../common/interface';
import { HaltFlagService } from '../../common/service/HaltFlagService';
import { Money, MoneyValue, formatMoney, parseMoney } from '../../common/utils/money';
import { AppConfigService } from '../../config/service';
import {
    ORDER_INTENT_EXPIRED_REASON_DRY_RUN,
    ORDER_INTENT_EXPIRED_REASON_HALTED,
    PROTECTIVE_CLIENT_ORDER_ID_SL_SUFFIX,
    PROTECTIVE_CLIENT_ORDER_ID_TP_SUFFIX,
    RECONCILIATION_FLATTEN_EVENT_ID_PREFIX,
} from '../../execution/const';
import { LocalProtectiveMonitor } from '../../execution/service/LocalProtectiveMonitor';
import { SharedCloseCoordinator } from '../../execution/service/SharedCloseCoordinator';
import { ACCOUNT_STATE_SOURCE } from '../../exchange/interface';
import { CcxtExecutionClient } from '../../exchange/service/CcxtExecutionClient';
import { SubscriptionRetainer } from '../../market-data/service/SubscriptionRetainer';
import { COOLDOWN_AFTER_LOSS_MS } from '../../risk/const';
import { IOrderIntent, IOrderIntentApprovedEvent, IRiskGateContext } from '../../risk/interface';
import { RiskGateService } from '../../risk/service';
import { StrategyVersionRepository } from '../../strategy/repository/StrategyVersionRepository';
import {
    DEFAULT_FOREIGN_POSITION_POLICY,
    ForeignPositionPolicy,
    MANUAL_ADOPTED_STRATEGY_NAME,
    MANUAL_ADOPTED_STRATEGY_VERSION,
    POSITION_ADOPTED_EVENT,
    POSITION_ADOPTION_VANISHED_EVENT,
    RECONCILIATION_DRIFT_DETECTED_EVENT,
    RECONCILIATION_MIN_INTERVAL_MS,
    RECONCILIATION_QTY_TOLERANCE,
    RECONCILIATION_RESOLVED_EVENT,
    RECONCILIATION_TICK_MS,
    TERMINAL_ORDER_STATUSES,
    UNKNOWN_INTENT_TTL_MS,
} from '../const';
import { PositionEntity } from '../entity';
import { PositionRepository } from '../repository/PositionRepository';
import { TransactionRepository } from '../repository/TransactionRepository';
import { AccountSnapshotWriter } from './AccountSnapshotWriter';
import { PositionInstrumentor } from './PositionInstrumentor';
import { PositionService } from './PositionService';

// R1.3.3 mechanical move: const/type declarations relocated to
// `position/const/reconciliationConsts.ts` and `reconciliationEventConsts.ts`.
// Re-exports preserved here so existing test imports against
// `..../service/ReconciliationService` keep compiling. The canonical
// definition sites are the const files; these lines are the migration shim.
export {
    DEFAULT_FOREIGN_POSITION_POLICY,
    ForeignPositionPolicy,
    POSITION_ADOPTED_EVENT,
    POSITION_ADOPTION_VANISHED_EVENT,
    RECONCILIATION_DRIFT_DETECTED_EVENT,
    RECONCILIATION_MIN_INTERVAL_MS,
    RECONCILIATION_RESOLVED_EVENT,
    RECONCILIATION_TICK_MS,
    UNKNOWN_INTENT_TTL_MS,
} from '../const';

// Per-tick observability counter. Engine-internal; not emitted as an event yet.
// Surfaced via the return value of `tick()` / `forceTick()` so tests + the W8 boot
// path can assert "this many of each case were classified."
export interface IReconciliationPass {
    readonly tickAtMs: number;
    readonly driftsByCase: Readonly<Record<DriftCaseEnum, number>>;
    readonly cooldownReleases: number;
    readonly fundingRowsWritten: number;
    readonly skippedTransitioning: number;
    readonly errors: number;
}

// ReconciliationService — periodic + on-restart reconciliation of DB positions vs
// exchange truth (ADR 0010). W4a ships:
//
//   - The 30s periodic tick (`@Interval(RECONCILIATION_TICK_MS)`) and a
//     `forceTick()` boot/test entry point.
//   - Classification of every (symbol, side) pair into a `DriftCaseEnum` value
//     per ADR 0010 §1 + §5.
//   - Full handlers for case (a) `EXCHANGE_NOT_IN_DB` (adopt-only branch) and
//     case (e) `PROTECTIVE_ORDER_DRIFT` (flip to local fallback, re-arm monitor).
//   - Log-only / event-only handling for cases (b), (c), (d) — mutation primitives
//     (`reconcileClose`, `adjustQty`, `recordExposureDrift`) land in W4b.
//   - Case (f) `UNKNOWN_INTENT_OUTCOME`: re-query by clientOrderId, emit terminal
//     or TTL-backstop outcome. Reservation release happens implicitly via the
//     existing M4 `expireStaleReservations(nowMs)` TTL sweep called from the same
//     tick (ADR 0010 §4 + §1f revised — TTL sweep is the authoritative path).
//   - Cooldown retention sweep: `releaseExpiredCooldownRetentions(nowMs)` consults
//     `PositionRepository.findLastClosedBySymbol(symbol)` + `COOLDOWN_AFTER_LOSS_MS`
//     locally (no new gate API per ADR 0010 §7) and releases the retainer reason
//     when the window has elapsed.
//
// ADR 0010 §6 reviewer rules respected:
//   - This is the ONLY caller of `exchange.fetchPositions()` / `fetchOpenOrders()`.
//   - All position-state transitions go through `PositionService.transition`.
//   - No direct mutation of `risk_state.open_exposure`; W4a does not call any gate
//     mutation API (W4b adds `reconcileClose` for that path).
//   - Deterministic clock — `nowMs` is plumbed through every method, never read
//     from `Date.now()` inside the classifier. The `@Interval` callback is the
//     ONE exception: that scheduler tick reads `Date.now()` as the boundary
//     timestamp, then injects it downward (same pattern UniverseService uses).
//
// Concurrency: the `@Interval` callback can in theory overlap with a `forceTick`
// invocation. The `running` guard ensures at most one tick is in flight; an
// overlapping call returns the previous pass's summary so the caller never sees a
// concurrent-write window.
@Injectable()
export class ReconciliationService {
    private readonly logger = new Logger(ReconciliationService.name);

    private running = false;
    private lastTickAtMs = 0;
    private lastPass: IReconciliationPass | null = null;
    private foreignPolicy: ForeignPositionPolicy = DEFAULT_FOREIGN_POSITION_POLICY;
    // M11a R2a Item 2 (BLOCKER B2 + HIGH H3). One-shot INFO log so the
    // skip-in-PAPER message lands once per process, not every 30s.
    private paperSkipLogged = false;

    // M6 R2.1.4. Per-process dedup for case-(b) MANUAL_ADOPTED_UNMANAGED-vanished
    // alerts. Each adopted position that vanishes from the exchange emits
    // `POSITION_ADOPTION_VANISHED_EVENT` exactly once per process lifetime;
    // subsequent ticks skip the alert (the row stays put per ADR-0010 §1b
    // revised — the bot can't auto-transition a MANUAL_ADOPTED_UNMANAGED row).
    // Restart drops the set, which is the desired behaviour: operators see a
    // fresh alert per process so a row that's been unresolved across multiple
    // restarts surfaces again (acceptable per the dispatch's option (c)).
    // No schema change, no shared-contract change.
    private readonly adoptionVanishedAlerted = new Set<number>();

    constructor(
        // M11a R2a BLOCKER B1 (ADR 0032 §3 D14). All account-state reads are
        // bound to the shared `IAccountStateSource` port so PAPER mode
        // reconciles against `PaperAccountStateSource` and the live exchange
        // is never touched. Case-(e) PROTECTIVE_ORDER_DRIFT now consumes the
        // shared `IOrder` DTO (which carries `reduceOnly` since the shared
        // pre-staged wave landed); the previous `EXCHANGE_CLIENT` injection
        // is removed.
        //
        // The `EXCHANGE_CLIENT` rebind also closes the latent LIVE/TESTNET
        // bug where the D14 capability guard rejected the direct
        // `fetchOpenOrders` call (no active capability frame) and case-(e)
        // silently no-op'd.
        //
        // Case-(f) UNKNOWN_INTENT_OUTCOME still resolves an order by
        // clientOrderId through `CcxtExecutionClient` (the M11a R2a-extracted
        // order-command surface). PAPER mode never reaches this path: the
        // PAPER env-gate in `runTickNow` short-circuits the tick before any
        // unknown-intent state can be processed (Item 2). R2c migrates the
        // call to the shared `IExecutionClient` port once the broader M5
        // execution migration lands.
        @Inject(ACCOUNT_STATE_SOURCE) private readonly accountState: IAccountStateSource,
        private readonly ccxtExecutionClient: CcxtExecutionClient,
        // M11a R2a BLOCKER B2 + HIGH H3 (ADR 0032 §3). Env-gates the entire
        // periodic reconciliation tick under PAPER. R2d wires
        // `PaperReconciliationAdapter` against the simulator's projected
        // state; until then PAPER reconciliation is a no-op (logged once).
        private readonly appConfig: AppConfigService,
        private readonly positions: PositionRepository,
        private readonly transactions: TransactionRepository,
        private readonly positionService: PositionService,
        @Inject(forwardRef(() => RiskGateService))
        private readonly riskGate: RiskGateService,
        @Inject(forwardRef(() => LocalProtectiveMonitor))
        private readonly localProtectiveMonitor: LocalProtectiveMonitor,
        private readonly retainer: SubscriptionRetainer,
        private readonly strategyVersions: StrategyVersionRepository,
        private readonly haltFlag: HaltFlagService,
        // M6 W7 wiring (resolves W6 carry-forward #2 + ADR 0012 §6 drift-forced
        // snapshot trigger). Instrumentor receives the freshest liquidation price
        // per tick; snapshot writer is poked at end-of-tick when any drift case
        // counter is non-zero.
        private readonly instrumentor: PositionInstrumentor,
        private readonly snapshotWriter: AccountSnapshotWriter,
        private readonly events: EventEmitter2,
        // M33 Fix 1b (ADR 0011 §9) — the shared close-in-flight registry. The flatten
        // producer acquires the position's slot before emitting a CLOSE so a concurrent
        // time-stop or SL/TP close on the same row emits exactly one close. Lives in
        // ExecutionModule (forwardRef-imported here, same seam as LocalProtectiveMonitor).
        @Inject(forwardRef(() => SharedCloseCoordinator))
        private readonly closeCoordinator: SharedCloseCoordinator,
    ) {}

    // Operator / boot-pipeline policy setter (ADR 0010 §1a). Live should call this
    // with 'flatten' before the first tick; dev/test keep the adopt_unmanaged default.
    setForeignPositionPolicy(policy: ForeignPositionPolicy): void {
        this.foreignPolicy = policy;
        this.logger.warn(`foreign-position policy set to '${policy}'`);
    }

    getForeignPositionPolicy(): ForeignPositionPolicy {
        return this.foreignPolicy;
    }

    // M6 R2.1.3 (ADR-0010 §1f step 1). On intent-timeout / unknown-result, the
    // executor emits `ORDER_INTENT_UNKNOWN_EVENT`. Without this listener, no
    // production code path transitions the row to `RECONCILING`, so the
    // case-(f) handler in `runPass` is structurally unreachable from live.
    // The listener moves the row to RECONCILING; the periodic tick then drives
    // the `fetchOrderByClientId` path → INTENT_TERMINAL or UNRESOLVED_TTL.
    //
    // Branches:
    //   - `positionId` null → OPEN/ADD escalation (no row yet) or missing-position
    //     case. Nothing to transition; the reservation TTL sweep handles cleanup
    //     (ADR-0010 §4). Log + return.
    //   - row already in a terminal/reconciling state → idempotent skip (the
    //     transition graph would otherwise throw `IllegalStateTransitionException`
    //     and the global filter would log a misleading error).
    //   - otherwise → transition to RECONCILING with eventClass='intent.unknown'.
    //     The transition is atomic per ADR-0009 §6.1; the close path remains the
    //     gate-only authority (this only flips state).
    @OnEvent(ORDER_INTENT_UNKNOWN_EVENT)
    async onOrderIntentUnknown(event: IOrderIntentUnknownEvent): Promise<void> {
        if (event.positionId === null || event.positionId === undefined) {
            // M6 R3.1.2 (doc-only). Null-positionId payloads come from the
            // executor's OPEN/ADD `RECONCILE_REQUIRED` branch (no row yet) and
            // the reduce-family `missing_position` branch (row already gone).
            // Neither has a row-state to transition; the reservation TTL sweep
            // releases the orphan exposure and the next reconciliation tick
            // adopts any silently-filled exchange position via case-(a)
            // `EXCHANGE_NOT_IN_DB`. This branch is the contract for those
            // recovery paths — intentionally a row-state no-op.
            this.logger.debug(
                `order.intent.unknown eventId=${event.eventId} carries no positionId (reason=${event.reason ?? 'n/a'}) - reservation TTL handles cleanup`,
            );

            return;
        }

        const position = await this.positions.findById(event.positionId);

        if (position === null) {
            this.logger.warn(`order.intent.unknown positionId=${event.positionId} eventId=${event.eventId} - row not found, skipping transition`);

            return;
        }

        // Idempotent: skip if the row is already in a state where the case-(f)
        // tick handler can pick it up, or already past the recovery window.
        //
        // M6 R3.2.1: MANUAL_ADOPTED_UNMANAGED added to the skip set. A race
        // producing an unknown-intent event for an already-adopted row (rare
        // — an operator hand-traded the symbol mid-flight) would otherwise
        // throw IllegalStateTransitionException (the §3 graph has no arrow
        // MANUAL_ADOPTED_UNMANAGED → RECONCILING). The skip is safe: an
        // adopted row is operator-owned, not bot-tracked, so the bot has no
        // standing to drive it into reconciliation.
        if (
            position.state === PositionStateEnum.RECONCILING ||
            position.state === PositionStateEnum.CLOSED ||
            position.state === PositionStateEnum.CLOSING ||
            position.state === PositionStateEnum.MANUAL_ADOPTED_UNMANAGED
        ) {
            this.logger.debug(
                `order.intent.unknown positionId=${event.positionId} eventId=${event.eventId} state=${position.state} - skipping transition (idempotent)`,
            );

            return;
        }

        try {
            await this.positionService.transition(position.id, PositionStateEnum.RECONCILING, {
                nowMs: Date.now(),
                eventClass: 'intent.unknown',
            });

            this.logger.warn(
                `order.intent.unknown positionId=${event.positionId} eventId=${event.eventId} reason=${event.reason ?? 'n/a'} - transitioned to RECONCILING; next tick resolves`,
            );
        } catch (cause) {
            // The transition graph may reject from states the case-(f) handler
            // doesn't expect (PENDING_OPEN → RECONCILING is legal per ADR-0009
            // §3, so this is rare). Log + swallow so the reservation TTL stays
            // the structural backstop.
            this.logger.error(`order.intent.unknown transition failed positionId=${event.positionId} eventId=${event.eventId}: ${this.describe(cause)}`);
        }
    }

    // M33 R1-Fix-A. A flatten that emits its CLOSE intent and then loses the executor race to a
    // halt / dry_run boundary surfaces as `ORDER_INTENT_EXPIRED_EVENT{reason:'halted'|'dry_run'}`.
    // The enforcer's parser (`time-stop-enforcer-`) and the monitor's parser (`local-monitor-breach-`)
    // do NOT match the flatten eventId, so without this listener the shared close slot stays held
    // forever and the foreign position can never be re-flattened in-run. We release ONLY our own
    // flatten slot (matched on the `reconciliation-flatten-` eventId prefix); the next reconciliation
    // tick re-attempts the flatten once halt clears. We do NOT release on ORDER_INTENT_UNKNOWN —
    // reconciliation owns that row's lifecycle through `onOrderIntentUnknown` instead.
    @OnEvent(ORDER_INTENT_EXPIRED_EVENT)
    onOrderIntentExpired(event: { eventId: string; reservationId: string | null; reason?: string }): void {
        if (event.reason !== ORDER_INTENT_EXPIRED_REASON_HALTED && event.reason !== ORDER_INTENT_EXPIRED_REASON_DRY_RUN) {
            return;
        }

        const positionId = this.extractPositionIdFromFlattenEventId(event.eventId);

        if (positionId === null) {
            return;
        }

        if (!this.closeCoordinator.isHeld(positionId)) {
            return;
        }

        this.closeCoordinator.release(positionId);
        this.logger.warn(
            `case-a flatten intent for positionId=${positionId} expired (reason=${event.reason}) — released close slot; ` +
                `next reconciliation tick will re-attempt the flatten`,
        );
    }

    // Parses a positionId out of the flatten eventId scheme `reconciliation-flatten-${positionId}-${nowMs}`.
    // Splits from the RIGHT (the `nowMs` suffix is the trailing dash-segment) and returns null on any
    // mismatch so an enforcer / monitor expiry never releases a reconciliation-owned slot.
    private extractPositionIdFromFlattenEventId(eventId: string): number | null {
        const prefix = RECONCILIATION_FLATTEN_EVENT_ID_PREFIX;

        if (!eventId.startsWith(prefix)) {
            return null;
        }

        const rest = eventId.slice(prefix.length);
        const dashIndex = rest.lastIndexOf('-');

        if (dashIndex <= 0) {
            return null;
        }

        const positionId = Number.parseInt(rest.slice(0, dashIndex), 10);

        if (!Number.isInteger(positionId) || positionId <= 0) {
            return null;
        }

        return positionId;
    }

    // Periodic 30s tick — the production cadence. Honors the `running` guard so
    // overlapping schedules don't double-fire. Failures are swallowed at the boundary
    // (logged, next tick retries) — a reconciliation outage MUST NOT cascade to the
    // main strategy loop (ADR 0010 §6 implicit safety: reconciliation is a sweep,
    // never a critical-path dependency).
    @Interval(RECONCILIATION_TICK_MS)
    async scheduledTick(): Promise<void> {
        // M6 W8.5 — boot-race guard. The @Interval scheduler starts running as
        // soon as ScheduleModule initializes (before OnApplicationBootstrap),
        // so a scheduled tick could fire mid-boot and race with phase 3's
        // `forceTick` or phase 4a's exposure rebuild. The recovery flag (set
        // at phase 9) is the canonical "boot is done" signal. `forceTick`
        // bypasses this guard so the boot pipeline still drives the
        // reconciliation sweep at phase 3.
        if (!this.riskGate.isRecoveryReady()) {
            this.logger.debug('scheduled reconciliation tick skipped: boot recovery not yet complete');

            return;
        }

        try {
            await this.tick(Date.now());
        } catch (cause) {
            this.logger.error(`scheduled reconciliation tick failed: ${this.describe(cause)}`);
        }
    }

    // M6 R1.3.2 — flag-arg removed. The previous public surface was
    // `tick(nowMs, bypassMinInterval = false)`, a Clean-Code F-rule violation
    // (boolean argument splits behaviour). The two callers are now two public
    // methods with distinct names that each call `runTickNow` privately:
    //
    //   - `tick(nowMs)`                — the scheduled-tick path. Honors the
    //                                    RECONCILIATION_MIN_INTERVAL_MS floor.
    //   - `forceTick(nowMs)`           — the boot + test path. Bypasses the floor.
    //
    // Production code MUST NOT call `forceTick` from the main loop (the
    // scheduled tick is the only legitimate driver).
    async tick(nowMs: number): Promise<IReconciliationPass> {
        if (nowMs - this.lastTickAtMs < RECONCILIATION_MIN_INTERVAL_MS) {
            this.logger.debug(`tick skipped: ${nowMs - this.lastTickAtMs}ms since last (< ${RECONCILIATION_MIN_INTERVAL_MS}ms floor)`);

            return this.lastPass ?? this.emptyPass(nowMs);
        }

        return this.runTickNow(nowMs);
    }

    async forceTick(nowMs: number): Promise<IReconciliationPass> {
        return this.runTickNow(nowMs);
    }

    // The single private entry point. The two public entry points differ only in
    // whether they consult the MIN_INTERVAL_MS floor — both end here.
    private async runTickNow(nowMs: number): Promise<IReconciliationPass> {
        // M11a R2a Item 2 (BLOCKER B2 + HIGH H3 — ADR 0032 §3). PAPER mode
        // has no live exchange to reconcile against; running the live
        // reconciliation sweep would touch `fapi.binance.com` and break the
        // "engine-local" property of PAPER. R2d wires
        // `PaperReconciliationAdapter` against the in-memory simulator state
        // + the persisted projection. Until then, the periodic tick AND the
        // boot/test `forceTick` path are no-ops under PAPER.
        if (this.appConfig.exchangeEnv === ExchangeEnvironmentEnum.PAPER) {
            if (!this.paperSkipLogged) {
                this.logger.log('Live-exchange reconciliation skipped in PAPER mode; awaiting R2d PaperReconciliationAdapter');
                this.paperSkipLogged = true;
            }

            return this.emptyPass(nowMs);
        }

        if (this.running) {
            this.logger.debug('tick skipped: previous pass still running');

            return this.lastPass ?? this.emptyPass(nowMs);
        }

        this.running = true;
        try {
            const pass = await this.runPass(nowMs);
            this.lastPass = pass;
            this.lastTickAtMs = nowMs;

            return pass;
        } finally {
            this.running = false;
        }
    }

    private async runPass(nowMs: number): Promise<IReconciliationPass> {
        const counters = this.emptyCounters();
        let errors = 0;
        let skippedTransitioning = 0;

        // §4 step 1: TTL sweep FIRST so stale PENDING reservations EXPIRE before the
        // diff sweep runs (ADR 0010 §4). This is the authoritative reservation release
        // path for case (f) per the revised §1f.
        this.riskGate.expireStaleReservations(nowMs);

        const exchangePositions = await this.fetchExchangePositionsSafe();
        const openOrders = await this.fetchOpenOrdersSafe();
        const dbPositions = await this.loadNonClosedPositions();

        const dbByKey = this.indexBy(dbPositions, this.positionKey);
        const exByKey = this.indexBy([...exchangePositions], this.snapshotKey);

        // M6 W7 wiring (resolves W6 carry-forward #2). Propagate the freshest
        // liquidation price for every (symbol, side) DB row that has a matching
        // exchange snapshot. The instrumentor caches it in memory; `onPriceUpdate`
        // recomputes `min_liquidation_distance_pct` against this value (ADR 0013 §1g).
        this.propagateLiquidationPrices(dbPositions, exByKey);

        // (a) EXCHANGE_NOT_IN_DB — exchange position with no matching DB row.
        for (const snapshot of exchangePositions) {
            const key = this.snapshotKey(snapshot);

            if (dbByKey.has(key)) {
                continue;
            }

            try {
                await this.handleExchangeNotInDb(snapshot, nowMs, counters);
            } catch (cause) {
                errors++;
                this.logger.error(`case-a handler failed for ${snapshot.symbol}/${snapshot.side}: ${this.describe(cause)}`);
            }
        }

        // (b) DB_OPEN_NOT_ON_EXCHANGE — DB row with no matching exchange position.
        // (c) QTY_MISMATCH — same (symbol, side) on both sides, qty differs.
        // (d) SIDE_MISMATCH — same symbol, opposite sides — split-detection below.
        for (const position of dbPositions) {
            if (this.shouldSkipDuringReconciliation(position)) {
                skippedTransitioning++;
                continue;
            }

            const key = this.positionKey(position);
            const match = exByKey.get(key);

            try {
                if (match === undefined) {
                    // No `(symbol, side)` exchange match. Check for a side-flip first
                    // (case d), otherwise plain case (b).
                    const oppositeKey = this.oppositeSideKey(position);

                    if (exByKey.has(oppositeKey)) {
                        this.handleSideMismatch(position, exByKey.get(oppositeKey)!, nowMs, counters);
                        continue;
                    }

                    await this.handleDbOpenNotOnExchange(position, nowMs, counters);
                    continue;
                }

                await this.handleMatchedPair(position, match, nowMs, counters);
            } catch (cause) {
                errors++;
                this.logger.error(`case-b/c/d handler failed for positionId=${position.id}: ${this.describe(cause)}`);
            }
        }

        // (e) PROTECTIVE_ORDER_DRIFT — for every EXCHANGE_SIDE row, verify SL/TP orders
        // are still resting on the exchange. The fix is local-fallback re-arm.
        for (const position of dbPositions) {
            if (position.protectiveOrderType !== ProtectiveOrderTypeEnum.EXCHANGE_SIDE) {
                continue;
            }

            try {
                await this.handleProtectiveOrderDriftIfNeeded(position, openOrders, nowMs, counters);
            } catch (cause) {
                errors++;
                this.logger.error(`case-e handler failed for positionId=${position.id}: ${this.describe(cause)}`);
            }
        }

        // (f) UNKNOWN_INTENT_OUTCOME — recheck `reconciling` rows whose original intent
        // was timed-out. W4a uses `fetchOrderByClientId` on the most recent transaction
        // for the position; W4b/W5+ may track a richer `pending_intents` ledger.
        //
        // M6 R3.1.1 (ADR-0010 §1f step 3): on terminal exchange status, the handler
        // also drives the row OUT of RECONCILING. The exchange-side qty is the
        // authoritative survived-vs-closed signal — plumbed from the snapshot index
        // built at top-of-pass so the handler has it without a second exchange call.
        //
        // Ownership note: if the RECONCILING row has NO exchange match, case-(b)
        // above already owns the close (DB_OPEN_NOT_ON_EXCHANGE → RECONCILED_MISSING
        // via the same finalize path). Case-(f) skips that row to avoid a
        // double-finalize race within a single tick — the row is already CLOSED
        // by the time we'd reach it. Case-(f) is for the surviving-on-exchange
        // path (transition to OPEN) and the closed-on-exchange-with-qty-zero path
        // (rare — exchange returns the symbol with qty=0).
        for (const position of dbPositions) {
            if (position.state !== PositionStateEnum.RECONCILING) {
                continue;
            }

            const exchangeMatch = exByKey.get(this.positionKey(position)) ?? null;

            if (exchangeMatch === null) {
                continue; // owned by case-(b) above
            }

            try {
                await this.handleUnknownIntentOutcome(position, exchangeMatch, nowMs, counters);
            } catch (cause) {
                errors++;
                this.logger.error(`case-f handler failed for positionId=${position.id}: ${this.describe(cause)}`);
            }
        }

        // Funding ingestion (ADR 0012 §2): one `fetchFundingHistory` call per open
        // position's symbol, sinceMs floored at the last-known funding row for the
        // position (or `openedAt` on first poll). Errors per-symbol are swallowed —
        // funding ingestion outage MUST NOT cascade into the main loop. The
        // recordFunding writer is idempotent via the deterministic clientOrderId, so
        // a re-poll inserts zero new rows.
        let fundingRowsWritten = 0;
        for (const position of dbPositions) {
            if (this.shouldSkipFundingIngestion(position)) {
                continue;
            }

            try {
                fundingRowsWritten += await this.ingestFundingForPosition(position, nowMs);
            } catch (cause) {
                errors++;
                this.logger.error(`funding ingestion failed for positionId=${position.id} symbol=${position.symbol}: ${this.describe(cause)}`);
            }
        }

        // Cooldown retention sweep (ADR 0010 §7, ADR 0011 §5 revised).
        const cooldownReleases = await this.releaseExpiredCooldownRetentions(nowMs);

        // M6 W7 (ADR 0012 §6 + plan W7 item 2): force an account_snapshot at
        // end-of-tick whenever any drift case fired so the equity-curve audit
        // trail reflects the corrected state immediately, not 60s later. The
        // writer's same-minute skip is bypassed for `drift_resolved` triggers.
        if (this.hasAnyDrift(counters)) {
            await this.snapshotWriter.writeNow(nowMs, 'drift_resolved');
        }

        return {
            tickAtMs: nowMs,
            driftsByCase: counters,
            cooldownReleases,
            fundingRowsWritten,
            skippedTransitioning,
            errors,
        };
    }

    private hasAnyDrift(counters: Record<DriftCaseEnum, number>): boolean {
        for (const count of Object.values(counters)) {
            if (count > 0) {
                return true;
            }
        }

        return false;
    }

    // M6 W7 (resolves W6 carry-forward #2). Walks the DB position list, looks up
    // each row's matching exchange snapshot by (symbol, side), and forwards
    // `liquidationPrice` (parsed to MoneyValue or null) to the instrumentor's
    // in-memory cache. The instrumentor's `setLiquidationPrice` is a safe no-op
    // for untracked positionIds (closed / never-opened in this process).
    private propagateLiquidationPrices(dbPositions: readonly PositionEntity[], exByKey: Map<string, IPosition>): void {
        for (const position of dbPositions) {
            const snapshot = exByKey.get(this.positionKey(position));

            if (snapshot === undefined) {
                continue;
            }

            const liquidationPrice = this.parseLiquidationPrice(snapshot.liquidationPrice);
            this.instrumentor.setLiquidationPrice(position.id, position.symbol, liquidationPrice);
        }
    }

    private parseLiquidationPrice(raw: string | null): MoneyValue | null {
        if (raw === null) {
            return null;
        }

        try {
            const value = new Money(raw);

            if (value.isNaN() || !value.isFinite()) {
                return null;
            }

            return value;
        } catch {
            return null;
        }
    }

    // ────────── funding ingestion (ADR 0012 §2) ──────────────────────────────────

    // CLOSED rows skip (no live position). MANUAL_ADOPTED_UNMANAGED rows skip until
    // operator ack (their funding is handled by whoever manages them); RECONCILING
    // and CLOSING rows skip to keep mid-flight state coherent. PENDING_OPEN rows
    // shouldn't have settled funding yet but we ingest defensively (a venue funding
    // boundary that fires within the protective-attach window would otherwise be
    // missed).
    private shouldSkipFundingIngestion(position: PositionEntity): boolean {
        return (
            position.state === PositionStateEnum.CLOSED ||
            position.state === PositionStateEnum.CLOSING ||
            position.state === PositionStateEnum.RECONCILING ||
            position.state === PositionStateEnum.MANUAL_ADOPTED_UNMANAGED
        );
    }

    private async ingestFundingForPosition(position: PositionEntity, nowMs: number): Promise<number> {
        const sinceMs = await this.computeFundingSinceMs(position);
        const events = await this.fetchFundingHistorySafe(position.symbol, sinceMs);

        let written = 0;
        for (const event of events) {
            // Defensive boundary: a venue echoing a row at exactly sinceMs (already
            // recorded) is dropped by the unique-constraint downstream, but skipping
            // here avoids the no-op INSERT round-trip.
            if (event.fundingTimeMs <= sinceMs) {
                continue;
            }

            const cashflow = parseMoney(event.amount);
            const markPriceSource = position.exitPrice ?? position.entryPrice;

            await this.positionService.recordFunding({
                positionId: position.id,
                side: position.side,
                symbol: position.symbol,
                cashflow,
                fundingTimeMs: event.fundingTimeMs,
                // Mark price at settlement is informational on the funding row
                // (ADR 0012 §1). We do not have a live mark cached here at W5
                // cadence; the position's entry price is a reasonable placeholder
                // and the row's CHECK constraint requires price > 0.
                markPrice: markPriceSource,
                qty: position.qty,
                exchangeOrderId: event.id,
            });
            written++;
        }

        if (written > 0) {
            this.logger.log(`funding ingestion positionId=${position.id} symbol=${position.symbol} wrote=${written} rows sinceMs=${sinceMs} nowMs=${nowMs}`);
        }

        return written;
    }

    // ADR 0012 §2 sinceMs: the most recent funding row's createdAt + 1ms, or the
    // position's openedAt on first poll. +1ms biases the exclusive lower bound so
    // the same settlement boundary cannot be re-fetched twice in a row.
    private async computeFundingSinceMs(position: PositionEntity): Promise<number> {
        const latest = await this.transactions.findLatestFundingByPosition(position.id);

        if (latest === null) {
            return position.openedAt.getTime();
        }

        return latest.createdAt.getTime() + 1;
    }

    private async fetchFundingHistorySafe(symbol: string, sinceMs: number): Promise<readonly IFunding[]> {
        try {
            return await this.accountState.fetchFundingHistory(symbol, sinceMs);
        } catch (cause) {
            this.logger.error(`fetchFundingHistory:${symbol} since=${sinceMs} failed: ${this.describe(cause)} - skipped this tick`);

            return [];
        }
    }

    // ────────── case handlers ────────────────────────────────────────────────────

    // Case (a) — branches on the runtime foreign-position policy (ADR 0010 §1a).
    //   'adopt_unmanaged' (dev/test default): insert MANUAL_ADOPTED_UNMANAGED row,
    //                                          alert operator, await human ack.
    //   'flatten' (live recommended): adopt first (need a DB row for the executor's
    //                                  reduce-family lookup), then synthesize a CLOSE
    //                                  intent through the risk gate so the position is
    //                                  liquidated. Honors the halt flag (no order on halt).
    //
    // NOTE: pure 'no-adoption flatten' (ADR 0010 §1a alternative wording) would require
    // the executor to handle reduce-family intents against positions that don't yet exist
    // in the DB; today `applyReduceFillToPosition` lookups by (symbol, slot) and would
    // fail. Adopting first + flattening from the adopted row is the pragmatic engineering
    // path. Surfacing the executor gap for a future wave.
    private async handleExchangeNotInDb(snapshot: IPosition, nowMs: number, counters: Record<DriftCaseEnum, number>): Promise<void> {
        counters[DriftCaseEnum.EXCHANGE_NOT_IN_DB]++;

        const side = this.normaliseSide(snapshot.side);

        this.emitDriftDetected({
            positionId: null,
            symbol: snapshot.symbol,
            side,
            driftCase: DriftCaseEnum.EXCHANGE_NOT_IN_DB,
            dbQty: null,
            exchangeQty: snapshot.qty,
            detectedAtMs: nowMs,
        });

        const insertedRow = await this.adoptForeignPosition(snapshot, side, nowMs);

        if (insertedRow === null) {
            return; // sentinel missing — already logged
        }

        if (this.foreignPolicy === 'flatten') {
            await this.flattenAdoptedForeignPosition(insertedRow, snapshot, nowMs);

            return;
        }

        // adopt_unmanaged default — alert + emit ADOPTED_FOREIGN resolved.
        const adoptedEvent: IPositionAdoptedEvent = {
            positionId: insertedRow.id,
            symbol: snapshot.symbol,
            side,
            qty: snapshot.qty,
            entryPrice: snapshot.entryPrice ?? '0',
            detectedAtMs: nowMs,
        };
        this.events.emit(POSITION_ADOPTED_EVENT, adoptedEvent);

        this.emitResolved({
            positionId: insertedRow.id,
            driftCase: DriftCaseEnum.EXCHANGE_NOT_IN_DB,
            outcome: ReconciliationOutcomeEnum.ADOPTED_FOREIGN,
            resolvedAtMs: nowMs,
        });

        this.logger.warn(
            `case-a ADOPTED FOREIGN positionId=${insertedRow.id} symbol=${snapshot.symbol} side=${side} qty=${snapshot.qty} entryPrice=${snapshot.entryPrice ?? 'unknown'} - awaiting operator ack`,
        );
    }

    // Insert a MANUAL_ADOPTED_UNMANAGED row for a foreign exchange position. Returns
    // null if the manual_adopted sentinel strategy_versions row is missing (contract
    // bug — log and skip; W8 boot can re-attempt). The row's positionSlot is set so
    // a follow-up flatten can locate it via (symbol, slot).
    private async adoptForeignPosition(snapshot: IPosition, side: PositionSideEnum, nowMs: number): Promise<PositionEntity | null> {
        const sentinel = await this.strategyVersions.findByNameAndVersion(MANUAL_ADOPTED_STRATEGY_NAME, MANUAL_ADOPTED_STRATEGY_VERSION);

        if (sentinel === null) {
            this.logger.error(
                `case-a adoption blocked: sentinel strategy_versions row name='${MANUAL_ADOPTED_STRATEGY_NAME}' missing - skipping ${snapshot.symbol}/${side}`,
            );

            return null;
        }

        const qty = parseMoney(snapshot.qty);
        const entryPrice = parseMoney(snapshot.entryPrice ?? '0');
        const markPrice = parseMoney(snapshot.markPrice ?? snapshot.entryPrice ?? '0');
        const leverage = parseMoney(snapshot.leverage ?? '1');

        return this.positions.createOpen({
            symbol: snapshot.symbol,
            strategyVersionId: sentinel.id,
            side,
            state: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED,
            leverage,
            entryPrice,
            qty,
            entryNotional: qty.times(markPrice),
            openedAt: new Date(nowMs),
            protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
            positionSlot: PositionSlotEnum.A,
        });
    }

    // Flatten policy branch. Synthesises a CLOSE IOrderIntent against the just-adopted
    // row, routes it through `riskGateService.evaluate` (the only legitimate close
    // API path — same pattern W3 LocalProtectiveMonitor uses), then emits
    // ORDER_INTENT_APPROVED_EVENT so the executor's reduce-family path takes over.
    //
    // Honors the halt flag: if halt is active the flatten is NOT placed; the row
    // stays MANUAL_ADOPTED_UNMANAGED and the next tick retries when halt clears.
    //
    // Outcome: uses RECONCILED_MISSING as a near-fit because shared
    // ReconciliationOutcomeEnum does NOT define a FLATTENED value today. Surfacing
    // the gap; if a downstream alert wants to distinguish "we flattened a foreign
    // position" vs. "we found one already gone" the shared enum needs a FLATTENED entry.
    private async flattenAdoptedForeignPosition(position: PositionEntity, snapshot: IPosition, nowMs: number): Promise<void> {
        if (this.haltFlag.isHalted()) {
            this.logger.warn(`case-a flatten suppressed by halt flag for positionId=${position.id} ${position.symbol} - next tick retries`);

            return;
        }

        // M33 Fix 1b (HIGH L2): acquire the shared close slot before emitting. If a time-stop
        // or SL/TP close already holds it for this row, skip the flatten — exactly one close
        // fires. Release on any abort below (gate-reject); on a successful emit the slot is held
        // until the row reaches CLOSED (released there by the shared registry's CLOSED listener).
        if (!this.closeCoordinator.tryAcquire(position.id)) {
            this.logger.warn(`case-a flatten skipped positionId=${position.id} ${position.symbol} - close already in flight (shared registry)`);

            return;
        }

        // M33 R1-Fix-A: once the slot is held, an unexpected throw from the gate evaluate would
        // leak it forever — the foreign position could never be re-flattened in-run. Wrap the
        // post-acquire body so any throw releases the slot, logs with context, and returns; the
        // next reconciliation tick re-attempts the flatten. The conditional gate-reject release
        // inside the try body remains correct as-is.
        try {
            const markPrice = parseMoney(snapshot.markPrice ?? snapshot.entryPrice ?? '0');
            const intent = this.buildCloseIntent(position, markPrice, nowMs);
            const context = this.buildDeRiskContext(nowMs);
            const decision = await this.riskGate.evaluate(intent, context);

            if (decision.outcome !== RiskOutcomeEnum.APPROVED) {
                this.closeCoordinator.release(position.id);
                this.logger.error(
                    `case-a flatten gate rejected positionId=${position.id} ${position.symbol} reason=${decision.rejectReason ?? 'unknown'} - row remains MANUAL_ADOPTED_UNMANAGED`,
                );

                return;
            }

            const approvedEvent: IOrderIntentApprovedEvent = {
                intent,
                approvedSlot: position.positionSlot ?? PositionSlotEnum.A,
                approvedSizing: intent.sizing,
                clampedExit: intent.proposedExit,
                reservationId: decision.reservationId,
                strategyVersionId: position.strategyVersionId,
            };
            this.events.emit(ORDER_INTENT_APPROVED_EVENT, approvedEvent);

            // M6 R1.1.3 (ADR 0010 §5 revised). FLATTENED outcome now in the shared
            // enum — replaces the prior RECONCILED_MISSING placeholder. M8 analytics
            // distinguishes "bot flattened a foreign position via case-a policy"
            // from "DB row vanished from exchange (case-b reconciled-missing)".
            this.emitResolved({
                positionId: position.id,
                driftCase: DriftCaseEnum.EXCHANGE_NOT_IN_DB,
                outcome: ReconciliationOutcomeEnum.FLATTENED,
                resolvedAtMs: nowMs,
            });

            this.logger.warn(`case-a FLATTEN positionId=${position.id} symbol=${snapshot.symbol} qty=${snapshot.qty} - close intent emitted through gate`);
        } catch (cause) {
            this.closeCoordinator.release(position.id);
            this.logger.error(
                `case-a flatten threw for positionId=${position.id} ${position.symbol}: ${this.describe(cause)} - ` +
                    `released close slot; next tick re-attempts the flatten`,
            );
        }
    }

    // Synthesize a CLOSE IOrderIntent for an adopted foreign position. Side = opposite
    // of position side (close direction). sizing.qty = full position qty. proposedExit
    // uses markPrice as a placeholder for both SL/TP (gate's de-risking path does not
    // read these fields). flowType uses TREND_INITIATION as a permissive default — the
    // gate short-circuits on intentAction=CLOSE without reading it.
    // M6 R1.3.1a — `nowMs` is injected (was `Date.now()`). The plumbed value
    // originates from `runPass` → `flattenAdoptedForeignPosition` → here, so
    // identical inputs produce identical eventIds (deterministic / replay-safe).
    private buildCloseIntent(position: PositionEntity, markPrice: MoneyValue, nowMs: number): IOrderIntent {
        const closeSide = position.side === PositionSideEnum.LONG ? PositionSideEnum.SHORT : PositionSideEnum.LONG;
        const eventId = `${RECONCILIATION_FLATTEN_EVENT_ID_PREFIX}${position.id}-${nowMs}`;
        const sizing = {
            qty: position.qty,
            notional: position.qty.times(markPrice),
            leverage: position.leverage,
            riskPerTradeUsdt: new Money(0),
            effectiveRiskUsdt: new Money(0),
        };

        return {
            intentAction: OrderIntentActionEnum.CLOSE,
            symbol: position.symbol,
            eventId,
            tradeSide: closeSide,
            signalScore: 0,
            correlationMode: position.correlationMode ?? CorrelationModeEnum.IDIOSYNCRATIC,
            coinTier: position.coinTier ?? CoinTierEnum.TIER_2,
            idiosyncrasyScore: 0,
            entryPrice: position.entryPrice,
            midAtTrigger: markPrice,
            maintenanceMarginRate: new Money(0),
            proposedExit: {
                takeProfitPrice: markPrice,
                stopLossPrice: markPrice,
                stopType: StopTypeEnum.ATR,
                timeStopAtMs: 0,
            },
            openPosition: null,
            sizing,
            flowType: FlowTypeEnum.TREND_INITIATION,
            exitReason: ExitReasonEnum.MANUAL,
        };
    }

    private buildDeRiskContext(nowMs: number): IRiskGateContext {
        return {
            nowMs,
            utcDateString: new Date(nowMs).toISOString().slice(0, 10),
            snapshot: {} as IRiskGateContext['snapshot'],
            params: {} as IRiskGateContext['params'],
            strategyVersionId: 0,
            belowUniverseFloor: false,
            limits: {} as IRiskGateContext['limits'],
            riskState: {} as IRiskGateContext['riskState'],
            openPositions: {} as IRiskGateContext['openPositions'],
            instruments: {} as IRiskGateContext['instruments'],
            modelDivergenceDetected: false,
        };
    }

    // Case (b) — W4b precise (ADR 0010 §1b). Position was closed outside the bot;
    // transition state to CLOSED with RECONCILED_MISSING exit reason, then call
    // `RiskGateService.reconcileClose` to release the reservation + decrement
    // open_exposure. exit_price / realized_pnl stay null (not recoverable without
    // account-history; M9 backfills).
    private async handleDbOpenNotOnExchange(position: PositionEntity, nowMs: number, counters: Record<DriftCaseEnum, number>): Promise<void> {
        counters[DriftCaseEnum.DB_OPEN_NOT_ON_EXCHANGE]++;

        this.emitDriftDetected({
            positionId: position.id,
            symbol: position.symbol,
            side: position.side,
            driftCase: DriftCaseEnum.DB_OPEN_NOT_ON_EXCHANGE,
            dbQty: position.qty.toFixed(),
            exchangeQty: null,
            detectedAtMs: nowMs,
        });

        // M6 R1.1.2 (ADR 0010 §1b revised) — source-state routing. Each non-closed
        // source state takes a distinct legal arrow sequence per ADR-0009 §3:
        //   OPEN / CLOSING                  → CLOSING → CLOSED (existing finalize path).
        //   PENDING_OPEN                    → RECONCILING → CLOSED (two-step).
        //   RECONCILING                     → CLOSED (one-step; finalize handles state).
        //   MANUAL_ADOPTED_UNMANAGED        → SKIP + emit IPositionAdoptionVanishedEvent.
        //
        // For RECONCILED_MISSING the exchange-side fills never landed locally, so the
        // transactions aggregate yields realizedPnl=null / exitPrice=null per ADR 0010
        // §1b — finalize handles that case (no closing fills → null PnL). Atomic
        // dual-write per ADR 0009 §6.1 is preserved: every state transition is one
        // UPDATE, finalize bundles close-side fields into the CLOSED transition.
        const sourceState = position.state;

        if (sourceState === PositionStateEnum.MANUAL_ADOPTED_UNMANAGED) {
            // The bot did not place this row — the §3 transition graph from
            // MANUAL_ADOPTED_UNMANAGED → CLOSED is operator-flatten only. Alert
            // for human investigation; do NOT auto-transition.
            //
            // M6 R2.1.4: dedup per-process via `adoptionVanishedAlerted`. Without
            // the gate, every 30s tick re-emits the same event indefinitely (the
            // row never moves), spamming downstream alerting. With the gate,
            // exactly one alert per (process, positionId) — restart replays the
            // alert, which is the intended operator-recovery signal.
            if (this.adoptionVanishedAlerted.has(position.id)) {
                this.logger.debug(`case-b MANUAL_ADOPTED_UNMANAGED vanished positionId=${position.id} - already alerted this process; skipping re-emit`);

                return;
            }

            const vanishedEvent: IPositionAdoptionVanishedEvent = {
                positionId: position.id,
                symbol: position.symbol,
                side: position.side,
                detectedAtMs: nowMs,
            };
            this.events.emit(POSITION_ADOPTION_VANISHED_EVENT, vanishedEvent);
            this.adoptionVanishedAlerted.add(position.id);

            this.logger.error(
                `case-b MANUAL_ADOPTED_UNMANAGED vanished from exchange positionId=${position.id} symbol=${position.symbol} side=${position.side} - alert operator (no auto-transition)`,
            );

            return;
        }

        const eventClass = 'reconciliation.b.reconciled_missing';

        if (sourceState === PositionStateEnum.PENDING_OPEN) {
            // pending_open → reconciling → closed (both legal per ADR-0009 §3).
            await this.positionService.transition(position.id, PositionStateEnum.RECONCILING, { nowMs, eventClass });
        } else if (sourceState === PositionStateEnum.OPEN || sourceState === PositionStateEnum.CLOSING) {
            // open → closing (closing → closed performed by finalize below).
            // From CLOSING, no leading transition is needed; finalize closes directly.
            if (sourceState === PositionStateEnum.OPEN) {
                await this.positionService.transition(position.id, PositionStateEnum.CLOSING, { nowMs, eventClass });
            }
        }
        // sourceState === RECONCILING → no leading transition; finalize closes directly.

        await this.positionService.finalizeRealizedPnl(position.id, ExitReasonEnum.RECONCILED_MISSING, { nowMs, eventClass });

        await this.riskGate.reconcileClose(position.id, nowMs);

        // Disarm any LocalProtectiveMonitor arm on the position — the row is now closed.
        this.localProtectiveMonitor.disarm(position.id);

        this.emitResolved({
            positionId: position.id,
            driftCase: DriftCaseEnum.DB_OPEN_NOT_ON_EXCHANGE,
            outcome: ReconciliationOutcomeEnum.RECONCILED_MISSING,
            resolvedAtMs: nowMs,
        });

        this.logger.warn(
            `case-b RECONCILED_MISSING positionId=${position.id} symbol=${position.symbol} side=${position.side} sourceState=${sourceState} dbQty=${formatMoney(position.qty)} - closed, reservation released`,
        );
    }

    // Case (c) — W4b precise (ADR 0010 §1c). Exchange wins. Sequence:
    //   1. recordExposureDrift on the gate (logs + open_exposure delta + telemetry).
    //   2. adjustQty on PositionService (atomic single UPDATE + position.qty.adjusted event).
    // Order matters: the exposure decrement uses the pre-mutation entryPrice (no risk
    // of a stale row read since both calls receive the same dbQty/exchangeQty deltas).
    private async handleMatchedPair(position: PositionEntity, snapshot: IPosition, nowMs: number, counters: Record<DriftCaseEnum, number>): Promise<void> {
        const exchangeQty = parseMoney(snapshot.qty);
        const delta = exchangeQty.minus(position.qty);

        if (delta.abs().lessThanOrEqualTo(RECONCILIATION_QTY_TOLERANCE)) {
            return; // clean match — no drift
        }

        counters[DriftCaseEnum.QTY_MISMATCH]++;

        this.emitDriftDetected({
            positionId: position.id,
            symbol: position.symbol,
            side: position.side,
            driftCase: DriftCaseEnum.QTY_MISMATCH,
            dbQty: position.qty.toFixed(),
            exchangeQty: snapshot.qty,
            detectedAtMs: nowMs,
        });

        const causeClass = delta.isPositive() ? 'missed_add_fill' : 'missed_reduce_fill';
        this.logger.warn(
            `case-c QTY_MISMATCH positionId=${position.id} symbol=${position.symbol} side=${position.side} ` +
                `dbQty=${formatMoney(position.qty)} exchangeQty=${snapshot.qty} delta=${formatMoney(delta)} causeClass=${causeClass}`,
        );

        // 1. Record the exposure drift (gate-side accounting). Logs WARN + delta;
        //    adjusts open_exposure by (exchangeQty - dbQty) * entryPrice; emits telemetry.
        await this.riskGate.recordExposureDrift(position.id, position.qty, exchangeQty, nowMs);

        // 2. Mutate the DB row's qty to the exchange truth (ADR 0009 §6.1b atomic single
        //    UPDATE + position.qty.adjusted event).
        await this.positionService.adjustQty(position.id, exchangeQty, QtyAdjustmentReasonEnum.EXCHANGE_QTY_CORRECTION, { nowMs });

        this.emitResolved({
            positionId: position.id,
            driftCase: DriftCaseEnum.QTY_MISMATCH,
            outcome: ReconciliationOutcomeEnum.QTY_ADJUSTED,
            resolvedAtMs: nowMs,
        });
    }

    // Case (d) — W4a high-severity alert. Full split-handler (case-a flatten +
    // case-b precise close) lands in W4b. ADR 0010 §1d: "almost certainly a
    // strategy or risk-gate bug, not a normal drift."
    private handleSideMismatch(position: PositionEntity, exchangeSnapshot: IPosition, nowMs: number, counters: Record<DriftCaseEnum, number>): void {
        counters[DriftCaseEnum.SIDE_MISMATCH]++;

        this.emitDriftDetected({
            positionId: position.id,
            symbol: position.symbol,
            side: position.side,
            driftCase: DriftCaseEnum.SIDE_MISMATCH,
            dbQty: position.qty.toFixed(),
            exchangeQty: exchangeSnapshot.qty,
            detectedAtMs: nowMs,
        });

        this.logger.error(
            `case-d SIDE_MISMATCH positionId=${position.id} symbol=${position.symbol} ` +
                `dbSide=${position.side} dbQty=${formatMoney(position.qty)} ` +
                `exchangeSide=${exchangeSnapshot.side} exchangeQty=${exchangeSnapshot.qty} ` +
                `- critical: split-handler deferred to W4b, operator must investigate`,
        );
    }

    // Case (e) — full W4a handler. If exchange-side SL/TP is missing, flip the row
    // to local_fallback, re-arm the monitor with the persisted SL/TP prices
    // (W1 schema columns), and emit a PROTECTIVE_FALLBACK outcome.
    private async handleProtectiveOrderDriftIfNeeded(
        position: PositionEntity,
        openOrders: readonly IOrder[],
        nowMs: number,
        counters: Record<DriftCaseEnum, number>,
    ): Promise<void> {
        const symbolOrders = openOrders.filter((order) => order.symbol === position.symbol);
        // R2.1 clean-code: suffixes sourced from `executionConsts` so the
        // executor side (ClientOrderIdFactory) and reconciliation side stay
        // in lockstep — a rename of either suffix is now a one-line edit.
        const hasSlOrder = symbolOrders.some((order) => order.clientOrderId?.endsWith(PROTECTIVE_CLIENT_ORDER_ID_SL_SUFFIX) === true);
        const hasTpOrder = symbolOrders.some((order) => order.clientOrderId?.endsWith(PROTECTIVE_CLIENT_ORDER_ID_TP_SUFFIX) === true);

        if (hasSlOrder && hasTpOrder) {
            return; // protection intact
        }

        counters[DriftCaseEnum.PROTECTIVE_ORDER_DRIFT]++;

        this.emitDriftDetected({
            positionId: position.id,
            symbol: position.symbol,
            side: position.side,
            driftCase: DriftCaseEnum.PROTECTIVE_ORDER_DRIFT,
            dbQty: position.qty.toFixed(),
            exchangeQty: null,
            detectedAtMs: nowMs,
        });

        // M6 R1.2.5 (ADR 0010 §1e + ADR 0009 §6.1). State-guarded column-scoped
        // UPDATE: writes only `protective_order_type` AND requires the row's
        // current state to still be PENDING_OPEN / OPEN / CLOSING (the "alive
        // and protected" set). The prior `position.protectiveOrderType = ...;
        // save(position)` sequence was racy — the in-memory `position` was read
        // at top-of-runPass and a concurrent state transition between read and
        // save could be clobbered by the full-row save. Now the UPDATE is
        // narrow and conditional; if the row already moved to RECONCILING /
        // MANUAL_ADOPTED_UNMANAGED / CLOSED, affected=0 and we skip re-arm.
        const acceptableStates: PositionStateEnum[] = [PositionStateEnum.PENDING_OPEN, PositionStateEnum.OPEN, PositionStateEnum.CLOSING];
        const affected = await this.positions.updateProtectiveOrderTypeIfState(position.id, ProtectiveOrderTypeEnum.LOCAL_FALLBACK, acceptableStates);

        if (affected === 0) {
            this.logger.warn(
                `case-e PROTECTIVE_FALLBACK positionId=${position.id} ${position.symbol} - state moved concurrently (no longer in ${acceptableStates.join('|')}); skip re-arm`,
            );

            return;
        }

        // Re-arm the monitor with the SL/TP prices stored on the row at attach time.
        // The monitor's `arm` is a constant-time map insert: idempotent — re-arming
        // an already-armed position overwrites the same key (W3 semantics).
        this.localProtectiveMonitor.arm({
            positionId: position.id,
            symbol: position.symbol,
            side: position.side,
            stopLossPrice: position.stopLossPrice ?? null,
            takeProfitPrice: position.takeProfitPrice ?? null,
        });

        this.emitResolved({
            positionId: position.id,
            driftCase: DriftCaseEnum.PROTECTIVE_ORDER_DRIFT,
            outcome: ReconciliationOutcomeEnum.PROTECTIVE_FALLBACK,
            resolvedAtMs: nowMs,
        });

        this.logger.warn(
            `case-e PROTECTIVE_FALLBACK positionId=${position.id} symbol=${position.symbol} ` +
                `missingSl=${!hasSlOrder} missingTp=${!hasTpOrder} - monitor re-armed`,
        );
    }

    // Case (f) — re-query the most recent transaction's clientOrderId. If the
    // exchange returns a terminal state, classify accordingly + emit
    // INTENT_TERMINAL. If non-terminal beyond the unknown-intent TTL,
    // emit UNRESOLVED_TTL (the operator alert path).
    //
    // The reservation release is handled by the `expireStaleReservations(nowMs)`
    // call at the top of `runPass` (ADR 0010 §1f revised — TTL sweep is the
    // authoritative path).
    private async handleUnknownIntentOutcome(
        position: PositionEntity,
        exchangeMatch: IPosition | null,
        nowMs: number,
        counters: Record<DriftCaseEnum, number>,
    ): Promise<void> {
        counters[DriftCaseEnum.UNKNOWN_INTENT_OUTCOME]++;

        const tx = await this.findRecentTransactionFor(position);

        if (tx === null || tx.clientOrderId === null || tx.clientOrderId === undefined) {
            // M6 R4.2.1. Operationally rare — a RECONCILING row should always
            // have at least one transaction by construction (the row reached
            // RECONCILING via either case-(b)'s sourceState=PENDING_OPEN or
            // the case-(f) `intent.unknown` listener that fires on the
            // executor's unknown-result emit, both of which run AFTER at
            // least one transaction insert). Defensive: if we somehow hit
            // this branch the row would otherwise stay in RECONCILING
            // forever (same stuck-loop pathology as the original 3.1.1).
            // Drive it out using the same `transitionOutOfReconciling`
            // helper R3.1.1 introduced — qty > 0 → OPEN, otherwise
            // finalize → CLOSED. Synthetic status string for the log.
            this.logger.warn(`case-f positionId=${position.id} no recent transaction with clientOrderId - driving out of RECONCILING via no-tx fallback`);
            this.emitResolved({
                positionId: position.id,
                driftCase: DriftCaseEnum.UNKNOWN_INTENT_OUTCOME,
                outcome: ReconciliationOutcomeEnum.UNRESOLVED_TTL,
                resolvedAtMs: nowMs,
            });
            await this.transitionOutOfReconciling(position, exchangeMatch, nowMs, 'no-transaction', 'n/a');

            return;
        }

        let orderSnapshot;
        try {
            orderSnapshot = await this.ccxtExecutionClient.fetchOrderByClientId(position.symbol, tx.clientOrderId);
        } catch (cause) {
            this.logger.warn(`case-f fetchOrderByClientId failed for positionId=${position.id} clientOrderId=${tx.clientOrderId}: ${this.describe(cause)}`);

            return; // next tick retries
        }

        if (orderSnapshot === null) {
            this.logger.warn(`case-f positionId=${position.id} clientOrderId=${tx.clientOrderId} not found on exchange - awaiting next tick or TTL`);

            return;
        }

        const isTerminal = this.isOrderTerminal(orderSnapshot.status);

        if (!isTerminal) {
            // M6 R1.2.4 (ADR 0010 §1f): non-terminal but PAST the TTL window →
            // emit UNRESOLVED_TTL so M9 alerting can fire and the operator
            // investigates. Reservation release is handled by the TTL sweep at
            // runPass entry (`expireStaleReservations`) — we do NOT release here
            // (precise reservationId-by-clientOrderId mapping is M7 W0).
            const ageMs = nowMs - tx.createdAt.getTime();

            if (ageMs > UNKNOWN_INTENT_TTL_MS) {
                this.logger.error(
                    `case-f positionId=${position.id} clientOrderId=${tx.clientOrderId} non-terminal status=${orderSnapshot.status} ` +
                        `age=${ageMs}ms > TTL=${UNKNOWN_INTENT_TTL_MS}ms - emitting UNRESOLVED_TTL (operator must investigate)`,
                );
                this.emitResolved({
                    positionId: position.id,
                    driftCase: DriftCaseEnum.UNKNOWN_INTENT_OUTCOME,
                    outcome: ReconciliationOutcomeEnum.UNRESOLVED_TTL,
                    resolvedAtMs: nowMs,
                });

                return;
            }

            this.logger.debug(
                `case-f positionId=${position.id} clientOrderId=${tx.clientOrderId} status=${orderSnapshot.status} non-terminal age=${ageMs}ms - waiting (TTL=${UNKNOWN_INTENT_TTL_MS}ms)`,
            );

            return;
        }

        // M6 R3.1.1 (ADR-0010 §1f step 3). Terminal exchange status means the
        // in-flight intent is resolved one way or another; the row MUST leave
        // RECONCILING this tick or the slot stays stuck forever (case-(b) skips
        // because the exchange still shows the position, case-(c) qty matches,
        // case-(f) re-fires on every 30s tick — the original blocker).
        //
        // The exchange-side qty is the authoritative survived-vs-closed signal:
        //   - qty > 0 → the order filled (or never reduced enough); the position
        //     survived. Transition RECONCILING → OPEN (legal arrow per ADR-0009
        //     §3) so the strategy / monitor resume normal operation. The
        //     periodic case-(c) handler will reconcile any qty drift on the
        //     next tick.
        //   - qty == 0 (or no exchange match at all) → the position closed
        //     outside the bot's normal flow. Drive the existing case-(b) close
        //     path (transition CLOSING → CLOSED via finalizeRealizedPnl) with
        //     RECONCILED_MISSING. We don't have closing-side fills locally for
        //     this branch, so realizedPnl/exitPrice come out null per the
        //     existing finalize contract (ADR-0010 §1b).
        await this.transitionOutOfReconciling(position, exchangeMatch, nowMs, orderSnapshot.status, tx.clientOrderId);

        this.emitResolved({
            positionId: position.id,
            driftCase: DriftCaseEnum.UNKNOWN_INTENT_OUTCOME,
            outcome: ReconciliationOutcomeEnum.INTENT_TERMINAL,
            resolvedAtMs: nowMs,
        });
    }

    // M6 R3.1.1. Drives the case-(f) terminal-status row out of RECONCILING.
    // The two arrows (RECONCILING → OPEN, RECONCILING → CLOSED) are both legal
    // per ADR-0009 §3 / `positionStateGraph`. The CLOSED path goes through
    // PositionService.finalizeRealizedPnl so the exit-reason + closedAt land in
    // the same UPDATE as the state — ADR-0009 §6.1 dual-write atomicity.
    private async transitionOutOfReconciling(
        position: PositionEntity,
        exchangeMatch: IPosition | null,
        nowMs: number,
        orderStatus: string,
        clientOrderId: string,
    ): Promise<void> {
        const survivedQty = this.extractExchangeQty(exchangeMatch);

        if (survivedQty !== null && survivedQty.greaterThan(0)) {
            // Position survived — re-open.
            await this.positionService.transition(position.id, PositionStateEnum.OPEN, {
                nowMs,
                eventClass: 'reconciliation.f.intent_terminal.open',
            });

            this.logger.log(
                `case-f INTENT_TERMINAL positionId=${position.id} clientOrderId=${clientOrderId} status=${orderStatus} ` +
                    `exchangeQty=${survivedQty.toFixed()} - transitioned RECONCILING → OPEN`,
            );

            return;
        }

        // Closed outside the bot — finalize with RECONCILED_MISSING (matches
        // case-(b)'s vanish path). RECONCILING → CLOSED is a single arrow in
        // §3 graph; finalize uses CLOSED as toState directly.
        const eventClass = 'reconciliation.f.intent_terminal.closed';
        await this.positionService.finalizeRealizedPnl(position.id, ExitReasonEnum.RECONCILED_MISSING, { nowMs, eventClass });

        // Symmetric with the case-(b) vanish branch: release any monitor arm,
        // release the exposure-reservation (best-effort no-op if already gone).
        this.localProtectiveMonitor.disarm(position.id);
        await this.riskGate.reconcileClose(position.id, nowMs);

        this.logger.warn(
            `case-f INTENT_TERMINAL positionId=${position.id} clientOrderId=${clientOrderId} status=${orderStatus} ` +
                `exchangeQty=${survivedQty === null ? 'none' : survivedQty.toFixed()} - finalized RECONCILED_MISSING (RECONCILING → CLOSED)`,
        );
    }

    // Parses `IPosition.qty` (decimal-as-string) into MoneyValue. Returns
    // null when the snapshot is absent or the qty is unparseable; either condition
    // is treated as "no exchange exposure" by the case-(f) close path.
    private extractExchangeQty(snapshot: IPosition | null): MoneyValue | null {
        if (snapshot === null) {
            return null;
        }

        try {
            const qty = new Money(snapshot.qty);

            if (qty.isNaN() || !qty.isFinite()) {
                return null;
            }

            return qty;
        } catch {
            return null;
        }
    }

    // ────────── cooldown retention sweep (ADR 0010 §7 / ADR 0011 §5 revised) ────────

    // Iterates retainer entries with `COOLDOWN_ACTIVE`, computes cooldown locally
    // (same logic as `RiskGateService.isCooldownActive` — see ADR 0010 §7: "no new
    // gate API; cooldown stays derivative"). Releases the retention if the cooldown
    // window has elapsed. Returns the release count for the pass summary.
    async releaseExpiredCooldownRetentions(nowMs: number): Promise<number> {
        const retained = this.retainer.getRetainedSymbols();
        let releases = 0;

        for (const symbol of retained) {
            const reasons = this.retainer.getReasonsFor(symbol);

            if (!reasons.has(RetainReasonEnum.COOLDOWN_ACTIVE)) {
                continue;
            }

            const active = await this.isCooldownStillActive(symbol, nowMs);

            if (active) {
                continue;
            }

            this.retainer.release(symbol, RetainReasonEnum.COOLDOWN_ACTIVE);
            releases++;
        }

        return releases;
    }

    // Same derivative computation as `RiskGateService.isCooldownActive` (ADR 0004
    // §5). Duplicated to keep the cooldown stay-derivative invariant from forcing
    // a new gate API (ADR 0010 §7). Single-line semantic: cooldown is active iff
    // the most recent close on the symbol was a loss within the last
    // `COOLDOWN_AFTER_LOSS_MS` window. The constant is a build-time default; M4's
    // operator-controlled `cooldownAfterLossMs` (per IRiskLimits) overrides for
    // live — W4b can plumb the runtime value through if needed.
    private async isCooldownStillActive(symbol: string, nowMs: number): Promise<boolean> {
        const lastClose = await this.positions.findLastClosedBySymbol(symbol);

        if (lastClose === null) {
            return false;
        }

        if (lastClose.realizedPnl === null || lastClose.realizedPnl === undefined) {
            return false;
        }

        if (!lastClose.realizedPnl.isNegative()) {
            return false;
        }

        if (lastClose.closedAt === null || lastClose.closedAt === undefined) {
            return false;
        }

        return nowMs - lastClose.closedAt.getTime() < COOLDOWN_AFTER_LOSS_MS;
    }

    // ────────── helpers ──────────────────────────────────────────────────────────

    private async fetchExchangePositionsSafe(): Promise<readonly IPosition[]> {
        try {
            // M11a R2a Item 5 (logic R2a). Returns the shared `IPosition` DTO
            // directly — structurally identical to the engine's
            // `IPosition` (both carry
            // symbol/side/qty/entryPrice/markPrice/liquidationPrice/marginType/leverage/timestampMs)
            // but the cast indirection through `IPosition` is
            // removed so downstream parsers consume the shared DTO field
            // names directly.
            return await this.accountState.fetchPositions();
        } catch (cause) {
            this.logger.error(`fetchPositions failed: ${this.describe(cause)} - tick continues with empty exchange snapshot`);

            return [];
        }
    }

    private async fetchOpenOrdersSafe(): Promise<readonly IOrder[]> {
        try {
            // M11a R2a BLOCKER B1 (ADR 0032 §3 D14). Reads route through the
            // shared `IAccountStateSource` port — `ExchangeAccountStateSource`
            // wraps the call in `runWithLiveAccountStateCapability` so the
            // D14 runtime guard accepts the call in LIVE/TESTNET.
            // `PaperAccountStateSource` returns the simulated open orders in
            // PAPER (R2c plumbs the simulator-side ledger). Shared `IOrder`
            // carries `reduceOnly` so case-(e) can keep its prefix-suffix
            // matching for protective-drift detection.
            return await this.accountState.fetchOpenOrders();
        } catch (cause) {
            this.logger.error(`fetchOpenOrders failed: ${this.describe(cause)} - case (e) protective drift will be skipped this tick`);

            return [];
        }
    }

    // M2 `findOpen()` already projects via status='open' which per ADR 0009 §1
    // covers state ∈ {pending_open, open, closing, reconciling,
    // manual_adopted_unmanaged}. Filtering further on `state !== CLOSED` is
    // defensive — should be a no-op given the projection invariant.
    private async loadNonClosedPositions(): Promise<PositionEntity[]> {
        // M31 Wave B (Defect 5): repointed from `findOpen` to `findNonTerminal` so the
        // reconciler still sees qty=0 zombie rows (state != CLOSED but quantity drained to
        // zero). `findLiveRisk` narrows on qty for sizing; reconciliation MUST NOT be qty-
        // narrowed or it goes blind to exactly the zombies it exists to resolve.
        const rows = await this.positions.findNonTerminal();

        return rows.filter((row) => row.state !== PositionStateEnum.CLOSED);
    }

    // ADR 0010 §1f reviewer rule: a row transitioning between read and classify
    // must be SKIPPED not double-resolved. Closing rows are already mid-flight;
    // closed rows shouldn't be in the snapshot but defensively skip them too.
    // M6 R1.1.2 (ADR 0010 §1b revised): CLOSING is now a legitimate source state
    // for case-(b) handling (finalize closes directly via CLOSING→CLOSED). Only
    // CLOSED is filtered — CLOSED rows shouldn't be in `findOpen`'s projection
    // anyway, but the defensive filter prevents corruption if one slips through.
    private shouldSkipDuringReconciliation(position: PositionEntity): boolean {
        return position.state === PositionStateEnum.CLOSED;
    }

    // M6 R1.2.4 (ADR 0010 §1f). Returns the most recent `transactions` row for
    // the position. Case-(f) UNKNOWN_INTENT_OUTCOME re-queries the exchange via
    // `fetchOrderByClientId(symbol, row.clientOrderId)` to resolve the terminal
    // state. The TTL backstop (via `expireStaleReservations` at runPass entry)
    // covers the orphan reservation if the exchange query keeps returning
    // non-terminal beyond the ADR-0010 TTL window — see the §1f path in
    // `handleUnknownIntentOutcome` for `UNRESOLVED_TTL` emission.
    private async findRecentTransactionFor(position: PositionEntity): Promise<{ clientOrderId: string | null; createdAt: Date } | null> {
        return this.transactions.findLatestByPositionId(position.id);
    }

    private isOrderTerminal(status: string): boolean {
        return TERMINAL_ORDER_STATUSES.has(status);
    }

    private emitDriftDetected(payload: IReconciliationDriftDetectedEvent): void {
        this.events.emit(RECONCILIATION_DRIFT_DETECTED_EVENT, payload);
    }

    private emitResolved(payload: IReconciliationResolvedEvent): void {
        this.events.emit(RECONCILIATION_RESOLVED_EVENT, payload);
    }

    private normaliseSide(side: string): PositionSideEnum {
        if (side.toLowerCase() === 'long') {
            return PositionSideEnum.LONG;
        }

        return PositionSideEnum.SHORT;
    }

    private positionKey = (position: PositionEntity): string => {
        return `${position.symbol}|${position.side}`;
    };

    private snapshotKey = (snapshot: IPosition): string => {
        return `${snapshot.symbol}|${this.normaliseSide(snapshot.side)}`;
    };

    private oppositeSideKey(position: PositionEntity): string {
        const opposite = position.side === PositionSideEnum.LONG ? PositionSideEnum.SHORT : PositionSideEnum.LONG;

        return `${position.symbol}|${opposite}`;
    }

    private indexBy<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T> {
        const map = new Map<string, T>();

        for (const item of items) {
            map.set(keyFn(item), item);
        }

        return map;
    }

    private emptyCounters(): Record<DriftCaseEnum, number> {
        return {
            [DriftCaseEnum.EXCHANGE_NOT_IN_DB]: 0,
            [DriftCaseEnum.DB_OPEN_NOT_ON_EXCHANGE]: 0,
            [DriftCaseEnum.QTY_MISMATCH]: 0,
            [DriftCaseEnum.SIDE_MISMATCH]: 0,
            [DriftCaseEnum.PROTECTIVE_ORDER_DRIFT]: 0,
            [DriftCaseEnum.UNKNOWN_INTENT_OUTCOME]: 0,
        };
    }

    private emptyPass(nowMs: number): IReconciliationPass {
        return {
            tickAtMs: nowMs,
            driftsByCase: this.emptyCounters(),
            cooldownReleases: 0,
            fundingRowsWritten: 0,
            skippedTransitioning: 0,
            errors: 0,
        };
    }

    private describe(cause: unknown): string {
        if (cause instanceof Error) {
            return cause.message;
        }

        return String(cause);
    }
}
