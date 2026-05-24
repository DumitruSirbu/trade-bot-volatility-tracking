import { CorrelationModeEnum, IBacktestPosition, IBacktestTradeResult, PositionSideEnum, PositionSlotEnum } from '@bot/shared';

import { Money } from '../../common/utils/money';
import { IClosedPositionView, IOpenPositionView, IOpenPositionsPort } from '../../risk/interface/IOpenPositionsPort';
import { BacktestBook } from '../state/BacktestBook';

const DAY_MS = 24 * 60 * 60 * 1000;

// In-memory IOpenPositionsPort backed by BacktestBook (ADR 0015 §2.4). Constructed by the
// runner per run; never registered with NestJS DI so it cannot leak into the live gate.
export class BacktestPositionAdapter implements IOpenPositionsPort {
    constructor(private readonly book: BacktestBook) {}

    async findOpen(): Promise<IOpenPositionView[]> {
        return this.book.openPositionList().map((position) => this.toOpenView(position));
    }

    async findClosedOnUtcDay(dateString: string): Promise<IClosedPositionView[]> {
        const dayStartMs = this.dayStartMs(dateString);
        const dayEndMs = dayStartMs + DAY_MS;
        return this.book.completedTrades
            .filter((trade) => trade.closedAtMs >= dayStartMs && trade.closedAtMs < dayEndMs)
            .map((trade) => this.toClosedView(trade));
    }

    async findLastCloseForSymbol(symbol: string): Promise<IClosedPositionView | null> {
        let latest: IBacktestTradeResult | null = null;
        for (const trade of this.book.completedTrades) {
            if (trade.symbol !== symbol) {
                continue;
            }
            if (latest === null || trade.closedAtMs > latest.closedAtMs) {
                latest = trade;
            }
        }
        return latest === null ? null : this.toClosedView(latest);
    }

    async countOpenedOnUtcDayForSymbol(symbol: string, dateString: string): Promise<number> {
        return this.book.countOpenedOnDay(symbol, dateString);
    }

    private toOpenView(position: IBacktestPosition): IOpenPositionView {
        return {
            symbol: position.symbol,
            slot: this.mapSlot(position.slot),
            side: this.mapSide(position.side),
            notional: new Money(position.entryNotionalUsdt),
            correlationMode: this.mapCorrelationMode(position.slot),
        };
    }

    private toClosedView(trade: IBacktestTradeResult): IClosedPositionView {
        return {
            symbol: trade.symbol,
            realizedPnl: new Money(trade.netPnlUsdt),
            closedAtMs: trade.closedAtMs,
        };
    }

    private mapSlot(slot: IBacktestPosition['slot']): PositionSlotEnum {
        switch (slot) {
            case 'A':
                return PositionSlotEnum.A;
            case 'B':
                return PositionSlotEnum.B;
            case 'C':
                return PositionSlotEnum.C;
        }
    }

    private mapSide(side: IBacktestPosition['side']): PositionSideEnum {
        return side === 'long' ? PositionSideEnum.LONG : PositionSideEnum.SHORT;
    }

    // Slot C is the dedicated BTC-correlated slot (ADR 0004 §4); A and B are idiosyncratic.
    private mapCorrelationMode(slot: IBacktestPosition['slot']): CorrelationModeEnum {
        return slot === 'C' ? CorrelationModeEnum.CORRELATED : CorrelationModeEnum.IDIOSYNCRATIC;
    }

    // Parse a YYYY-MM-DD UTC date string into the day's UTC ms boundary. Using Date.UTC
    // avoids any local-timezone drift the runner host might have.
    private dayStartMs(dateString: string): number {
        const [year, month, day] = dateString.split('-').map((segment) => Number(segment));
        return Date.UTC(year, month - 1, day);
    }
}
