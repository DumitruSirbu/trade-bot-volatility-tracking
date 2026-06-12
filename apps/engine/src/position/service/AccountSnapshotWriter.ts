import { ExchangeEnvironmentEnum, IAccountStateSource, IPriceUpdateEvent, PositionStateEnum, TransactionTypeEnum } from '@bot/shared';
import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';

import { PRICE_UPDATE_EVENT } from '../../common/const';
import { Money, MoneyValue } from '../../common/utils/money';
import { AppConfigService } from '../../config/service';
import { ACCOUNT_STATE_SOURCE } from '../../exchange/interface';
import { RiskGateService } from '../../risk/service/RiskGateService';
import { ACCOUNT_SNAPSHOT_INTERVAL_MS, SAME_MINUTE_BUCKET_MS, SETTLE_CURRENCY } from '../const';
import { AccountSnapshotEntity } from '../entity';
import { PositionEntity } from '../entity';
import { AccountSnapshotRepository } from '../repository/AccountSnapshotRepository';
import { PositionRepository } from '../repository/PositionRepository';
import { TransactionRepository } from '../repository/TransactionRepository';
import { computeUnrealizedPnl } from '../util/pnlMath';

// R1.3.3 mechanical move: const declarations relocated to
// `position/const/accountSnapshotConsts.ts`. Re-exports preserved so
// existing imports against the service path keep compiling. The boot
// pipeline (`EngineBootstrapService`) and the W7 spec both consume
// `ACCOUNT_SNAPSHOT_DRIFT_TOLERANCE_USDT` / `ACCOUNT_SNAPSHOT_INTERVAL_MS`
// through this re-export today.
export { ACCOUNT_SNAPSHOT_DRIFT_TOLERANCE_USDT, ACCOUNT_SNAPSHOT_INTERVAL_MS } from '../const';

// Trigger source for a snapshot write. Drives the same-minute skip behavior:
// only SCHEDULED ticks can be skipped; BOOT and DRIFT_RESOLVED always write
// (the audit-trail value is too high to skip).
export type SnapshotTrigger = 'scheduled' | 'boot' | 'drift_resolved';

// M6 W7 (ADR 0012 §6). Periodic + drift-forced + boot writer for
// `account_snapshots`. Subscribes to `price.update` to maintain a per-symbol
// latest-mark cache used for the unrealized-PnL computation across open
// positions (mirror of the W3 / W6 idiom — same source the strategy and
// monitor consume so live and backtest match).
//
// Each snapshot row carries:
//   - balance: exchange wallet USDT balance (fetchBalance().total)
//   - unrealized_pnl_price: SUM over open positions of (computeUnrealizedPnl.pricePnl)
//   - unrealized_pnl_funding: SUM over open positions of (computeUnrealizedPnl.fundingPnl)
//   - unrealized_pnl: their sum (== SUM of computeUnrealizedPnl.total)
//   - equity: balance + unrealized_pnl
//
// Concurrency: the `@Interval` scheduler and `writeNow()` callers can in
// theory overlap. The `running` guard ensures at most one write is in flight;
// a contention-time call returns silently (the in-flight write captures the
// same nowMs window).
//
// CONTRACT GAP — accrued funding (ADR 0012 §4a): the next-funding-rate cache
// is NOT implemented in W7. `accruedFunding` is passed as zero to
// `computeUnrealizedPnl` for every position. The settled-funding component
// (sum of `transactions.cashflow` where type=FUNDING) IS aggregated correctly
// and lands in `unrealized_pnl_funding`. The accrued-funding feed lands in a
// future micro-wave once `bot-shared-maintainer` and the exchange client land
// the rate-poll cache (~3 new load-bearing files; out of W7's ≤5 budget).
// The dashboard accepts the 0.0001-of-notional miss per §4a.
@Injectable()
export class AccountSnapshotWriter {
    private readonly logger = new Logger(AccountSnapshotWriter.name);

    // Per-symbol latest mark price from `price.update`. Same in-memory cache
    // shape as the W3 monitor / W6 instrumentor — the writer composes them.
    private readonly latestMarkPriceBySymbol = new Map<string, MoneyValue>();

    private running = false;

    // Last-written wall-minute bucket (ms / 60_000, floored). Drives the
    // §6 same-minute skip — scheduler ticks within the same minute as a
    // recent write are skipped. -1 sentinel = "no snapshot written yet."
    private lastWrittenMinuteBucket = -1;
    // M11a R2a Item 2 (BLOCKER B2). One-shot INFO log so the skip-in-PAPER
    // message lands once per process, not every interval tick.
    private paperSkipLogged = false;

