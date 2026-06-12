/**
 * M6 W7 — AccountSnapshotWriter + W6 carry-forward wiring.
 *
 * Coverage:
 *   - Writer: row contents (balance, equity, unrealized split LONG/SHORT sign-correct).
 *   - Writer: same-minute skip on scheduled; bypassed by drift_resolved / boot triggers.
 *   - Writer: writeNow() callable from boot/recon paths.
 *   - Writer: exchange fetchBalance failure tolerated (no crash; next tick retries).
 *   - Writer: positions in RECONCILING / MANUAL_ADOPTED_UNMANAGED contribute zero unrealized.
 *   - Writer: positions whose symbol has no price tick yet contribute zero (defensive skip).
 *   - Wiring: POSITION_OPENED_EVENT triggers instrumentor seed via onPositionOpenedEvent.
 *   - Wiring: ReconciliationService.runPass propagates liquidation price to instrumentor.
 *   - Wiring: ReconciliationService.runPass calls writeNow('drift_resolved') when any drift fires.
 */

import { PositionSideEnum, PositionSlotEnum, PositionStateEnum, ProtectiveOrderTypeEnum, TransactionTypeEnum } from '@bot/shared';

import { Money, MoneyValue } from '../../src/common/utils/money';
import { IPositionOpenedEvent } from '../../src/common/interface/IPositionOpenedEvent';
import { IBalanceSnapshot, IExchangeClient } from '../../src/exchange/interface';
import { AccountSnapshotEntity, PositionEntity, TransactionEntity } from '../../src/position/entity';
import { AccountSnapshotRepository } from '../../src/position/repository/AccountSnapshotRepository';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { TransactionRepository } from '../../src/position/repository/TransactionRepository';
import { AccountSnapshotWriter, ACCOUNT_SNAPSHOT_INTERVAL_MS } from '../../src/position/service/AccountSnapshotWriter';
import { PositionInstrumentor } from '../../src/position/service/PositionInstrumentor';
import { SharedCloseCoordinator } from '../../src/execution/service/SharedCloseCoordinator';

const NOW_MS = 1_700_000_000_000;

function buildOpenedEvent(positionId: number): IPositionOpenedEvent {
    return {
        positionId,
        symbol: 'BTCUSDT',
        side: PositionSideEnum.LONG,
        leverage: new Money('5'),
        entryPrice: new Money('30000'),
        entryNotional: new Money('300'),
        strategyVersionId: 1,
    };
}

function buildPositionRow(overrides: Partial<PositionEntity> = {}): PositionEntity {
    return {
        id: 42,
        symbol: 'BTCUSDT',
        side: PositionSideEnum.LONG,
        state: PositionStateEnum.OPEN,
        status: 'open',
        strategyVersionId: 1,
        leverage: new Money('5'),
        entryPrice: new Money('30000'),
        qty: new Money('0.01'),
        entryNotional: new Money('300'),
        openedAt: new Date(NOW_MS - 60_000),
        protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
        positionSlot: PositionSlotEnum.A,
        ...overrides,
    } as PositionEntity;
}

function buildBalance(total: string): IBalanceSnapshot {
    return { asset: 'USDT', free: total, used: '0', total };
}

interface IWriterHarnessOpts {
    balance?: IBalanceSnapshot[];
    fetchBalanceThrows?: boolean;
    positions?: PositionEntity[];
    transactionsByPositionId?: Map<number, TransactionEntity[]>;
}

