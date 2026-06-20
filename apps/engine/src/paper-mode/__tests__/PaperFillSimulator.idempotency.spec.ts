/**
 * Idempotency-ledger replay test for PaperFillSimulator (ADR 0032 §3 D3 +
 * D15 — replay determinism).
 *
 * Invariants:
 *   1. Same `(eventId, orderIntentId, versionNamespace)` → ledger lookup
 *      returns the persisted fill VERBATIM. The shared FillSimulatorCore /
 *      StreamingFillAdapter MUST NOT be invoked a second time.
 *   2. SIGKILL-replay (simulated by clearing in-memory state but preserving
 *      the persisted ledger) returns the same fill that was recorded before
 *      the crash.
 *   3. Numerical equality per D15's whitelisted tolerance — exact equality
 *      on string-encoded decimal fields.
 */

import { CoinTierEnum, IOrderIntent, ISimulatedFillCore, OrderIntentActionEnum, CorrelationModeEnum, FlowTypeEnum, PositionSideEnum } from '@bot/shared';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { BootstrapSubkeyDeriver } from '../../boot-mode-history/service/BootstrapSubkeyDeriver';
import { AppConfigService } from '../../config/service';
import { PaperSimulatorIdempotencyEntity } from '../entity/PaperSimulatorIdempotencyEntity';
import { PaperSimulatorIdempotencyRepository } from '../repository/PaperSimulatorIdempotencyRepository';
import { PaperFillSimulator, IPaperSimulatorContext } from '../service/PaperFillSimulator';
import { StreamingFillAdapter } from '../service/StreamingFillAdapter';

function buildIntent(eventId: string): IOrderIntent {
    return {
        intentAction: OrderIntentActionEnum.OPEN,
        symbol: 'BTCUSDT',
        eventId,
        tradeSide: PositionSideEnum.LONG,
        signalScore: 70,
        correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
        coinTier: CoinTierEnum.TIER_1,
        idiosyncrasyScore: 0.8,
        quantity: '0.01',
        flowType: FlowTypeEnum.TREND_INITIATION,
    };
}

function buildContext(eventId: string): IPaperSimulatorContext {
    return {
        eventId,
        orderIntentId: `${eventId}-intent-1`,
        versionNamespace: 'paper.active.v1',
    };
}

interface IFakeIdempotencyStore {
    rows: Array<{
        eventId: string;
        orderIntentId: string;
        versionNamespace: string;
        simulatedFillId: string;
        simulatedFillPayload: Record<string, unknown>;
    }>;
}

function buildFakeRepo(store: IFakeIdempotencyStore): PaperSimulatorIdempotencyRepository {
    const repo: Partial<PaperSimulatorIdempotencyRepository> = {
        findByKey: jest.fn(async (key) => {
            const found = store.rows.find(
                (r) => r.eventId === key.eventId && r.orderIntentId === key.orderIntentId && r.versionNamespace === key.versionNamespace,
            );

            return (found as PaperSimulatorIdempotencyEntity | undefined) ?? null;
        }),
        insertNew: jest.fn(async (params) => {
            store.rows.push({
                eventId: params.eventId,
                orderIntentId: params.orderIntentId,
                versionNamespace: params.versionNamespace,
                simulatedFillId: params.simulatedFillId,
                simulatedFillPayload: params.simulatedFillPayload,
            });

            return {
                id: `id-${store.rows.length}`,
                createdAt: new Date(),
                ...params,
            } as unknown as PaperSimulatorIdempotencyEntity;
        }),
    };

    return repo as PaperSimulatorIdempotencyRepository;
}

// M11a R4 Item 3A — the stub now also implements `getLastSnapshot` so
// PaperFillSimulator.simulateFill can derive a non-zero reference price
// before delegating to the shared core. We return a fixed snapshot with
// positive bid/ask/mark/last so the simulator's positive-decimal check
// passes and the test exercises the fill path; the synthetic price has
// no semantic meaning here (the stubbed `simulateOrderFill` ignores it).
const STUB_SNAPSHOT = {
    bid: '100.10',
    ask: '100.20',
    last: '100.15',
    mark: '100.15',
    high: '100.30',
    low: '100.00',
    ts: 5_000,
};

function buildStreamingAdapterStub(fill: ISimulatedFillCore | null): { adapter: StreamingFillAdapter; calls: number } {
    let calls = 0;
    const adapter = {
        simulateOrderFill: jest.fn(() => {
            calls += 1;

            return fill;
        }),
        getLastSnapshot: jest.fn(() => STUB_SNAPSHOT),
    } as unknown as StreamingFillAdapter;

    return {
        adapter,
        get calls() {
            return calls;
        },
    };
}

const BOOTSTRAP_SECRET = 'b'.repeat(64);

function buildEventEmitterStub(): EventEmitter2 {
    return {
        emitAsync: jest.fn().mockResolvedValue(true),
    } as unknown as EventEmitter2;
}

function buildSubkeys(): BootstrapSubkeyDeriver {
    return new BootstrapSubkeyDeriver({ authBootstrapSecret: BOOTSTRAP_SECRET } as unknown as AppConfigService);
}

const SAMPLE_FILL: ISimulatedFillCore = {
    filled: true,
    fillPrice: '100.15',
    qty: '0.01',
    feeUsdt: '0.0004006',
    slippagePct: '0.15',
    missedReason: null,
    lowFidelity: false,
    tsMs: 5_050,
};