    constructor(
        // M11a R2a.4 (ADR 0032 §3 D14): rebound from EXCHANGE_CLIENT to
        // ACCOUNT_STATE_SOURCE so PAPER mode reads simulated balances
        // (PaperAccountStateSource) instead of touching the live exchange.
        @Inject(ACCOUNT_STATE_SOURCE) private readonly accountState: IAccountStateSource,
        private readonly positions: PositionRepository,
        private readonly transactions: TransactionRepository,
        private readonly snapshots: AccountSnapshotRepository,
        // M6 W8.5 boot-race guard. RiskGateService.isRecoveryReady() is the
        // canonical "boot is done" signal (set at phase 9). forwardRef because
        // RiskModule imports PositionModule for repositories — the cycle is a
        // read-only no-op at construction time.
        @Inject(forwardRef(() => RiskGateService))
        private readonly riskGate: RiskGateService,
        // M11a R2a BLOCKER B2 (ADR 0032 §3). Env-gates the periodic snapshot
        // writer AND the boot-time phase-7 `writeNow` insert under PAPER.
        // R2b wires `PaperAccountStateService` and a sibling
        // `paper_account_snapshots` writer that goes through the three-table
        // atomic-write path (D16). Until then PAPER is a no-op (logged once).
        private readonly appConfig: AppConfigService,
    ) {}

    // ADR 0012 §6 — primary periodic writer. Honors the same-minute skip rule;
    // tolerates exchange errors (logs + skips the tick, next interval retries).
    @Interval(ACCOUNT_SNAPSHOT_INTERVAL_MS)
    async scheduledTick(): Promise<void> {
        // M6 W8.5 boot-race guard. Skip scheduled ticks until phase 9 opens
        // the orchestrator; `writeNow(...)` (used by phase 7 boot snapshot
        // and reconciliation drift-forced triggers) bypasses this guard.
        if (!this.riskGate.isRecoveryReady()) {
            this.logger.debug('scheduled account_snapshot tick skipped: boot recovery not yet complete');

            return;
        }

        try {
            await this.writeSnapshot(Date.now(), 'scheduled');
        } catch (cause) {
            this.logger.error(`scheduled snapshot failed: ${this.describe(cause)} - next tick retries`);
        }
    }

    // Public entry point for boot pipeline (W8 phase 7) and reconciliation
    // drift-forced triggers. Bypasses the same-minute skip — the caller has
    // an explicit reason to want a fresh audit row. Returns the persisted
    // entity or null on failure (caller may log; failures are non-fatal).
    async writeNow(nowMs: number, trigger: SnapshotTrigger): Promise<AccountSnapshotEntity | null> {
        try {
            return await this.writeSnapshot(nowMs, trigger);
        } catch (cause) {
            this.logger.error(`writeNow trigger=${trigger} failed: ${this.describe(cause)}`);

            return null;
        }
    }

    // Subscribes to the same `price.update` event the strategy / monitor /
    // instrumentor consume. Maintains the per-symbol latest-mark cache used
    // to compute unrealized PnL across open positions at snapshot time.
    @OnEvent(PRICE_UPDATE_EVENT)
    onPriceUpdate(event: IPriceUpdateEvent): void {
        const price = this.parsePrice(event.price);

        if (price === null) {
            return;
        }

        this.latestMarkPriceBySymbol.set(event.symbol, price);
    }

    // ─── internals ─────────────────────────────────────────────────────────

    private async writeSnapshot(nowMs: number, trigger: SnapshotTrigger): Promise<AccountSnapshotEntity | null> {
        // M11a R2a Item 2 (BLOCKER B2 — ADR 0032 §3). PAPER mode has no live
        // wallet to snapshot and writes to `paper_account_snapshots` (D16)
        // are owned by R2b's atomic three-table path. Until then the writer
        // is a no-op so `accountState.fetchBalance()` is not called against
        // the empty `PaperAccountStateSource` stub (the call itself is
        // harmless — returns []; the skip is for clarity in logs and to
        // avoid emitting a misleading `account_snapshot written balance=0`
        // line every interval).
        if (this.appConfig.exchangeEnv === ExchangeEnvironmentEnum.PAPER) {
            if (!this.paperSkipLogged) {
                this.logger.log(`account_snapshot writer paused in PAPER mode (trigger=${trigger}); awaiting R2b PaperAccountStateService`);
                this.paperSkipLogged = true;
            }

            return null;
        }

        if (this.running) {
            this.logger.debug(`snapshot skipped: previous write still running (trigger=${trigger})`);

            return null;
        }

        // Same-minute skip applies to SCHEDULED only (ADR 0012 §6 + W7 item 3).
        // Boot and drift-resolved triggers always write.
        if (trigger === 'scheduled' && this.isSameMinuteAsLastWrite(nowMs)) {
            this.logger.debug('scheduled snapshot skipped: same wall-minute as last write');

            return null;
        }

        this.running = true;

        try {
            const row = await this.buildAndPersist(nowMs, trigger);
            this.lastWrittenMinuteBucket = this.minuteBucket(nowMs);

            return row;
        } finally {
            this.running = false;
        }
    }

