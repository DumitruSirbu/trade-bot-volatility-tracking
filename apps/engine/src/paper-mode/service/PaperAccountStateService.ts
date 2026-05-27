import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { PositionSideEnum } from '@bot/shared';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { BootstrapSubkeyDeriver } from '../../boot-mode-history/service/BootstrapSubkeyDeriver';
import { AppConfigService } from '../../config/service';
import { MoneyValue, addMoney, bufferEquals, isGreaterThanMoney, multiplyMoney, parseMoney, subtractMoney } from '../../common/utils';
import {
    CHAIN_NAME_PAPER_STATE_AUDIT,
    DRAWDOWN_ABORT_REMAINING_FRACTION_STR,
    HKDF_INFO_PAPER_STATE_AUDIT,
    PAPER_HKDF_INFO_VERSION,
    PAPER_MTM_THROTTLE_MS,
    PAPER_SIMULATOR_SEED_VERSION_LABEL,
    PAPER_STATE_AUDIT_ADVISORY_LOCK_KEY,
    PAPER_STATE_AUDIT_PAYLOAD_HASH_BYTES,
} from '../const';
import { PaperAccountSnapshotEntity } from '../entity/PaperAccountSnapshotEntity';
import { PaperAccountStateEntity } from '../entity/PaperAccountStateEntity';
import { PaperAccountStateHistoryEntity } from '../entity/PaperAccountStateHistoryEntity';
import { PaperAccountStateMetaEntity } from '../entity/PaperAccountStateMetaEntity';
import { PaperStateAuditEntity } from '../entity/PaperStateAuditEntity';
import { MutationKindEnum, PaperCloseReasonEnum, SubjectKindEnum } from '../enum';
import { PaperAccountStateBootException, PaperPositionNotFoundException, PaperStateInvariantException } from '../exception';
import {
    IClosePaperPositionInput,
    IClosedPaperPositionView,
    IFundingApplicationInput,
    IOpenPaperPositionInput,
    IPaperBalanceView,
    IPaperMarkPriceNotification,
    IPaperPositionView,
    ISnapshotInput,
} from '../interface';
import { PaperAccountSnapshotRepository } from '../repository/PaperAccountSnapshotRepository';
import { PaperAccountStateHistoryRepository } from '../repository/PaperAccountStateHistoryRepository';
import { PaperAccountStateMetaRepository } from '../repository/PaperAccountStateMetaRepository';
import { PaperAccountStateRepository } from '../repository/PaperAccountStateRepository';
import { PaperStateAuditRepository } from '../repository/PaperStateAuditRepository';
import { PaperStateAuditHmacCodec } from './PaperStateAuditHmacCodec';

// In-memory shape of an open paper position. Mirrors PaperAccountStateEntity's
// position-defining columns; held in a Map keyed by clientOrderId for O(1)
// lookup on the hot path (mark-to-market on tick arrival).
interface IInMemoryPaperPosition {
    id: string;
    clientOrderId: string;
    symbol: string;
    side: PositionSideEnum;
    entryPrice: MoneyValue;
    size: MoneyValue;
    leverage: number;
    openedAt: Date;
    fundingAccrued: MoneyValue;
}

// Event channel emitted on every drawdown evaluation. R2c's drawdown abort
// handler subscribes; this service only emits. Decoupled via EventEmitter2 so
// the abort handler can live in a sibling module without a cyclic import.
export const PAPER_MARK_TO_MARKET_EVENT = 'paper.mark-to-market.evaluated';

export interface IPaperMarkToMarketEvent {
    readonly evaluatedAt: Date;
    readonly equity: MoneyValue;
    readonly peakEquity: MoneyValue;
    readonly drawdownPct: number;
    readonly drawdownAbortTripped: boolean;
}

// In-memory state owner for PAPER mode (ADR 0032 §3 + §D5 + §D16).
//
// Responsibilities:
//   - Authoritative in-memory store of open positions, balance, cumulative
//     realised PnL, cumulative funding accrued, and running peak equity.
//   - Atomic three-table writes (audited subject row + paper_state_audit row)
//     for every mutation. Single TypeORM transaction per public mutator;
//     `pg_advisory_xact_lock(PAPER_STATE_AUDIT_ADVISORY_LOCK_KEY)` serialises
//     concurrent writers against the audit chain tip.
//   - Boot-time hydration: validates the soak-meta row's simulator-config
//     hash matches the current build, then rehydrates open positions +
//     cumulative counters from persisted state.
//   - MTM throttle (D5) — coalesces price-update-driven recompute to at most
//     once per `PAPER_MTM_THROTTLE_MS` per held symbol unless force-flushed.
//
// Compile-time invariant (ADR 0032 §2): this file MUST NOT import any ccxt
// module — PAPER is engine-local. The R2a.5 module-graph sentinel guards
// the closure.
//
// MUTATION DISCIPLINE (R2b-fix Item 1): every audited mutator MUST route
// through `withAuditedTransaction`. The helper opens a single transaction,
// takes the advisory lock, runs the audited writes in `body`, then runs
// in-memory mutations in `onCommit` AFTER the transaction body has resolved
// successfully. NO mutator opens `dataSource.transaction(...)` directly —
// that would lose the lexical "audited writes vs. in-memory mutations"
// split and re-open the bug class R2b-fix exists to close.
//
// WARM RESTART RULE (R2b-fix Item 4): if persisted positions exist without a
// corresponding snapshot row, `peakEquity` resets to PAPER_STARTING_EQUITY_USDT
// (safer-side per D5 monotone-peak rule). The operator must consult the audit
// chain to reconcile — a WARN log flags the case at boot.

@Injectable()
export class PaperAccountStateService implements OnApplicationBootstrap {
    private readonly logger = new Logger(PaperAccountStateService.name);

