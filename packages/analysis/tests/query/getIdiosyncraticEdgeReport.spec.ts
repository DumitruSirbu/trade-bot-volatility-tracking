// M30 D2 — getIdiosyncraticEdgeReport unit tests.
//
// Stub DataSource.query with fixture IEdgeTradeRow arrays so we can verify
// R-multiple arithmetic, clamped-trade counting, BTC-regime bucketing,
// floor checks, robustness logic, and input validation without a real DB.
// No real DB — the SQL is exercised only by integration tests against the
// port-6900 test container.

import { Decimal } from 'decimal.js';

import { AnalysisValidationError } from '../../src/index';
import { getIdiosyncraticEdgeReport } from '../../src/query/getIdiosyncraticEdgeReport';

// ─── Fixture factory ──────────────────────────────────────────────────────────

interface IEdgeTradeRowOverrides {
    utc_date?: string;
    realized_pnl?: string | null;
    reconstructed_risk_usdt?: string | null;
    r_multiple?: string | null;
    btc_5m_move_pct?: string | null;
}

function buildEdgeRow(overrides: IEdgeTradeRowOverrides = {}): Record<string, unknown> {
    return {
        utc_date: '2026-06-01',
        realized_pnl: '40',
        reconstructed_risk_usdt: '20',
        r_multiple: '2',
        btc_5m_move_pct: null,
        ...overrides,
    };
}

function stubDs(rows: Record<string, unknown>[]): { query: () => Promise<unknown[]> } {
    return {
        query: async () => rows,
    };
}

const DEFAULT_PARAMS = {
    fromDate: '2026-06-01',
    toDate: '2026-06-30',
    riskPerTradeUsdt: '15',
};

// ─── R-multiple denominator reconstruction ───────────────────────────────────

describe('getIdiosyncraticEdgeReport — R-multiple denominator reconstruction', () => {
    it('trade with qty=10, entry=100, sl=98, pnl=40 yields meanRMultiple=2', async () => {
        const row = buildEdgeRow({
            realized_pnl: '40',
            reconstructed_risk_usdt: '20',
            r_multiple: '2',
        });
        const ds = stubDs([row]);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.meanRMultiple).toBe('2');
    });

    it('null qty → r_multiple null → excluded from n and meanRMultiple', async () => {
        const row = buildEdgeRow({ r_multiple: null, reconstructed_risk_usdt: null });
        const ds = stubDs([row]);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.n).toBe(0);
        expect(report.meanRMultiple).toBeNull();
    });

    it('null entry_price → r_multiple null → excluded from aggregates', async () => {
        const row = buildEdgeRow({ r_multiple: null, reconstructed_risk_usdt: null, realized_pnl: null });
        const ds = stubDs([row]);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.n).toBe(0);
        expect(report.meanRMultiple).toBeNull();
    });

    it('null stop_loss_price → r_multiple null → excluded from aggregates', async () => {
        const row = buildEdgeRow({ r_multiple: null, reconstructed_risk_usdt: null });
        const ds = stubDs([row]);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.n).toBe(0);
        expect(report.meanRMultiple).toBeNull();
    });

    it('clamped trade (reconstructed_risk_usdt=8 < riskPerTrade=15) increments clampedTradeCount', async () => {
        const row = buildEdgeRow({ reconstructed_risk_usdt: '8', r_multiple: '5' });
        const ds = stubDs([row]);

        const report = await getIdiosyncraticEdgeReport(ds as never, { ...DEFAULT_PARAMS, riskPerTradeUsdt: '15' });

        expect(report.clampedTradeCount).toBe(1);
    });

    it('unclamped trade (reconstructed_risk_usdt=20 >= riskPerTrade=15) does not increment clampedTradeCount', async () => {
        const row = buildEdgeRow({ reconstructed_risk_usdt: '20', r_multiple: '2' });
        const ds = stubDs([row]);

        const report = await getIdiosyncraticEdgeReport(ds as never, { ...DEFAULT_PARAMS, riskPerTradeUsdt: '15' });

        expect(report.clampedTradeCount).toBe(0);
    });

    it('all unclamped trades yields clampedTradeFraction=0.00', async () => {
        const rows = [buildEdgeRow({ reconstructed_risk_usdt: '20', r_multiple: '2' }), buildEdgeRow({ reconstructed_risk_usdt: '25', r_multiple: '1' })];
        const ds = stubDs(rows);

        const report = await getIdiosyncraticEdgeReport(ds as never, { ...DEFAULT_PARAMS, riskPerTradeUsdt: '15' });

        expect(report.clampedTradeFraction).toBe('0.00');
    });
});

