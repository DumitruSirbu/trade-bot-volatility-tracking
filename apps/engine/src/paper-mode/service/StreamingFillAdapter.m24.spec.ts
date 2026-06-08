/**
 * M24 paired tests for StreamingFillAdapter — paper-mode open-fill path.
 *
 * What changed in M24:
 *   - `buildIntraBarTicks` synthesizes a single side-aware tick for MARKETABLE_LIMIT_IOC opens
 *     instead of passing `[]` to `sharedApplyFill`.
 *   - `resolveExecutablePrice` picks ask for LONG, bid for SHORT, with fallback chain
 *     mark → last → opposite side; returns null when all are missing/zero.
 *   - `simulateOrderFill` overrides fill `tsMs` to `snapshot.ts + latencyMs` (event-time)
 *     for MARKETABLE_LIMIT_IOC fills that succeed.
 *
 * Regression guard (T10): the shared `applyFill` with empty ticks still misses for IOC,
 * confirming the synthesized tick is not leaked into the shared core's signature.
 */

import { CoinTierEnum, IFillIntent, IFillSeed, IFillSnapshot, OrderPolicyEnum, applyFill } from '@bot/shared';
import { Decimal } from 'decimal.js';

import { ORDER_TIMEOUT_MS } from '../../execution/const/executionConsts';
import { PAPER_FILL_LATENCY_MS } from '../const/paperFillSimulatorConsts';
import { StreamingFillAdapter } from './StreamingFillAdapter';

// ---------------------------------------------------------------------------
// Tier slippage params used throughout all tests
// ---------------------------------------------------------------------------
const TIER_PARAMS = {
    slippage_tier1_pct: 0.15,
    slippage_tier2_pct: 0.5,
    slippage_tier3_pct: 1.0,
};

// ---------------------------------------------------------------------------
// Snapshot / intent factory helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<IFillSnapshot> = {}): IFillSnapshot {
    return {
        bid: '99000',
        ask: '100000',
        mark: '99500',
        last: '99500',
        high: '101000', // bar-level — must NOT appear in synthetic tick
        low: '98000', // bar-level — must NOT appear in synthetic tick
        ts: Date.now(),
        ...overrides,
    };
}

function makeLongIocIntent(limitPrice: string): IFillIntent {
    return {
        side: 'long',
        action: 'open',
        policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
        limitPrice,
        qty: '0.001',
        postOnly: false,
        reduceOnly: false,
    };
}

function makeShortIocIntent(limitPrice: string): IFillIntent {
    return {
        side: 'short',
        action: 'open',
        policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
        limitPrice,
        qty: '0.001',
        postOnly: false,
        reduceOnly: false,
    };
}

function makeSeed(label = 'test'): IFillSeed {
    return { seedBytes: Buffer.from(label.padEnd(32, '\0').slice(0, 32), 'utf8'), version: 'test-v1' };
}

function buildAdapter(snapshot: IFillSnapshot): StreamingFillAdapter {
    const adapter = new StreamingFillAdapter();
    adapter.notifyTick('BTCUSDT', snapshot);
    return adapter;
}

function callFill(adapter: StreamingFillAdapter, intent: IFillIntent, snapshot: IFillSnapshot) {
    return adapter.simulateOrderFill(intent, 'BTCUSDT', CoinTierEnum.TIER_1, TIER_PARAMS, makeSeed(), snapshot.ts, PAPER_FILL_LATENCY_MS);
}

// ---------------------------------------------------------------------------
// T1 — Open now fills (crossing LONG IOC)
// ---------------------------------------------------------------------------

