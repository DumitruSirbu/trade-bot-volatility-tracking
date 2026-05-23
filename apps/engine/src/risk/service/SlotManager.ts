import { CorrelationModeEnum, PositionSlotEnum, RejectReasonEnum } from '@bot/shared';
import { Injectable } from '@nestjs/common';

import { MAX_IDIOSYNCRATIC_SLOTS } from '../const';

// One occupied slot, as seen from open positions + active (PENDING/CONFIRMED) reservations.
export interface IOccupiedSlot {
    readonly slot: PositionSlotEnum;
    readonly correlationMode: CorrelationModeEnum;
}

export type SlotAssignment = { readonly kind: 'assigned'; readonly slot: PositionSlotEnum } | { readonly kind: 'rejected'; readonly reason: RejectReasonEnum };

// Deterministic 3-slot assignment (ADR 0004 §4). A/B are idiosyncratic-only (max 2); C holds
// at most one BTC-correlated position but is available to an idiosyncratic trade when no
// correlated position is open. Pure: it reads the occupied-slot set the gate passes in.
@Injectable()
export class SlotManager {
    assign(correlationMode: CorrelationModeEnum, idiosyncrasyScore: number, idiosyncrasyMinScore: number, occupied: IOccupiedSlot[]): SlotAssignment {
        if (correlationMode === CorrelationModeEnum.CORRELATED) {
            return this.assignCorrelated(occupied);
        }

        return this.assignIdiosyncratic(idiosyncrasyScore, idiosyncrasyMinScore, occupied);
    }

    private assignCorrelated(occupied: IOccupiedSlot[]): SlotAssignment {
        if (this.hasCorrelatedSlotC(occupied)) {
            return { kind: 'rejected', reason: RejectReasonEnum.BTC_CORRELATED_SLOT_TAKEN };
        }

        return { kind: 'assigned', slot: PositionSlotEnum.C };
    }

    private assignIdiosyncratic(idiosyncrasyScore: number, idiosyncrasyMinScore: number, occupied: IOccupiedSlot[]): SlotAssignment {
        if (idiosyncrasyScore < idiosyncrasyMinScore) {
            return { kind: 'rejected', reason: RejectReasonEnum.NO_ELIGIBLE_SLOT };
        }

        const occupiedSet = new Set(occupied.map((entry) => entry.slot));

        if (!occupiedSet.has(PositionSlotEnum.A)) {
            return { kind: 'assigned', slot: PositionSlotEnum.A };
        }

        if (!occupiedSet.has(PositionSlotEnum.B)) {
            return { kind: 'assigned', slot: PositionSlotEnum.B };
        }

        if (this.isSlotCFreeForIdiosyncratic(occupied)) {
            return { kind: 'assigned', slot: PositionSlotEnum.C };
        }

        return { kind: 'rejected', reason: RejectReasonEnum.MAX_POSITIONS_REACHED };
    }

    private hasCorrelatedSlotC(occupied: IOccupiedSlot[]): boolean {
        return occupied.some((entry) => entry.slot === PositionSlotEnum.C && entry.correlationMode === CorrelationModeEnum.CORRELATED);
    }

    private isSlotCFreeForIdiosyncratic(occupied: IOccupiedSlot[]): boolean {
        const slotCTaken = occupied.some((entry) => entry.slot === PositionSlotEnum.C);
        const idiosyncraticCount = occupied.filter((entry) => entry.correlationMode === CorrelationModeEnum.IDIOSYNCRATIC).length;

        return !slotCTaken && idiosyncraticCount >= MAX_IDIOSYNCRATIC_SLOTS;
    }
}