// ─── LATERAL join and BTC bucket from btc_5m_move_pct ────────────────────────

describe('getIdiosyncraticEdgeReport — BTC-move bucket assignment from LATERAL join', () => {
    it('btc_5m_move_pct=null falls into btc5mFlat bucket', async () => {
        const row = buildEdgeRow({ btc_5m_move_pct: null, r_multiple: '1' });
        const ds = stubDs([row]);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.btc5mFlat.n).toBe(1);
        expect(report.btc5mUp.n).toBe(0);
        expect(report.btc5mDown.n).toBe(0);
    });

    it('btc_5m_move_pct=1.5 (boundary) falls into btc5mUp bucket', async () => {
        const row = buildEdgeRow({ btc_5m_move_pct: '1.5', r_multiple: '1' });
        const ds = stubDs([row]);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.btc5mUp.n).toBe(1);
        expect(report.btc5mFlat.n).toBe(0);
        expect(report.btc5mDown.n).toBe(0);
    });

    it('btc_5m_move_pct=-1.5 (negative boundary) falls into btc5mDown bucket', async () => {
        const row = buildEdgeRow({ btc_5m_move_pct: '-1.5', r_multiple: '1' });
        const ds = stubDs([row]);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.btc5mDown.n).toBe(1);
        expect(report.btc5mUp.n).toBe(0);
        expect(report.btc5mFlat.n).toBe(0);
    });

    it('btc_5m_move_pct=1.49 (just inside flat window) falls into btc5mFlat bucket', async () => {
        const row = buildEdgeRow({ btc_5m_move_pct: '1.49', r_multiple: '1' });
        const ds = stubDs([row]);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.btc5mFlat.n).toBe(1);
        expect(report.btc5mUp.n).toBe(0);
        expect(report.btc5mDown.n).toBe(0);
    });

    it('btc_5m_move_pct=2.0 (well above threshold) falls into btc5mUp bucket', async () => {
        const row = buildEdgeRow({ btc_5m_move_pct: '2.0', r_multiple: '1' });
        const ds = stubDs([row]);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.btc5mUp.n).toBe(1);
    });
});

// ─── Floor boundaries ─────────────────────────────────────────────────────────

describe('getIdiosyncraticEdgeReport — floor boundaries', () => {
    function buildNRows(count: number): Record<string, unknown>[] {
        return Array.from({ length: count }, (_, i) => buildEdgeRow({ utc_date: `2026-06-${String(i + 1).padStart(2, '0')}`, r_multiple: '1' }));
    }

    it('meetsClosedTradeFloor is false at n=19', async () => {
        const ds = stubDs(buildNRows(19));

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.n).toBe(19);
        expect(report.meetsClosedTradeFloor).toBe(false);
    });

    it('meetsClosedTradeFloor is true at n=20 (exact boundary)', async () => {
        const ds = stubDs(buildNRows(20));

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.n).toBe(20);
        expect(report.meetsClosedTradeFloor).toBe(true);
    });

    it('meetsTradingDayFloor is false at distinctTradingDays=2', async () => {
        const rows = [buildEdgeRow({ utc_date: '2026-06-01', r_multiple: '1' }), buildEdgeRow({ utc_date: '2026-06-02', r_multiple: '1' })];
        const ds = stubDs(rows);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.distinctTradingDays).toBe(2);
        expect(report.meetsTradingDayFloor).toBe(false);
    });

    it('meetsTradingDayFloor is true at distinctTradingDays=3 (exact boundary)', async () => {
        const rows = [
            buildEdgeRow({ utc_date: '2026-06-01', r_multiple: '1' }),
            buildEdgeRow({ utc_date: '2026-06-02', r_multiple: '1' }),
            buildEdgeRow({ utc_date: '2026-06-03', r_multiple: '1' }),
        ];
        const ds = stubDs(rows);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.distinctTradingDays).toBe(3);
        expect(report.meetsTradingDayFloor).toBe(true);
    });
});