    // Single in-memory store; the persisted state is the source-of-truth for
    // crash recovery, the in-memory store is the read-fast path. The two
    // diverge only inside a single transaction's window (mutation in flight)
    // — D12 reconciliation catches any sustained divergence.
    private readonly positions = new Map<string, IInMemoryPaperPosition>();

    private balanceUsdt: MoneyValue = parseMoney('0');

    private realisedPnlCumulative: MoneyValue = parseMoney('0');

    private fundingAccruedCumulative: MoneyValue = parseMoney('0');

    private peakEquity: MoneyValue = parseMoney('0');

    private hasBooted = false;

    // MTM throttle bookkeeping per held symbol. Both timer + last-fired
    // timestamp tracked so a tick-size move can force-fire ahead of the
    // 100 ms ceiling (D5). R2c wires actual tick-size lookup; R2b stubs the
    // tick-size early-trip behind the `notifyMarkPrice` API.
    private readonly mtmTimers = new Map<string, NodeJS.Timeout>();

    private readonly pendingMarkPrices = new Map<string, IPaperMarkPriceNotification>();

    // Last-observed mark price per held symbol (R2b-fix Item 5). The MTM
    // flush computes equity over ALL open positions; without a cache it
    // would only see the symbol that just ticked. Populated by
    // `notifyMarkPrice` and `flushMtmForSymbol`; R2c's subscription
    // pipeline keeps it warm for every held symbol.
    private readonly lastMarkPrices = new Map<string, MoneyValue>();

    // Memoised simulator-config-hash (R2b-fix Item 5 LOW). The WARN log
    // should fire once per boot; the hash itself is deterministic for the
    // life of the process.
    private cachedSimulatorConfigHash: string | null = null;

