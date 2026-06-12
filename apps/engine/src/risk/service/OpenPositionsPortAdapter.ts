import { CorrelationModeEnum, PositionSlotEnum } from '@bot/shared';
import { Injectable } from '@nestjs/common';

import { Money } from '../../common/utils/money';
import { PositionEntity } from '../../position/entity';
import { PositionRepository } from '../../position/repository/PositionRepository';
import { InvalidPositionStateException } from '../exception';
import { IClosedPositionView, IOpenPositionsPort, IOpenPositionView } from '../interface';

// Live IOpenPositionsPort (ADR 0004 §7): bridges the gate's open/closed-position state ports
// onto PositionRepository. Backtest swaps the simulated book behind the same interface. The
// real positions.correlation_mode column drives the slot model; the slot-C inference is kept
// only as a documented fallback for legacy/null rows (none exist before M5 opens).
@Injectable()
export class OpenPositionsPortAdapter implements IOpenPositionsPort {
    constructor(private readonly positions: PositionRepository) {}

    // M31 R1 (HIGH): live-risk view only (qty > 0 AND non-terminal). This port backs both the
    // gate's occupiedSlots context (RiskGateService.loadState) and StrategyService's open-count
    // stamp; a qty=0 zombie row would otherwise phantom-occupy a slot and inflate live-risk
    // reporting. Reconciliation deliberately stays on the broad findNonTerminal view elsewhere.
    async findOpen(): Promise<IOpenPositionView[]> {
        const open = await this.positions.findLiveRisk();

        return open.map((position) => this.toOpenView(position));
    }

    async findClosedOnUtcDay(dateString: string): Promise<IClosedPositionView[]> {
        const closed = await this.positions.findClosedOnUtcDay(dateString);

        return closed.map((position) => this.toClosedView(position));
    }

    async findLastCloseForSymbol(symbol: string): Promise<IClosedPositionView | null> {
        const last = await this.positions.findLastClosedBySymbol(symbol);

        if (last === null) {
            return null;
        }

        return this.toClosedView(last);
    }

    async countOpenedOnUtcDayForSymbol(symbol: string, dateString: string): Promise<number> {
        return this.positions.countOpenedOnUtcDayForSymbol(symbol, dateString);
    }

    private toOpenView(position: PositionEntity): IOpenPositionView {
        const slot = position.positionSlot ?? null;

        return {
            symbol: position.symbol,
            slot,
            side: position.side,
            notional: position.entryNotional,
            correlationMode: this.resolveCorrelationMode(position.correlationMode ?? null, slot),
        };
    }

    private toClosedView(position: PositionEntity): IClosedPositionView {
        if (position.closedAt === null || position.closedAt === undefined) {
            throw new InvalidPositionStateException(`closed position ${position.id} (${position.symbol}) has a null closed_at`);
        }

        return {
            symbol: position.symbol,
            realizedPnl: position.realizedPnl ?? new Money(0),
            closedAtMs: position.closedAt.getTime(),
        };
    }

    // Prefer the stored correlation_mode; fall back to the slot-C inference only for
    // legacy/null rows (conservative — slot C is the BTC-correlated slot).
    private resolveCorrelationMode(stored: CorrelationModeEnum | null, slot: PositionSlotEnum | null): CorrelationModeEnum {
        if (stored !== null) {
            return stored;
        }

        if (slot === PositionSlotEnum.C) {
            return CorrelationModeEnum.CORRELATED;
        }

        return CorrelationModeEnum.IDIOSYNCRATIC;
    }
}
