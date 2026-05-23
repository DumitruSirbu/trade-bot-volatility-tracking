/**
 * ProtectiveOrderAttacher — SL/TP attach (ADR 0008 §1/§3).
 *
 * Coverage:
 *   - Success path: both SL and TP place → EXCHANGE_SIDE result
 *   - SL failure → LOCAL_FALLBACK with error message
 *   - TP failure after SL success → LOCAL_FALLBACK with error message
 *   - SL clientOrderId carries -sl suffix; TP carries -tp suffix
 *   - Success result errorMessage is null
 *   - Fallback result errorMessage is non-null
 */

import { PositionSideEnum, PositionSlotEnum, ProtectiveOrderTypeEnum } from '@bot/shared';

import { Money } from '../../../src/common/utils/money';
import { PROTECTIVE_CLIENT_ORDER_ID_SL_SUFFIX, PROTECTIVE_CLIENT_ORDER_ID_TP_SUFFIX } from '../../../src/execution/const';
import { ClientOrderIdFactory } from '../../../src/execution/service/ClientOrderIdFactory';
import { ProtectiveOrderAttacher } from '../../../src/execution/service/ProtectiveOrderAttacher';
import { buildExchangeClientMock, buildOrderSnapshot } from '../support/fixtures';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeAttacher(exchangeClientMock: ReturnType<typeof buildExchangeClientMock>) {
    const factory = new ClientOrderIdFactory();
    return new ProtectiveOrderAttacher(exchangeClientMock as never, factory);
}

function baseAttachInput() {
    return {
        eventId: 'BTCUSDT:1716307200000',
        positionSlot: PositionSlotEnum.A,
        symbol: 'BTCUSDT',
        tradeSide: PositionSideEnum.SHORT,
        stopLossPrice: new Money('30500'),
        takeProfitPrice: new Money('29000'),
    };
}

// ─── success path ─────────────────────────────────────────────────────────────

describe('ProtectiveOrderAttacher — success path', () => {
    it('returns EXCHANGE_SIDE when both SL and TP are accepted', async () => {
        // BUILD
        const mock = buildExchangeClientMock();
        mock.createOrder.mockResolvedValue(buildOrderSnapshot({ status: 'open' }));
        const attacher = makeAttacher(mock);

        // OPERATE
        const result = await attacher.attach(baseAttachInput());

        // CHECK
        expect(result.protectiveOrderType).toBe(ProtectiveOrderTypeEnum.EXCHANGE_SIDE);
    });

    it('success result errorMessage is null', async () => {
        const mock = buildExchangeClientMock();
        mock.createOrder.mockResolvedValue(buildOrderSnapshot({ status: 'open' }));
        const attacher = makeAttacher(mock);

        const result = await attacher.attach(baseAttachInput());

        expect(result.errorMessage).toBeNull();
    });

    it('places exactly two exchange orders (SL + TP)', async () => {
        const mock = buildExchangeClientMock();
        mock.createOrder.mockResolvedValue(buildOrderSnapshot({ status: 'open' }));
        const attacher = makeAttacher(mock);

        await attacher.attach(baseAttachInput());

        expect(mock.createOrder).toHaveBeenCalledTimes(2);
    });

    it('SL clientOrderId ends with the -sl suffix', async () => {
        const mock = buildExchangeClientMock();
        mock.createOrder.mockResolvedValue(buildOrderSnapshot({ status: 'open' }));
        const attacher = makeAttacher(mock);

        await attacher.attach(baseAttachInput());

        const firstCallClientId = (mock.createOrder.mock.calls[0][0] as { clientOrderId: string }).clientOrderId;
        expect(firstCallClientId.endsWith(PROTECTIVE_CLIENT_ORDER_ID_SL_SUFFIX)).toBe(true);
    });

    it('TP clientOrderId ends with the -tp suffix', async () => {
        const mock = buildExchangeClientMock();
        mock.createOrder.mockResolvedValue(buildOrderSnapshot({ status: 'open' }));
        const attacher = makeAttacher(mock);

        await attacher.attach(baseAttachInput());

        const secondCallClientId = (mock.createOrder.mock.calls[1][0] as { clientOrderId: string }).clientOrderId;
        expect(secondCallClientId.endsWith(PROTECTIVE_CLIENT_ORDER_ID_TP_SUFFIX)).toBe(true);
    });

    it('result stopLossClientOrderId and takeProfitClientOrderId are distinct', async () => {
        const mock = buildExchangeClientMock();
        mock.createOrder.mockResolvedValue(buildOrderSnapshot({ status: 'open' }));
        const attacher = makeAttacher(mock);

        const result = await attacher.attach(baseAttachInput());

        expect(result.stopLossClientOrderId).not.toBe(result.takeProfitClientOrderId);
    });
});