    constructor(
        private readonly appConfig: AppConfigService,
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly stateRepo: PaperAccountStateRepository,
        private readonly historyRepo: PaperAccountStateHistoryRepository,
        private readonly metaRepo: PaperAccountStateMetaRepository,
        private readonly snapshotRepo: PaperAccountSnapshotRepository,
        private readonly auditRepo: PaperStateAuditRepository,
        private readonly subkeys: BootstrapSubkeyDeriver,
        private readonly codec: PaperStateAuditHmacCodec,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    // Hydrate in-memory state at bootstrap. Per ADR 0032 §D3, the soak-meta
    // row's `simulator_config_hash` is verified against the current committed
    // config; mismatch refuses to start.
    async onApplicationBootstrap(): Promise<void> {
        if (this.hasBooted) {
            return;
        }

        this.hasBooted = true;

        await this.hydrateOnBoot();
    }

    // ----- public mutators -----

    async openPosition(input: IOpenPaperPositionInput): Promise<IPaperPositionView> {
        // Idempotency check on `client_order_id` UNIQUE — runs OUTSIDE the
        // audited transaction so a replay neither takes the advisory lock
        // nor writes a second audit row. Mirrors M5's idempotency
        // discipline.
        const preExisting = await this.stateRepo.findByClientOrderId(input.clientOrderId);

        if (preExisting !== null) {
            this.logger.warn(`openPosition idempotent replay (clientOrderId=${input.clientOrderId})`);

            return this.toPositionView(preExisting);
        }

        const inserted = await this.withAuditedTransaction(
            async (manager) => {
                // Re-check under the advisory lock to defeat a TOCTOU
                // race between two concurrent open intents for the same
                // clientOrderId.
                const existing = await this.stateRepo.findByClientOrderId(input.clientOrderId, manager);

                if (existing !== null) {
                    return { row: existing, wasReplay: true };
                }

                const draft: Partial<PaperAccountStateEntity> = {
                    clientOrderId: input.clientOrderId,
                    symbol: input.symbol,
                    side: input.side,
                    entryPrice: input.entryPrice,
                    size: input.size,
                    leverage: input.leverage,
                    openedAt: input.openedAt,
                    mode: 'paper',
                };

                const row = await this.stateRepo.insertNew(draft, manager);

                const auditPayload = this.codec.hashOrderedPayload([
                    ['op', 'open'],
                    ['client_order_id', row.clientOrderId],
                    ['symbol', row.symbol],
                    ['side', row.side],
                    ['entry_price', row.entryPrice.toFixed()],
                    ['size', row.size.toFixed()],
                    ['leverage', row.leverage],
                    ['opened_at', row.openedAt.toISOString()],
                ]);

                await this.appendAuditRow(manager, {
                    mutationKind: MutationKindEnum.OPEN_POSITION,
                    subjectKind: SubjectKindEnum.PAPER_ACCOUNT_STATE,
                    subjectId: row.id,
                    payloadHash: auditPayload,
                });

                return { row, wasReplay: false };
            },
            (result) => {
                if (result.wasReplay) {
                    return;
                }

                this.positions.set(input.clientOrderId, {
                    id: result.row.id,
                    clientOrderId: input.clientOrderId,
                    symbol: input.symbol,
                    side: input.side,
                    entryPrice: input.entryPrice,
                    size: input.size,
                    leverage: input.leverage,
                    openedAt: input.openedAt,
                    fundingAccrued: parseMoney('0'),
                });
            },
        );

        return this.toPositionView(inserted.row);
    }

    async closePosition(input: IClosePaperPositionInput): Promise<IClosedPaperPositionView> {
        const result = await this.withAuditedTransaction(
            async (manager) => {
                const open = await this.stateRepo.findByClientOrderId(input.clientOrderId, manager);

                if (open === null) {
                    throw new PaperPositionNotFoundException(input.clientOrderId, 'closePosition');
                }

                // R2b-fix Item 5 (MEDIUM): when the caller does not supply
                // `fundingAccrued`, default to the in-memory per-position
                // value so funding the position has accumulated does not
                // silently disappear from the closed-trade history row.
                const inMemory = this.positions.get(open.clientOrderId);
                const fundingAccrued = input.fundingAccrued ?? (inMemory !== undefined ? inMemory.fundingAccrued : parseMoney('0'));
                const fees = input.fees ?? parseMoney('0');
                const slippage = input.slippage ?? parseMoney('0');
                const realisedPnl = this.computeRealisedPnl(open, input.exitPrice);

                const historyDraft: Partial<PaperAccountStateHistoryEntity> = {
                    clientOrderId: open.clientOrderId,
                    symbol: open.symbol,
                    side: open.side,
                    entryPrice: open.entryPrice,
                    exitPrice: input.exitPrice,
                    size: open.size,
                    realisedPnl,
                    fees,
                    fundingAccrued,
                    slippage,
                    closeReason: input.closeReason,
                    openedAt: open.openedAt,
                    closedAt: input.closedAt,
                    mode: 'paper',
                };

                const closed = await this.historyRepo.appendClose(historyDraft, manager);

                await this.stateRepo.deleteByClientOrderId(open.clientOrderId, manager);

                const auditPayload = this.codec.hashOrderedPayload([
                    ['op', 'close'],
                    ['client_order_id', closed.clientOrderId],
                    ['symbol', closed.symbol],
                    ['exit_price', closed.exitPrice.toFixed()],
                    ['size', closed.size.toFixed()],
                    ['realised_pnl', closed.realisedPnl.toFixed()],
                    ['fees', closed.fees.toFixed()],
                    ['funding_accrued', closed.fundingAccrued.toFixed()],
                    ['slippage', closed.slippage.toFixed()],
                    ['close_reason', closed.closeReason],
                    ['closed_at', closed.closedAt.toISOString()],
                ]);

                await this.appendAuditRow(manager, {
                    mutationKind: MutationKindEnum.CLOSE_POSITION,
                    subjectKind: SubjectKindEnum.PAPER_ACCOUNT_STATE_HISTORY,
                    subjectId: closed.id,
                    payloadHash: auditPayload,
                });

                return { closed, realisedPnl, fees, fundingAccrued };
            },
            (result) => {
                this.positions.delete(result.closed.clientOrderId);
                // Settled-cash on close per D4: balance moves by realised PnL,
                // minus fees, plus the funding accrued over the position's
                // lifetime. Funding-on-close keeps the closed-trade record's
                // `funding_accrued` column and the cash ledger in sync.
                const pnlNetOfFees = subtractMoney(result.realisedPnl, result.fees);
                const cashDelta = addMoney(pnlNetOfFees, result.fundingAccrued);
                this.balanceUsdt = addMoney(this.balanceUsdt, cashDelta);
                this.realisedPnlCumulative = addMoney(this.realisedPnlCumulative, result.realisedPnl);
            },
        );

        return this.toClosedView(result.closed);
    }

    async applyFunding(input: IFundingApplicationInput): Promise<void> {
        await this.withAuditedTransaction(
            async (manager) => {
                const auditPayload = this.codec.hashOrderedPayload([
                    ['op', 'funding'],
                    ['client_order_id', input.clientOrderId],
                    ['symbol', input.symbol],
                    ['funding_ts', input.fundingTs.toISOString()],
                    ['funding_amount_usdt', input.fundingAmountUsdt.toFixed()],
                ]);

                // The funding event always writes an audit row even if there
                // is no longer an open position for the symbol — the
                // cumulative still moves and the audit chain documents it.
                // The `subject_id` points at the meta row (the only
                // persistent paper-mode artefact that survives a position
                // close) so the FK-less audit row still references a live
                // row for forensic traversal.
                const meta = await this.metaRepo.findLatest(manager);

                if (meta === null) {
                    throw new PaperStateInvariantException('applyFunding', 'paper_account_state_meta has no row — hydrateOnBoot must run first');
                }

                await this.appendAuditRow(manager, {
                    mutationKind: MutationKindEnum.APPLY_FUNDING,
                    subjectKind: SubjectKindEnum.PAPER_ACCOUNT_STATE_META,
                    subjectId: meta.id,
                    payloadHash: auditPayload,
                });
            },
            () => {
                this.fundingAccruedCumulative = addMoney(this.fundingAccruedCumulative, input.fundingAmountUsdt);

                if (input.clientOrderId !== null) {
                    const position = this.positions.get(input.clientOrderId);

                    if (position !== undefined) {
                        position.fundingAccrued = addMoney(position.fundingAccrued, input.fundingAmountUsdt);
                    }
                }

                // Funding force-flushes the MTM evaluation for the affected
                // symbol (D4 throttle-exemption). R4 fix: route through
                // `forceMtmRecomputeAndEvaluate` so the evaluation fires
                // UNCONDITIONALLY — the prior `flushMtmForSymbolIfPending`
                // call gated on a pending timer, meaning funding that arrived
                // during a quiet tick window produced NO recompute_unrealised
                // + drawdown-evaluate. Runs in onCommit so listeners on
                // PAPER_MARK_TO_MARKET_EVENT see post-commit equity (and
                // never deadlock on the advisory lock while the funding
                // transaction is still open).
                this.forceMtmRecomputeAndEvaluate(input.symbol);
            },
        );
    }

    // Sign-convention contract (R2c TODO): the producer
    // (`PaperFundingAccrualService`) is responsible for computing
    // `funding_pnl = -position_notional × funding_rate × side_sign` per ADR
    // 0032 §D4 BEFORE handing it to `applyFunding`. This service applies the
    // signed amount verbatim — positive credits the account, negative debits
    // it. A contract test will pin this expectation when the producer comes
    // online in R2c.

    async recordSnapshot(input: ISnapshotInput): Promise<void> {
        await this.withAuditedTransaction(
            async (manager) => {
                // D5: equity = balance + sum(unrealised_pnl). Funding is
                // already settled into `balanceUsdt` at position close (per
                // the D4 fix in this wave's Item 5), so there is no separate
                // funding term here.
                const equity = addMoney(this.balanceUsdt, input.unrealisedPnlTotal);
                const nextPeakEquity = isGreaterThanMoney(equity, this.peakEquity) ? equity : this.peakEquity;

                const draft: Partial<PaperAccountSnapshotEntity> = {
                    takenAt: input.takenAt,
                    balance: this.balanceUsdt,
                    equity,
                    realisedPnlCumulative: this.realisedPnlCumulative,
                    fundingAccruedCumulative: this.fundingAccruedCumulative,
                    unrealisedPnlTotal: input.unrealisedPnlTotal,
                    peakEquity: nextPeakEquity,
                    openPositionsCount: input.openPositionsCount,
                    mode: 'paper',
                };

                const inserted = await this.snapshotRepo.insertNew(draft, manager);

                const auditPayload = this.codec.hashOrderedPayload([
                    ['op', 'snapshot'],
                    ['taken_at', inserted.takenAt.toISOString()],
                    ['balance', inserted.balance.toFixed()],
                    ['equity', inserted.equity.toFixed()],
                    ['realised_pnl_cumulative', inserted.realisedPnlCumulative.toFixed()],
                    ['funding_accrued_cumulative', inserted.fundingAccruedCumulative.toFixed()],
                    ['unrealised_pnl_total', inserted.unrealisedPnlTotal.toFixed()],
                    ['peak_equity', inserted.peakEquity.toFixed()],
                    ['open_positions_count', inserted.openPositionsCount],
                ]);

                await this.appendAuditRow(manager, {
                    mutationKind: MutationKindEnum.SNAPSHOT,
                    subjectKind: SubjectKindEnum.PAPER_ACCOUNT_SNAPSHOTS,
                    subjectId: inserted.id,
                    payloadHash: auditPayload,
                });

                return { nextPeakEquity };
            },
            (result) => {
                // peak_equity is a derived AUDITED value — once the snapshot
                // row commits, the in-memory peak follows suit so subsequent
                // in-process drawdown evaluations agree with the persisted
                // reading.
                this.peakEquity = result.nextPeakEquity;
            },
        );
    }

    // R2c.D Item 2 / Item 3 — public entry point for downstream subscribers
    // (PaperDrawdownAbortHandler, PaperFundingAccrualService cap-breach) to
    // write an audit row WITHOUT touching audited table state. Per ADR 0032
    // §D5 the drawdown handler is a downstream subscriber to
    // PAPER_MARK_TO_MARKET_EVENT — it must NOT participate in the producer's
    // transaction. This method opens a SEPARATE audited transaction, takes
    // the advisory lock, and appends a single audit row whose `subject_kind`
    // points at the meta row (the only paper-mode artefact that always
    // exists once hydration has run).
    //
    // The `mutationKind` argument is constrained to the standalone-only
    // kinds — wiring it for OPEN_POSITION / CLOSE_POSITION / APPLY_FUNDING
    // would let a caller bypass the three-table atomic-write discipline
    // that protects audited subject rows.
    async appendStandaloneAuditRow(params: {
        mutationKind: MutationKindEnum.DRAWDOWN_ABORT | MutationKindEnum.FUNDING_CAP_BREACH;
        payloadHash: Buffer;
    }): Promise<void> {
        await this.withAuditedTransaction(
            async (manager) => {
                const meta = await this.metaRepo.findLatest(manager);

                if (meta === null) {
                    throw new PaperStateInvariantException(
                        'appendStandaloneAuditRow',
                        `paper_account_state_meta has no row — hydrateOnBoot must run first (mutationKind=${params.mutationKind})`,
                    );
                }

                await this.appendAuditRow(manager, {
                    mutationKind: params.mutationKind,
                    subjectKind: SubjectKindEnum.PAPER_ACCOUNT_STATE_META,
                    subjectId: meta.id,
                    payloadHash: params.payloadHash,
                });
            },
            () => {
                // No in-memory mutation — the standalone audit row is a
                // forensic-trail breadcrumb, not a state transition. The
                // caller's reaction (halt flag flip, alert) is dispatched
                // OUTSIDE this transaction in its own handler.
            },
        );
    }

    // ----- public reads -----

    getOpenPositions(symbol?: string): IPaperPositionView[] {
        const out: IPaperPositionView[] = [];

        for (const position of this.positions.values()) {
            if (symbol !== undefined && position.symbol !== symbol) {
                continue;
            }

            out.push({
                id: position.id,
                clientOrderId: position.clientOrderId,
                symbol: position.symbol,
                side: position.side,
                entryPrice: position.entryPrice,
                size: position.size,
                leverage: position.leverage,
                openedAt: position.openedAt,
            });
        }

        return out;
    }

    getBalance(): IPaperBalanceView {
        return {
            balanceUsdt: this.balanceUsdt,
            realisedPnlCumulative: this.realisedPnlCumulative,
            fundingAccruedCumulative: this.fundingAccruedCumulative,
            peakEquity: this.peakEquity,
        };
    }

    getRealisedPnlCumulative(): MoneyValue {
        return this.realisedPnlCumulative;
    }

    getFundingAccruedCumulative(): MoneyValue {
        return this.fundingAccruedCumulative;
    }

    getPeakEquity(): MoneyValue {
        return this.peakEquity;
    }

    // R2c.D Item 3 — exposes the per-symbol last-known mark cache so
    // PaperFundingAccrualService can mark each open position to market at
    // the funding timestamp (ADR 0032 §D4: position_notional uses the live
    // mark price). Returns `null` when no tick has been observed for the
    // symbol — callers should fall back to `entryPrice` (the only money
    // already in scope for the position) and log the divergence.
    getLastMarkPrice(symbol: string): MoneyValue | null {
        return this.lastMarkPrices.get(symbol) ?? null;
    }

    // ----- pure deriving helpers (D16 — unrealised PnL is derived, not state) -----

    // Sum of (mark - entry) × size × side_sign across held positions whose
    // symbol appears in `markPrices`. Positions with no mark in the map
    // contribute zero (caller is responsible for supplying a complete map for
    // a meaningful equity calculation).
    recomputeUnrealisedPnl(markPrices: ReadonlyMap<string, MoneyValue>): MoneyValue {
        let total = parseMoney('0');

        for (const position of this.positions.values()) {
            const mark = markPrices.get(position.symbol);

            if (mark === undefined) {
                continue;
            }

            const sideSign = position.side === PositionSideEnum.LONG ? parseMoney('1') : parseMoney('-1');
            const delta = multiplyMoney(subtractMoney(mark, position.entryPrice), multiplyMoney(position.size, sideSign));
            total = addMoney(total, delta);
        }

        return total;
    }

    // Pure boundary check — does NOT mutate state, just evaluates the
    // threshold. The drawdown-abort handler subscribes to
    // PAPER_MARK_TO_MARKET_EVENT (emitted by `notifyMarkPrice` when the
    // throttle fires) and acts on the boolean. Returns `true` when
    // `currentEquity <= peakEquity * DRAWDOWN_ABORT_REMAINING_FRACTION`.
    //
    // Decimal-precise: the remaining fraction is parsed from a string
    // literal so a float subtraction (`1 - 0.15 === 0.8500000000000001`)
    // cannot corrupt the threshold (R2b-fix Item 2).
    evaluateDrawdownAbort(currentEquity: MoneyValue): boolean {
        const threshold = multiplyMoney(this.peakEquity, parseMoney(DRAWDOWN_ABORT_REMAINING_FRACTION_STR));

        return currentEquity.lessThanOrEqualTo(threshold);
    }

    // ----- MTM throttle entry point -----

    // Notify the service that a new mark price has arrived. R2b implementation:
    // coalesce per-symbol updates with a `PAPER_MTM_THROTTLE_MS` debounce; on
    // fire, emit a PAPER_MARK_TO_MARKET_EVENT with the evaluation. The
    // tick-size early-trip + actual subscription wiring lands in R2c.
    notifyMarkPrice(notification: IPaperMarkPriceNotification): void {
        // Always retain the latest tick — when the timer fires we evaluate
        // with the freshest data (no dropped data, only deferred work per D5).
        this.pendingMarkPrices.set(notification.symbol, notification);
        // Warm the per-symbol mark cache so a subsequent flush for a
        // different symbol still has THIS symbol's last mark available
        // for the cross-position equity computation.
        this.lastMarkPrices.set(notification.symbol, notification.markPrice);

        if (this.mtmTimers.has(notification.symbol)) {
            return;
        }

        const timer = setTimeout(() => {
            this.flushMtmForSymbol(notification.symbol);
        }, PAPER_MTM_THROTTLE_MS);

        // `unref` so an unflushed timer never blocks process exit during
        // tests / shutdown.
        if (typeof timer.unref === 'function') {
            timer.unref();
        }

        this.mtmTimers.set(notification.symbol, timer);
    }

    // Force-flush the pending MTM evaluation for a symbol IFF the throttle
    // timer is currently pending. Called by the throttle-timer-fired path;
    // funding's force path uses `forceMtmRecomputeAndEvaluate` instead so
    // it fires regardless of pending-timer state (R4 fix per ADR §D4).
    flushMtmForSymbolIfPending(symbol: string): void {
        if (this.mtmTimers.has(symbol)) {
            this.flushMtmForSymbol(symbol);
        }
    }

    // M11a R4 Item 4A — unconditional MTM recompute + drawdown evaluate +
    // PAPER_MARK_TO_MARKET_EVENT emit. Called from `applyFunding`'s onCommit
    // hook so a funding settlement that arrives during a quiet tick window
    // (no pending throttle timer) still triggers the §D4 force-flush.
    forceMtmRecomputeAndEvaluate(symbol: string): void {
        // Cancel any pending timer for the symbol so we don't double-fire
        // when the timer's deferred callback runs after this synchronous
        // force-evaluate. The pending mark price (if any) is preserved in
        // `lastMarkPrices` already via `notifyMarkPrice`'s warm-cache write.
        const timer = this.mtmTimers.get(symbol);

        if (timer !== undefined) {
            clearTimeout(timer);
            this.mtmTimers.delete(symbol);
            this.pendingMarkPrices.delete(symbol);
        }

        this.emitMarkToMarketEvent(new Date());
    }

    private flushMtmForSymbol(symbol: string): void {
        const timer = this.mtmTimers.get(symbol);

        if (timer !== undefined) {
            clearTimeout(timer);
            this.mtmTimers.delete(symbol);
        }

        const latest = this.pendingMarkPrices.get(symbol);
        this.pendingMarkPrices.delete(symbol);

        if (latest !== undefined) {
            this.lastMarkPrices.set(latest.symbol, latest.markPrice);
        }

        this.emitMarkToMarketEvent(latest !== undefined ? latest.observedAt : new Date());
    }

    // Shared compute-and-emit helper so the throttled path and the force
    // path produce structurally identical events (one source of truth for
    // the equity formula + drawdownPct clamp + drawdown-abort check).
    private emitMarkToMarketEvent(evaluatedAt: Date): void {
        // Compose the FULL mark map from the per-symbol cache so equity
        // reflects every held position's last known mark — not just the
        // symbol that just ticked (R2b-fix Item 5).
        if (this.lastMarkPrices.size === 0) {
            return;
        }

        const marks = new Map<string, MoneyValue>(this.lastMarkPrices);
        const unrealised = this.recomputeUnrealisedPnl(marks);
        const equity = addMoney(this.balanceUsdt, unrealised);
        const drawdownAbort = this.evaluateDrawdownAbort(equity);
        // M11a R4 Item 5: clamp drawdownPct at zero when equity > peak.
        // Negative drawdownPct is mathematically correct (peak hasn't
        // advanced yet for an unrealised gain) but semantically confusing
        // for the drawdown-abort consumer + dashboards — a "drawdown" of
        // -0.02 reads as a contradiction.
        const rawDrawdownPct = this.peakEquity.isZero() ? 0 : Number(subtractMoney(this.peakEquity, equity).dividedBy(this.peakEquity).toFixed(6));
        const drawdownPct = rawDrawdownPct < 0 ? 0 : rawDrawdownPct;

        const event: IPaperMarkToMarketEvent = {
            evaluatedAt,
            equity,
            peakEquity: this.peakEquity,
            drawdownPct,
            drawdownAbortTripped: drawdownAbort,
        };

        this.eventEmitter.emit(PAPER_MARK_TO_MARKET_EVENT, event);
    }

    // ----- boot hydration -----

    private async hydrateOnBoot(): Promise<void> {
        await this.dataSource.transaction(async (manager) => {
            await this.acquireAuditAdvisoryLock(manager);

            // R2c.D Item 4 — chain-integrity walker (ADR 0032 §D6 / §D16).
            // Walks every existing paper_state_audit row, recomputes its
            // HMAC under the per-purpose sub-key, and verifies the
            // prev_row_hash linkage. A break aborts the boot BEFORE any
            // mutation is accepted. Runs inside the SAME advisory-lock
            // transaction as the hydrate so a concurrent appender cannot
            // race the walk (mirrors BootModeChainService boot-sequence).
            await this.verifyAuditChainIntegrity(manager);

            const meta = await this.metaRepo.findLatest(manager);

            if (meta === null) {
                await this.guardAgainstOrphanState(manager);

                await this.initFreshMeta(manager);

                return;
            }

            await this.validateMetaOrThrow(meta);

            await this.restoreFromPersisted(manager);
        });
    }

    // R2c.D Item 4 — HMAC + linkage walker over the paper_state_audit chain.
    // Mirrors BootModeChainService.verifyChainIntegrity exactly so the same
    // tamper / re-link / wrong-subkey class of regression that the boot-mode
    // walk catches is also caught here. A chain break throws
    // PaperAccountStateBootException — the engine refuses to accept any
    // mutation until the operator runbook resolves the break (per ADR 0032
    // §D6 mid-soak chain-break action: CRITICAL, invalidate soak).
    private async verifyAuditChainIntegrity(manager: EntityManager): Promise<void> {
        const subkey = this.subkeys.deriveSubkey(HKDF_INFO_PAPER_STATE_AUDIT);
        const rows = await this.auditRepo.findOrderedAll(manager);
        let expectedPrev: Buffer | null = null;

        for (const row of rows) {
            if (row.prevRowHash === null && expectedPrev !== null) {
                throw new PaperAccountStateBootException(
                    `paper_state_audit chain break at seq=${row.seq}: null prev_row_hash but a prior tip exists (ADR 0032 §D6).`,
                );
            }

            if (row.prevRowHash !== null && expectedPrev === null) {
                throw new PaperAccountStateBootException(
                    `paper_state_audit chain break at seq=${row.seq}: carries prev_row_hash but no prior row exists (ADR 0032 §D6).`,
                );
            }

            if (row.prevRowHash !== null && expectedPrev !== null && !bufferEquals(row.prevRowHash, expectedPrev)) {
                throw new PaperAccountStateBootException(
                    `paper_state_audit chain break at seq=${row.seq}: prev_row_hash does not match prior tip (ADR 0032 §D6).`,
                );
            }

            const recomputed = this.codec.computeHmac(
                subkey,
                this.codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, {
                    seq: String(row.seq),
                    recordedAt: row.recordedAt,
                    mutationKind: row.mutationKind,
                    subjectKind: row.subjectKind,
                    subjectId: row.subjectId,
                    payloadHash: row.payloadHash,
                    prevRowHash: row.prevRowHash,
                }),
            );

            if (!bufferEquals(recomputed, row.thisRowHmac)) {
                throw new PaperAccountStateBootException(
                    `paper_state_audit chain break at seq=${row.seq}: HMAC mismatch (tampered or wrong sub-key) (ADR 0032 §D6).`,
                );
            }

            expectedPrev = row.thisRowHmac;
        }
    }