    private async buildAndPersist(nowMs: number, trigger: SnapshotTrigger): Promise<AccountSnapshotEntity> {
        const balance = await this.fetchUsdtBalance();
        const openPositions = await this.loadOpenPositions();
        const { unrealizedPnlPrice, unrealizedPnlFunding } = await this.aggregateUnrealized(openPositions);
        const unrealizedPnl = unrealizedPnlPrice.plus(unrealizedPnlFunding);
        const equity = balance.plus(unrealizedPnl);

        // R1.3c — BaseRepository pattern: build entity via the named factory on the
        // concrete repository, then save. Removes the `as AccountSnapshotEntity` cast
        // and routes the construction through the typed `DeepPartial<T>` path.
        const entity = this.snapshots.buildSnapshot({
            ts: new Date(nowMs),
            balance,
            equity,
            unrealizedPnl,
            unrealizedPnlPrice,
            unrealizedPnlFunding,
        });
        const row = await this.snapshots.save(entity);

        this.logger.log(
            `account_snapshot written trigger=${trigger} balance=${balance.toFixed()} ` +
                `equity=${equity.toFixed()} unrealized=${unrealizedPnl.toFixed()} ` +
                `(price=${unrealizedPnlPrice.toFixed()} funding=${unrealizedPnlFunding.toFixed()}) ` +
                `openPositions=${openPositions.length}`,
        );

        return row;
    }

    private async fetchUsdtBalance(): Promise<MoneyValue> {
        const balances = await this.accountState.fetchBalance();
        const usdt = balances.find((b) => b.asset === SETTLE_CURRENCY);

        if (usdt === undefined) {
            this.logger.warn(`fetchBalance returned no ${SETTLE_CURRENCY} entry - using 0`);

            return new Money(0);
        }

        return new Money(usdt.total);
    }

    // M31 R1 (HIGH): live-risk view only (qty > 0 AND non-terminal). A qty=0 zombie row is
    // lifecycle residue carrying no live exposure and would otherwise phantom-inflate the
    // account snapshot's unrealized/exposure aggregate. `findLiveRisk` already excludes CLOSED,
    // so no further state filter is needed; flat residue contributes zero unrealized anyway.
    private async loadOpenPositions(): Promise<PositionEntity[]> {
        return this.positions.findLiveRisk();
    }

    private async aggregateUnrealized(positions: PositionEntity[]): Promise<{ unrealizedPnlPrice: MoneyValue; unrealizedPnlFunding: MoneyValue }> {
        let unrealizedPnlPrice = new Money(0);
        let unrealizedPnlFunding = new Money(0);

        for (const position of positions) {
            const contribution = await this.computeContribution(position);

            if (contribution === null) {
                continue;
            }

            unrealizedPnlPrice = unrealizedPnlPrice.plus(contribution.pricePnl);
            unrealizedPnlFunding = unrealizedPnlFunding.plus(contribution.fundingPnl);
        }

        return { unrealizedPnlPrice, unrealizedPnlFunding };
    }

    private async computeContribution(position: PositionEntity): Promise<{ pricePnl: MoneyValue; fundingPnl: MoneyValue } | null> {
        // Skip drift-state positions — instrumentation and PnL on drifted state
        // would corrupt the snapshot (ADR 0013 §2 cousin rule).
        if (position.state === PositionStateEnum.RECONCILING || position.state === PositionStateEnum.MANUAL_ADOPTED_UNMANAGED) {
            return null;
        }

        const markPrice = this.latestMarkPriceBySymbol.get(position.symbol);

        if (markPrice === undefined) {
            // No price tick observed yet for this symbol since the writer
            // started — skip rather than guess. Next tick the cache will be
            // populated and the position contributes.
            return null;
        }

        const aggregates = await this.aggregateTransactions(position.id);

        const breakdown = computeUnrealizedPnl({
            side: position.side,
            qty: position.qty,
            entryPrice: position.entryPrice,
            markPrice,
            feesPaid: aggregates.feesPaid,
            settledFunding: aggregates.settledFunding,
            // ADR 0012 §4a — accrued funding cache is a W7+ contract gap (see
            // class-level note). Pass zero; the dashboard tolerates the miss.
            accruedFunding: new Money(0),
        });

        return { pricePnl: breakdown.pricePnl, fundingPnl: breakdown.fundingPnl };
    }

    private async aggregateTransactions(positionId: number): Promise<{ feesPaid: MoneyValue; settledFunding: MoneyValue }> {
        const txs = await this.transactions.findByPosition(positionId);
        let feesPaid = new Money(0);
        let settledFunding = new Money(0);

        for (const tx of txs) {
            if (tx.type === TransactionTypeEnum.FUNDING) {
                settledFunding = settledFunding.plus(tx.cashflow);
                continue; // ADR 0012 §1b: funding rows carry fee=0 by contract
            }

            feesPaid = feesPaid.plus(tx.fee);
        }

        return { feesPaid, settledFunding };
    }

    private isSameMinuteAsLastWrite(nowMs: number): boolean {
        return this.minuteBucket(nowMs) === this.lastWrittenMinuteBucket;
    }

    private minuteBucket(nowMs: number): number {
        return Math.floor(nowMs / SAME_MINUTE_BUCKET_MS);
    }

    private parsePrice(raw: string): MoneyValue | null {
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

    private describe(cause: unknown): string {
        if (cause instanceof Error) {
            return cause.message;
        }

        return String(cause);
    }
}