function buildWriterHarness(opts: IWriterHarnessOpts = {}) {
    const fetchBalance = opts.fetchBalanceThrows
        ? jest.fn().mockRejectedValue(new Error('exchange offline'))
        : jest.fn().mockResolvedValue(opts.balance ?? [buildBalance('1000')]);

    const exchangeClient = { fetchBalance } as unknown as IExchangeClient;

    const findLiveRisk = jest.fn().mockResolvedValue(opts.positions ?? []);
    const positions = { findLiveRisk } as unknown as PositionRepository;

    const findByPosition = jest.fn().mockImplementation(async (positionId: number) => opts.transactionsByPositionId?.get(positionId) ?? []);
    const transactions = { findByPosition } as unknown as TransactionRepository;

    const save = jest.fn().mockImplementation(async (row: AccountSnapshotEntity) => ({ ...row, id: 1 }));
    // R1.3c: AccountSnapshotWriter routes entity construction through the
    // repository's named builder. The mock surfaces a passthrough so callers
    // hitting `save` continue to behave identically.
    const buildSnapshot = jest.fn().mockImplementation((row: AccountSnapshotEntity) => row);
    const snapshots = { save, buildSnapshot } as unknown as AccountSnapshotRepository;

    // M6 W8.5: gate-ready by default so existing W7 scheduledTick semantics are preserved.
    const riskGate = { isRecoveryReady: jest.fn().mockReturnValue(true) } as never;
    // M11a R2a BLOCKER B2 — TESTNET env so the PAPER env-gate does NOT
    // short-circuit. PAPER-specific behaviour is covered by
    // `AccountSnapshotWriter.paperGuard.spec.ts`.
    const appConfig = { exchangeEnv: 'testnet' } as never;
    const writer = new AccountSnapshotWriter(exchangeClient as never, positions, transactions, snapshots, riskGate, appConfig);

    return { writer, fetchBalance, findLiveRisk, findByPosition, save };
}

// ─── snapshot row contents ─────────────────────────────────────────────────

