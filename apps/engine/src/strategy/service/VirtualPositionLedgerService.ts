import {
    IVirtualCloseInput,
    IVirtualClosedTradeLogEntry,
    IVirtualGateInput,
    IVirtualGateOutcome,
    IVirtualLedgerSnapshot,
    IVirtualMutationResult,
    IVirtualOpenInput,
    IVirtualOpenPosition,
    IVirtualPositionLedger,
} from '@bot/shared';
import { Injectable, Logger, Scope } from '@nestjs/common';
import Decimal from 'decimal.js';

import { SHADOW_TAKER_FEE_PCT, VIRTUAL_LEDGER_CONSECUTIVE_LOSS_HALT_THRESHOLD } from '../const';

// Reason discriminator the orchestrator passes into the close-by-symbol path.
// 'sl'/'tp'/'time_stop' are in-pass resolved-exit reasons from the fill simulator
// (ADR 0029 §2.1.3 close path 1); 'force_close' is an end-of-window or in-pass
// same-bar close; 'reverse_signal' fires when the same shadow version emits an
// opposite-side open on a later event (close path 3).
export type ShadowCloseBySymbolReason = 'sl' | 'tp' | 'force_close' | 'time_stop' | 'reverse_signal';

// Internal-only extension of the shared closed-trade log entry. Adds the
// risk-day on which the position was OPENED so trades-opened-today is counted
// by open-day, not close-day. The shared type is unchanged — external callers
// (closeBySymbol return, forceCloseAllPositions) still see a
// `IVirtualClosedTradeLogEntry`-compatible shape.
interface IInternalClosedTradeLogEntry extends IVirtualClosedTradeLogEntry {
    readonly openedRiskDayUtcDate: string;
}

// M11a W0.6.1 (ADR 0029 §2.1). Concrete in-memory implementation of the per-
// shadow-version virtual ledger. Each non-executed strategy version (v0/v2/v3)
// owns an isolated instance — the W2 orchestrator's registry resolves one per
// version. The ledger is the gate AROUND the pure strategies, never inside
// them: strategies emit pure decisions, the orchestrator routes those through
// this ledger's `evaluateGates`, and only successful gate outcomes route into
// the fill simulator + `tryOpen`/`tryClose` (ADR 0029 §2.2 main loop).
//
// `scope: TRANSIENT` so `ModuleRef.resolve(VirtualPositionLedgerService)`
// returns a fresh instance per resolve. The W2 registry seeds and caches the
// per-version instance; this class does not own the cache.
//
// State scope (ADR 0029 §2.1.2):
//   - `openPositions`              : Map<virtualOrderId, IVirtualOpenPosition>
//   - `closedTrades`               : per-(riskDay, closeReason) log for the
//                                    consecutive-loss and trades-per-day gates
//   - `haltedUntilRiskDayUtcDate`  : null when not halted; set on the
//                                    `halt_after_consecutive_losses` trip
//   - `lastEventIdProcessed`       : idempotency cursor for restart replay
//   - `processedEventIds`          : in-memory dedup set for tryOpen/tryClose
//                                    idempotency (replay must not double-fire)
//
// Money fields arrive as decimal-as-string (ISimulatedFill / IVirtualOpenInput
// contracts); internal math uses `decimal.js` and serializes back to string
// at the boundary. No JS `number` arithmetic on monetary values.
@Injectable({ scope: Scope.TRANSIENT })
export class VirtualPositionLedgerService implements IVirtualPositionLedger {
    private readonly logger = new Logger(VirtualPositionLedgerService.name);

    private readonly openPositions = new Map<string, IVirtualOpenPosition>();
    // Internal log entry — extends the shared `IVirtualClosedTradeLogEntry`
    // with `openedRiskDayUtcDate` so the trades-opened-today gate can count by
    // the OPEN day (not the close day). Without this, a trade opened yesterday
    // and closed today would be counted toward today's opens cap.
    private readonly closedTrades: IInternalClosedTradeLogEntry[] = [];
    // Map<virtualOrderId, openedRiskDayUtcDate> — captured at `tryOpen` so the
    // close path can stamp `openedRiskDayUtcDate` onto the closed log entry.
    private readonly openedRiskDayByVirtualOrderId = new Map<string, string>();
    private readonly processedEventIds = new Set<string>();

    private haltedUntilRiskDayUtcDate: string | null = null;
    private lastEventIdProcessed = '';

    // ----- Read (pure projections) -----

    snapshotForDecision(nowMs: number): IVirtualLedgerSnapshot {
        return {
            riskDayUtcDate: deriveRiskDayUtcDate(nowMs),
            openPositions: Array.from(this.openPositions.values()),
            haltedUntilRiskDayUtcDate: this.haltedUntilRiskDayUtcDate,
            lastEventIdProcessed: this.lastEventIdProcessed,
        };
    }

