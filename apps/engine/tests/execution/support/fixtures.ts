/**
 * Execution-layer test fixtures. All factories produce valid, independent value objects.
 * Tests override only the fields under test — F.I.R.S.T. / Clean Code §Tests.
 */

import {
    CoinTierEnum,
    FlowTypeEnum,
    OrderIntentActionEnum,
    PositionSideEnum,
    PositionSlotEnum,
    ProtectiveOrderTypeEnum,
    StrategyDirectionEnum,
} from '@bot/shared';

import { Money } from '../../../src/common/utils/money';
import { IExchangeOrderSnapshot } from '../../../src/exchange/interface';
import { IOrderIntentApprovedEvent } from '../../../src/risk/interface';
import { buildOrderIntent, buildProposedExit, buildSizing } from '../../risk/support/fixtures';

// ─── IExchangeOrderSnapshot ───────────────────────────────────────────────────

export function buildOrderSnapshot(overrides: Partial<IExchangeOrderSnapshot> = {}): IExchangeOrderSnapshot {
    return {
        exchangeOrderId: 'ex-1',
        clientOrderId: 'tbvt-aabbccddee1122334455',
        symbol: 'BTCUSDT',
        status: 'closed',
        type: 'limit',
        side: 'sell',
        price: '30000',
        average: '30000',
        amount: '0.01',
        filled: '0.01',
        remaining: '0',
        cost: '300',
        fee: '0.12',
        feeCurrency: 'USDT',
        timestampMs: 1_716_307_200_000,
        ...overrides,
    };
}

export function buildOpenSnapshot(overrides: Partial<IExchangeOrderSnapshot> = {}): IExchangeOrderSnapshot {
    return buildOrderSnapshot({ status: 'open', filled: '0', remaining: '0.01', ...overrides });
}

export function buildPartialSnapshot(filledQty: string, overrides: Partial<IExchangeOrderSnapshot> = {}): IExchangeOrderSnapshot {
    const filled = new Money(filledQty);
    const price = new Money('30000');
    return buildOrderSnapshot({
        status: 'open',
        filled: filledQty,
        remaining: new Money('0.01').minus(filled).toFixed(),
        cost: filled.times(price).toFixed(),
        average: '30000',
        ...overrides,
    });
}

export function buildCancelledSnapshot(overrides: Partial<IExchangeOrderSnapshot> = {}): IExchangeOrderSnapshot {
    return buildOrderSnapshot({ status: 'canceled', filled: '0', remaining: '0.01', ...overrides });
}

export function buildZeroFillSnapshot(overrides: Partial<IExchangeOrderSnapshot> = {}): IExchangeOrderSnapshot {
    return buildOrderSnapshot({ status: 'canceled', filled: '0', cost: '0', average: null, ...overrides });
}

// ─── IOrderIntentApprovedEvent ────────────────────────────────────────────────

export function buildApprovedEvent(overrides: Partial<IOrderIntentApprovedEvent> = {}): IOrderIntentApprovedEvent {
    const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
    return {
        intent: buildOrderIntent(),
        approvedSlot: PositionSlotEnum.A,
        approvedSizing: buildSizing(),
        clampedExit: buildProposedExit({ timeStopAtMs: NOW_MS + 30 * 60_000 }),
        reservationId: 'res-test-1',
        strategyVersionId: 1,
        ...overrides,
    };
}

// ─── IProtectiveAttachResult helpers ─────────────────────────────────────────

export function buildExchangeSideAttachResult() {
    return {
        protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE,
        stopLossClientOrderId: 'tbvt-aabb-sl',
        takeProfitClientOrderId: 'tbvt-aabb-tp',
        errorMessage: null,
    };
}

export function buildLocalFallbackAttachResult(errorMessage = 'exchange rejected') {
    return {
        protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
        stopLossClientOrderId: 'tbvt-aabb-sl',
        takeProfitClientOrderId: 'tbvt-aabb-tp',
        errorMessage,
    };
}

// ─── IOrderPlanInput builder ──────────────────────────────────────────────────

export function buildPlanInput(
    overrides: Partial<{
        strategyDirection: StrategyDirectionEnum;
        flowType: FlowTypeEnum;
        coinTier: CoinTierEnum;
        intentAction: OrderIntentActionEnum;
        tradeSide: PositionSideEnum;
    }> = {},
) {
    const intent = buildOrderIntent({
        coinTier: overrides.coinTier ?? CoinTierEnum.TIER_1,
        intentAction: overrides.intentAction ?? OrderIntentActionEnum.OPEN,
        tradeSide: overrides.tradeSide ?? PositionSideEnum.SHORT,
        entryPrice: new Money('30000'),
        midAtTrigger: new Money('30000'),
        flowType: overrides.flowType ?? FlowTypeEnum.TREND_INITIATION,
        proposedExit: buildProposedExit({
            stopLossPrice: new Money('30500'),
            takeProfitPrice: new Money('29000'),
        }),
    });
    return {
        intent,
        strategyDirection: overrides.strategyDirection ?? StrategyDirectionEnum.MEAN_REVERSION,
        maxSlippageOfSlPct: null,
    };
}

// ─── Exchange client fake ─────────────────────────────────────────────────────

export function buildExchangeClientMock() {
    return {
        loadMarkets: jest.fn(),
        fetchBalance: jest.fn(),
        fetchOpenInterest: jest.fn(),
        fetchFundingRate: jest.fn(),
        fetchTickers: jest.fn(),
        watchTickers: jest.fn(),
        watchOrderBook: jest.fn(),
        watchTrades: jest.fn(),
        createOrder: jest.fn(),
        fetchOrderByClientId: jest.fn(),
        cancelOrderByClientId: jest.fn(),
        close: jest.fn(),
    };
}

// ─── PositionEntity mock ──────────────────────────────────────────────────────

export function buildPositionEntityMock(id = 1) {
    return {
        id,
        symbol: 'BTCUSDT',
        protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
    };
}