describe('AccountSnapshotWriter — row contents (ADR 0012 §6)', () => {
    it('writes balance + zero unrealized when no open positions', async () => {
        const { writer, save } = buildWriterHarness({ balance: [buildBalance('1500.50')] });

        const row = await writer.writeNow(NOW_MS, 'boot');

        expect(row).not.toBeNull();
        expect(save).toHaveBeenCalledTimes(1);
        const saved = save.mock.calls[0][0] as AccountSnapshotEntity;
        expect(saved.balance.toFixed()).toBe('1500.5');
        expect(saved.unrealizedPnl.toFixed()).toBe('0');
        expect(saved.unrealizedPnlPrice.toFixed()).toBe('0');
        expect(saved.unrealizedPnlFunding.toFixed()).toBe('0');
        expect(saved.equity.toFixed()).toBe('1500.5');
    });

    it('LONG position above entry contributes positive unrealized_pnl_price', async () => {
        const position = buildPositionRow({ side: PositionSideEnum.LONG, entryPrice: new Money('30000'), qty: new Money('0.01') });
        const { writer, save } = buildWriterHarness({ balance: [buildBalance('1000')], positions: [position] });

        // Seed the writer's per-symbol mark cache via the @OnEvent handler.
        writer.onPriceUpdate({ symbol: 'BTCUSDT', price: '30200', timestampMs: NOW_MS });

        await writer.writeNow(NOW_MS, 'boot');

        const saved = save.mock.calls[0][0] as AccountSnapshotEntity;
        // (30200 - 30000) * 0.01 = 2.0 (no fees)
        expect(saved.unrealizedPnlPrice.toFixed()).toBe('2');
        expect(saved.unrealizedPnlFunding.toFixed()).toBe('0');
        expect(saved.unrealizedPnl.toFixed()).toBe('2');
        expect(saved.equity.toFixed()).toBe('1002');
    });

    it('SHORT position above entry contributes negative unrealized_pnl_price (mirror)', async () => {
        const position = buildPositionRow({ side: PositionSideEnum.SHORT, entryPrice: new Money('30000'), qty: new Money('0.01') });
        const { writer, save } = buildWriterHarness({ balance: [buildBalance('1000')], positions: [position] });

        writer.onPriceUpdate({ symbol: 'BTCUSDT', price: '30200', timestampMs: NOW_MS });

        await writer.writeNow(NOW_MS, 'boot');

        const saved = save.mock.calls[0][0] as AccountSnapshotEntity;
        // (30000 - 30200) * 0.01 = -2.0
        expect(saved.unrealizedPnlPrice.toFixed()).toBe('-2');
        expect(saved.equity.toFixed()).toBe('998');
    });

    it('settled funding rows aggregate into unrealized_pnl_funding (positive received)', async () => {
        const position = buildPositionRow({ side: PositionSideEnum.LONG, entryPrice: new Money('30000'), qty: new Money('0.01') });
        const fundingTx = {
            id: 100,
            positionId: 42,
            type: TransactionTypeEnum.FUNDING,
            side: PositionSideEnum.LONG,
            price: new Money('30050'),
            qty: new Money('0.01'),
            fee: new Money('0'),
            cashflow: new Money('0.5'),
            clientOrderId: 'funding-42-1',
            exchangeOrderId: null,
            createdAt: new Date(NOW_MS),
        } as TransactionEntity;
        const { writer, save } = buildWriterHarness({
            balance: [buildBalance('1000')],
            positions: [position],
            transactionsByPositionId: new Map([[42, [fundingTx]]]),
        });
        writer.onPriceUpdate({ symbol: 'BTCUSDT', price: '30000', timestampMs: NOW_MS });

        await writer.writeNow(NOW_MS, 'boot');

        const saved = save.mock.calls[0][0] as AccountSnapshotEntity;
        expect(saved.unrealizedPnlFunding.toFixed()).toBe('0.5');
        expect(saved.unrealizedPnlPrice.toFixed()).toBe('0'); // mark == entry
        expect(saved.unrealizedPnl.toFixed()).toBe('0.5');
    });

    it('fees from non-funding transactions reduce unrealized_pnl_price', async () => {
        const position = buildPositionRow({ side: PositionSideEnum.LONG, entryPrice: new Money('30000'), qty: new Money('0.01') });
        const openTx = {
            id: 50,
            positionId: 42,
            type: TransactionTypeEnum.OPEN,
            side: PositionSideEnum.LONG,
            price: new Money('30000'),
            qty: new Money('0.01'),
            fee: new Money('0.12'),
            cashflow: new Money('0'),
            clientOrderId: 'tbvt-open-42',
            exchangeOrderId: 'ex-50',
            createdAt: new Date(NOW_MS - 60_000),
        } as TransactionEntity;
        const { writer, save } = buildWriterHarness({
            balance: [buildBalance('1000')],
            positions: [position],
            transactionsByPositionId: new Map([[42, [openTx]]]),
        });
        writer.onPriceUpdate({ symbol: 'BTCUSDT', price: '30200', timestampMs: NOW_MS });

        await writer.writeNow(NOW_MS, 'boot');

        const saved = save.mock.calls[0][0] as AccountSnapshotEntity;
        // priceTerm 2.0 - fees 0.12 = 1.88
        expect(saved.unrealizedPnlPrice.toFixed()).toBe('1.88');
    });

    it('RECONCILING positions contribute zero unrealized (drift-state skip)', async () => {
        const position = buildPositionRow({ side: PositionSideEnum.LONG, state: PositionStateEnum.RECONCILING });
        const { writer, save } = buildWriterHarness({ balance: [buildBalance('1000')], positions: [position] });
        writer.onPriceUpdate({ symbol: 'BTCUSDT', price: '30500', timestampMs: NOW_MS });

        await writer.writeNow(NOW_MS, 'boot');

        const saved = save.mock.calls[0][0] as AccountSnapshotEntity;
        expect(saved.unrealizedPnlPrice.toFixed()).toBe('0');
    });

    it('MANUAL_ADOPTED_UNMANAGED positions contribute zero unrealized', async () => {
        const position = buildPositionRow({ side: PositionSideEnum.LONG, state: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED });
        const { writer, save } = buildWriterHarness({ balance: [buildBalance('1000')], positions: [position] });
        writer.onPriceUpdate({ symbol: 'BTCUSDT', price: '30500', timestampMs: NOW_MS });

        await writer.writeNow(NOW_MS, 'boot');

        const saved = save.mock.calls[0][0] as AccountSnapshotEntity;
        expect(saved.unrealizedPnlPrice.toFixed()).toBe('0');
    });

    it('positions with no observed price tick yet contribute zero (cache miss is defensive)', async () => {
        const position = buildPositionRow({ symbol: 'NEWLISTING', side: PositionSideEnum.LONG });
        const { writer, save } = buildWriterHarness({ balance: [buildBalance('1000')], positions: [position] });
        // No onPriceUpdate call for 'NEWLISTING'.

        await writer.writeNow(NOW_MS, 'boot');

        const saved = save.mock.calls[0][0] as AccountSnapshotEntity;
        expect(saved.unrealizedPnlPrice.toFixed()).toBe('0');
    });

    it('uses USDT balance when fetchBalance returns multiple assets', async () => {
        const balances: IBalanceSnapshot[] = [
            { asset: 'BNB', free: '5', used: '0', total: '5' },
            { asset: 'USDT', free: '750', used: '250', total: '1000' },
        ];
        const { writer, save } = buildWriterHarness({ balance: balances });

        await writer.writeNow(NOW_MS, 'boot');

        const saved = save.mock.calls[0][0] as AccountSnapshotEntity;
        expect(saved.balance.toFixed()).toBe('1000');
    });

    it('uses zero balance when fetchBalance returns no USDT entry', async () => {
        const balances: IBalanceSnapshot[] = [{ asset: 'BNB', free: '5', used: '0', total: '5' }];
        const { writer, save } = buildWriterHarness({ balance: balances });

        await writer.writeNow(NOW_MS, 'boot');

        const saved = save.mock.calls[0][0] as AccountSnapshotEntity;
        expect(saved.balance.toFixed()).toBe('0');
    });
});