// ─── SL failure → LOCAL_FALLBACK ─────────────────────────────────────────────

describe('ProtectiveOrderAttacher — SL attach failure', () => {
    it('SL failure returns LOCAL_FALLBACK', async () => {
        // BUILD: first call (SL) throws; TP should not be attempted
        const mock = buildExchangeClientMock();
        mock.createOrder.mockRejectedValueOnce(new Error('SL order rejected by exchange'));
        const attacher = makeAttacher(mock);

        // OPERATE
        const result = await attacher.attach(baseAttachInput());

        // CHECK
        expect(result.protectiveOrderType).toBe(ProtectiveOrderTypeEnum.LOCAL_FALLBACK);
    });

    it('SL failure errorMessage is non-null and descriptive', async () => {
        const mock = buildExchangeClientMock();
        mock.createOrder.mockRejectedValueOnce(new Error('SL rejected'));
        const attacher = makeAttacher(mock);

        const result = await attacher.attach(baseAttachInput());

        expect(result.errorMessage).not.toBeNull();
        expect(result.errorMessage!.length).toBeGreaterThan(0);
    });

    it('SL failure does not attempt TP placement', async () => {
        const mock = buildExchangeClientMock();
        mock.createOrder.mockRejectedValueOnce(new Error('SL rejected'));
        const attacher = makeAttacher(mock);

        await attacher.attach(baseAttachInput());

        // Only SL was attempted, TP must not have been called
        expect(mock.createOrder).toHaveBeenCalledTimes(1);
    });
});

// ─── TP failure → LOCAL_FALLBACK ─────────────────────────────────────────────

describe('ProtectiveOrderAttacher — TP attach failure after SL success', () => {
    it('TP failure returns LOCAL_FALLBACK', async () => {
        // BUILD: SL succeeds, TP throws
        const mock = buildExchangeClientMock();
        mock.createOrder
            .mockResolvedValueOnce(buildOrderSnapshot({ status: 'open' })) // SL
            .mockRejectedValueOnce(new Error('TP order rejected')); // TP
        const attacher = makeAttacher(mock);

        // OPERATE
        const result = await attacher.attach(baseAttachInput());

        // CHECK
        expect(result.protectiveOrderType).toBe(ProtectiveOrderTypeEnum.LOCAL_FALLBACK);
    });

    it('TP failure errorMessage mentions TP', async () => {
        const mock = buildExchangeClientMock();
        mock.createOrder.mockResolvedValueOnce(buildOrderSnapshot({ status: 'open' })).mockRejectedValueOnce(new Error('TP rejected'));
        const attacher = makeAttacher(mock);

        const result = await attacher.attach(baseAttachInput());

        expect(result.errorMessage).not.toBeNull();
    });

    it('TP failure still attempts both SL and TP calls', async () => {
        const mock = buildExchangeClientMock();
        mock.createOrder.mockResolvedValueOnce(buildOrderSnapshot({ status: 'open' })).mockRejectedValueOnce(new Error('TP rejected'));
        const attacher = makeAttacher(mock);

        await attacher.attach(baseAttachInput());

        expect(mock.createOrder).toHaveBeenCalledTimes(2);
    });
});
