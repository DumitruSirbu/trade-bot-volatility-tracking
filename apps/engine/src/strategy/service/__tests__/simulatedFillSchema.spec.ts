import { MissedReasonEnum, simulatedFillSchema } from '@bot/shared';

interface IZodLike {
    issues: Array<{ message: string }>;
}

function isZodError(error: unknown): error is IZodLike {
    return typeof error === 'object' && error !== null && Array.isArray((error as IZodLike).issues);
}

function buildValidMissedFill() {
    return {
        entryPrice: '0',
        exitPrice: null,
        slippageEntryPct: '0',
        slippageExitPct: null,
        slippageComponents: { tierBase: '0', latency: '0', crossingSpread: '0' },
        missed: true,
        missedReason: MissedReasonEnum.MISSING_TICK_DATA,
        forceClose: false,
        lowFidelity: true,
        closedAt: null,
        closeReason: null,
    };
}

function buildValidFilledFill() {
    return {
        entryPrice: '100',
        exitPrice: '98',
        slippageEntryPct: '0.05',
        slippageExitPct: '0.05',
        slippageComponents: { tierBase: '0.05', latency: '0', crossingSpread: '0' },
        missed: false,
        missedReason: null,
        forceClose: false,
        lowFidelity: true,
        closedAt: '2026-06-01T10:05:00.000Z',
        closeReason: 'sl' as const,
    };
}

describe('A1 — missed=true with typed missedReason parses successfully', () => {
    it('parses MISSING_TICK_DATA without throwing', () => {
        expect(() => simulatedFillSchema.parse(buildValidMissedFill())).not.toThrow();
    });

    it('parses every MissedReasonEnum variant without throwing', () => {
        for (const reason of Object.values(MissedReasonEnum)) {
            expect(() => simulatedFillSchema.parse({ ...buildValidMissedFill(), missedReason: reason })).not.toThrow();
        }
    });
});

describe('A2 — missed=true with missedReason=null is rejected', () => {
    it('throws when missedReason is null', () => {
        expect(() => simulatedFillSchema.parse({ ...buildValidMissedFill(), missedReason: null })).toThrow();
    });

    it('issue message mentions missedReason', () => {
        let caught: IZodLike | null = null;
        try {
            simulatedFillSchema.parse({ ...buildValidMissedFill(), missedReason: null });
        } catch (error) {
            if (isZodError(error)) caught = error;
        }
        expect(caught).not.toBeNull();
        expect(caught!.issues[0].message).toMatch(/missedReason/);
    });

    it('boundary — missedReason=undefined also throws', () => {
        expect(() => simulatedFillSchema.parse({ ...buildValidMissedFill(), missedReason: undefined })).toThrow();
    });
});

describe('B1 — missed=false with closeReason+exitPrice parses successfully', () => {
    it('parses a filled fill without throwing', () => {
        expect(() => simulatedFillSchema.parse(buildValidFilledFill())).not.toThrow();
    });

    it('parses all closeReason values without throwing', () => {
        for (const reason of ['sl', 'tp', 'force_close', 'time_stop'] as const) {
            expect(() => simulatedFillSchema.parse({ ...buildValidFilledFill(), closeReason: reason })).not.toThrow();
        }
    });
});

describe('B2 — missed=false with closeReason=null is rejected', () => {
    it('throws when closeReason is null', () => {
        expect(() => simulatedFillSchema.parse({ ...buildValidFilledFill(), closeReason: null })).toThrow();
    });

    it('issue message mentions closeReason', () => {
        let caught: IZodLike | null = null;
        try {
            simulatedFillSchema.parse({ ...buildValidFilledFill(), closeReason: null });
        } catch (error) {
            if (isZodError(error)) caught = error;
        }
        expect(caught).not.toBeNull();
        expect(caught!.issues.map((issue) => issue.message).some((msg) => msg.includes('closeReason'))).toBe(true);
    });
});

describe('B3 — missed=false with exitPrice=null is rejected', () => {
    it('throws when exitPrice is null', () => {
        expect(() => simulatedFillSchema.parse({ ...buildValidFilledFill(), exitPrice: null })).toThrow();
    });

    it('issue message mentions exitPrice', () => {
        let caught: IZodLike | null = null;
        try {
            simulatedFillSchema.parse({ ...buildValidFilledFill(), exitPrice: null });
        } catch (error) {
            if (isZodError(error)) caught = error;
        }
        expect(caught).not.toBeNull();
        expect(caught!.issues.map((issue) => issue.message).some((msg) => msg.includes('exitPrice'))).toBe(true);
    });

    it('boundary — closeReason=null and exitPrice=null both fire', () => {
        let caught: IZodLike | null = null;
        try {
            simulatedFillSchema.parse({ ...buildValidFilledFill(), closeReason: null, exitPrice: null });
        } catch (error) {
            if (isZodError(error)) caught = error;
        }
        expect(caught).not.toBeNull();
        expect(caught!.issues.length).toBeGreaterThanOrEqual(2);
    });
});
