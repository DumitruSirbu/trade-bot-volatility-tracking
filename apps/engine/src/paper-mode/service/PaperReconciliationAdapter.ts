import {
    AlertSeverityEnum,
    AlertTypeEnum,
    DriftCaseEnum,
    ExchangeEnvironmentEnum,
    HaltSourceEnum,
    IAlertPayload,
    IReconciliationDriftDetectedEvent,
    PositionSideEnum,
} from '@bot/shared';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ALERT_SINK, IAlertSink } from '../../alert/sink/AlertSinkModule';
import { HaltFlagService } from '../../common/service/HaltFlagService';
import { AppConfigService } from '../../config/service';
import { HaltService } from '../../control/HaltService';
import { RECONCILIATION_DRIFT_DETECTED_EVENT, RECONCILIATION_TICK_MS } from '../../position/const';
import { PaperAccountStateEntity } from '../entity/PaperAccountStateEntity';
import { PaperAccountStateRepository } from '../repository/PaperAccountStateRepository';
import { IPaperPositionView } from '../interface';
import { PaperAccountStateService } from './PaperAccountStateService';

// PaperReconciliationAdapter — ADR 0032 §D12 / §D16.
//
// Reconciles the in-memory PaperAccountStateService against the persisted
// `paper_account_state` rows (NOT against the live exchange — D13's
// `PaperExchangeNullityProbe` covers that surface separately). Inherits the
// same triggers as M6 W4b live reconciliation:
//
//   - periodic poll at RECONCILIATION_TICK_MS cadence (same as ReconciliationService);
//   - event-driven retick (no direct hook today — the periodic cadence is
//     sufficient because every audited mutator commits the persisted row in
//     the SAME transaction as the in-memory mutation; mid-transaction drift
//     is structurally impossible per the R2b withAuditedTransaction primitive).
//
// Drift in PAPER is more severe than in LIVE (D12): there is no exchange-clock
// cause for divergence. Any drift between in-memory state and the persisted
// projection is a production bug in the audited-mutation discipline.
//
// Action on drift detection:
//   1. CRITICAL Telegram alert (not WARNING — D12 elevates the severity).
//   2. Emit `RECONCILIATION_DRIFT_DETECTED_EVENT` for downstream observers
//      using the existing shared `IReconciliationDriftDetectedEvent` shape;
//      the `dbQty` field carries the persisted qty and `exchangeQty` carries
//      the in-memory qty (no new shared shape — reuse per the addendum).
//   3. Halt new decision routing via `HaltFlagService.halt(...)` +
//      `HaltService.notePragmaticTransition(...)` (mirrors
//      PaperDrawdownAbortHandler's halt path).
//
// Halt source: `HaltSourceEnum.MODEL_DIVERGENCE` — the closest existing
// semantic neighbour (engine-internal protective kill switch). Adding a
// dedicated `PAPER_RECONCILIATION_DRIFT` would require routing through
// bot-shared-maintainer; deferred consistent with the
// PaperDrawdownAbortHandler precedent (architect-adjudication item).
//
// Audit-row mutation kind: reuses `MutationKindEnum.RECONCILIATION_FORCED`
// per the dispatch's preference for not extending the enum. A dedicated
// `RECONCILIATION_DRIFT` value would need a paired migration + shared
// surface; flagged as a future cleanup. The audit row is written via the
// drawdown-handler pattern (separate audited transaction) if/when an
// actionable mutation lands — R2d's drift detection is observation-only
// (halt + alert + event); no audited subject mutation. So no audit row is
// appended here; the chain stays intact.
//
// Env-conditional: only active in PAPER. Mirrors the R2c.D handlers — the
// provider is bound unconditionally so Nest can instantiate it for the
// scheduler, but every tick short-circuits when `exchangeEnv !== PAPER`.
//
// COMPILE-TIME INVARIANT (ADR 0032 §2 D2 / §3 D14): this file MUST NOT
// import ccxt or any `exchange/` module — it reconciles purely engine-local
// state. The R2a.5 module-graph sentinel guards the closure.

interface IPaperReconciliationPass {
    readonly tickAtMs: number;
    readonly driftCount: number;
    readonly inMemoryCount: number;
    readonly persistedCount: number;
}