    isHalted(nowMs: number): boolean {
        if (this.haltedUntilRiskDayUtcDate === null) {
            return false;
        }

        // Halt clears once the current risk day strictly passes the halt day.
        // Same UTC-date derivation v1's RiskGateService uses, so the halt
        // gate behaves identically across the live and shadow paths. Self-
        // heal the stale field so snapshots never expose an expired halt day
        // after rollover (reviewer W4 HIGH).
        const currentRiskDay = deriveRiskDayUtcDate(nowMs);

        if (currentRiskDay > this.haltedUntilRiskDayUtcDate) {
            this.haltedUntilRiskDayUtcDate = null;

            return false;
        }

        return true;
    }

    countOpenPositions(): number {
        return this.openPositions.size;
    }

    countTradesOpenedOnRiskDay(riskDayUtcDate: string): number {
        let opens = 0;

        for (const position of this.openPositions.values()) {
            if (deriveRiskDayUtcDate(position.openedAtMs) === riskDayUtcDate) {
                opens += 1;
            }
        }

        for (const closed of this.closedTrades) {
            // Count by the risk day on which the position was OPENED — NOT
            // the close day. A trade opened yesterday and closed today must
            // count toward yesterday's opens, not today's. Matches v1's
            // `countOpenedOnUtcDayForSymbol` semantics (opens-today only).
            if (closed.openedRiskDayUtcDate === riskDayUtcDate) {
                opens += 1;
            }
        }

        return opens;
    }

    countConsecutiveLossesInRiskDay(riskDayUtcDate: string): number {
        const dayClosed = this.closedTrades
            .filter((entry) => entry.riskDayUtcDate === riskDayUtcDate)
            .slice()
            .sort((left, right) => left.closedAtMs - right.closedAtMs);

        let streak = 0;

        for (const entry of dayClosed) {
            // A force_close exit is neither an arming loss nor a streak-resetting
            // win — it is an in-pass end-of-window close, not a strategy-driven
            // outcome. Skipping it means N consecutive force_close exits never
            // halt the version, while a genuine sl/tp/time_stop loss that lands
            // slightly negative still arms the streak.
            if (entry.closeReason === 'force_close') {
                continue;
            }

            if (new Decimal(entry.realizedPnl).isNegative()) {
                streak += 1;
            } else {
                streak = 0;
            }
        }

        return streak;
    }

    // ----- Gate -----

    evaluateGates(input: IVirtualGateInput): IVirtualGateOutcome {
        if (this.isHalted(input.nowMs)) {
            return { allowed: false, rejectReason: 'halted' };
        }

        const consecutiveLosses = this.countConsecutiveLossesInRiskDay(input.riskDayUtcDate);

        if (consecutiveLosses >= input.haltAfterConsecutiveLosses) {
            return { allowed: false, rejectReason: 'halt_after_consecutive_losses' };
        }

        const tradesToday = this.countTradesOpenedOnRiskDay(input.riskDayUtcDate);

        if (tradesToday >= input.maxTradesPerDay) {
            return { allowed: false, rejectReason: 'max_trades_per_day_reached' };
        }

        if (this.openPositions.size >= input.maxOpenPositions) {
            return { allowed: false, rejectReason: 'max_open_positions_reached' };
        }

        return { allowed: true };
    }

    // ----- Mutate (idempotent on eventId) -----

    tryOpen(open: IVirtualOpenInput): IVirtualMutationResult {
        if (this.processedEventIds.has(open.eventId)) {
            return { success: false, reason: 'duplicate_event_id' };
        }

        if (this.openPositions.has(open.virtualOrderId)) {
            return { success: false, reason: 'duplicate_virtual_order_id' };
        }

        const position: IVirtualOpenPosition = {
            symbol: open.symbol,
            side: open.side,
            openedAtMs: open.nowMs,
            openedAtEventId: open.eventId,
            entryPrice: open.entryPrice,
            qty: open.qty,
            stopLoss: open.stopLoss,
            takeProfit: open.takeProfit,
            virtualOrderId: open.virtualOrderId,
        };

        this.openPositions.set(open.virtualOrderId, position);
        this.openedRiskDayByVirtualOrderId.set(open.virtualOrderId, open.riskDayUtcDate);
        this.markEventProcessed(open.eventId);

        return { success: true };
    }