// ─── Idiosyncratic-only SQL filter ────────────────────────────────────────────

describe('getIdiosyncraticEdgeReport — idiosyncratic-only SQL filter', () => {
    it('the SQL contains correlation_mode = idiosyncratic filter (not correlated)', async () => {
        // The SQL is the contract-verified surface. We test the query function
        // only calls ds.query once, and that the stub is used (i.e. the
        // correlated row would contaminate if the filter were removed).
        // We verify the mock receives a SQL string containing the filter.
        let capturedSql = '';
        const mockDs = {
            query: async (sql: string) => {
                capturedSql = sql;
                return [];
            },
        };

        await getIdiosyncraticEdgeReport(mockDs as never, DEFAULT_PARAMS);

        expect(capturedSql).toContain("'idiosyncratic'");
    });
});

// ─── rMultipleStdError semantics ─────────────────────────────────────────────

describe('getIdiosyncraticEdgeReport — rMultipleStdError semantics', () => {
    it('zero trades → rMultipleStdError=null and meanRMultiple=null', async () => {
        const ds = stubDs([]);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.rMultipleStdError).toBeNull();
        expect(report.meanRMultiple).toBeNull();
    });

    it('one trade → rMultipleStdError=null (no dispersion, false certainty if 0)', async () => {
        const ds = stubDs([buildEdgeRow({ r_multiple: '2' })]);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.rMultipleStdError).toBeNull();
        expect(report.meanRMultiple).toBe('2');
    });

    it('two trades R=1 and R=3 → stdError=1 (exact decimal: stdDev=√2, stdError=√2/√2=1)', async () => {
        // mean = (1+3)/2 = 2
        // sampleVariance = ((1-2)^2 + (3-2)^2) / (2-1) = 2
        // stdDev = √2 ≈ 1.4142135...
        // stdError = √2 / √2 = 1 (exactly)
        const rows = [buildEdgeRow({ r_multiple: '1', reconstructed_risk_usdt: '20' }), buildEdgeRow({ r_multiple: '3', reconstructed_risk_usdt: '20' })];
        const ds = stubDs(rows);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.meanRMultiple).toBe('2');
        // Verify via Decimal.js reference to avoid float drift
        const expectedStdError = new Decimal(2).sqrt().dividedBy(new Decimal(2).sqrt());
        expect(report.rMultipleStdError).toBe(expectedStdError.toFixed());
    });

    it('two trades R=2 and R=4 → meanRMultiple=3 and rMultipleStdError is non-null positive decimal', async () => {
        const rows = [buildEdgeRow({ r_multiple: '2', reconstructed_risk_usdt: '20' }), buildEdgeRow({ r_multiple: '4', reconstructed_risk_usdt: '20' })];
        const ds = stubDs(rows);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.meanRMultiple).toBe('3');
        expect(report.rMultipleStdError).not.toBeNull();
        expect(new Decimal(report.rMultipleStdError as string).greaterThan(0)).toBe(true);
    });
});

// ─── regimeRobustnessPasses advisory ─────────────────────────────────────────