// ─── cadence + skip rule ───────────────────────────────────────────────────

describe('AccountSnapshotWriter — cadence + same-minute skip (ADR 0012 §6)', () => {
    it('scheduled tick is skipped if a write already happened in the same wall-minute', async () => {
        const { writer, save } = buildWriterHarness({ balance: [buildBalance('1000')] });

        // First scheduled write at minute boundary.
        await (writer as unknown as { writeSnapshot: (ms: number, trigger: 'scheduled') => Promise<unknown> }).writeSnapshot(NOW_MS, 'scheduled');
        // Second scheduled call within the same minute.
        await (writer as unknown as { writeSnapshot: (ms: number, trigger: 'scheduled') => Promise<unknown> }).writeSnapshot(NOW_MS + 30_000, 'scheduled');

        expect(save).toHaveBeenCalledTimes(1);
    });

    it('drift_resolved trigger bypasses the same-minute skip', async () => {
        const { writer, save } = buildWriterHarness({ balance: [buildBalance('1000')] });

        await writer.writeNow(NOW_MS, 'drift_resolved');
        await writer.writeNow(NOW_MS + 5_000, 'drift_resolved');

        expect(save).toHaveBeenCalledTimes(2);
    });

    it('boot trigger bypasses the same-minute skip', async () => {
        const { writer, save } = buildWriterHarness({ balance: [buildBalance('1000')] });

        await writer.writeNow(NOW_MS, 'scheduled');
        await writer.writeNow(NOW_MS + 5_000, 'boot');

        expect(save).toHaveBeenCalledTimes(2);
    });

    it('scheduled tick after the wall-minute rolls over does write', async () => {
        const { writer, save } = buildWriterHarness({ balance: [buildBalance('1000')] });

        await (writer as unknown as { writeSnapshot: (ms: number, trigger: 'scheduled') => Promise<unknown> }).writeSnapshot(NOW_MS, 'scheduled');
        // Roll over to the next wall-minute.
        await (writer as unknown as { writeSnapshot: (ms: number, trigger: 'scheduled') => Promise<unknown> }).writeSnapshot(NOW_MS + 60_500, 'scheduled');

        expect(save).toHaveBeenCalledTimes(2);
    });

    it('exposes ACCOUNT_SNAPSHOT_INTERVAL_MS = 60_000 (ADR 0012 §6)', () => {
        expect(ACCOUNT_SNAPSHOT_INTERVAL_MS).toBe(60_000);
    });
});

// ─── error tolerance ───────────────────────────────────────────────────────

describe('AccountSnapshotWriter — exchange-error tolerance (W7 item 5 adversarial)', () => {
    it('fetchBalance failure returns null, no crash, no save', async () => {
        const { writer, save } = buildWriterHarness({ fetchBalanceThrows: true });

        const result = await writer.writeNow(NOW_MS, 'boot');

        expect(result).toBeNull();
        expect(save).not.toHaveBeenCalled();
    });

    it('parsePrice rejects NaN/non-finite ticks without poisoning the cache', async () => {
        const position = buildPositionRow({ symbol: 'BTCUSDT' });
        const { writer, save } = buildWriterHarness({ balance: [buildBalance('1000')], positions: [position] });

        writer.onPriceUpdate({ symbol: 'BTCUSDT', price: 'not-a-number', timestampMs: NOW_MS });
        await writer.writeNow(NOW_MS, 'boot');

        const saved = save.mock.calls[0][0] as AccountSnapshotEntity;
        // No price observed for BTCUSDT → position contributes zero.
        expect(saved.unrealizedPnlPrice.toFixed()).toBe('0');
    });
});

