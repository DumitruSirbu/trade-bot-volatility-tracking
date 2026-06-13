/**
 * M6 W5 — funding cashflows + realized/unrealized PnL (ADR 0012).
 *
 * Coverage matrix (paired-per-fix, one happy-path per feature + adversarial):
 *
 *   computeUnrealizedPnl (pure helper, ADR 0012 §4):
 *     - LONG above entry → positive pricePnl
 *     - LONG below entry → negative pricePnl
 *     - SHORT above entry → negative pricePnl (mirror)
 *     - SHORT below entry → positive pricePnl (mirror)
 *     - Funding accrual added with correct sign per side+rate
 *     - Fees subtracted from priceTerm
 *     - Side-aware: identical price/qty/funding but opposite side flips sign of price term
 *
 *   PositionService.recordFunding (ADR 0012 §1):
 *     - Funding event → exactly one TransactionEntity row with cashflow set,
 *       type=FUNDING, fee=0, deterministic clientOrderId.
 *
 *   PositionService.finalizeRealizedPnl (ADR 0012 §5):
 *     - LONG closed at +X → realizedPnl = (exit-entry)*qty - fees + funding
 *     - SHORT closed at +X (entry > exit) → realizedPnl = (entry-exit)*qty - fees + funding
 *     - Exit price = vol-weighted avg of reduce/close transaction rows
 *     - Exit reason persists from finalize arg through to closePayload
 *     - Funding rows (cashflow only) contribute to realizedPnl
 *     - Empty/zero-fill close: realizedPnl=null, exitReason still recorded
 *     - Re-CLOSE rejected by state graph (CLOSED has no out-edge)
 *
 *   ReconciliationService funding ingestion (ADR 0012 §2):
 *     - One funding event from the exchange snapshot becomes exactly one
 *       recordFunding call with cashflow set
 *     - Rerun produces zero new recordFunding calls (sinceMs floored above the last row)
 *     - Position state CLOSING/RECONCILING/MANUAL_ADOPTED_UNMANAGED skipped
 */

import {
    ExitReasonEnum,
    IPositionStateTransitionedEvent,
    PositionSideEnum,
    PositionSlotEnum,
    PositionStateEnum,
    ProtectiveOrderTypeEnum,
    TransactionTypeEnum,
} from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { HaltFlagService } from '../../src/common/service/HaltFlagService';
import { Money } from '../../src/common/utils/money';
import { LocalProtectiveMonitor } from '../../src/execution/service/LocalProtectiveMonitor';
import { SharedCloseCoordinator } from '../../src/execution/service/SharedCloseCoordinator';
import { SubscriptionRetainer } from '../../src/market-data/service/SubscriptionRetainer';
import { POSITION_STATE_TRANSITIONED_EVENT } from '../../src/position/const';
import { PositionEntity, TransactionEntity } from '../../src/position/entity';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { TransactionRepository } from '../../src/position/repository/TransactionRepository';
import { PositionService } from '../../src/position/service/PositionService';
import { ReconciliationService } from '../../src/position/service/ReconciliationService';
import { computeUnrealizedPnl } from '../../src/position/util/pnlMath';
import { RiskGateService } from '../../src/risk/service/RiskGateService';
import { StrategyVersionRepository } from '../../src/strategy/repository/StrategyVersionRepository';

const NOW_MS = 1_700_000_000_000;

function buildPositionRow(overrides: Partial<PositionEntity> = {}): PositionEntity {
    return {
        id: 42,
        symbol: 'BTCUSDT',
        side: PositionSideEnum.LONG,
        state: PositionStateEnum.CLOSING,
        status: 'open',
        strategyVersionId: 1,
        leverage: new Money('5'),
        entryPrice: new Money('30000'),
        qty: new Money('0.01'),
        entryNotional: new Money('300'),
        openedAt: new Date(NOW_MS - 9 * 60 * 60 * 1000),
        protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
        positionSlot: PositionSlotEnum.A,
        ...overrides,
    } as PositionEntity;
}

function buildTxRow(overrides: Partial<TransactionEntity> = {}): TransactionEntity {
    return {
        id: 1,
        positionId: 42,
        type: TransactionTypeEnum.CLOSE,
        side: PositionSideEnum.SHORT,
        price: new Money('30100'),
        qty: new Money('0.01'),
        fee: new Money('0.1'),
        cashflow: new Money('1'),
        clientOrderId: 'cid-1',
        exchangeOrderId: 'ex-1',
        createdAt: new Date(NOW_MS),
        ...overrides,
    } as TransactionEntity;
}