describe('PaperFillSimulator — D3 idempotency-ledger replay', () => {
    it('first call produces a fill and writes it to the ledger', async () => {
        const store: IFakeIdempotencyStore = { rows: [] };
        const repo = buildFakeRepo(store);
        const stub = buildStreamingAdapterStub(SAMPLE_FILL);
        const simulator = new PaperFillSimulator(buildSubkeys(), repo, stub.adapter, buildEventEmitterStub());

        const intent = buildIntent('evt-1');
        const context = buildContext('evt-1');

        const result = await simulator.simulateFill(intent, context, CoinTierEnum.TIER_1, 5_000);

        expect(result.fill.filled).toBe(true);
        expect(result.fill.fillPrice).toBe('100.15');
        expect(store.rows).toHaveLength(1);
        expect(store.rows[0]).toMatchObject({
            eventId: 'evt-1',
            orderIntentId: 'evt-1-intent-1',
            versionNamespace: 'paper.active.v1',
        });
        expect(stub.calls).toBe(1);
    });

    it('second call with the same key returns the persisted fill VERBATIM — no second adapter call', async () => {
        const store: IFakeIdempotencyStore = { rows: [] };
        const repo = buildFakeRepo(store);
        const stub = buildStreamingAdapterStub(SAMPLE_FILL);
        const simulator = new PaperFillSimulator(buildSubkeys(), repo, stub.adapter, buildEventEmitterStub());

        const intent = buildIntent('evt-2');
        const context = buildContext('evt-2');

        const first = await simulator.simulateFill(intent, context, CoinTierEnum.TIER_1, 5_000);
        const second = await simulator.simulateFill(intent, context, CoinTierEnum.TIER_1, 5_000);

        // Adapter was invoked exactly once — the second call returned from the ledger.
        expect(stub.calls).toBe(1);
        // Ledger holds exactly one row.
        expect(store.rows).toHaveLength(1);
        // Numerical equality per D15.
        expect(second.fill.fillPrice).toBe(first.fill.fillPrice);
        expect(second.fill.qty).toBe(first.fill.qty);
        expect(second.fill.feeUsdt).toBe(first.fill.feeUsdt);
        expect(second.fill.filled).toBe(first.fill.filled);
        expect(second.fill.slippagePct).toBe(first.fill.slippagePct);
        expect(second.fill.tsMs).toBe(first.fill.tsMs);
    });

    it('SIGKILL replay — a fresh simulator instance reading the same ledger returns the pre-crash fill', async () => {
        const store: IFakeIdempotencyStore = { rows: [] };
        const repo = buildFakeRepo(store);
        const stubBefore = buildStreamingAdapterStub(SAMPLE_FILL);
        const simulatorBefore = new PaperFillSimulator(buildSubkeys(), repo, stubBefore.adapter, buildEventEmitterStub());

        const intent = buildIntent('evt-3');
        const context = buildContext('evt-3');

        const before = await simulatorBefore.simulateFill(intent, context, CoinTierEnum.TIER_1, 5_000);
        expect(stubBefore.calls).toBe(1);
        expect(store.rows).toHaveLength(1);

        // Simulate SIGKILL: drop the in-memory simulator + adapter, keep the
        // persisted ledger. A fresh simulator with a fresh adapter is
        // constructed (post-restart state).
        const stubAfter = buildStreamingAdapterStub({
            // If the adapter were called, it would return a DIFFERENT fill so a
            // bug in the ledger-lookup path produces a numerically visible
            // mismatch. The assertion below proves the adapter is never
            // invoked.
            ...SAMPLE_FILL,
            fillPrice: '999.99',
            qty: '0.999',
        });
        const simulatorAfter = new PaperFillSimulator(buildSubkeys(), repo, stubAfter.adapter, buildEventEmitterStub());

        const after = await simulatorAfter.simulateFill(intent, context, CoinTierEnum.TIER_1, 5_000);

        // Post-crash adapter was NEVER called.
        expect(stubAfter.calls).toBe(0);
        // The replayed fill is numerically equal to the pre-crash fill.
        expect(after.fill.fillPrice).toBe(before.fill.fillPrice);
        expect(after.fill.qty).toBe(before.fill.qty);
        expect(after.fill.feeUsdt).toBe(before.fill.feeUsdt);
        expect(after.fill.filled).toBe(before.fill.filled);
        expect(after.fill.tsMs).toBe(before.fill.tsMs);
    });

    it('distinct events / order_intent_ids / version_namespaces produce distinct ledger rows', async () => {
        const store: IFakeIdempotencyStore = { rows: [] };
        const repo = buildFakeRepo(store);
        const stub = buildStreamingAdapterStub(SAMPLE_FILL);
        const simulator = new PaperFillSimulator(buildSubkeys(), repo, stub.adapter, buildEventEmitterStub());

        await simulator.simulateFill(buildIntent('evt-A'), buildContext('evt-A'), CoinTierEnum.TIER_1, 5_000);
        await simulator.simulateFill(buildIntent('evt-B'), buildContext('evt-B'), CoinTierEnum.TIER_1, 5_000);
        // Same event, different version namespace — separate ledger row.
        await simulator.simulateFill(
            buildIntent('evt-A'),
            { eventId: 'evt-A', orderIntentId: 'evt-A-intent-1', versionNamespace: 'paper.shadow.v2' },
            CoinTierEnum.TIER_1,
            5_000,
        );

        expect(store.rows).toHaveLength(3);
        expect(stub.calls).toBe(3);
    });
});