    // R2b-fix Item 3: when meta is empty but state / snapshot rows exist,
    // the persisted artefacts are orphaned — `initFreshMeta` would silently
    // mint a fresh `soak_start_id` while the orphan rows linger. Refuse to
    // boot; the operator runbook decides between dropping the orphan rows
    // (fresh soak) or restoring the missing meta (partial restore).
    private async guardAgainstOrphanState(manager: EntityManager): Promise<void> {
        const openRows = await this.stateRepo.findAllOpen(manager);
        const latestSnapshot = await this.snapshotRepo.findLatest(manager);

        if (openRows.length === 0 && latestSnapshot === null) {
            return;
        }

        const orphans: string[] = [];

        if (openRows.length > 0) {
            orphans.push(`paper_account_state (${openRows.length} open rows)`);
        }

        if (latestSnapshot !== null) {
            orphans.push('paper_account_snapshots (non-empty)');
        }

        throw new PaperAccountStateBootException(
            `paper_account_state_meta is empty but the following tables are non-empty: ${orphans.join(', ')}. ` +
                'Refusing to mint a fresh soak meta over orphaned state. Operator runbook: either drop the ' +
                'orphan rows for a fresh soak, or restore the missing paper_account_state_meta row from backup ' +
                '(ADR 0032 §D16).',
        );
    }

