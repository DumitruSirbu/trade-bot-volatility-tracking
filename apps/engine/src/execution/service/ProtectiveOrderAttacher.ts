import { PositionSideEnum, PositionSlotEnum, ProtectiveOrderTypeEnum } from '@bot/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { EXCHANGE_CLIENT, IExchangeClient } from '../../exchange/interface';
import { formatMoney, MoneyValue } from '../../common/utils/money';
import {
    BINANCE_CLOSE_POSITION_PLACEHOLDER_AMOUNT,
    CCXT_ORDER_SIDE_BUY,
    CCXT_ORDER_SIDE_SELL,
    CCXT_ORDER_TYPE_STOP_MARKET,
    CCXT_ORDER_TYPE_TAKE_PROFIT_MARKET,
    CCXT_TIME_IN_FORCE_GTC,
    CCXT_WORKING_TYPE_MARK_PRICE,
    PROTECTIVE_CLIENT_ORDER_ID_SL_SUFFIX,
    PROTECTIVE_CLIENT_ORDER_ID_TP_SUFFIX,
} from '../const';
import { IProtectiveAttachResult } from '../interface';
import { ClientOrderIdFactory } from './ClientOrderIdFactory';

// Attaches exchange-side SL + TP after entry fill confirmation (ADR 0008 §1). Both orders use
// MARK_PRICE as the trigger source (so a wick on the last-price feed doesn't false-trigger),
// reduceOnly + closePosition so the qty auto-tracks the live position (critical for partial
// reduces), and GTE_GTC time-in-force for exchange-managed lifetime.
//
// Failure -> LOCAL_FALLBACK (ADR 0008 §3). The caller (ExecutionService) is responsible for
// emitting ORDER_PROTECTIVE_FALLBACK_EVENT so M6's monitor (next milestone) sees the position.

interface IProtectiveAttachInput {
    readonly eventId: string;
    readonly positionSlot: PositionSlotEnum;
    readonly symbol: string;
    readonly tradeSide: PositionSideEnum;
    readonly stopLossPrice: MoneyValue;
    readonly takeProfitPrice: MoneyValue;
}

@Injectable()
export class ProtectiveOrderAttacher {
    private readonly logger = new Logger(ProtectiveOrderAttacher.name);

    constructor(
        @Inject(EXCHANGE_CLIENT) private readonly exchangeClient: IExchangeClient,
        private readonly clientOrderIdFactory: ClientOrderIdFactory,
    ) {}

    async attach(input: IProtectiveAttachInput): Promise<IProtectiveAttachResult> {
        const stopLossClientOrderId = this.clientOrderIdFactory.buildProtective({
            eventId: input.eventId,
            positionSlot: input.positionSlot,
            suffix: PROTECTIVE_CLIENT_ORDER_ID_SL_SUFFIX,
        });
        const takeProfitClientOrderId = this.clientOrderIdFactory.buildProtective({
            eventId: input.eventId,
            positionSlot: input.positionSlot,
            suffix: PROTECTIVE_CLIENT_ORDER_ID_TP_SUFFIX,
        });

        const closingSide = this.closingSide(input.tradeSide);

        const stopLossError = await this.submitProtective({
            symbol: input.symbol,
            type: CCXT_ORDER_TYPE_STOP_MARKET,
            side: closingSide,
            triggerPrice: input.stopLossPrice,
            clientOrderId: stopLossClientOrderId,
        });

        if (stopLossError !== null) {
            return this.fallback(stopLossClientOrderId, takeProfitClientOrderId, `SL attach failed: ${stopLossError}`);
        }

        const takeProfitError = await this.submitProtective({
            symbol: input.symbol,
            type: CCXT_ORDER_TYPE_TAKE_PROFIT_MARKET,
            side: closingSide,
            triggerPrice: input.takeProfitPrice,
            clientOrderId: takeProfitClientOrderId,
        });

        if (takeProfitError !== null) {
            return this.fallback(stopLossClientOrderId, takeProfitClientOrderId, `TP attach failed: ${takeProfitError}`);
        }

        return {
            protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE,
            stopLossClientOrderId,
            takeProfitClientOrderId,
            errorMessage: null,
        };
    }

    private async submitProtective(input: IProtectiveSubmitInput): Promise<string | null> {
        try {
            await this.exchangeClient.createOrder({
                symbol: input.symbol,
                type: input.type,
                side: input.side,
                amount: BINANCE_CLOSE_POSITION_PLACEHOLDER_AMOUNT, // ignored by Binance when closePosition=true
                price: null,
                clientOrderId: input.clientOrderId,
                params: {
                    reduceOnly: true,
                    closePosition: true,
                    workingType: CCXT_WORKING_TYPE_MARK_PRICE,
                    stopPrice: formatMoney(input.triggerPrice),
                    timeInForce: CCXT_TIME_IN_FORCE_GTC,
                },
            });

            return null;
        } catch (cause) {
            const description = cause instanceof Error ? cause.message : String(cause);
            this.logger.warn(`protective ${input.type} ${input.symbol} ${input.clientOrderId} failed: ${description}`);

            return description;
        }
    }

    private closingSide(tradeSide: PositionSideEnum): string {
        return tradeSide === PositionSideEnum.LONG ? CCXT_ORDER_SIDE_SELL : CCXT_ORDER_SIDE_BUY;
    }

    private fallback(stopLossClientOrderId: string, takeProfitClientOrderId: string, errorMessage: string): IProtectiveAttachResult {
        this.logger.warn(`protective attach falling back to LOCAL_FALLBACK: ${errorMessage}`);

        return {
            protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
            stopLossClientOrderId,
            takeProfitClientOrderId,
            errorMessage,
        };
    }
}

interface IProtectiveSubmitInput {
    readonly symbol: string;
    readonly type: string;
    readonly side: string;
    readonly triggerPrice: MoneyValue;
    readonly clientOrderId: string;
}
