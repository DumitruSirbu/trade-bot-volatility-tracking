// M29 W2 — getFunnelSummary unit tests.
//
// Stub DataSource.query returns fixture IFunnelRollupRow arrays so we cover the
// mapping logic, gate_allowed three-value bucketing, halt detection, sl_sub_cause
// classification, date-range boundary inclusion, and input validation.
// No real DB — the SQL is exercised only by integration tests against the
// port-6900 test container.

import { AnalysisValidationError, getFunnelSummary } from '../../src/index';

type QueryHandler = (sql: string, bindings: readonly unknown[]) => Promise<unknown[]>;

// ─── IFunnelRollupRow fixture factory ─────────────────────────────────────────

function buildRollupRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        utc_date: '2026-06-01',
        reason: 'coin_book_too_thin',
        gate_allowed: false,
        sl_sub_cause: null,
        row_count: '1',
        ...overrides,
    };
}

function stubDs(rows: Record<string, unknown>[]): { query: QueryHandler } {
    return {
        query: async () => rows,
    };
}

// ─── C15: Three-way gate_allowed bucket ───────────────────────────────────────

describe('getFunnelSummary — C15: gate_allowed three-value bucketing', () => {
    it('gate_allowed=true maps to gateAllowedBucket=approved', async () => {
        const ds = stubDs([buildRollupRow({ gate_allowed: true, reason: 'some_reason' })]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-01');

        expect(rows).toHaveLength(1);
        expect(rows[0].gateAllowedBucket).toBe('approved');
    });

    it('gate_allowed=false maps to gateAllowedBucket=rejected', async () => {
        const ds = stubDs([buildRollupRow({ gate_allowed: false, reason: 'exposure_cap_per_coin' })]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-01');

        expect(rows).toHaveLength(1);
        expect(rows[0].gateAllowedBucket).toBe('rejected');
    });

    it('gate_allowed=null maps to gateAllowedBucket=unknown and is NOT counted as rejected', async () => {
        const ds = stubDs([buildRollupRow({ gate_allowed: null, reason: 'some_legacy_reason' })]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-01');

        expect(rows).toHaveLength(1);
        expect(rows[0].gateAllowedBucket).toBe('unknown');
        expect(rows[0].gateAllowedBucket).not.toBe('rejected');
    });

    it('all three gate_allowed values in one fixture return three distinct buckets', async () => {
        const ds = stubDs([
            buildRollupRow({ gate_allowed: true, reason: null }),
            buildRollupRow({ gate_allowed: false, reason: 'exposure_cap_per_coin' }),
            buildRollupRow({ gate_allowed: null, reason: 'pre_m27_reason' }),
        ]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-02');

        const buckets = rows.map((r) => r.gateAllowedBucket);

        expect(buckets).toContain('approved');
        expect(buckets).toContain('rejected');
        expect(buckets).toContain('unknown');
    });
});

// ─── C16: global_halt → isHalted=true ─────────────────────────────────────────

describe('getFunnelSummary — C16: global_halt reason sets isHalted=true', () => {
    it('reason=global_halt returns isHalted=true', async () => {
        const ds = stubDs([buildRollupRow({ reason: 'global_halt', gate_allowed: false })]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-01');

        expect(rows[0].isHalted).toBe(true);
    });

    it('reason=market_stress:breadth does NOT set isHalted=true', async () => {
        const ds = stubDs([buildRollupRow({ reason: 'market_stress:breadth', gate_allowed: false })]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-01');

        expect(rows[0].isHalted).toBe(false);
    });

    it('reason=daily_loss_limit does NOT set isHalted=true (global_halt is a specific string)', async () => {
        const ds = stubDs([buildRollupRow({ reason: 'daily_loss_limit', gate_allowed: false })]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-01');

        expect(rows[0].isHalted).toBe(false);
    });

    it('reason=null (mapped to empty string) does NOT set isHalted=true', async () => {
        const ds = stubDs([buildRollupRow({ reason: null, gate_allowed: null })]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-01');

        expect(rows[0].isHalted).toBe(false);
    });
});

// ─── C17: market_stress% prefix — distinct rows kept as-is ───────────────────

describe('getFunnelSummary — C17: market_stress sub-reason rows preserved verbatim', () => {
    it('market_stress:breadth and market_stress:btc_5m are two distinct rows with full reason strings', async () => {
        const ds = stubDs([
            buildRollupRow({ reason: 'market_stress:breadth', gate_allowed: false }),
            buildRollupRow({ reason: 'market_stress:btc_5m', gate_allowed: false }),
        ]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-01');

        expect(rows).toHaveLength(2);

        const reasons = rows.map((r) => r.reason);

        expect(reasons).toContain('market_stress:breadth');
        expect(reasons).toContain('market_stress:btc_5m');
    });

    it('market_stress rows are NOT dropped or merged into a single row', async () => {
        const ds = stubDs([
            buildRollupRow({ reason: 'market_stress:same_bar', gate_allowed: false }),
            buildRollupRow({ reason: 'market_stress:oi', gate_allowed: false }),
            buildRollupRow({ reason: 'market_stress:funding', gate_allowed: false }),
        ]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-01');

        expect(rows).toHaveLength(3);
        expect(rows.map((r) => r.reason)).toEqual(expect.arrayContaining(['market_stress:same_bar', 'market_stress:oi', 'market_stress:funding']));
    });
});

// ─── C18: sl_outside_liquidation — wrong-side stop (LONG) ─────────────────────

describe('getFunnelSummary — C18: sl_sub_cause=wrong_side_stop for LONG with stop >= entry proxy', () => {
    it('sl_sub_cause=wrong_side_stop when the DB row carries that value', async () => {
        // The SQL computes sl_sub_cause; we test that the mapper preserves it correctly.
        const ds = stubDs([
            buildRollupRow({
                reason: 'sl_outside_liquidation',
                gate_allowed: false,
                sl_sub_cause: 'wrong_side_stop',
            }),
        ]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-01');

        expect(rows[0].slSubCause).toBe('wrong_side_stop');
    });
});

// ─── C19: sl_outside_liquidation — over-levered ────────────────────────────────

describe('getFunnelSummary — C19: sl_sub_cause=over_levered for leverage > MAX_LEVERAGE', () => {
    it('sl_sub_cause=over_levered when the DB row carries that value', async () => {
        const ds = stubDs([
            buildRollupRow({
                reason: 'sl_outside_liquidation',
                gate_allowed: false,
                sl_sub_cause: 'over_levered',
            }),
        ]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-01');

        expect(rows[0].slSubCause).toBe('over_levered');
    });
});

// ─── C20: sl_outside_liquidation — non-positive liq fraction ──────────────────

describe('getFunnelSummary — C20: sl_sub_cause=non_positive_liq_fraction', () => {
    it('sl_sub_cause=non_positive_liq_fraction when the DB row carries that value', async () => {
        const ds = stubDs([
            buildRollupRow({
                reason: 'sl_outside_liquidation',
                gate_allowed: false,
                sl_sub_cause: 'non_positive_liq_fraction',
            }),
        ]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-01');

        expect(rows[0].slSubCause).toBe('non_positive_liq_fraction');
    });
});

// ─── C21: Non-SL reason has slSubCause=null ───────────────────────────────────

describe('getFunnelSummary — C21: slSubCause=null for non sl_outside_liquidation rows', () => {
    it('coin_book_too_thin reject has slSubCause=null', async () => {
        const ds = stubDs([buildRollupRow({ reason: 'coin_book_too_thin', gate_allowed: false, sl_sub_cause: null })]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-01');

        expect(rows[0].slSubCause).toBeNull();
    });

    it('an unknown sl_sub_cause string falls back to null', async () => {
        // The mapper is strict: only the three known values pass through; anything else → null.
        const ds = stubDs([
            buildRollupRow({
                reason: 'sl_outside_liquidation',
                gate_allowed: false,
                sl_sub_cause: 'unexpected_future_value',
            }),
        ]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-01');

        expect(rows[0].slSubCause).toBeNull();
    });
});

// ─── C22: Date range inclusive both ends ──────────────────────────────────────

describe('getFunnelSummary — C22: date range validation — fromDate and toDate accepted', () => {
    it('fromDate === toDate is valid (single-day query)', async () => {
        let capturedBindings: readonly unknown[] = [];
        const ds = {
            query: async (_sql: string, bindings: readonly unknown[]) => {
                capturedBindings = bindings;

                return [];
            },
        };

        await expect(getFunnelSummary(ds as never, '2026-06-01', '2026-06-01')).resolves.toBeDefined();
        // Both date bindings passed to SQL
        expect(capturedBindings[0]).toBe('2026-06-01');
        expect(capturedBindings[1]).toBe('2026-06-01');
    });

    it('passes fromDate and toDate as the first two SQL bindings', async () => {
        let capturedBindings: readonly unknown[] = [];
        const ds = {
            query: async (_sql: string, bindings: readonly unknown[]) => {
                capturedBindings = bindings;

                return [];
            },
        };

        await getFunnelSummary(ds as never, '2026-05-01', '2026-06-30');

        expect(capturedBindings[0]).toBe('2026-05-01');
        expect(capturedBindings[1]).toBe('2026-06-30');
    });

    it('passes MAX_LEVERAGE and MAINTENANCE_MARGIN_RATE as the 3rd and 4th bindings', async () => {
        // These are the hard-coded constants the mapper uses for sl_sub_cause classification.
        let capturedBindings: readonly unknown[] = [];
        const ds = {
            query: async (_sql: string, bindings: readonly unknown[]) => {
                capturedBindings = bindings;

                return [];
            },
        };

        await getFunnelSummary(ds as never, '2026-06-01', '2026-06-30');

        // 3rd binding = MAX_LEVERAGE (3), 4th = MAINTENANCE_MARGIN_RATE (0.005)
        expect(capturedBindings[2]).toBe(3);
        expect(capturedBindings[3]).toBe(0.005);
    });
});

// ─── C23: Input validation ────────────────────────────────────────────────────

describe('getFunnelSummary — C23: input validation', () => {
    const ds = stubDs([]);

    it('throws AnalysisValidationError when fromDate is not a valid date string', async () => {
        await expect(getFunnelSummary(ds as never, 'not-a-date', '2026-06-01')).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('throws AnalysisValidationError for non-string fromDate', async () => {
        await expect(getFunnelSummary(ds as never, 123 as never, '2026-06-01')).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('throws AnalysisValidationError when fromDate > toDate (reversed range)', async () => {
        await expect(getFunnelSummary(ds as never, '2026-06-10', '2026-06-01')).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('rejects 2026-02-29 — not a real calendar date in a non-leap year', async () => {
        await expect(getFunnelSummary(ds as never, '2026-02-29', '2026-03-01')).rejects.toThrow();
    });

    it('throws AnalysisValidationError for toDate with wrong format (has time component)', async () => {
        await expect(getFunnelSummary(ds as never, '2026-06-01', '2026-06-01T00:00:00')).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('throws AnalysisValidationError when toDate is not a real date', async () => {
        await expect(getFunnelSummary(ds as never, '2026-06-01', '2026-13-99')).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('accepts fromDate === toDate (boundary: single day is valid)', async () => {
        await expect(getFunnelSummary(ds as never, '2026-06-01', '2026-06-01')).resolves.toBeDefined();
    });

    it('rejects fromDate strictly after toDate (reversed range by one day)', async () => {
        await expect(getFunnelSummary(ds as never, '2026-06-02', '2026-06-01')).rejects.toBeInstanceOf(AnalysisValidationError);
        await expect(getFunnelSummary(ds as never, '2026-06-02', '2026-06-01')).rejects.toThrow(/fromDate/);
    });
});

// ─── C24: Approved rows mapping ───────────────────────────────────────────────

describe('getFunnelSummary — C24: gate_allowed=true row maps to approved fields', () => {
    it('approved row: reason=approved, gateAllowedBucket=approved, isHalted=false', async () => {
        const ds = stubDs([
            buildRollupRow({
                utc_date: '2026-06-05',
                reason: 'signal_matches_filter', // original reason is overridden by gate_allowed=true
                gate_allowed: true,
                sl_sub_cause: null,
                row_count: '3',
            }),
        ]);

        const rows = await getFunnelSummary(ds as never, '2026-06-05', '2026-06-05');

        expect(rows).toHaveLength(1);
        expect(rows[0].reason).toBe('approved');
        expect(rows[0].gateAllowedBucket).toBe('approved');
        expect(rows[0].isHalted).toBe(false);
        expect(rows[0].slSubCause).toBeNull();
        expect(rows[0].count).toBe(3);
        expect(rows[0].utcDate).toBe('2026-06-05');
    });

    it('approved row with a non-null db reason: reason field is overridden to "approved"', async () => {
        // When gate_allowed=true the reason column from the DB is ignored — the mapper
        // unconditionally returns 'approved'. This test pins that invariant.
        const ds = stubDs([
            buildRollupRow({
                reason: 'some_signal_reason',
                gate_allowed: true,
            }),
        ]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-01');

        expect(rows[0].reason).toBe('approved');
    });

    it('approved row with gate_allowed=true and null reason still maps reason to "approved"', async () => {
        const ds = stubDs([
            buildRollupRow({
                reason: null,
                gate_allowed: true,
            }),
        ]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-01');

        expect(rows[0].reason).toBe('approved');
    });
});

// ─── Additional mapping edge cases ────────────────────────────────────────────

describe('getFunnelSummary — mapping: count parsed from string correctly', () => {
    it('row_count string is parsed to a number', async () => {
        const ds = stubDs([buildRollupRow({ row_count: '42' })]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-01');

        expect(rows[0].count).toBe(42);
        expect(typeof rows[0].count).toBe('number');
    });

    it('empty result set returns empty array', async () => {
        const ds = stubDs([]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-30');

        expect(rows).toEqual([]);
    });
});

describe('getFunnelSummary — mapping: utcDate passthrough', () => {
    it('utcDate field is passed through from utc_date column without modification', async () => {
        const ds = stubDs([buildRollupRow({ utc_date: '2026-06-15', gate_allowed: false })]);

        const rows = await getFunnelSummary(ds as never, '2026-06-01', '2026-06-30');

        expect(rows[0].utcDate).toBe('2026-06-15');
    });
});