    private async initFreshMeta(manager: EntityManager): Promise<void> {
        const startingEquity = parseMoney(String(this.appConfig.paperStartingEquityUsdt));
        this.balanceUsdt = startingEquity;
        this.peakEquity = startingEquity;
        this.realisedPnlCumulative = parseMoney('0');
        this.fundingAccruedCumulative = parseMoney('0');
        this.positions.clear();

        const simulatorConfigHash = this.computeSimulatorConfigHash();
        const bootstrapFingerprint = this.computeBootstrapFingerprint();

        const metaDraft: Partial<PaperAccountStateMetaEntity> = {
            soakStartId: randomUUID(),
            soakStartTs: new Date(),
            seedVersionLabel: PAPER_SIMULATOR_SEED_VERSION_LABEL,
            hkdfInfoVersion: PAPER_HKDF_INFO_VERSION,
            simulatorConfigHash,
            bootstrapAtStartFingerprint: bootstrapFingerprint,
        };

        const inserted = await this.metaRepo.insertNew(metaDraft, manager);

        const auditPayload = this.codec.hashOrderedPayload([
            ['op', 'meta_init'],
            ['soak_start_id', inserted.soakStartId],
            ['soak_start_ts', inserted.soakStartTs.toISOString()],
            ['seed_version_label', inserted.seedVersionLabel],
            ['hkdf_info_version', inserted.hkdfInfoVersion],
            ['simulator_config_hash', inserted.simulatorConfigHash],
            ['bootstrap_at_start_fingerprint', inserted.bootstrapAtStartFingerprint],
            ['starting_equity_usdt', startingEquity.toFixed()],
        ]);

        await this.appendAuditRow(manager, {
            mutationKind: MutationKindEnum.META_INIT,
            subjectKind: SubjectKindEnum.PAPER_ACCOUNT_STATE_META,
            subjectId: inserted.id,
            payloadHash: auditPayload,
        });

        this.logger.warn(
            `PaperAccountStateService fresh soak META_INIT: soak_start_id=${inserted.soakStartId} starting_equity_usdt=${startingEquity.toFixed()}`,
        );
    }