describe('StreamingFillAdapter M24 — T1: crossing LONG IOC fills immediately', () => {
    it('LONG IOC at limitPrice = ask returns filled:true, non-zero fillPrice, lowFidelity:true', () => {
        const snapshot = makeSnapshot({ bid: '99000', ask: '100000', mark: '99500' });
        const intent = makeLongIocIntent('100000');
        const adapter = buildAdapter(snapshot);

        const result = callFill(adapter, intent, snapshot);

        expect(result).not.toBeNull();
        expect(result!.filled).toBe(true);
        expect(new Decimal(result!.fillPrice).isPositive()).toBe(true);
        expect(result!.lowFidelity).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// T2 — Crossing semantics LONG (A1)
// ---------------------------------------------------------------------------

describe('StreamingFillAdapter M24 — T2: LONG IOC crossing semantics', () => {
    it('limitPrice = ask (100000) → fills (tick.low = ask ≤ limitPrice)', () => {
        const snapshot = makeSnapshot({ bid: '99000', ask: '100000', mark: '99500' });
        const adapter = buildAdapter(snapshot);

        const result = callFill(adapter, makeLongIocIntent('100000'), snapshot);

        expect(result!.filled).toBe(true);
    });

    it('limitPrice = 99500 (inside spread, below ask) → misses (tick.low = 100000 > 99500)', () => {
        const snapshot = makeSnapshot({ bid: '99000', ask: '100000', mark: '99500' });
        const adapter = buildAdapter(snapshot);

        const result = callFill(adapter, makeLongIocIntent('99500'), snapshot);

        expect(result!.filled).toBe(false);
    });

    it('limitPrice = 95000 (below bid) → misses (non-crossing)', () => {
        const snapshot = makeSnapshot({ bid: '99000', ask: '100000', mark: '99500' });
        const adapter = buildAdapter(snapshot);

        const result = callFill(adapter, makeLongIocIntent('95000'), snapshot);

        expect(result!.filled).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// T3 — Crossing semantics SHORT (A1)
// ---------------------------------------------------------------------------

describe('StreamingFillAdapter M24 — T3: SHORT IOC crossing semantics', () => {
    it('limitPrice = bid (99000) → fills (tick.high = bid ≥ limitPrice)', () => {
        const snapshot = makeSnapshot({ bid: '99000', ask: '100000', mark: '99500' });
        const adapter = buildAdapter(snapshot);

        const result = callFill(adapter, makeShortIocIntent('99000'), snapshot);

        expect(result!.filled).toBe(true);
    });

    it('limitPrice = 99500 (inside spread) → misses (tick.high = 99000 < 99500)', () => {
        const snapshot = makeSnapshot({ bid: '99000', ask: '100000', mark: '99500' });
        const adapter = buildAdapter(snapshot);

        const result = callFill(adapter, makeShortIocIntent('99500'), snapshot);

        expect(result!.filled).toBe(false);
    });

    it('limitPrice = 105000 (above ask) → misses (non-crossing)', () => {
        const snapshot = makeSnapshot({ bid: '99000', ask: '100000', mark: '99500' });
        const adapter = buildAdapter(snapshot);

        const result = callFill(adapter, makeShortIocIntent('105000'), snapshot);

        expect(result!.filled).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// T4 — Boundary-exact inclusive (≤ / ≥)
// ---------------------------------------------------------------------------

describe('StreamingFillAdapter M24 — T4: boundary-exact inclusive fill', () => {
    it('LONG IOC limitPrice exactly = ask → fills (tick.low = ask ≤ limitPrice = ask)', () => {
        const snapshot = makeSnapshot({ bid: '99000', ask: '100000', mark: '99500' });
        const adapter = buildAdapter(snapshot);

        const result = callFill(adapter, makeLongIocIntent('100000'), snapshot);

        expect(result!.filled).toBe(true);
    });

    it('SHORT IOC limitPrice exactly = bid → fills (tick.high = bid ≥ limitPrice = bid)', () => {
        const snapshot = makeSnapshot({ bid: '99000', ask: '100000', mark: '99500' });
        const adapter = buildAdapter(snapshot);

        const result = callFill(adapter, makeShortIocIntent('99000'), snapshot);

        expect(result!.filled).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// T5 — Fallback when ask/bid missing (M2)
// ---------------------------------------------------------------------------

describe('StreamingFillAdapter M24 — T5: resolveExecutablePrice fallback chain', () => {
    it('LONG IOC with ask=0 falls back to mark; limitPrice = mark → fills', () => {
        const snapshot = makeSnapshot({ ask: '0', bid: '99000', mark: '99500', last: '99500' });
        const adapter = buildAdapter(snapshot);

        const result = callFill(adapter, makeLongIocIntent('99500'), snapshot);

        expect(result!.filled).toBe(true);
    });

    it('LONG IOC with ask=0; limitPrice below mark (99000) → misses', () => {
        const snapshot = makeSnapshot({ ask: '0', bid: '99000', mark: '99500', last: '99500' });
        const adapter = buildAdapter(snapshot);

        const result = callFill(adapter, makeLongIocIntent('99000'), snapshot);

        expect(result!.filled).toBe(false);
    });

    it('LONG IOC with both ask=0 and bid=0; mark used as exec price → fills when limitPrice = mark', () => {
        const snapshot = makeSnapshot({ ask: '0', bid: '0', mark: '99500', last: '99500' });
        const adapter = buildAdapter(snapshot);

        const result = callFill(adapter, makeLongIocIntent('99500'), snapshot);

        expect(result!.filled).toBe(true);
        expect(result!.fillPrice).not.toBe('0');
    });
});

// ---------------------------------------------------------------------------
// T6 — All quotes missing → no synthetic tick → miss
// ---------------------------------------------------------------------------

describe('StreamingFillAdapter M24 — T6: pathological all-quotes-missing → miss', () => {
    it('LONG IOC with ask=0, bid=0, mark=0, last=0 → filled:false regardless of limitPrice', () => {
        const snapshot = makeSnapshot({ ask: '0', bid: '0', mark: '0', last: '0' });
        const adapter = buildAdapter(snapshot);

        // Even at a very high limit price that would normally cross any spread, no fill occurs
        const result = callFill(adapter, makeLongIocIntent('999999'), snapshot);

        expect(result!.filled).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// T7 — Event-time timestamp (A2)
// ---------------------------------------------------------------------------

describe('StreamingFillAdapter M24 — T7: fill tsMs is event-time (snapshot.ts + latencyMs)', () => {
    it('filled LONG IOC tsMs === snapshot.ts + PAPER_FILL_LATENCY_MS', () => {
        const fixedTs = 1_700_000_000_000;
        const snapshot = makeSnapshot({ ts: fixedTs, bid: '99000', ask: '100000', mark: '99500' });
        const adapter = new StreamingFillAdapter();
        adapter.notifyTick('BTCUSDT', snapshot);

        const result = adapter.simulateOrderFill(
            makeLongIocIntent('100000'),
            'BTCUSDT',
            CoinTierEnum.TIER_1,
            TIER_PARAMS,
            makeSeed(),
            fixedTs,
            PAPER_FILL_LATENCY_MS,
        );

        expect(result!.filled).toBe(true);
        expect(result!.tsMs).toBe(fixedTs + PAPER_FILL_LATENCY_MS);
    });

    it('fill tsMs is NOT the next-bar timestamp (snapshot.ts + 5min + latencyMs)', () => {
        const fixedTs = 1_700_000_000_000;
        const snapshot = makeSnapshot({ ts: fixedTs, bid: '99000', ask: '100000', mark: '99500' });
        const adapter = new StreamingFillAdapter();
        adapter.notifyTick('BTCUSDT', snapshot);

        const result = adapter.simulateOrderFill(
            makeLongIocIntent('100000'),
            'BTCUSDT',
            CoinTierEnum.TIER_1,
            TIER_PARAMS,
            makeSeed(),
            fixedTs,
            PAPER_FILL_LATENCY_MS,
        );

        const nextBarTimestamp = fixedTs + 5 * 60 * 1000 + PAPER_FILL_LATENCY_MS;
        expect(result!.tsMs).not.toBe(nextBarTimestamp);
    });
});

// ---------------------------------------------------------------------------
// T8 — POST_ONLY_MAKER: no synthetic tick → miss (A3)
// ---------------------------------------------------------------------------

describe('StreamingFillAdapter M24 — T8: POST_ONLY_MAKER does not synthesize a tick', () => {
    it('POST_ONLY_MAKER LONG with limitPrice = ask → filled:false (no synthetic tick emitted)', () => {
        const snapshot = makeSnapshot({ bid: '99000', ask: '100000', mark: '99500' });
        const adapter = buildAdapter(snapshot);

        const intent: IFillIntent = {
            side: 'long',
            action: 'open',
            policy: OrderPolicyEnum.POST_ONLY_MAKER,
            limitPrice: '100000',
            qty: '0.001',
            postOnly: true,
            reduceOnly: false,
        };

        const result = callFill(adapter, intent, snapshot);

        expect(result!.filled).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// T9 — REDUCE_MARKET always fills (unchanged behavior)
// ---------------------------------------------------------------------------

describe('StreamingFillAdapter M24 — T9: REDUCE_MARKET always fills', () => {
    it('REDUCE_MARKET intent returns filled:true regardless of limitPrice relation to spread', () => {
        const snapshot = makeSnapshot({ bid: '99000', ask: '100000', mark: '99500' });
        const adapter = buildAdapter(snapshot);

        const intent: IFillIntent = {
            side: 'long',
            action: 'reduce',
            policy: OrderPolicyEnum.REDUCE_MARKET,
            limitPrice: '99000',
            qty: '0.001',
            postOnly: false,
            reduceOnly: true,
        };

        const result = callFill(adapter, intent, snapshot);

        expect(result!.filled).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// T10 — Historical conservatism regression guard
// ---------------------------------------------------------------------------

describe('StreamingFillAdapter M24 — T10: shared applyFill with empty ticks misses for IOC (regression guard)', () => {
    it('applyFill(snapshot, IOC intent, ticks=[]) → filled:false regardless of limitPrice', () => {
        const snapshot = makeSnapshot({ bid: '99000', ask: '100000', mark: '99500', ts: 1_700_000_000_000 });
        const intent = makeLongIocIntent('100000');
        const seed = makeSeed('regression');

        const orderTimeoutMs = ORDER_TIMEOUT_MS[OrderPolicyEnum.MARKETABLE_LIMIT_IOC];
        const latencyMs = 0;

        const result = applyFill(
            snapshot,
            intent,
            CoinTierEnum.TIER_1,
            TIER_PARAMS,
            seed,
            [], // empty ticks — the pre-M24 behavior
            snapshot.ts,
            orderTimeoutMs,
            latencyMs,
        );

        // With empty ticks, isMissedFill returns true → no fill
        expect(result.filled).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// T11 — Determinism: same inputs → same outputs
// ---------------------------------------------------------------------------

describe('StreamingFillAdapter M24 — T11: deterministic output for identical inputs', () => {
    it('two identical calls produce identical filled, fillPrice, tsMs, slippagePct', () => {
        const fixedTs = 1_700_000_000_000;
        const snapshot = makeSnapshot({ ts: fixedTs, bid: '99000', ask: '100000', mark: '99500' });
        const seed: IFillSeed = { seedBytes: Buffer.alloc(32, 0), version: 'test-v1' };

        const adapter1 = new StreamingFillAdapter();
        adapter1.notifyTick('BTCUSDT', snapshot);
        const result1 = adapter1.simulateOrderFill(
            makeLongIocIntent('100000'),
            'BTCUSDT',
            CoinTierEnum.TIER_1,
            TIER_PARAMS,
            seed,
            fixedTs,
            PAPER_FILL_LATENCY_MS,
        );

        const adapter2 = new StreamingFillAdapter();
        adapter2.notifyTick('BTCUSDT', snapshot);
        const result2 = adapter2.simulateOrderFill(
            makeLongIocIntent('100000'),
            'BTCUSDT',
            CoinTierEnum.TIER_1,
            TIER_PARAMS,
            seed,
            fixedTs,
            PAPER_FILL_LATENCY_MS,
        );

        expect(result1).not.toBeNull();
        expect(result2).not.toBeNull();
        expect(result1!.filled).toBe(result2!.filled);
        expect(result1!.fillPrice).toBe(result2!.fillPrice);
        expect(result1!.tsMs).toBe(result2!.tsMs);
        expect(result1!.slippagePct).toBe(result2!.slippagePct);
    });
});

// ---------------------------------------------------------------------------
// T12 — Exit unaffected: REDUCE_MARKET with below-bid limitPrice still fills
// ---------------------------------------------------------------------------

describe('StreamingFillAdapter M24 — T12: REDUCE_MARKET close with below-bid limitPrice fills', () => {
    it('REDUCE_MARKET close at limitPrice well below bid → filled:true (market always fills)', () => {
        const snapshot = makeSnapshot({ bid: '99000', ask: '100000', mark: '99500' });
        const adapter = buildAdapter(snapshot);

        const intent: IFillIntent = {
            side: 'short',
            action: 'close',
            policy: OrderPolicyEnum.REDUCE_MARKET,
            limitPrice: '50000', // far below bid — irrelevant for market orders
            qty: '0.001',
            postOnly: false,
            reduceOnly: true,
        };

        const result = callFill(adapter, intent, snapshot);

        expect(result!.filled).toBe(true);
    });
});
