import { Injectable, Logger } from '@nestjs/common';

import { IExchangeOrderSnapshot } from '../../exchange/interface';
import { Money, MoneyValue, parseMoney } from '../../common/utils/money';
import { IFillSummary } from '../interface';

// In-memory accumulator (ADR 0007 §2). Folds the exchange-side ORDER snapshot (which Binance
// returns with cumulative `filled` + `average` + `cost` + `fee`) into the canonical fill
// summary the orchestrator uses to drive position notional / SL/TP / reservation math.
// Restart safety is M6's job: a restart reconstructs the accumulator from
// `fetchOrder(clientOrderId)` which returns the same cumulative numbers.
//
// Must-fix #10 (Round-1 reviewers): when `snapshot.average` is missing and `filled > 0`,
// DO NOT fall back to `snapshot.price` (the limit/ref price). That would anchor SL/PnL on
// the planned price, not the realized price — a quant-class bias. Instead, signal
// "unknown average" by returning null so the caller routes through recover-by-clientOrderId
// (ADR 0006 §3 protocol) to re-fetch a snapshot that includes `average`.
@Injectable()
export class FillAccumulator {
    private readonly logger = new Logger(FillAccumulator.name);

    private readonly orders = new Map<string, IExchangeOrderSnapshot>();

    record(snapshot: IExchangeOrderSnapshot): void {
        if (snapshot.clientOrderId === null) {
            return;
        }

        this.orders.set(snapshot.clientOrderId, snapshot);
    }

    // Evict on terminal so the accumulator does not leak memory across the lifetime of
    // the executor (small but unbounded otherwise — every order leaves a Map entry).
    forget(clientOrderId: string): void {
        this.orders.delete(clientOrderId);
    }

    // Derives the canonical filled-qty / avg-price / fee numbers from the exchange snapshot.
    // Returns null when nothing has filled (zero qty) so the caller skips writing a position
    // row for a missed entry (ADR 0007 §3). Returns null when filled > 0 but average is
    // unknown — caller must route through recover-by-clientOrderId rather than anchor on
    // the limit price (must-fix #10).
    toSummary(snapshot: IExchangeOrderSnapshot): IFillSummary | null {
        const filledQty = this.toDecimal(snapshot.filled);

        if (filledQty === null || filledQty.lessThanOrEqualTo(0)) {
            return null;
        }

        const avgFillPrice = this.toDecimal(snapshot.average);

        if (avgFillPrice === null || avgFillPrice.lessThanOrEqualTo(0)) {
            this.logger.warn(
                `fill summary unresolved clientOrderId=${snapshot.clientOrderId ?? '?'} filled=${snapshot.filled} average=${snapshot.average} - ` +
                    'caller must re-fetch via recover-by-clientOrderId before anchoring SL/PnL',
            );

            return null;
        }

        const filledNotional = this.toDecimal(snapshot.cost) ?? filledQty.times(avgFillPrice);
        const feeTotal = this.toDecimal(snapshot.fee) ?? new Money(0);

        return {
            filledQty,
            filledNotional,
            avgFillPrice,
            feeTotal,
            feeCurrency: snapshot.feeCurrency,
        };
    }

    private toDecimal(value: string | null): MoneyValue | null {
        if (value === null) {
            return null;
        }

        return parseMoney(value);
    }
}