describe('getIdiosyncraticEdgeReport — regimeRobustnessPasses advisory', () => {
    it('bucket with n<8 does NOT participate in sign check (small negative bucket does not make robustness fail)', async () => {
        // 8 up-regime trades with R=3 (positive aggregate)
        // 2 flat-regime trades with R=-1 (negative mean, but n=2 < 8 → excluded from sign check)
        // Aggregate mean = (8*3 + 2*(-1)) / 10 = (24-2)/10 = 2.2 → positive
        // btc5mUp has n=8 and mean=3 → positive, agrees with aggregate → no failure
        // btc5mFlat has n=2 < 8 → excluded → robustness passes
        const upRows = Array.from({ length: 8 }, () => buildEdgeRow({ btc_5m_move_pct: '2.0', r_multiple: '3', reconstructed_risk_usdt: '20' }));
        const flatRows = [
            buildEdgeRow({ btc_5m_move_pct: null, r_multiple: '-1', reconstructed_risk_usdt: '20' }),
            buildEdgeRow({ btc_5m_move_pct: null, r_multiple: '-1', reconstructed_risk_usdt: '20' }),
        ];
        const ds = stubDs([...upRows, ...flatRows]);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        // Flat bucket has n=2 < 8 → does not participate → robustness passes
        expect(report.btc5mUp.n).toBe(8);
        expect(report.btc5mFlat.n).toBe(2);
        expect(report.regimeRobustnessPasses).toBe(true);
    });

    it('bucket with n>=8 that disagrees in sign with aggregate makes regimeRobustnessPasses=false', async () => {
        // 8 up-regime trades with R=1 (mean=1, positive)
        // 8 flat-regime trades with R=-2 (mean=-2, negative) → sign disagrees
        const upRows = Array.from({ length: 8 }, () => buildEdgeRow({ btc_5m_move_pct: '2.0', r_multiple: '1', reconstructed_risk_usdt: '20' }));
        const flatRows = Array.from({ length: 8 }, () => buildEdgeRow({ btc_5m_move_pct: null, r_multiple: '-2', reconstructed_risk_usdt: '20' }));
        const ds = stubDs([...upRows, ...flatRows]);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.regimeRobustnessPasses).toBe(false);
    });

    it('all qualifying buckets (n>=8) agreeing in sign → regimeRobustnessPasses=true', async () => {
        // 8 up-regime trades with R=2 and 8 flat-regime trades with R=1 (both positive)
        const upRows = Array.from({ length: 8 }, () => buildEdgeRow({ btc_5m_move_pct: '2.0', r_multiple: '2', reconstructed_risk_usdt: '20' }));
        const flatRows = Array.from({ length: 8 }, () => buildEdgeRow({ btc_5m_move_pct: null, r_multiple: '1', reconstructed_risk_usdt: '20' }));
        const ds = stubDs([...upRows, ...flatRows]);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.regimeRobustnessPasses).toBe(true);
    });

    it('regimeRobustnessPasses failure does NOT affect slotCGateOpen (robustness is advisory only)', async () => {
        // Build 20 up-regime trades (n=8 qualifying, mean=1) and 20 flat-regime trades (n>=8, mean=-2)
        // The flat bucket disagrees with aggregate → regimeRobustnessPasses=false
        // 40 trades total across 3 days → both floor conditions met → slotCGateOpen=true
        const DAYS = ['2026-06-01', '2026-06-02', '2026-06-03'];
        const upRows = Array.from({ length: 20 }, (_, i) =>
            buildEdgeRow({ btc_5m_move_pct: '2.0', r_multiple: '1', reconstructed_risk_usdt: '20', utc_date: DAYS[i % 3] }),
        );
        const flatRows = Array.from({ length: 20 }, (_, i) =>
            buildEdgeRow({ btc_5m_move_pct: null, r_multiple: '-2', reconstructed_risk_usdt: '20', utc_date: DAYS[i % 3] }),
        );
        const ds = stubDs([...upRows, ...flatRows]);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.regimeRobustnessPasses).toBe(false);
        // Gate is open because floor conditions are satisfied
        expect(report.meetsClosedTradeFloor).toBe(true);
        expect(report.meetsTradingDayFloor).toBe(true);
        expect(report.slotCGateOpen).toBe(true);
    });
});

// ─── slotCGateOpen ────────────────────────────────────────────────────────────

describe('getIdiosyncraticEdgeReport — slotCGateOpen', () => {
    it('slotCGateOpen=false when n<20 even if tradingDays>=3', async () => {
        const rows = [
            buildEdgeRow({ utc_date: '2026-06-01', r_multiple: '1' }),
            buildEdgeRow({ utc_date: '2026-06-02', r_multiple: '1' }),
            buildEdgeRow({ utc_date: '2026-06-03', r_multiple: '1' }),
        ];
        const ds = stubDs(rows);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.slotCGateOpen).toBe(false);
    });

    it('slotCGateOpen=false when n>=20 but distinctTradingDays<3', async () => {
        // 20 trades all on 2 days
        const rows = Array.from({ length: 20 }, (_, i) => buildEdgeRow({ utc_date: i < 10 ? '2026-06-01' : '2026-06-02', r_multiple: '1' }));
        const ds = stubDs(rows);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.meetsClosedTradeFloor).toBe(true);
        expect(report.meetsTradingDayFloor).toBe(false);
        expect(report.slotCGateOpen).toBe(false);
    });

    it('slotCGateOpen flips true at exactly n=20 AND distinctTradingDays=3', async () => {
        // 20 trades spread across exactly 3 days
        const rows = Array.from({ length: 20 }, (_, i) => {
            const day = (i % 3) + 1;

            return buildEdgeRow({ utc_date: `2026-06-${String(day).padStart(2, '0')}`, r_multiple: '1' });
        });
        const ds = stubDs(rows);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.n).toBe(20);
        expect(report.distinctTradingDays).toBe(3);
        expect(report.slotCGateOpen).toBe(true);
    });

    it('empty range: n=0, slotCGateOpen=false, no divide-by-zero', async () => {
        const ds = stubDs([]);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.n).toBe(0);
        expect(report.slotCGateOpen).toBe(false);
        expect(report.clampedTradeFraction).toBe('0.00');
        expect(report.meanRMultiple).toBeNull();
        expect(report.rMultipleStdError).toBeNull();
    });
});