    // The arm threshold rides on the close input (`consecutiveLossHaltThreshold`)
    // so it never diverges from the per-call gate value the caller already passes
    // to `evaluateGates` — both surfaces must read the same effective number or the
    // durable `isHalted()` short-circuit re-introduces the halt relax intends to
    // suppress (M36, D4).
    tryClose(close: IVirtualCloseInput): IVirtualMutationResult {
        const consecutiveLossHaltThreshold = close.consecutiveLossHaltThreshold ?? VIRTUAL_LEDGER_CONSECUTIVE_LOSS_HALT_THRESHOLD;

        if (this.processedEventIds.has(close.eventId)) {
            return { success: false, reason: 'duplicate_event_id' };
        }

        const position = this.openPositions.get(close.virtualOrderId);

        if (position === undefined) {
            return { success: false, reason: 'no_open_position_for_virtual_order_id' };
        }

        // Fall back to the close-risk-day only when the open record is missing
        // (legacy / rebuilt ledger paths). Live tryOpen always seeds this map.
        const openedRiskDayUtcDate = this.openedRiskDayByVirtualOrderId.get(close.virtualOrderId) ?? close.riskDayUtcDate;
        this.openPositions.delete(close.virtualOrderId);
        this.openedRiskDayByVirtualOrderId.delete(close.virtualOrderId);
        this.closedTrades.push({
            symbol: position.symbol,
            side: position.side,
            riskDayUtcDate: close.riskDayUtcDate,
            openedRiskDayUtcDate,
            closeReason: close.closeReason,
            realizedPnl: close.realizedPnl,
            closedAtMs: close.nowMs,
            closedAtEventId: close.eventId,
        });

        this.maybeArmConsecutiveLossHalt(close.riskDayUtcDate, consecutiveLossHaltThreshold);
        this.markEventProcessed(close.eventId);

        return { success: true };
    }

    // M11a W5a (ADR 0029 §2.1.2). Seed the in-memory idempotency dedup set
    // from the persisted shadow_decisions row stream during cold-restart
    // rebuild. Without this, `processedEventIds` starts empty on restart and a
    // redelivered live `eventId` would slip past the duplicate-guard in
    // `tryOpen` / `tryClose`. Also advances `lastEventIdProcessed` so the
    // restart cursor matches the durable record.
    seedProcessedEventIds(eventIds: string[]): void {
        for (const id of eventIds) {
            this.processedEventIds.add(id);

            if (id > this.lastEventIdProcessed) {
                this.lastEventIdProcessed = id;
            }
        }
    }

    // M11a W5a (ADR 0029 §2.1.3 close paths 2 + 3). Close-by-symbol helper
    // used by the orchestrator when a reverse-signal open arrives or an end-
    // of-window force-close fires. The existing `tryClose(IVirtualCloseInput)`
    // requires the caller to know the `virtualOrderId` and pre-compute the
    // realised PnL; both are inconvenient at the orchestrator level where the
    // close is triggered by a new event, not by a stop-simulator firing.
    //
    // PnL accounting: `(exit - entry) × qty × sideMultiplier - exitFee`. The
    // close fee mirrors the live taker rate so v1-realised and shadow-
    // simulated PnL series are dimensionally comparable. Open-leg fees are
    // outside this method's scope — the ADR 0018 paired bootstrap reads
    // entry/exit prices and slippage components from `ISimulatedFill` and is
    // responsible for full fee bookkeeping; this method's `realizedPnl` is the
    // ledger's gate-relevant signal (negative ⇒ loss for the streak counter).
    //
    // Returns `null` when there is no open position for `symbol` so the caller
    // can distinguish "no-op" from "closed". Idempotent: if the close event id
    // has already been processed, the existing `tryClose` no-op rule applies.
    closeBySymbol(
        symbol: string,
        exitPriceStr: string,
        nowMs: number,
        reason: ShadowCloseBySymbolReason,
        eventId: string,
        consecutiveLossHaltThreshold?: number,
    ): IVirtualClosedTradeLogEntry | null {
        const position = this.findOpenPositionBySymbol(symbol);

        if (position === null) {
            return null;
        }

        const entryPrice = new Decimal(position.entryPrice);
        const exitPrice = new Decimal(exitPriceStr);
        const qty = new Decimal(position.qty);

        if (!entryPrice.isFinite() || !exitPrice.isFinite() || !qty.isFinite()) {
            this.logger.warn(`closeBySymbol skipped — non-finite money symbol=${symbol} entry=${position.entryPrice} exit=${exitPriceStr} qty=${position.qty}`);

            return null;
        }

        const sideMultiplier = position.side === 'long' ? new Decimal(1) : new Decimal(-1);
        const grossPnl = exitPrice.minus(entryPrice).times(qty).times(sideMultiplier);
        const exitFee = exitPrice.times(qty).times(new Decimal(SHADOW_TAKER_FEE_PCT));
        const realizedPnl = grossPnl.minus(exitFee);
        const riskDayUtcDate = deriveRiskDayUtcDate(nowMs);

        const result = this.tryClose({
            eventId,
            nowMs,
            riskDayUtcDate,
            virtualOrderId: position.virtualOrderId,
            exitPrice: exitPriceStr,
            closeReason: reason,
            realizedPnl: realizedPnl.toFixed(),
            consecutiveLossHaltThreshold,
        });

        if (!result.success) {
            this.logger.debug(`closeBySymbol tryClose declined symbol=${symbol} reason=${result.reason ?? 'unknown'}`);

            return null;
        }

        const closed = this.closedTrades[this.closedTrades.length - 1] ?? null;
        this.logger.debug(
            `Virtual position closed: symbol=${symbol} side=${position.side} entryPrice=${entryPrice.toFixed()} exitPrice=${exitPrice.toFixed()} pnl=${realizedPnl.toFixed()} reason=${reason}`,
        );

        return closed;
    }