    private async validateMetaOrThrow(meta: PaperAccountStateMetaEntity): Promise<void> {
        const currentHash = this.computeSimulatorConfigHash();

        if (meta.simulatorConfigHash !== currentHash) {
            throw new PaperAccountStateBootException(
                `simulator_config_hash mismatch: stored=${meta.simulatorConfigHash} current=${currentHash} (ADR 0032 §D3). ` +
                    'A simulator-config change between boots invalidates the soak — restart with the committed config or initialise a new soak.',
            );
        }
    }

    private async restoreFromPersisted(manager: EntityManager): Promise<void> {
        // Open positions are the persisted source-of-truth for in-memory
        // hydration (D16). Cumulative counters come from the most recent
        // snapshot row; on a fresh boot before the first snapshot, they are
        // zeroed and the next snapshot will record the baseline.
        const openRows = await this.stateRepo.findAllOpen(manager);
        const latestSnapshot = await this.snapshotRepo.findLatest(manager);

        this.positions.clear();

        for (const row of openRows) {
            this.positions.set(row.clientOrderId, {
                id: row.id,
                clientOrderId: row.clientOrderId,
                symbol: row.symbol,
                side: row.side,
                entryPrice: row.entryPrice,
                size: row.size,
                leverage: row.leverage,
                openedAt: row.openedAt,
                fundingAccrued: parseMoney('0'),
            });
        }

        if (latestSnapshot !== null) {
            this.balanceUsdt = latestSnapshot.balance;
            // M11a R4 Item 5: defence-in-depth — clamp peakEquity at the
            // configured PAPER_STARTING_EQUITY_USDT floor. A snapshot row
            // carrying a sub-starting-equity peak (introduced by a future
            // bug or a hand-edited backup) must NOT slide the drawdown-abort
            // threshold downward; the safer-side rule from D5 is "peak is
            // monotone-non-decreasing from the soak's starting equity".
            const startingEquityFloor = parseMoney(String(this.appConfig.paperStartingEquityUsdt));
            this.peakEquity = isGreaterThanMoney(latestSnapshot.peakEquity, startingEquityFloor) ? latestSnapshot.peakEquity : startingEquityFloor;
            this.realisedPnlCumulative = latestSnapshot.realisedPnlCumulative;
            this.fundingAccruedCumulative = latestSnapshot.fundingAccruedCumulative;
        } else {
            // R2b-fix Item 4: warm restart with persisted positions but no
            // snapshot. Reset peak to PAPER_STARTING_EQUITY_USDT (safer-side
            // per D5 monotone-peak rule), explicitly zero the cumulatives
            // (don't trust class-init residuals), and WARN the operator —
            // the audit chain is the source of truth for reconciliation.
            const startingEquity = parseMoney(String(this.appConfig.paperStartingEquityUsdt));
            this.balanceUsdt = startingEquity;
            this.peakEquity = startingEquity;
            this.realisedPnlCumulative = parseMoney('0');
            this.fundingAccruedCumulative = parseMoney('0');

            if (openRows.length > 0) {
                this.logger.warn(
                    `PaperAccountStateService warm restart: ${openRows.length} persisted open position(s) ` +
                        `but no paper_account_snapshots row — peak_equity reset to PAPER_STARTING_EQUITY_USDT ` +
                        `(${startingEquity.toFixed()}, safer-side per ADR 0032 §D5). ` +
                        `Operator: reconcile against paper_state_audit before continuing the soak.`,
                );
            }
        }

        this.logger.log(
            `PaperAccountStateService restored from persistence: open_positions=${this.positions.size} balance_usdt=${this.balanceUsdt.toFixed()} peak_equity=${this.peakEquity.toFixed()}`,
        );
    }

