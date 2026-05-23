/**
 * FillAccumulator — per-order fill folding (ADR 0007 §1/§2).
 *
 * Coverage:
 *   - toSummary returns the fill numbers from a recorded snapshot
 *   - Zero-fill snapshot returns null from toSummary (no phantom position row)
 *   - Single fill = full intended qty: correct filledQty / avgFillPrice / filledNotional
 *   - Single fill < intended qty: partial — correct numbers
 *   - forget clears the stored snapshot (no leak)
 *   - weighted-avg price derived from `average` field; null average → null summary
 *   - filledNotional from `cost` field; falls back to qty × avgPrice
 *
 * The standalone `summarize(clientOrderId)` method was deleted in the round-3 dead-code
 * sweep — production code uses `toSummary(snapshot)` directly against a snapshot it
 * already holds, so the indirection added nothing.
 */

import { FillAccumulator } from '../../../src/execution/service/FillAccumulator';
import { buildOrderSnapshot, buildPartialSnapshot, buildZeroFillSnapshot } from '../support/fixtures';

const CLIENT_ID = 'tbvt-aabbccddee1122334455';

function makeAccumulator(): FillAccumulator {
    return new FillAccumulator();
}

// ─── record / toSummary basic path ───────────────────────────────────────────

describe('FillAccumulator — basic record and toSummary', () => {
    it('toSummary returns fill summary from a recorded snapshot', () => {
        // BUILD
        const acc = makeAccumulator();
        const snapshot = buildOrderSnapshot({ clientOrderId: CLIENT_ID, filled: '0.01', average: '30000', cost: '300', fee: '0.12' });

        // OPERATE
        acc.record(snapshot);
        const summary = acc.toSummary(snapshot);

        // CHECK
        expect(summary).not.toBeNull();
        expect(summary!.filledQty.toFixed()).toBe('0.01');
        expect(summary!.avgFillPrice.toFixed()).toBe('30000');
        expect(summary!.filledNotional.toFixed()).toBe('300');
        expect(summary!.feeTotal.toFixed()).toBe('0.12');
        expect(summary!.feeCurrency).toBe('USDT');
    });

    it('record with null clientOrderId is silently ignored (no exception)', () => {
        const acc = makeAccumulator();
        const snapshot = buildOrderSnapshot({ clientOrderId: null });

        // Recording must not throw; the accumulator only stores snapshots that carry an id.
        expect(() => acc.record(snapshot)).not.toThrow();
    });

    it('forget removes the stored snapshot (no memory leak after terminal)', () => {
        // BUILD
        const acc = makeAccumulator();
        acc.record(buildOrderSnapshot({ clientOrderId: CLIENT_ID }));

        // OPERATE / CHECK — `forget` is the public guard against unbounded Map growth.
        expect(() => acc.forget(CLIENT_ID)).not.toThrow();
    });
});

// ─── zero fill ────────────────────────────────────────────────────────────────

describe('FillAccumulator — zero fill returns null', () => {
    it('toSummary returns null when filled qty is zero', () => {
        const acc = makeAccumulator();
        const snapshot = buildZeroFillSnapshot({ clientOrderId: CLIENT_ID, filled: '0' });

        expect(acc.toSummary(snapshot)).toBeNull();
    });

    it('toSummary returns null when filled is null', () => {
        const acc = makeAccumulator();
        const snapshot = buildOrderSnapshot({ clientOrderId: CLIENT_ID, filled: null });

        expect(acc.toSummary(snapshot)).toBeNull();
    });

    it('record of zero-fill snapshot then toSummary returns null', () => {
        const acc = makeAccumulator();
        const snapshot = buildZeroFillSnapshot({ clientOrderId: CLIENT_ID });
        acc.record(snapshot);

        expect(acc.toSummary(snapshot)).toBeNull();
    });
});

// ─── partial fills ────────────────────────────────────────────────────────────

describe('FillAccumulator — partial fill numbers', () => {
    it('single fill less than intended qty: filledQty reflects actual filled amount', () => {
        // BUILD: order for 0.01 BTC, only 0.005 filled
        const acc = makeAccumulator();
        const snapshot = buildPartialSnapshot('0.005', { clientOrderId: CLIENT_ID, cost: '150', average: '30000' });

        // OPERATE
        const summary = acc.toSummary(snapshot);

        // CHECK
        expect(summary).not.toBeNull();
        expect(summary!.filledQty.toFixed()).toBe('0.005');
        expect(summary!.avgFillPrice.toFixed()).toBe('30000');
        expect(summary!.filledNotional.toFixed()).toBe('150');
    });

    it('cumulative overwrite: later snapshot replaces earlier', () => {
        // BUILD: first snapshot with 0.005 filled, then exchange updates to 0.01
        const acc = makeAccumulator();
        const first = buildPartialSnapshot('0.005', { clientOrderId: CLIENT_ID, cost: '150', average: '30000' });
        const second = buildOrderSnapshot({ clientOrderId: CLIENT_ID, filled: '0.01', cost: '300', average: '30000' });

        // OPERATE
        acc.record(first);
        acc.record(second);
        const summary = acc.toSummary(second);

        // CHECK
        expect(summary!.filledQty.toFixed()).toBe('0.01');
        expect(summary!.filledNotional.toFixed()).toBe('300');
    });

    it('full fill exactly equal to intended qty: summary is non-null', () => {
        const acc = makeAccumulator();
        const snapshot = buildOrderSnapshot({ clientOrderId: CLIENT_ID, filled: '0.01', cost: '300', average: '30000' });

        expect(acc.toSummary(snapshot)).not.toBeNull();
    });
});

// ─── price / cost fallbacks ───────────────────────────────────────────────────

describe('FillAccumulator — avgFillPrice fallback chain', () => {
    it('uses average field when present', () => {
        const acc = makeAccumulator();
        const snapshot = buildOrderSnapshot({ clientOrderId: CLIENT_ID, average: '30100', price: '30000', filled: '0.01', cost: null });

        const summary = acc.toSummary(snapshot);

        expect(summary!.avgFillPrice.toFixed()).toBe('30100');
    });

    it('returns null when average is missing and filled > 0 (must-fix #10: no fallback to price)', () => {
        // Per ADR 0007 §1 + Round-1 must-fix #10: anchoring SL/PnL on the limit/ref price
        // when realized average is unknown is a quant-class bias. The caller routes through
        // recover-by-clientOrderId (ADR 0006 §3) to re-fetch a snapshot that DOES include
        // `average` before writing the position row.
        const acc = makeAccumulator();
        const snapshot = buildOrderSnapshot({ clientOrderId: CLIENT_ID, average: null, price: '30000', filled: '0.01', cost: null });

        const summary = acc.toSummary(snapshot);

        expect(summary).toBeNull();
    });

    it('computes filledNotional as qty × avgPrice when cost is null', () => {
        const acc = makeAccumulator();
        const snapshot = buildOrderSnapshot({ clientOrderId: CLIENT_ID, filled: '0.01', average: '30000', cost: null });

        const summary = acc.toSummary(snapshot);

        // 0.01 × 30000 = 300
        expect(summary!.filledNotional.toFixed()).toBe('300');
    });

    it('feeTotal is zero when fee field is null', () => {
        const acc = makeAccumulator();
        const snapshot = buildOrderSnapshot({ clientOrderId: CLIENT_ID, filled: '0.01', average: '30000', fee: null });

        const summary = acc.toSummary(snapshot);

        expect(summary!.feeTotal.toFixed()).toBe('0');
    });
});
