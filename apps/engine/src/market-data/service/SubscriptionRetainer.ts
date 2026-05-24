import { RetainReasonEnum } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';

// Held-symbol registry — reason-set semantics per ADR 0011 §5.
//
// A symbol stays retained while ANY reason is present. Multiple producers
// (position lifecycle, reconciliation, foreign-adoption, cooldown) each
// contribute independent reasons; release removes one reason; the symbol
// is dropped from the retained set only when its reason-set empties.
//
// Pure in-memory, no I/O. Deterministic — used identically in live and
// backtest. Universe-prune consults isRetained(...) before dropping a
// symbol's subscription so positions that leave the top-300 keep their
// price tape (ADR 0011 §5: "a coin leaving the top-300 universe must
// keep its price subscription + SL/TP monitoring until its position
// closes").
//
// Concurrency: the engine is single-threaded JS; arms/releases interleave
// only between awaited I/O. The Map<string, Set<RetainReasonEnum>>
// guarantee is preserved within a synchronous turn.
@Injectable()
export class SubscriptionRetainer {
    private readonly logger = new Logger(SubscriptionRetainer.name);

    // symbol -> active reason set. A non-empty set is the retention signal;
    // when the last reason releases, the entry is removed entirely so
    // getRetainedSymbols() returns the exact "is retained" view in O(1).
    private readonly reasonsBySymbol = new Map<string, Set<RetainReasonEnum>>();

    // Idempotent on (symbol, reason). Adding the same reason twice from two
    // independent callers leaves the symbol with one occurrence of that
    // reason — refcount semantics are NOT used here. The §5 contract is
    // "all reasons must release"; a single caller is responsible for one
    // reason class.
    retain(symbol: string, reason: RetainReasonEnum): void {
        const existing = this.reasonsBySymbol.get(symbol);

        if (existing === undefined) {
            this.reasonsBySymbol.set(symbol, new Set<RetainReasonEnum>([reason]));
            this.logger.debug(`retain ${symbol} reason=${reason} (first retention)`);

            return;
        }

        if (existing.has(reason)) {
            // Idempotent: re-retaining with the same reason is a no-op, not
            // an error — the §5 producer table can dispatch the same retain
            // call on a re-emitted event (e.g. boot-time rebuild on top of
            // a live retention) without flagging.
            return;
        }

        existing.add(reason);
        this.logger.debug(`retain ${symbol} reason=${reason} (now ${existing.size} reasons)`);
    }

    // No-op if the symbol was never retained or the reason was never added
    // (the §5 boot-rebuild contract may issue a release for a reason that
    // got cleared earlier in the same boot; treating it as an error would
    // make the boot sequence brittle to ordering). The release is logged
    // at debug for visibility.
    release(symbol: string, reason: RetainReasonEnum): void {
        const existing = this.reasonsBySymbol.get(symbol);

        if (existing === undefined) {
            this.logger.debug(`release ${symbol} reason=${reason} (no-op: symbol not retained)`);

            return;
        }

        if (!existing.has(reason)) {
            this.logger.debug(`release ${symbol} reason=${reason} (no-op: reason not present)`);

            return;
        }

        existing.delete(reason);

        if (existing.size === 0) {
            this.reasonsBySymbol.delete(symbol);
            this.logger.debug(`release ${symbol} reason=${reason} (dropped from retainer)`);

            return;
        }

        this.logger.debug(`release ${symbol} reason=${reason} (still retained by ${existing.size} reasons)`);
    }

    isRetained(symbol: string): boolean {
        return this.reasonsBySymbol.has(symbol);
    }

    // Snapshot — callers iterate without seeing the live map. Returns
    // a new Set so consumers cannot mutate the internal registry.
    getRetainedSymbols(): Set<string> {
        return new Set(this.reasonsBySymbol.keys());
    }

    // Returns an empty Set for a non-retained symbol (not null), keeping
    // call sites branch-free.
    getReasonsFor(symbol: string): Set<RetainReasonEnum> {
        const existing = this.reasonsBySymbol.get(symbol);

        if (existing === undefined) {
            return new Set<RetainReasonEnum>();
        }

        return new Set(existing);
    }
}