// ─── W6 wiring: POSITION_OPENED_EVENT → instrumentor seed ────────────────

describe('PositionInstrumentor.onPositionOpenedEvent — W7 wiring (W6 carry-forward #3)', () => {
    it('seeds the accumulator when POSITION_OPENED_EVENT fires for a known position', async () => {
        const row = buildPositionRow();
        const findById = jest.fn().mockResolvedValue(row);
        const positions = { findById, save: jest.fn() } as unknown as PositionRepository;
        const instrumentor = new PositionInstrumentor(positions, { isRecoveryReady: jest.fn().mockReturnValue(true) } as never);

        await instrumentor.onPositionOpenedEvent(buildOpenedEvent(42));

        const stats = instrumentor.getLifeStats(42);
        expect(stats).not.toBeNull();
        expect(stats!.positionId).toBe(42);
    });

    it('skips silently when the position row is missing (race window)', async () => {
        const findById = jest.fn().mockResolvedValue(null);
        const positions = { findById, save: jest.fn() } as unknown as PositionRepository;
        const instrumentor = new PositionInstrumentor(positions, { isRecoveryReady: jest.fn().mockReturnValue(true) } as never);

        await instrumentor.onPositionOpenedEvent(buildOpenedEvent(999));

        expect(instrumentor.getLifeStats(999)).toBeNull();
    });
});

// ─── W6 wiring: recon propagates liquidation price to instrumentor ────────

