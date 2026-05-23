import { OrderIntentActionEnum, PositionSlotEnum } from '@bot/shared';
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { CLIENT_ORDER_ID_HASH_LENGTH, CLIENT_ORDER_ID_PREFIX } from '../const';

// Deterministic clientOrderId mint (ADR 0006 §1). Inputs are persisted data (eventId, slot,
// action, attemptN) — same inputs always produce the same id, so:
//   - the duplicate-id guard at Binance catches double-submits as `-5022 Duplicate order id`;
//   - reconciliation (M6) reconstructs the id from `decisions` + `transactions.type` +
//     `positions.position_slot` after a restart without an external id map;
//   - M7 replay produces byte-identical ids (live-vs-backtest contract C7).
//
// Pure helper, but lives as an injectable so unit tests can mock it (deterministic mocking
// stays trivial because the implementation is also deterministic).
@Injectable()
export class ClientOrderIdFactory {
    // Builds the entry/exit client order id from the canonical seed
    // `${eventId}|${slot}|${action}|${attemptN}`.
    build(seed: ISeedInput): string {
        const seedString = `${seed.eventId}|${seed.positionSlot}|${seed.intentAction}|${seed.attemptN}`;
        const hash = createHash('sha1').update(seedString).digest('hex').slice(0, CLIENT_ORDER_ID_HASH_LENGTH);

        return `${CLIENT_ORDER_ID_PREFIX}${hash}`;
    }

    // Builds the protective-order id by appending the suffix INSIDE the 20-hex slice so both
    // sides stay reproducible (ADR 0008 §1 step 3). Uses intentAction=CLOSE + attemptN=0,
    // independently from the entry's attemptN.
    buildProtective(seed: IProtectiveSeedInput): string {
        const baseSeed = { eventId: seed.eventId, positionSlot: seed.positionSlot, intentAction: OrderIntentActionEnum.CLOSE, attemptN: 0 };
        const baseId = this.build(baseSeed);
        const hashStart = CLIENT_ORDER_ID_PREFIX.length;
        const head = baseId.slice(0, hashStart + CLIENT_ORDER_ID_HASH_LENGTH - seed.suffix.length);

        return `${head}${seed.suffix}`;
    }
}

export interface ISeedInput {
    readonly eventId: string;
    readonly positionSlot: PositionSlotEnum;
    readonly intentAction: OrderIntentActionEnum;
    readonly attemptN: number;
}

export interface IProtectiveSeedInput {
    readonly eventId: string;
    readonly positionSlot: PositionSlotEnum;
    readonly suffix: string;
}