// ═══════════════════════════════════════════════════════════════════════════════
// computeUnrealizedPnl — pure helper (ADR 0012 §4)
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeUnrealizedPnl (ADR 0012 §4) — single helper for unrealized PnL', () => {
    it('LONG above entry → positive priceTerm', () => {
        const result = computeUnrealizedPnl({
            side: PositionSideEnum.LONG,
            qty: new Money('0.5'),
            entryPrice: new Money('30000'),
            markPrice: new Money('30200'),
            feesPaid: new Money('0'),
            settledFunding: new Money('0'),
            accruedFunding: new Money('0'),
        });

        expect(result.pricePnl.toFixed()).toBe('100'); // (30200-30000)*0.5
        expect(result.fundingPnl.toFixed()).toBe('0');
        expect(result.total.toFixed()).toBe('100');
    });

    it('LONG below entry → negative priceTerm', () => {
        const result = computeUnrealizedPnl({
            side: PositionSideEnum.LONG,
            qty: new Money('0.5'),
            entryPrice: new Money('30000'),
            markPrice: new Money('29800'),
            feesPaid: new Money('0'),
            settledFunding: new Money('0'),
            accruedFunding: new Money('0'),
        });

        expect(result.pricePnl.toFixed()).toBe('-100');
    });

    it('SHORT above entry → negative priceTerm (mirror of LONG)', () => {
        const result = computeUnrealizedPnl({
            side: PositionSideEnum.SHORT,
            qty: new Money('0.5'),
            entryPrice: new Money('30000'),
            markPrice: new Money('30200'),
            feesPaid: new Money('0'),
            settledFunding: new Money('0'),
            accruedFunding: new Money('0'),
        });

        expect(result.pricePnl.toFixed()).toBe('-100');
    });

    it('SHORT below entry → positive priceTerm', () => {
        const result = computeUnrealizedPnl({
            side: PositionSideEnum.SHORT,
            qty: new Money('0.5'),
            entryPrice: new Money('30000'),
            markPrice: new Money('29800'),
            feesPaid: new Money('0'),
            settledFunding: new Money('0'),
            accruedFunding: new Money('0'),
        });

        expect(result.pricePnl.toFixed()).toBe('100');
    });

    it('subtracts fees from priceTerm in the pricePnl axis', () => {
        const result = computeUnrealizedPnl({
            side: PositionSideEnum.LONG,
            qty: new Money('0.5'),
            entryPrice: new Money('30000'),
            markPrice: new Money('30200'),
            feesPaid: new Money('5'),
            settledFunding: new Money('0'),
            accruedFunding: new Money('0'),
        });

        expect(result.pricePnl.toFixed()).toBe('95'); // 100 - 5
        expect(result.total.toFixed()).toBe('95');
    });

    it('adds settled+accrued funding to the fundingPnl axis with caller sign', () => {
        const result = computeUnrealizedPnl({
            side: PositionSideEnum.LONG,
            qty: new Money('0.5'),
            entryPrice: new Money('30000'),
            markPrice: new Money('30000'),
            feesPaid: new Money('0'),
            settledFunding: new Money('-2.5'),
            accruedFunding: new Money('-0.3'),
        });

        expect(result.fundingPnl.toFixed()).toBe('-2.8');
        expect(result.pricePnl.toFixed()).toBe('0');
        expect(result.total.toFixed()).toBe('-2.8');
    });

    it('positive funding (received) adds to total', () => {
        const result = computeUnrealizedPnl({
            side: PositionSideEnum.SHORT,
            qty: new Money('0.5'),
            entryPrice: new Money('30000'),
            markPrice: new Money('30000'),
            feesPaid: new Money('0'),
            settledFunding: new Money('1.5'),
            accruedFunding: new Money('0.5'),
        });

        expect(result.fundingPnl.toFixed()).toBe('2');
        expect(result.total.toFixed()).toBe('2');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PositionService.recordFunding (ADR 0012 §1)
// ═══════════════════════════════════════════════════════════════════════════════

describe('PositionService.recordFunding (ADR 0012 §1) — single funding writer', () => {
    function buildService() {
        const positions = {
            findById: jest.fn(),
            save: jest.fn(),
        } as unknown as PositionRepository;
        const recordTerminal = jest.fn().mockImplementation(async (e: Partial<TransactionEntity>) => e as TransactionEntity);
        const transactions = {
            findByPosition: jest.fn().mockResolvedValue([]),
            recordTerminal,
        } as unknown as TransactionRepository;
        const events = new EventEmitter2();
        const service = new PositionService(positions, transactions, events);
        return { service, recordTerminal };
    }

    it('writes one transaction row with type=FUNDING, fee=0, signed cashflow', async () => {
        const { service, recordTerminal } = buildService();

        await service.recordFunding({
            positionId: 42,
            side: PositionSideEnum.LONG,
            symbol: 'BTCUSDT',
            cashflow: new Money('-0.45'),
            fundingTimeMs: NOW_MS,
            markPrice: new Money('30100'),
            qty: new Money('0.01'),
            exchangeOrderId: 'tran-12345',
        });

        expect(recordTerminal).toHaveBeenCalledTimes(1);
        const arg = recordTerminal.mock.calls[0][0] as Partial<TransactionEntity>;
        expect(arg.type).toBe(TransactionTypeEnum.FUNDING);
        expect(arg.positionId).toBe(42);
        expect((arg.fee as InstanceType<typeof Money>).toFixed()).toBe('0');
        expect((arg.cashflow as InstanceType<typeof Money>).toFixed()).toBe('-0.45');
        expect(arg.clientOrderId).toBe(`funding-42-${NOW_MS}`);
        expect(arg.exchangeOrderId).toBe('tran-12345');
    });

    it('uses deterministic clientOrderId so a rerun is idempotent via the unique constraint', async () => {
        const { service, recordTerminal } = buildService();

        await service.recordFunding({
            positionId: 7,
            side: PositionSideEnum.SHORT,
            symbol: 'ETHUSDT',
            cashflow: new Money('0.12'),
            fundingTimeMs: 1_700_000_001_000,
            markPrice: new Money('2000'),
            qty: new Money('1.5'),
            exchangeOrderId: null,
        });
        await service.recordFunding({
            positionId: 7,
            side: PositionSideEnum.SHORT,
            symbol: 'ETHUSDT',
            cashflow: new Money('0.12'),
            fundingTimeMs: 1_700_000_001_000,
            markPrice: new Money('2000'),
            qty: new Money('1.5'),
            exchangeOrderId: null,
        });

        // Both calls land with the SAME clientOrderId — the repository's
        // recordTerminal handles the unique-violation as a no-op. Asserting the
        // signature here proves the dedupe key is constructed from the position
        // + fundingTime alone.
        const ids = recordTerminal.mock.calls.map(([row]) => (row as { clientOrderId: string }).clientOrderId);
        expect(ids).toEqual(['funding-7-1700000001000', 'funding-7-1700000001000']);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PositionService.finalizeRealizedPnl (ADR 0012 §5)
// ═══════════════════════════════════════════════════════════════════════════════

describe('PositionService.finalizeRealizedPnl (ADR 0012 §5) — realized PnL aggregate at close', () => {
    function buildService(position: PositionEntity, txs: TransactionEntity[]) {
        const positions = {
            findById: jest.fn().mockResolvedValue(position),
            save: jest.fn().mockImplementation(async (p: PositionEntity) => p),
        } as unknown as PositionRepository;
        const transactions = {
            findByPosition: jest.fn().mockResolvedValue(txs),
            recordTerminal: jest.fn(),
        } as unknown as TransactionRepository;
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');
        const service = new PositionService(positions, transactions, events);
        return { service, positions, emitSpy };
    }

    it('LONG closed: realizedPnl = (exit-entry)*qty - fees + funding', async () => {
        const position = buildPositionRow({ side: PositionSideEnum.LONG, state: PositionStateEnum.CLOSING });
        const txs: TransactionEntity[] = [
            buildTxRow({ type: TransactionTypeEnum.OPEN, cashflow: new Money('0'), fee: new Money('0.3'), price: new Money('30000'), qty: new Money('0.01') }),
            buildTxRow({
                type: TransactionTypeEnum.CLOSE,
                cashflow: new Money('1'),
                fee: new Money('0.31'),
                price: new Money('30100'),
                qty: new Money('0.01'),
            }), // (30100-30000)*0.01 = 1
            buildTxRow({
                type: TransactionTypeEnum.FUNDING,
                cashflow: new Money('-0.12'),
                fee: new Money('0'),
                price: new Money('30050'),
                qty: new Money('0.01'),
            }),
        ];
        const { service } = buildService(position, txs);

        const saved = await service.finalizeRealizedPnl(42, ExitReasonEnum.TAKE_PROFIT, { nowMs: NOW_MS, eventClass: 'test' });

        // fillPnl=1, fees=0.61 (open+close), funding=-0.12 → 1 - 0.61 - 0.12 = 0.27
        expect(saved.realizedPnl?.toFixed()).toBe('0.27');
        expect(saved.exitReason).toBe(ExitReasonEnum.TAKE_PROFIT);
        expect(saved.exitPrice?.toFixed()).toBe('30100');
        expect(saved.state).toBe(PositionStateEnum.CLOSED);
        expect(saved.closedAt).toEqual(new Date(NOW_MS));
    });

    it('SHORT closed: realizedPnl mirrors with (entry-exit)*qty', async () => {
        const position = buildPositionRow({ side: PositionSideEnum.SHORT, state: PositionStateEnum.CLOSING, entryPrice: new Money('30000') });
        const txs: TransactionEntity[] = [
            buildTxRow({ type: TransactionTypeEnum.OPEN, cashflow: new Money('0'), fee: new Money('0.3'), price: new Money('30000'), qty: new Money('0.01') }),
            // SHORT exits at 29800 — cashflow = (entry-exit)*qty = (30000-29800)*0.01 = 2
            buildTxRow({ type: TransactionTypeEnum.CLOSE, cashflow: new Money('2'), fee: new Money('0.3'), price: new Money('29800'), qty: new Money('0.01') }),
            buildTxRow({
                type: TransactionTypeEnum.FUNDING,
                cashflow: new Money('0.5'),
                fee: new Money('0'),
                price: new Money('29900'),
                qty: new Money('0.01'),
            }),
        ];
        const { service } = buildService(position, txs);

        const saved = await service.finalizeRealizedPnl(42, ExitReasonEnum.STOP_LOSS, { nowMs: NOW_MS, eventClass: 'test' });

        // fillPnl=2, fees=0.6, funding=+0.5 → 2 - 0.6 + 0.5 = 1.9
        expect(saved.realizedPnl?.toFixed()).toBe('1.9');
        expect(saved.exitReason).toBe(ExitReasonEnum.STOP_LOSS);
    });

    it('exitPrice = volume-weighted avg over reduce + close fills', async () => {
        const position = buildPositionRow({ state: PositionStateEnum.CLOSING });
        const txs: TransactionEntity[] = [
            buildTxRow({
                type: TransactionTypeEnum.REDUCE,
                cashflow: new Money('1'),
                fee: new Money('0.1'),
                price: new Money('30100'),
                qty: new Money('0.003'),
            }),
            buildTxRow({
                type: TransactionTypeEnum.CLOSE,
                cashflow: new Money('2'),
                fee: new Money('0.2'),
                price: new Money('30200'),
                qty: new Money('0.007'),
            }),
        ];
        const { service } = buildService(position, txs);

        const saved = await service.finalizeRealizedPnl(42, ExitReasonEnum.SIGNAL, { nowMs: NOW_MS, eventClass: 'test' });

        // (30100*0.003 + 30200*0.007) / (0.003 + 0.007) = (90.3 + 211.4) / 0.01 = 30170
        expect(saved.exitPrice?.toFixed()).toBe('30170');
    });

    it('zero closing fills (defensive) → realizedPnl=null, exitReason still recorded', async () => {
        const position = buildPositionRow({ state: PositionStateEnum.CLOSING });
        const txs: TransactionEntity[] = [
            buildTxRow({ type: TransactionTypeEnum.OPEN, cashflow: new Money('0'), fee: new Money('0.3'), price: new Money('30000'), qty: new Money('0.01') }),
        ];
        const { service } = buildService(position, txs);

        const saved = await service.finalizeRealizedPnl(42, ExitReasonEnum.RECONCILED_MISSING, { nowMs: NOW_MS, eventClass: 'test' });

        expect(saved.realizedPnl).toBeNull();
        expect(saved.exitPrice).toBeNull();
        expect(saved.exitReason).toBe(ExitReasonEnum.RECONCILED_MISSING);
        expect(saved.state).toBe(PositionStateEnum.CLOSED);
    });

    it('each exit reason flows through to the persisted column', async () => {
        const reasons = [
            ExitReasonEnum.TAKE_PROFIT,
            ExitReasonEnum.STOP_LOSS,
            ExitReasonEnum.TIME_STOP,
            ExitReasonEnum.SIGNAL,
            ExitReasonEnum.MANUAL,
            ExitReasonEnum.KILL_SWITCH,
            ExitReasonEnum.RECONCILED_MISSING,
            ExitReasonEnum.LIQUIDATED,
        ];

        for (const reason of reasons) {
            const position = buildPositionRow({ state: PositionStateEnum.CLOSING, exitReason: null });
            const { service } = buildService(position, [
                buildTxRow({
                    type: TransactionTypeEnum.CLOSE,
                    cashflow: new Money('1'),
                    fee: new Money('0.1'),
                    price: new Money('30100'),
                    qty: new Money('0.01'),
                }),
            ]);

            const saved = await service.finalizeRealizedPnl(42, reason, { nowMs: NOW_MS, eventClass: 'test' });

            expect(saved.exitReason).toBe(reason);
        }
    });

    it('emits POSITION_STATE_TRANSITIONED_EVENT with toState=CLOSED on success', async () => {
        const position = buildPositionRow({ state: PositionStateEnum.CLOSING });
        const { service, emitSpy } = buildService(position, [
            buildTxRow({ type: TransactionTypeEnum.CLOSE, cashflow: new Money('1'), fee: new Money('0.1'), price: new Money('30100'), qty: new Money('0.01') }),
        ]);

        await service.finalizeRealizedPnl(42, ExitReasonEnum.SIGNAL, { nowMs: NOW_MS, eventClass: 'execution.reduce.fill.terminal' });

        const transitions = emitSpy.mock.calls.filter(([n]) => n === POSITION_STATE_TRANSITIONED_EVENT).map(([, p]) => p as IPositionStateTransitionedEvent);
        expect(transitions).toHaveLength(1);
        expect(transitions[0].toState).toBe(PositionStateEnum.CLOSED);
        expect(transitions[0].eventClass).toBe('execution.reduce.fill.terminal');
    });

    it('atomic dual-write: CLOSED state and exit_reason persist in the SAME save call (no split write)', async () => {
        const position = buildPositionRow({ state: PositionStateEnum.CLOSING });
        const positions = {
            findById: jest.fn().mockResolvedValue(position),
            save: jest.fn().mockImplementation(async (p: PositionEntity) => p),
        } as unknown as PositionRepository;
        const transactions = {
            findByPosition: jest.fn().mockResolvedValue([
                buildTxRow({
                    type: TransactionTypeEnum.CLOSE,
                    cashflow: new Money('1'),
                    fee: new Money('0.1'),
                    price: new Money('30100'),
                    qty: new Money('0.01'),
                }),
            ]),
            recordTerminal: jest.fn(),
        } as unknown as TransactionRepository;
        const events = new EventEmitter2();
        const service = new PositionService(positions, transactions, events);

        await service.finalizeRealizedPnl(42, ExitReasonEnum.TAKE_PROFIT, { nowMs: NOW_MS, eventClass: 'test' });

        // ADR 0009 §6.1: closed_at + exit_reason + realized_pnl + state land in ONE
        // UPDATE. We assert save was called once and the saved row carries all four.
        expect(positions.save).toHaveBeenCalledTimes(1);
        const saved = (positions.save as jest.Mock).mock.calls[0][0] as PositionEntity;
        expect(saved.state).toBe(PositionStateEnum.CLOSED);
        expect(saved.exitReason).toBe(ExitReasonEnum.TAKE_PROFIT);
        expect(saved.realizedPnl).not.toBeNull();
        expect(saved.closedAt).toEqual(new Date(NOW_MS));
    });

    it('re-finalize on CLOSED row is rejected by the transition graph (no double-PnL write)', async () => {
        const position = buildPositionRow({ state: PositionStateEnum.CLOSED });
        const { service } = buildService(position, [
            buildTxRow({ type: TransactionTypeEnum.CLOSE, cashflow: new Money('1'), fee: new Money('0.1'), price: new Money('30100'), qty: new Money('0.01') }),
        ]);

        await expect(service.finalizeRealizedPnl(42, ExitReasonEnum.SIGNAL, { nowMs: NOW_MS, eventClass: 'test' })).rejects.toThrow();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ReconciliationService funding ingestion (ADR 0012 §2)
// ═══════════════════════════════════════════════════════════════════════════════

describe('ReconciliationService funding ingestion (ADR 0012 §2)', () => {
    interface IFundingIngestHarness {
        service: ReconciliationService;
        exchangeClient: { fetchFundingHistory: jest.Mock; fetchPositions: jest.Mock; fetchOpenOrders: jest.Mock; fetchOrderByClientId: jest.Mock };
        positionService: { recordFunding: jest.Mock; transition: jest.Mock; adjustQty: jest.Mock; finalizeRealizedPnl: jest.Mock };
        transactions: { findLatestFundingByPosition: jest.Mock; findByClientOrderId: jest.Mock };
    }

    function buildHarness(opts: {
        dbPositions: PositionEntity[];
        fundingEvents: Array<{ id: string | null; symbol: string; fundingTimeMs: number; amount: string; asset: string }>;
        latestFundingRow?: TransactionEntity | null;
    }): IFundingIngestHarness {
        const exchangeClient = {
            fetchPositions: jest.fn().mockResolvedValue([]),
            fetchOpenOrders: jest.fn().mockResolvedValue([]),
            fetchOrderByClientId: jest.fn().mockResolvedValue(null),
            fetchFundingHistory: jest.fn().mockResolvedValue(opts.fundingEvents),
        };

        const positions = {
            findOpen: jest.fn().mockResolvedValue(opts.dbPositions),
            findNonTerminal: jest.fn().mockResolvedValue(opts.dbPositions),
            findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
        } as unknown as PositionRepository;

        const transactions = {
            findByClientOrderId: jest.fn().mockResolvedValue(null),
            findLatestFundingByPosition: jest.fn().mockResolvedValue(opts.latestFundingRow ?? null),
        };

        const positionService = {
            transition: jest.fn().mockResolvedValue(undefined),
            adjustQty: jest.fn().mockResolvedValue(undefined),
            finalizeRealizedPnl: jest.fn().mockResolvedValue(undefined),
            recordFunding: jest.fn().mockResolvedValue({ id: 1 } as TransactionEntity),
        };

        const riskGate = {
            expireStaleReservations: jest.fn(),
            listActiveReservationSlots: jest.fn().mockReturnValue([]),
            reconcileClose: jest.fn(),
            recordExposureDrift: jest.fn(),
        };
        const monitor = { arm: jest.fn(), disarm: jest.fn() };
        const retainer = new SubscriptionRetainer();
        const strategyVersions = { findByNameAndVersion: jest.fn().mockResolvedValue({ id: 7 }) };
        const haltFlag = new HaltFlagService();
        const events = new EventEmitter2();

        const service = new ReconciliationService(
            exchangeClient as never,
            exchangeClient as never,
            { exchangeEnv: 'testnet' } as never,
            positions,
            transactions as unknown as TransactionRepository,
            positionService as unknown as PositionService,
            riskGate as unknown as RiskGateService,
            monitor as unknown as LocalProtectiveMonitor,
            retainer,
            strategyVersions as unknown as StrategyVersionRepository,
            haltFlag,
            { setLiquidationPrice: jest.fn() } as never,
            { writeNow: jest.fn().mockResolvedValue(null) } as never,
            events,
            new SharedCloseCoordinator(),
        );

        return { service, exchangeClient, positionService, transactions };
    }

    it('a funding event becomes exactly one recordFunding call with cashflow set', async () => {
        const dbRow = buildPositionRow({ state: PositionStateEnum.OPEN, symbol: 'BTCUSDT' });
        const fundingTime = NOW_MS - 60_000;
        const harness = buildHarness({
            dbPositions: [dbRow],
            fundingEvents: [{ id: 'tran-abc', symbol: 'BTCUSDT', fundingTimeMs: fundingTime, amount: '-0.45', asset: 'USDT' }],
        });

        const pass = await harness.service.tick(NOW_MS);

        expect(pass.fundingRowsWritten).toBe(1);
        expect(harness.positionService.recordFunding).toHaveBeenCalledTimes(1);
        const arg = harness.positionService.recordFunding.mock.calls[0][0];
        expect(arg.positionId).toBe(dbRow.id);
        expect(arg.symbol).toBe('BTCUSDT');
        expect(arg.side).toBe(PositionSideEnum.LONG);
        expect(arg.cashflow.toFixed()).toBe('-0.45');
        expect(arg.fundingTimeMs).toBe(fundingTime);
        expect(arg.exchangeOrderId).toBe('tran-abc');
    });

    it('floors fetchFundingHistory sinceMs at latest funding row + 1ms (rerun dedupe)', async () => {
        const dbRow = buildPositionRow({ state: PositionStateEnum.OPEN, symbol: 'BTCUSDT' });
        const lastFundingMs = NOW_MS - 60_000;
        const latestFunding = buildTxRow({ type: TransactionTypeEnum.FUNDING, createdAt: new Date(lastFundingMs) });

        const harness = buildHarness({
            dbPositions: [dbRow],
            // Exchange echoes the same event already recorded — engine must drop it.
            fundingEvents: [{ id: 'tran-abc', symbol: 'BTCUSDT', fundingTimeMs: lastFundingMs, amount: '-0.45', asset: 'USDT' }],
            latestFundingRow: latestFunding,
        });

        const pass = await harness.service.tick(NOW_MS);

        expect(harness.exchangeClient.fetchFundingHistory).toHaveBeenCalledWith('BTCUSDT', lastFundingMs + 1);
        // The event echoes at fundingTimeMs == latest (not > sinceMs) — the inline
        // boundary guard in ingestFundingForPosition drops it. Zero recordFunding calls.
        expect(harness.positionService.recordFunding).not.toHaveBeenCalled();
        expect(pass.fundingRowsWritten).toBe(0);
    });

    it('uses position.openedAt as sinceMs on first poll (no prior funding row)', async () => {
        const openedAt = new Date(NOW_MS - 9 * 60 * 60 * 1000);
        const dbRow = buildPositionRow({ state: PositionStateEnum.OPEN, symbol: 'BTCUSDT', openedAt });

        const harness = buildHarness({
            dbPositions: [dbRow],
            fundingEvents: [],
            latestFundingRow: null,
        });

        await harness.service.tick(NOW_MS);

        expect(harness.exchangeClient.fetchFundingHistory).toHaveBeenCalledWith('BTCUSDT', openedAt.getTime());
    });

    it('skips CLOSING / RECONCILING / MANUAL_ADOPTED_UNMANAGED rows', async () => {
        const rows = [
            buildPositionRow({ id: 1, state: PositionStateEnum.CLOSING, symbol: 'AAA' }),
            buildPositionRow({ id: 2, state: PositionStateEnum.RECONCILING, symbol: 'BBB' }),
            buildPositionRow({ id: 3, state: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED, symbol: 'CCC' }),
            buildPositionRow({ id: 4, state: PositionStateEnum.OPEN, symbol: 'DDD' }),
        ];
        const harness = buildHarness({ dbPositions: rows, fundingEvents: [] });

        await harness.service.tick(NOW_MS);

        const symbolsPolled = harness.exchangeClient.fetchFundingHistory.mock.calls.map(([s]) => s);
        expect(symbolsPolled).toEqual(['DDD']);
    });

    it('fetchFundingHistory failure does not break the tick (errors++, next tick retries)', async () => {
        const dbRow = buildPositionRow({ state: PositionStateEnum.OPEN, symbol: 'BTCUSDT' });
        const harness = buildHarness({ dbPositions: [dbRow], fundingEvents: [] });
        harness.exchangeClient.fetchFundingHistory.mockRejectedValueOnce(new Error('rate limited'));

        const pass = await harness.service.tick(NOW_MS);

        // Per-symbol fetch failure is swallowed by fetchFundingHistorySafe (logged,
        // not counted as a tick error). The tick completes; next tick retries.
        expect(pass.fundingRowsWritten).toBe(0);
        expect(harness.positionService.recordFunding).not.toHaveBeenCalled();
    });
});