describe('ReconciliationService — liquidation-price propagation to instrumentor (W7 wiring; W6 carry-forward #2)', () => {
    // Lightweight inline harness — the full ReconciliationService.spec.ts covers
    // the broader matrix; here we just verify the new wiring path.
    it('calls instrumentor.setLiquidationPrice for each matched (symbol, side) pair', async () => {
        const { ReconciliationService } = await import('../../src/position/service/ReconciliationService');
        const { HaltFlagService } = await import('../../src/common/service/HaltFlagService');
        const { EventEmitter2 } = await import('@nestjs/event-emitter');
        const { SubscriptionRetainer } = await import('../../src/market-data/service/SubscriptionRetainer');

        const dbRow = buildPositionRow({ id: 42, symbol: 'BTCUSDT', side: PositionSideEnum.LONG, protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK });
        const exchangeClient = {
            fetchPositions: jest.fn().mockResolvedValue([
                {
                    symbol: 'BTCUSDT',
                    side: 'long',
                    qty: '0.01',
                    entryPrice: '30000',
                    markPrice: '30100',
                    liquidationPrice: '25000',
                    marginType: null,
                    leverage: '5',
                    timestampMs: NOW_MS,
                },
            ]),
            fetchOpenOrders: jest.fn().mockResolvedValue([]),
            fetchOrderByClientId: jest.fn(),
            fetchFundingHistory: jest.fn().mockResolvedValue([]),
        };
        const positions = {
            findOpen: jest.fn().mockResolvedValue([dbRow]),
            findNonTerminal: jest.fn().mockResolvedValue([dbRow]),
            findById: jest.fn().mockResolvedValue(dbRow),
            createOpen: jest.fn(),
            save: jest.fn(),
            findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
        };
        const transactions = { findByClientOrderId: jest.fn(), findLatestFundingByPosition: jest.fn().mockResolvedValue(null) };
        const positionService = { transition: jest.fn(), adjustQty: jest.fn(), recordFunding: jest.fn(), finalizeRealizedPnl: jest.fn() };
        const riskGate = { expireStaleReservations: jest.fn(), reconcileClose: jest.fn(), recordExposureDrift: jest.fn(), evaluate: jest.fn() };
        const monitor = { arm: jest.fn(), disarm: jest.fn() };
        const retainer = new SubscriptionRetainer();
        const strategyVersions = { findByNameAndVersion: jest.fn() };
        const haltFlag = new HaltFlagService();
        const instrumentor = { setLiquidationPrice: jest.fn() };
        const snapshotWriter = { writeNow: jest.fn().mockResolvedValue(null) };
        const events = new EventEmitter2();

        const service = new ReconciliationService(
            exchangeClient as never,
            exchangeClient as never,
            { exchangeEnv: 'testnet' } as never,
            positions as never,
            transactions as never,
            positionService as never,
            riskGate as never,
            monitor as never,
            retainer,
            strategyVersions as never,
            haltFlag,
            instrumentor as never,
            snapshotWriter as never,
            events,
            new SharedCloseCoordinator(),
        );

        await service.tick(NOW_MS);

        expect(instrumentor.setLiquidationPrice).toHaveBeenCalledTimes(1);
        const args = instrumentor.setLiquidationPrice.mock.calls[0] as [number, string, MoneyValue];
        expect(args[0]).toBe(42);
        expect(args[1]).toBe('BTCUSDT');
        expect(args[2].toFixed()).toBe('25000');
    });

    it('skips propagation when liquidation price is null on the snapshot', async () => {
        const { ReconciliationService } = await import('../../src/position/service/ReconciliationService');
        const { HaltFlagService } = await import('../../src/common/service/HaltFlagService');
        const { EventEmitter2 } = await import('@nestjs/event-emitter');
        const { SubscriptionRetainer } = await import('../../src/market-data/service/SubscriptionRetainer');

        const dbRow = buildPositionRow({ protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK });
        const exchangeClient = {
            fetchPositions: jest.fn().mockResolvedValue([
                {
                    symbol: 'BTCUSDT',
                    side: 'long',
                    qty: '0.01',
                    entryPrice: '30000',
                    markPrice: '30100',
                    liquidationPrice: null,
                    marginType: null,
                    leverage: '5',
                    timestampMs: NOW_MS,
                },
            ]),
            fetchOpenOrders: jest.fn().mockResolvedValue([]),
            fetchOrderByClientId: jest.fn(),
            fetchFundingHistory: jest.fn().mockResolvedValue([]),
        };
        const positions = {
            findOpen: jest.fn().mockResolvedValue([dbRow]),
            findNonTerminal: jest.fn().mockResolvedValue([dbRow]),
            findById: jest.fn().mockResolvedValue(dbRow),
            createOpen: jest.fn(),
            save: jest.fn(),
            findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
        };
        const transactions = { findByClientOrderId: jest.fn(), findLatestFundingByPosition: jest.fn().mockResolvedValue(null) };
        const positionService = { transition: jest.fn(), adjustQty: jest.fn(), recordFunding: jest.fn(), finalizeRealizedPnl: jest.fn() };
        const riskGate = { expireStaleReservations: jest.fn(), reconcileClose: jest.fn(), recordExposureDrift: jest.fn(), evaluate: jest.fn() };
        const monitor = { arm: jest.fn(), disarm: jest.fn() };
        const retainer = new SubscriptionRetainer();
        const haltFlag = new HaltFlagService();
        const instrumentor = { setLiquidationPrice: jest.fn() };
        const snapshotWriter = { writeNow: jest.fn().mockResolvedValue(null) };
        const events = new EventEmitter2();

        const service = new ReconciliationService(
            exchangeClient as never,
            exchangeClient as never,
            { exchangeEnv: 'testnet' } as never,
            positions as never,
            transactions as never,
            positionService as never,
            riskGate as never,
            monitor as never,
            retainer,
            { findByNameAndVersion: jest.fn() } as never,
            haltFlag,
            instrumentor as never,
            snapshotWriter as never,
            events,
            new SharedCloseCoordinator(),
        );

        await service.tick(NOW_MS);

        // setLiquidationPrice IS called (the recon tick always propagates the latest
        // value, including nulls — the instrumentor decides what to do with null).
        expect(instrumentor.setLiquidationPrice).toHaveBeenCalledTimes(1);
        const args = instrumentor.setLiquidationPrice.mock.calls[0] as [number, string, MoneyValue | null];
        expect(args[2]).toBeNull();
    });
});

// ─── W7 wiring: recon drift-forced snapshot ───────────────────────────────

