/**
 * ClientOrderIdFactory — deterministic client order ID generation (ADR 0006 §1).
 *
 * Coverage:
 *   - Same inputs always produce the same id (determinism)
 *   - Different attemptN values produce different ids
 *   - Format: 'tbvt-' prefix + 20-char hex sha1 slice
 *   - Same eventId + slot + action across attempts produce distinct ids per attemptN
 *   - buildProtective produces ids with the expected suffix, within total length budget
 */

import { OrderIntentActionEnum, PositionSlotEnum } from '@bot/shared';

import {
    CLIENT_ORDER_ID_HASH_LENGTH,
    CLIENT_ORDER_ID_PREFIX,
    PROTECTIVE_CLIENT_ORDER_ID_SL_SUFFIX,
    PROTECTIVE_CLIENT_ORDER_ID_TP_SUFFIX,
} from '../../../src/execution/const';
import { ClientOrderIdFactory, ISeedInput } from '../../../src/execution/service/ClientOrderIdFactory';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeFactory(): ClientOrderIdFactory {
    return new ClientOrderIdFactory();
}

function baseSeed(overrides: Partial<ISeedInput> = {}): ISeedInput {
    return {
        eventId: 'BTCUSDT:1716307200000',
        positionSlot: PositionSlotEnum.A,
        intentAction: OrderIntentActionEnum.OPEN,
        attemptN: 0,
        ...overrides,
    };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('ClientOrderIdFactory.build', () => {
    it('same inputs always produce the same id', () => {
        // BUILD
        const factory = makeFactory();
        const seed = baseSeed();

        // OPERATE
        const first = factory.build(seed);
        const second = factory.build(seed);

        // CHECK
        expect(first).toBe(second);
    });

    it('id starts with the tbvt- prefix', () => {
        const factory = makeFactory();
        const id = factory.build(baseSeed());

        expect(id.startsWith(CLIENT_ORDER_ID_PREFIX)).toBe(true);
    });

    it('hash slice is exactly CLIENT_ORDER_ID_HASH_LENGTH hex characters', () => {
        const factory = makeFactory();
        const id = factory.build(baseSeed());
        const hashSlice = id.slice(CLIENT_ORDER_ID_PREFIX.length);

        expect(hashSlice).toHaveLength(CLIENT_ORDER_ID_HASH_LENGTH);
        expect(hashSlice).toMatch(/^[0-9a-f]+$/);
    });

    it('total id length is prefix + hash length', () => {
        const factory = makeFactory();
        const id = factory.build(baseSeed());

        expect(id).toHaveLength(CLIENT_ORDER_ID_PREFIX.length + CLIENT_ORDER_ID_HASH_LENGTH);
    });

    it('different attemptN produces a different id', () => {
        const factory = makeFactory();
        const id0 = factory.build(baseSeed({ attemptN: 0 }));
        const id1 = factory.build(baseSeed({ attemptN: 1 }));
        const id2 = factory.build(baseSeed({ attemptN: 2 }));

        expect(id0).not.toBe(id1);
        expect(id1).not.toBe(id2);
        expect(id0).not.toBe(id2);
    });

    it('different positionSlot produces a different id', () => {
        const factory = makeFactory();
        const idA = factory.build(baseSeed({ positionSlot: PositionSlotEnum.A }));
        const idB = factory.build(baseSeed({ positionSlot: PositionSlotEnum.B }));

        expect(idA).not.toBe(idB);
    });

    it('different intentAction produces a different id', () => {
        const factory = makeFactory();
        const idOpen = factory.build(baseSeed({ intentAction: OrderIntentActionEnum.OPEN }));
        const idClose = factory.build(baseSeed({ intentAction: OrderIntentActionEnum.CLOSE }));

        expect(idOpen).not.toBe(idClose);
    });

    it('different eventId produces a different id', () => {
        const factory = makeFactory();
        const id1 = factory.build(baseSeed({ eventId: 'BTCUSDT:1716307200000' }));
        const id2 = factory.build(baseSeed({ eventId: 'ETHUSDT:1716307200000' }));

        expect(id1).not.toBe(id2);
    });
});

describe('ClientOrderIdFactory.buildProtective', () => {
    it('SL protective id ends with the -sl suffix', () => {
        const factory = makeFactory();
        const id = factory.buildProtective({
            eventId: 'BTCUSDT:1716307200000',
            positionSlot: PositionSlotEnum.A,
            suffix: PROTECTIVE_CLIENT_ORDER_ID_SL_SUFFIX,
        });

        expect(id.endsWith(PROTECTIVE_CLIENT_ORDER_ID_SL_SUFFIX)).toBe(true);
    });

    it('TP protective id ends with the -tp suffix', () => {
        const factory = makeFactory();
        const id = factory.buildProtective({
            eventId: 'BTCUSDT:1716307200000',
            positionSlot: PositionSlotEnum.A,
            suffix: PROTECTIVE_CLIENT_ORDER_ID_TP_SUFFIX,
        });

        expect(id.endsWith(PROTECTIVE_CLIENT_ORDER_ID_TP_SUFFIX)).toBe(true);
    });

    it('protective id starts with the tbvt- prefix', () => {
        const factory = makeFactory();
        const id = factory.buildProtective({
            eventId: 'BTCUSDT:1716307200000',
            positionSlot: PositionSlotEnum.A,
            suffix: PROTECTIVE_CLIENT_ORDER_ID_SL_SUFFIX,
        });

        expect(id.startsWith(CLIENT_ORDER_ID_PREFIX)).toBe(true);
    });

    it('protective id total length equals entry id total length', () => {
        const factory = makeFactory();
        const entryId = factory.build(baseSeed());
        const slId = factory.buildProtective({
            eventId: 'BTCUSDT:1716307200000',
            positionSlot: PositionSlotEnum.A,
            suffix: PROTECTIVE_CLIENT_ORDER_ID_SL_SUFFIX,
        });

        expect(slId).toHaveLength(entryId.length);
    });

    it('SL and TP protective ids are distinct', () => {
        const factory = makeFactory();
        const input = { eventId: 'BTCUSDT:1716307200000', positionSlot: PositionSlotEnum.A };
        const slId = factory.buildProtective({ ...input, suffix: PROTECTIVE_CLIENT_ORDER_ID_SL_SUFFIX });
        const tpId = factory.buildProtective({ ...input, suffix: PROTECTIVE_CLIENT_ORDER_ID_TP_SUFFIX });

        expect(slId).not.toBe(tpId);
    });

    it('same inputs produce the same protective id (determinism)', () => {
        const factory = makeFactory();
        const input = {
            eventId: 'BTCUSDT:1716307200000',
            positionSlot: PositionSlotEnum.A,
            suffix: PROTECTIVE_CLIENT_ORDER_ID_SL_SUFFIX,
        };

        expect(factory.buildProtective(input)).toBe(factory.buildProtective(input));
    });
});