    // ----- shared internals -----

    // R2b-fix Item 1 — the single audited-mutation primitive.
    //
    // Opens one TypeORM transaction, takes the per-chain advisory lock, runs
    // the audited writes in `body`, captures the result, and ONLY after the
    // transaction body has resolved cleanly does it invoke `onCommit` for
    // the in-memory mutations. A throw inside `body` rolls back the audit
    // row + audited table writes AND never runs `onCommit` — the in-memory
    // store and the persisted projection cannot diverge.
    //
    // Why a helper, not a comment: the lexical split (audited writes inside
    // `body`, in-memory writes inside `onCommit`) is unmissable to a
    // reviewer. A future mutator copying the pattern from openPosition /
    // closePosition / applyFunding / recordSnapshot cannot accidentally
    // mutate `this.positions` before the audit row commits.
    private async withAuditedTransaction<T>(body: (manager: EntityManager) => Promise<T>, onCommit: (result: T) => void): Promise<T> {
        const result = await this.dataSource.transaction(async (manager) => {
            await this.acquireAuditAdvisoryLock(manager);

            return body(manager);
        });

        onCommit(result);

        return result;
    }

    private async appendAuditRow(
        manager: EntityManager,
        params: { mutationKind: MutationKindEnum; subjectKind: SubjectKindEnum; subjectId: string; payloadHash: Buffer },
    ): Promise<PaperStateAuditEntity> {
        // R2b-fix Item 5: byte-length guard so an upstream codec misbehaviour
        // surfaces here as a clear typed failure (and never produces an
        // unaudited audit row with a malformed payload hash).
        if (params.payloadHash.byteLength !== PAPER_STATE_AUDIT_PAYLOAD_HASH_BYTES) {
            throw new PaperStateInvariantException(
                'appendAuditRow',
                `payloadHash byteLength=${params.payloadHash.byteLength} expected=${PAPER_STATE_AUDIT_PAYLOAD_HASH_BYTES} ` +
                    `(SHA-256 width). Codec misbehaviour — refusing to write a malformed audit row.`,
            );
        }

        const subkey = this.subkeys.deriveSubkey(HKDF_INFO_PAPER_STATE_AUDIT);
        const tip = await this.auditRepo.findTip(manager);
        const prevRowHash = tip === null ? null : tip.thisRowHmac;

        return this.auditRepo.appendInTransaction(manager, {
            mutationKind: params.mutationKind,
            subjectKind: params.subjectKind,
            subjectId: params.subjectId,
            payloadHash: params.payloadHash,
            prevRowHash,
            computeHmac: (payload) => this.codec.computeHmac(subkey, this.codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, payload)),
        });
    }

    private async acquireAuditAdvisoryLock(manager: EntityManager): Promise<void> {
        await manager.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [PAPER_STATE_AUDIT_ADVISORY_LOCK_KEY.toString()]);
    }

    private computeRealisedPnl(open: PaperAccountStateEntity, exitPrice: MoneyValue): MoneyValue {
        const sideSign = open.side === PositionSideEnum.LONG ? parseMoney('1') : parseMoney('-1');

        return multiplyMoney(subtractMoney(exitPrice, open.entryPrice), multiplyMoney(open.size, sideSign));
    }

    private toPositionView(row: PaperAccountStateEntity): IPaperPositionView {
        return {
            id: row.id,
            clientOrderId: row.clientOrderId,
            symbol: row.symbol,
            side: row.side,
            entryPrice: row.entryPrice,
            size: row.size,
            leverage: row.leverage,
            openedAt: row.openedAt,
        };
    }

    private toClosedView(row: PaperAccountStateHistoryEntity): IClosedPaperPositionView {
        return {
            id: row.id,
            clientOrderId: row.clientOrderId,
            symbol: row.symbol,
            side: row.side,
            entryPrice: row.entryPrice,
            size: row.size,
            // R2b-fix Item 5 (LOW): the history row does not persist leverage;
            // surfaced as 0 here. The soak evaluator (D10/D16) reads the
            // closed-trade record for trade count / PnL, not leverage. Defer
            // a real leverage column to R3 if downstream wants it.
            leverage: 0,
            openedAt: row.openedAt,
            exitPrice: row.exitPrice,
            closedAt: row.closedAt,
            closeReason: row.closeReason as PaperCloseReasonEnum,
            realisedPnl: row.realisedPnl,
            fees: row.fees,
            fundingAccrued: row.fundingAccrued,
            slippage: row.slippage,
        };
    }

    // ADR 0032 §D3 — the simulator config hash is sourced from the M7
    // simulator config committed to version control. R2b architect-
    // adjudication item: no single committed config file exists at a stable
    // path today (config is constructed at runtime from
    // `strategy_versions.params`). Until the architect adjudicates the
    // canonical source, hash a stable empty-payload sentinel so the META_INIT
    // row carries a deterministic value, and emit a WARN log so the gap is
    // visible. R3.1 will replace this with the resolved hash source.
    //
    // R2b-fix Item 5 (LOW): the hash is memoised per process so the WARN log
    // fires once per boot, not per call.
    private computeSimulatorConfigHash(): string {
        if (this.cachedSimulatorConfigHash !== null) {
            return this.cachedSimulatorConfigHash;
        }

        const SENTINEL_PAYLOAD = Buffer.from('paper_simulator_config_hash:R2b-pending-architect-adjudication', 'utf8');
        const digest = createHash('sha256').update(SENTINEL_PAYLOAD).digest('hex');
        this.logger.warn(
            `simulator_config_hash sourced from R2b sentinel (no committed M7 config file at a stable path yet). ` +
                `Hash=${digest.slice(0, 16)}… — see ADR 0032 §D3 + R2b work-log architect-adjudication item.`,
        );
        this.cachedSimulatorConfigHash = digest;

        return digest;
    }

    private computeBootstrapFingerprint(): string {
        return createHash('sha256').update(this.appConfig.authBootstrapSecret, 'utf8').digest('hex');
    }
}

// M11a R4 Item 5: bufferEquals extracted to common/utils so the three
// HMAC-chain walkers (boot-mode-history, paper-state-audit, nullity-probe
// preflight) share one constant-time comparator instead of each carrying a
// private copy.