describe('ReconciliationService — drift-forced snapshot (W7 item 2; ADR 0012 §6)', () => {
    it('calls snapshotWriter.writeNow with drift_resolved trigger when a drift case fires', async () => {
        const { ReconciliationService } = await import('../../src/position/service/ReconciliationService');
        const { HaltFlagService } = await import('../../src/common/service/HaltFlagService');
        const { EventEmitter2 } = await import('@nestjs/event-emitter');
        const { SubscriptionRetainer } = await import('../../src/market-data/service/SubscriptionRetainer');

        // Case (b): DB row open, exchange returns no matching position → drift fires.
        const dbRow = buildPositionRow({ protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK });
        const exchangeClient = {
            fetchPositions: jest.fn().mockResolvedValue([]),
            fetchOpenOrders: jest.fn().mockResolvedValue([]),
            fetchOrderByClientId: jest.fn(),
            fetchFundingHistory: jest.fn().mockResolvedValue([]),
        };
        const positions = {
            findOpen: jest.fn().mockResolvedValue([dbRow]),
            findNonTerminal: jest.fn().mockResolvedValue([dbRow]),
            findById: jest.fn().mockResolvedValue(dbRow),
            createOpen: jest.fn(),
            save: jest.fn(),
            findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
        };
        const positionService = { transition: jest.fn(), adjustQty: jest.fn(), recordFunding: jest.fn(), finalizeRealizedPnl: jest.fn() };
        const riskGate = { expireStaleReservations: jest.fn(), reconcileClose: jest.fn(), recordExposureDrift: jest.fn(), evaluate: jest.fn() };
        const monitor = { arm: jest.fn(), disarm: jest.fn() };
        const retainer = new SubscriptionRetainer();
        const haltFlag = new HaltFlagService();
        const instrumentor = { setLiquidationPrice: jest.fn() };
        const snapshotWriter = { writeNow: jest.fn().mockResolvedValue(null) };
        const events = new EventEmitter2();

        const service = new ReconciliationService(
            exchangeClient as never,
            exchangeClient as never,
            { exchangeEnv: 'testnet' } as never,
            positions as never,
            { findByClientOrderId: jest.fn(), findLatestFundingByPosition: jest.fn().mockResolvedValue(null) } as never,
            positionService as never,
            riskGate as never,
            monitor as never,
            retainer,
            { findByNameAndVersion: jest.fn() } as never,
            haltFlag,
            instrumentor as never,
            snapshotWriter as never,
            events,
            new SharedCloseCoordinator(),
        );

        await service.tick(NOW_MS);

        expect(snapshotWriter.writeNow).toHaveBeenCalledTimes(1);
        expect(snapshotWriter.writeNow).toHaveBeenCalledWith(NOW_MS, 'drift_resolved');
    });

    it('does NOT call writeNow when no drift fires (clean tick)', async () => {
        const { ReconciliationService } = await import('../../src/position/service/ReconciliationService');
        const { HaltFlagService } = await import('../../src/common/service/HaltFlagService');
        const { EventEmitter2 } = await import('@nestjs/event-emitter');
        const { SubscriptionRetainer } = await import('../../src/market-data/service/SubscriptionRetainer');

        const exchangeClient = {
            fetchPositions: jest.fn().mockResolvedValue([]),
            fetchOpenOrders: jest.fn().mockResolvedValue([]),
            fetchOrderByClientId: jest.fn(),
            fetchFundingHistory: jest.fn().mockResolvedValue([]),
        };
        const positions = {
            findOpen: jest.fn().mockResolvedValue([]),
            findNonTerminal: jest.fn().mockResolvedValue([]),
            findById: jest.fn().mockResolvedValue(null),
            findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
        };
        const snapshotWriter = { writeNow: jest.fn().mockResolvedValue(null) };

        const service = new ReconciliationService(
            exchangeClient as never,
            exchangeClient as never,
            { exchangeEnv: 'testnet' } as never,
            positions as never,
            { findByClientOrderId: jest.fn(), findLatestFundingByPosition: jest.fn().mockResolvedValue(null) } as never,
            { transition: jest.fn(), adjustQty: jest.fn(), recordFunding: jest.fn(), finalizeRealizedPnl: jest.fn() } as never,
            { expireStaleReservations: jest.fn(), reconcileClose: jest.fn(), recordExposureDrift: jest.fn(), evaluate: jest.fn() } as never,
            { arm: jest.fn(), disarm: jest.fn() } as never,
            new SubscriptionRetainer(),
            { findByNameAndVersion: jest.fn() } as never,
            new HaltFlagService(),
            { setLiquidationPrice: jest.fn() } as never,
            snapshotWriter as never,
            new EventEmitter2(),
            new SharedCloseCoordinator(),
        );

        await service.tick(NOW_MS);

        expect(snapshotWriter.writeNow).not.toHaveBeenCalled();
    });
});