    // M11a W5a (ADR 0029 §2.1.3 close path 2). End-of-window force-close: for
    // each open position whose `symbol` is keyed in `exitPriceBySymbol`, close
    // at the supplied price. Symbols absent from the map are left open (the
    // caller controls which positions are eligible). Returns the closed-trade
    // log entries in the order they were closed.
    //
    // Wiring to a window-close event is a TODO (see ShadowStrategyOrchestratorService);
    // the method exists so the orchestrator can begin to drive end-of-window
    // closes the moment a window-close signal is available.
    forceCloseAllPositions(
        exitPriceBySymbol: Map<string, string>,
        nowMs: number,
        eventIdPrefix: string,
        consecutiveLossHaltThreshold?: number,
    ): IVirtualClosedTradeLogEntry[] {
        const closed: IVirtualClosedTradeLogEntry[] = [];
        const symbols = Array.from(this.openPositions.values()).map((position) => position.symbol);

        for (const symbol of symbols) {
            const exitPrice = exitPriceBySymbol.get(symbol);

            if (exitPrice === undefined) {
                continue;
            }

            const entry = this.closeBySymbol(symbol, exitPrice, nowMs, 'force_close', `${eventIdPrefix}:${symbol}`, consecutiveLossHaltThreshold);

            if (entry !== null) {
                closed.push(entry);
            }
        }

        return closed;
    }

    findOpenPositionBySymbol(symbol: string): IVirtualOpenPosition | null {
        for (const position of this.openPositions.values()) {
            if (position.symbol === symbol) {
                return position;
            }
        }

        return null;
    }

    // ----- Internal -----

    // M36 (D4): the arm threshold is the EFFECTIVE value the close caller passes
    // (the restricted-profile const when relax is off; an unreachable sentinel
    // when PAPER_RELAX_CONSECUTIVE_LOSS_HALT is on). Both this durable arm AND the
    // per-call gate at `evaluateGates` must read the same effective value — arming
    // here against the bare const while the gate uses the sentinel would let the
    // durable `isHalted()` short-circuit re-introduce the halt the relax mode
    // intends to suppress. The ledger still does not OWN the threshold; the caller
    // supplies it so a profile change stays caller-side.
    private maybeArmConsecutiveLossHalt(riskDayUtcDate: string, consecutiveLossHaltThreshold: number): void {
        const streak = this.countConsecutiveLossesInRiskDay(riskDayUtcDate);

        if (streak >= consecutiveLossHaltThreshold) {
            this.haltedUntilRiskDayUtcDate = riskDayUtcDate;
            this.logger.warn(`virtual ledger halted (consecutive losses=${streak}) until end of ${riskDayUtcDate}`);
        }
    }

    private markEventProcessed(eventId: string): void {
        this.processedEventIds.add(eventId);

        if (eventId > this.lastEventIdProcessed) {
            this.lastEventIdProcessed = eventId;
        }
    }
}

// Same UTC-date derivation v1's RiskGateService uses (see RiskGateService
// `utcDateString` derivation: `new Date(nowMs).toISOString().slice(0, 10)`).
// ADR 0029 §2.1.2: "same string v1's gate computes for the same `nowMs`."
// Promoting this to a shared `common/utils/dateUtils.ts` helper is tracked in
// `docs/tech-debt.md` LOW — the duplication is intentional in W0.5/W0.6 (do
// not refactor RiskGateService in the shadow-foundation wave).
function deriveRiskDayUtcDate(nowMs: number): string {
    return new Date(nowMs).toISOString().slice(0, 10);
}