@Injectable()
export class PaperReconciliationAdapter implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(PaperReconciliationAdapter.name);

    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private haltLatched = false;
    private oneShotPaperSkipLogged = false;

    constructor(
        private readonly appConfig: AppConfigService,
        private readonly accountState: PaperAccountStateService,
        private readonly stateRepo: PaperAccountStateRepository,
        private readonly haltFlag: HaltFlagService,
        private readonly haltService: HaltService,
        private readonly events: EventEmitter2,
        @Inject(ALERT_SINK) private readonly alerts: IAlertSink,
    ) {}

    onApplicationBootstrap(): void {
        if (this.appConfig.exchangeEnv !== ExchangeEnvironmentEnum.PAPER) {
            if (!this.oneShotPaperSkipLogged) {
                this.logger.log(`PaperReconciliationAdapter dormant: EXCHANGE_ENV=${this.appConfig.exchangeEnv} (PAPER only)`);
                this.oneShotPaperSkipLogged = true;
            }

            return;
        }

        this.startPeriodicPoll();
        this.logger.log(`PaperReconciliationAdapter active: cadence=${RECONCILIATION_TICK_MS}ms`);
    }

    onModuleDestroy(): void {
        this.stopPeriodicPoll();
    }

    // Public for tests + EngineBootstrapService's PAPER-branch forceTick call
    // (mirrors ReconciliationService.forceTick). Bypasses the running guard
    // for the boot pipeline; the periodic poll uses `scheduledTick`. Under
    // LIVE/TESTNET this short-circuits so a defensively-wired boot caller
    // that forgot the env-gate can never accidentally touch PAPER state.
    async forceTick(nowMs: number): Promise<IPaperReconciliationPass> {
        if (this.appConfig.exchangeEnv !== ExchangeEnvironmentEnum.PAPER) {
            return {
                tickAtMs: nowMs,
                driftCount: 0,
                inMemoryCount: 0,
                persistedCount: 0,
            };
        }

        return this.runPass(nowMs);
    }

    // Periodic-poll entry point. Guards against re-entry so an overlapping
    // schedule doesn't double-fire.
    async scheduledTick(nowMs: number): Promise<IPaperReconciliationPass | null> {
        if (this.appConfig.exchangeEnv !== ExchangeEnvironmentEnum.PAPER) {
            return null;
        }

        if (this.running) {
            this.logger.debug('PaperReconciliationAdapter scheduled tick skipped: previous pass still running');

            return null;
        }

        this.running = true;

        try {
            return await this.runPass(nowMs);
        } catch (cause) {
            this.logger.error(`PaperReconciliationAdapter scheduled tick failed: ${this.describe(cause)}`);

            return null;
        } finally {
            this.running = false;
        }
    }

    // Reset latch for tests so a subsequent drift in the same Jest process
    // re-arms the halt path.
    resetForTest(): void {
        this.haltLatched = false;
    }

    private startPeriodicPoll(): void {
        if (this.timer !== null) {
            return;
        }

        this.timer = setInterval(() => {
            void this.scheduledTick(Date.now());
        }, RECONCILIATION_TICK_MS);

        if (typeof this.timer.unref === 'function') {
            this.timer.unref();
        }
    }

    private stopPeriodicPoll(): void {
        if (this.timer === null) {
            return;
        }

        clearInterval(this.timer);
        this.timer = null;
    }

    private async runPass(nowMs: number): Promise<IPaperReconciliationPass> {
        const inMemory = this.accountState.getOpenPositions();
        const persisted = await this.stateRepo.findAllOpen();

        const drifts = this.diffStates(inMemory, persisted);

        if (drifts.length === 0) {
            return {
                tickAtMs: nowMs,
                driftCount: 0,
                inMemoryCount: inMemory.length,
                persistedCount: persisted.length,
            };
        }

        // First drift in the process triggers the full halt + alert flow.
        // Subsequent drifts in the same process still emit per-drift events
        // for forensic visibility but do NOT re-halt (already halted) and do
        // NOT re-alert (telegram-spam guard) — same one-shot latch pattern as
        // PaperDrawdownAbortHandler.
        for (const drift of drifts) {
            this.emitDriftEvent(drift, nowMs);
            this.logger.error(
                `PaperReconciliationAdapter DRIFT key=${drift.key} cause=${drift.cause} ` +
                    `inMemoryQty=${drift.inMemoryQty ?? 'null'} persistedQty=${drift.persistedQty ?? 'null'}`,
            );
        }

        if (!this.haltLatched) {
            this.haltLatched = true;
            await this.executeCriticalAbort(drifts, nowMs);
        }

        return {
            tickAtMs: nowMs,
            driftCount: drifts.length,
            inMemoryCount: inMemory.length,
            persistedCount: persisted.length,
        };
    }

    private diffStates(inMemory: readonly IPaperPositionView[], persisted: readonly PaperAccountStateEntity[]): readonly IDrift[] {
        const drifts: IDrift[] = [];
        const inMemoryByCoid = new Map<string, IPaperPositionView>(inMemory.map((p) => [p.clientOrderId, p]));
        const persistedByCoid = new Map<string, PaperAccountStateEntity>(persisted.map((p) => [p.clientOrderId, p]));

        // (1) in-memory rows missing from persisted state.
        for (const [coid, view] of inMemoryByCoid.entries()) {
            const persistedRow = persistedByCoid.get(coid);

            if (persistedRow === undefined) {
                drifts.push({
                    key: this.driftKey(view.symbol, view.side, coid),
                    cause: 'IN_MEMORY_NOT_IN_PERSISTED',
                    symbol: view.symbol,
                    side: view.side,
                    inMemoryQty: view.size.toFixed(),
                    persistedQty: null,
                });
                continue;
            }

            // (3) field-value drift on matched pairs (qty, side, entry price, symbol).
            const fieldDrift = this.diffMatchedPair(view, persistedRow);

            if (fieldDrift !== null) {
                drifts.push(fieldDrift);
            }
        }

        // (2) persisted rows missing from in-memory.
        for (const [coid, row] of persistedByCoid.entries()) {
            if (inMemoryByCoid.has(coid)) {
                continue;
            }

            drifts.push({
                key: this.driftKey(row.symbol, row.side, coid),
                cause: 'PERSISTED_NOT_IN_MEMORY',
                symbol: row.symbol,
                side: row.side,
                inMemoryQty: null,
                persistedQty: row.size.toFixed(),
            });
        }

        return drifts;
    }

    private diffMatchedPair(view: IPaperPositionView, row: PaperAccountStateEntity): IDrift | null {
        if (view.symbol !== row.symbol) {
            return {
                key: this.driftKey(view.symbol, view.side, view.clientOrderId),
                cause: 'SYMBOL_DRIFT',
                symbol: view.symbol,
                side: view.side,
                inMemoryQty: view.size.toFixed(),
                persistedQty: row.size.toFixed(),
            };
        }

        if (view.side !== row.side) {
            return {
                key: this.driftKey(view.symbol, view.side, view.clientOrderId),
                cause: 'SIDE_DRIFT',
                symbol: view.symbol,
                side: view.side,
                inMemoryQty: view.size.toFixed(),
                persistedQty: row.size.toFixed(),
            };
        }

        if (!view.size.equals(row.size)) {
            return {
                key: this.driftKey(view.symbol, view.side, view.clientOrderId),
                cause: 'SIZE_DRIFT',
                symbol: view.symbol,
                side: view.side,
                inMemoryQty: view.size.toFixed(),
                persistedQty: row.size.toFixed(),
            };
        }

        if (!view.entryPrice.equals(row.entryPrice)) {
            return {
                key: this.driftKey(view.symbol, view.side, view.clientOrderId),
                cause: 'ENTRY_PRICE_DRIFT',
                symbol: view.symbol,
                side: view.side,
                inMemoryQty: view.size.toFixed(),
                persistedQty: row.size.toFixed(),
            };
        }

        // M11a R4 Item 5: defence-in-depth — leverage drift catches a
        // class of regression that the qty/price/symbol/side checks miss
        // (e.g. a future mutation path that updates leverage without
        // syncing in-memory). Cheap to evaluate and rare in practice;
        // any divergence is a production bug worth surfacing as DRIFT.
        if (view.leverage !== row.leverage) {
            return {
                key: this.driftKey(view.symbol, view.side, view.clientOrderId),
                cause: 'LEVERAGE_DRIFT',
                symbol: view.symbol,
                side: view.side,
                inMemoryQty: view.size.toFixed(),
                persistedQty: row.size.toFixed(),
            };
        }

        return null;
    }

    private driftKey(symbol: string, side: PositionSideEnum, clientOrderId: string): string {
        return `${symbol}|${side}|${clientOrderId}`;
    }

    private emitDriftEvent(drift: IDrift, nowMs: number): void {
        const payload: IReconciliationDriftDetectedEvent = {
            positionId: null,
            symbol: drift.symbol,
            side: drift.side,
            // Reuse the shared DriftCaseEnum's closest neighbour. SIZE_DRIFT
            // and ENTRY_PRICE_DRIFT map to QTY_MISMATCH (size mismatch is the
            // canonical numeric-field drift). Missing-row drifts map to the
            // existing live cases so downstream listeners need no enum widening.
            driftCase: this.mapDriftCase(drift.cause),
            dbQty: drift.persistedQty,
            exchangeQty: drift.inMemoryQty,
            detectedAtMs: nowMs,
        };
        this.events.emit(RECONCILIATION_DRIFT_DETECTED_EVENT, payload);
    }

    private mapDriftCase(cause: DriftCause): DriftCaseEnum {
        if (cause === 'IN_MEMORY_NOT_IN_PERSISTED') {
            return DriftCaseEnum.EXCHANGE_NOT_IN_DB;
        }

        if (cause === 'PERSISTED_NOT_IN_MEMORY') {
            return DriftCaseEnum.DB_OPEN_NOT_ON_EXCHANGE;
        }

        if (cause === 'SIDE_DRIFT') {
            return DriftCaseEnum.SIDE_MISMATCH;
        }

        return DriftCaseEnum.QTY_MISMATCH;
    }

    private async executeCriticalAbort(drifts: readonly IDrift[], nowMs: number): Promise<void> {
        const summary = `paper reconciliation DRIFT: ${drifts.length} divergence(s) between in-memory and persisted state`;

        // (a) halt flag — mirrors PaperDrawdownAbortHandler's two-step halt
        // path so the read-API `GET /v1/control/halt` reports the source.
        try {
            if (!this.haltFlag.isHalted()) {
                this.haltFlag.halt(`${HaltSourceEnum.MODEL_DIVERGENCE}:paper_reconciliation_drift`);
                this.haltService.notePragmaticTransition(HaltSourceEnum.MODEL_DIVERGENCE, 'paper_reconciliation_drift', nowMs);
            }
        } catch (cause) {
            this.logger.error(`PaperReconciliationAdapter halt-flag flip failed: ${this.describe(cause)}`);
        }

        // (b) CRITICAL alert — Telegram out-of-band notification.
        const payload: IAlertPayload = {
            type: AlertTypeEnum.MODEL_DIVERGENCE_ENGAGED,
            severity: AlertSeverityEnum.CRITICAL,
            occurredAt: new Date(nowMs).toISOString(),
            title: 'PAPER reconciliation drift',
            body: summary,
            data: {
                driftCount: String(drifts.length),
                firstDriftKey: drifts[0].key,
                firstDriftCause: drifts[0].cause,
            },
        };

        try {
            await this.alerts.publish(payload);
        } catch (cause) {
            this.logger.error(`PaperReconciliationAdapter alert publish failed: ${this.describe(cause)}`);
        }

        this.logger.error(`PaperReconciliationAdapter CRITICAL ${summary}`);
    }

    private describe(cause: unknown): string {
        if (cause instanceof Error) {
            return `${cause.name}: ${cause.message}`;
        }

        return String(cause);
    }
}

type DriftCause =
    | 'IN_MEMORY_NOT_IN_PERSISTED'
    | 'PERSISTED_NOT_IN_MEMORY'
    | 'SYMBOL_DRIFT'
    | 'SIDE_DRIFT'
    | 'SIZE_DRIFT'
    | 'ENTRY_PRICE_DRIFT'
    | 'LEVERAGE_DRIFT';

interface IDrift {
    readonly key: string;
    readonly cause: DriftCause;
    readonly symbol: string;
    readonly side: PositionSideEnum;
    readonly inMemoryQty: string | null;
    readonly persistedQty: string | null;
}