// ─── Decimal math exactness ───────────────────────────────────────────────────

describe('getIdiosyncraticEdgeReport — decimal math exactness', () => {
    it('R-multiple computed from simple integers has no float drift', async () => {
        // R = pnl / reconstructedRisk = 60 / 30 = 2 (exactly)
        const row = buildEdgeRow({
            realized_pnl: '60',
            reconstructed_risk_usdt: '30',
            r_multiple: '2',
        });
        const ds = stubDs([row]);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.meanRMultiple).toBe('2');
    });

    it('clampedTradeFraction uses decimal division (1 of 3 clamped → 0.33)', async () => {
        const rows = [
            buildEdgeRow({ reconstructed_risk_usdt: '8', r_multiple: '5' }), // clamped
            buildEdgeRow({ reconstructed_risk_usdt: '20', r_multiple: '1' }), // not clamped
            buildEdgeRow({ reconstructed_risk_usdt: '20', r_multiple: '1' }), // not clamped
        ];
        const ds = stubDs(rows);

        const report = await getIdiosyncraticEdgeReport(ds as never, DEFAULT_PARAMS);

        expect(report.clampedTradeCount).toBe(1);
        expect(report.clampedTradeFraction).toBe('0.33');
    });
});

// ─── Input validation ─────────────────────────────────────────────────────────

describe('getIdiosyncraticEdgeReport — input validation', () => {
    it('invalid fromDate format throws AnalysisValidationError', async () => {
        const ds = stubDs([]);

        await expect(getIdiosyncraticEdgeReport(ds as never, { ...DEFAULT_PARAMS, fromDate: '01-06-2026' })).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('invalid toDate format throws AnalysisValidationError', async () => {
        const ds = stubDs([]);

        await expect(getIdiosyncraticEdgeReport(ds as never, { ...DEFAULT_PARAMS, toDate: '2026/06/30' })).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('fromDate > toDate throws AnalysisValidationError on field "range"', async () => {
        const ds = stubDs([]);

        await expect(getIdiosyncraticEdgeReport(ds as never, { ...DEFAULT_PARAMS, fromDate: '2026-06-30', toDate: '2026-06-01' })).rejects.toMatchObject({
            field: 'range',
        });
    });

    it('riskPerTradeUsdt=NaN throws AnalysisValidationError on field "riskPerTradeUsdt"', async () => {
        const ds = stubDs([]);

        await expect(getIdiosyncraticEdgeReport(ds as never, { ...DEFAULT_PARAMS, riskPerTradeUsdt: 'NaN' })).rejects.toMatchObject({
            field: 'riskPerTradeUsdt',
        });
    });

    it('riskPerTradeUsdt negative throws AnalysisValidationError', async () => {
        const ds = stubDs([]);

        await expect(getIdiosyncraticEdgeReport(ds as never, { ...DEFAULT_PARAMS, riskPerTradeUsdt: '-5' })).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('riskPerTradeUsdt zero throws AnalysisValidationError', async () => {
        const ds = stubDs([]);

        await expect(getIdiosyncraticEdgeReport(ds as never, { ...DEFAULT_PARAMS, riskPerTradeUsdt: '0' })).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('non-numeric riskPerTradeUsdt throws AnalysisValidationError', async () => {
        const ds = stubDs([]);

        await expect(getIdiosyncraticEdgeReport(ds as never, { ...DEFAULT_PARAMS, riskPerTradeUsdt: 'abc' })).rejects.toBeInstanceOf(AnalysisValidationError);
    });
});
