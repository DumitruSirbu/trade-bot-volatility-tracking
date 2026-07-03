// M52 D3 (ADR 0051 §6 / §6.1) — getRetryAttribution unit tests.
//
// Unit-scope: a stub DataSource routes the four queries (matched retry arm, matched attempt-1 arm,
// retry-all, drift) by their bind/SQL shape and returns fixture rows, so we exercise the
// survival / counterfactual / matched-control / drift-histogram aggregation without a live Postgres.
// Correctness of the SQL/aggregation logic is the bar — no real soak data needed.

import { getRetryAttribution } from '../../src/query/getRetryAttribution';
import { AnalysisValidationError } from '../../src/util/analysisValidation';

type QueryHandler = (sql: string, bindings: readonly unknown[]) => Promise<unknown[]>;

interface IStubDataSource {
    query: QueryHandler;
}

function stubDataSource(handler: QueryHandler): IStubDataSource {
    return { query: handler };
}

function isDriftSql(sql: string): boolean {
    return sql.includes('force_close_atr_units_drift') && sql.includes('IS NOT NULL');
}

// RETRY_ALL_SQL takes only the 3 base binds (no $4 arm switch); the matched-entry queries take 4.
function isRetryAllSql(bindings: readonly unknown[]): boolean {
    return bindings.length === 3;
}

function isMatchedRetryArm(bindings: readonly unknown[]): boolean {
    return bindings[3] === true;
}

describe('getRetryAttribution', () => {
    const versionId = 20;
    const from = new Date('2026-07-01T00:00:00Z');
    const to = new Date('2026-07-31T00:00:00Z');

    // Matched retry entries (metric 2): both tier_1, ATR% = 1/100 = 0.01 → band [0.01,0.02).
    // returns-on-notional 2/100 = 0.02 and -1/100 = -0.01 → mean 0.005, population stddev 0.015.
    const matchedRetryRows = [
        { realized_pnl: '2', entry_notional: '100', coin_tier: 'tier_1', atr_at_entry: '1', entry_price: '100' },
        { realized_pnl: '-1', entry_notional: '100', coin_tier: 'tier_1', atr_at_entry: '1', entry_price: '100' },
    ];

    // Matched attempt-1 entries: two in the SAME cell (tier_1, 0.01) → returns 0.05, 0.03 → mean 0.04,
    // stddev 0.01; plus one in a DIFFERENT cell (tier_2, ATR% 0.02 → [0.02,0.04)) with no retry
    // counterpart, which MUST be excluded from the matched control (naive whole-basket compare is
    // rejected — ADR 0051 §6).
    const matchedAttempt1Rows = [
        { realized_pnl: '5', entry_notional: '100', coin_tier: 'tier_1', atr_at_entry: '1', entry_price: '100' },
        { realized_pnl: '3', entry_notional: '100', coin_tier: 'tier_1', atr_at_entry: '1', entry_price: '100' },
        { realized_pnl: '10', entry_notional: '100', coin_tier: 'tier_2', atr_at_entry: '2', entry_price: '100' },
    ];

    // Retry-all rows (metrics 1 + 5): KEEP the force_close leg. 4 fired, 1 force_closed again.
    // net PnL = 2 − 1 + 3 − 0.2 = 3.8; wins = 2. survivalRate = 1 − 1/4 = 0.75.
    const retryAllRows = [
        { realized_pnl: '2', exit_reason: 'take_profit' },
        { realized_pnl: '-1', exit_reason: 'stop_loss' },
        { realized_pnl: '3', exit_reason: 'take_profit' },
        { realized_pnl: '-0.2', exit_reason: 'force_close' },
    ];

    // Drift rows placed to land one in each finer 0.25 band across the calibration range (metric 3).
    const driftRows = [
        { drift: '0.1' },
        { drift: '0.3' },
        { drift: '0.6' },
        { drift: '0.8' },
        { drift: '1.1' },
        { drift: '1.32' },
        { drift: '1.6' },
        { drift: '1.76' },
        { drift: '2.5' },
    ];

    function fixtureDataSource(): IStubDataSource {
        return stubDataSource(async (sql, bindings) => {
            if (isDriftSql(sql)) {
                return driftRows;
            }

            if (isRetryAllSql(bindings)) {
                return retryAllRows;
            }

            return isMatchedRetryArm(bindings) ? matchedRetryRows : matchedAttempt1Rows;
        });
    }

    it('computes the survival rate (metric 1) over all retry legs including force_close', async () => {
        const report = await getRetryAttribution(fixtureDataSource() as never, { versionId, from, to });

        expect(report.survival.firedCount).toBe(4);
        expect(report.survival.forceClosedAgainCount).toBe(1);
        expect(report.survival.survivedCount).toBe(3);
        expect(report.survival.survivalRate).toBe('0.75');
    });

    it('computes the counterfactual PnL (metric 5) over retry entries, keeping the force_close leg', async () => {
        const report = await getRetryAttribution(fixtureDataSource() as never, { versionId, from, to });

        expect(report.strategyVersionId).toBe('20');
        expect(report.counterfactual.retryEntryCount).toBe(4);
        expect(report.counterfactual.retryWinCount).toBe(2);
        expect(report.counterfactual.retryNetPnlUsd).toBe('3.8');
    });

    it('emits a matched-control cell (return-on-notional) only where BOTH arms populate, excluding the unmatched tier_2 cell', async () => {
        const report = await getRetryAttribution(fixtureDataSource() as never, { versionId, from, to });

        expect(report.matchedControl).toHaveLength(1);

        const cell = report.matchedControl[0];
        expect(cell.coinTier).toBe('tier_1');
        expect(cell.atrPctBucket).toBe('[0.01,0.02)');
        expect(cell.retryCount).toBe(2);
        expect(cell.retryAvgReturnOnNotional).toBe('0.005');
        expect(cell.attempt1Count).toBe(2);
        expect(cell.attempt1AvgReturnOnNotional).toBe('0.04');
        // retry 0.005 − attempt1 0.04 = −0.035 → negative ⇒ the adverse-selection direction.
        expect(cell.avgReturnDelta).toBe('-0.035');
    });

    it('reports per-arm population stddev and the delta standard error on each matched cell (§6.1)', async () => {
        const report = await getRetryAttribution(fixtureDataSource() as never, { versionId, from, to });
        const cell = report.matchedControl[0];

        expect(cell.retryReturnStdDev).toBe('0.015');
        expect(cell.attempt1ReturnStdDev).toBe('0.01');

        // deltaStdErr = sqrt(varRetry/nRetry + varAttempt1/nAttempt1)
        //            = sqrt(0.000225/2 + 0.0001/2) = sqrt(0.0001625).
        const expectedStdErr = Math.sqrt(0.015 ** 2 / 2 + 0.01 ** 2 / 2);
        expect(Number(cell.deltaStdErr)).toBeCloseTo(expectedStdErr, 12);
    });

    it('fences force_close from BOTH matched arms but keeps it in the retry-all source (§6.1)', async () => {
        const seenSql: string[] = [];
        const ds = stubDataSource(async (sql, bindings) => {
            seenSql.push(sql);

            if (isDriftSql(sql)) {
                return driftRows;
            }

            if (isRetryAllSql(bindings)) {
                return retryAllRows;
            }

            return isMatchedRetryArm(bindings) ? matchedRetryRows : matchedAttempt1Rows;
        });

        await getRetryAttribution(ds as never, { versionId, from, to });

        const matchedSql = seenSql.filter((sql) => sql.includes('is_retry_entry = true') && sql.includes('entry_notional'));
        const retryAllSql = seenSql.find((sql) => sql.includes('is_retry_entry = true') && !sql.includes('entry_notional'));

        // Matched query is used for BOTH arms and fences force_close on both.
        expect(matchedSql.length).toBeGreaterThan(0);
        for (const sql of matchedSql) {
            expect(sql).toContain("exit_reason IS DISTINCT FROM 'force_close'");
        }

        // Retry-all source keeps force_close (no fence) so metrics 1 and 5 include the unwind cost.
        expect(retryAllSql).toBeDefined();
        expect(retryAllSql).not.toContain('IS DISTINCT FROM');
    });

    it('drops matched rows with a zero or non-finite entry_notional rather than bucketing them', async () => {
        const retryWithBadNotional = [
            ...matchedRetryRows,
            { realized_pnl: '5', entry_notional: '0', coin_tier: 'tier_1', atr_at_entry: '1', entry_price: '100' },
        ];
        const ds = stubDataSource(async (sql, bindings) => {
            if (isDriftSql(sql)) {
                return driftRows;
            }

            if (isRetryAllSql(bindings)) {
                return retryAllRows;
            }

            return isMatchedRetryArm(bindings) ? retryWithBadNotional : matchedAttempt1Rows;
        });

        const report = await getRetryAttribution(ds as never, { versionId, from, to });

        // The zero-notional row is dropped: retryCount stays 2 and the mean is unchanged.
        expect(report.matchedControl[0].retryCount).toBe(2);
        expect(report.matchedControl[0].retryAvgReturnOnNotional).toBe('0.005');
    });

    it('buckets the force_close ATR-unit drift distribution (metric 3) on the finer 0.25 bands', async () => {
        const report = await getRetryAttribution(fixtureDataSource() as never, { versionId, from, to });

        const byLabel = new Map(report.driftDistribution.map((bucket) => [bucket.label, bucket.count]));

        expect(byLabel.get('[0,0.25)')).toBe(1);
        expect(byLabel.get('[0.25,0.5)')).toBe(1);
        expect(byLabel.get('[0.5,0.75)')).toBe(1);
        expect(byLabel.get('[0.75,1)')).toBe(1);
        expect(byLabel.get('[1,1.25)')).toBe(1);
        expect(byLabel.get('[1.25,1.5)')).toBe(1);
        expect(byLabel.get('[1.5,1.75)')).toBe(1);
        expect(byLabel.get('[1.75,2)')).toBe(1);
        expect(byLabel.get('[2,∞)')).toBe(1);
    });

    it('surfaces the flat-fill-sim caveat annotation', async () => {
        const report = await getRetryAttribution(fixtureDataSource() as never, { versionId, from, to });

        expect(report.flatFillSimCaveat).toContain('pipeline-validation');
    });

    it('returns an empty survival / counterfactual / matched control when there are no retry entries', async () => {
        const ds = stubDataSource(async (sql, bindings) => {
            if (isDriftSql(sql)) {
                return [];
            }

            if (isRetryAllSql(bindings)) {
                return [];
            }

            return isMatchedRetryArm(bindings) ? [] : matchedAttempt1Rows;
        });

        const report = await getRetryAttribution(ds as never, { versionId, from, to });

        expect(report.survival.firedCount).toBe(0);
        expect(report.survival.survivalRate).toBe('0');
        expect(report.counterfactual.retryEntryCount).toBe(0);
        expect(report.counterfactual.retryNetPnlUsd).toBe('0');
        expect(report.matchedControl).toHaveLength(0);
    });

    it('rejects a non-positive versionId', async () => {
        await expect(getRetryAttribution(fixtureDataSource() as never, { versionId: 0, from, to })).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('rejects a reversed date range', async () => {
        await expect(getRetryAttribution(fixtureDataSource() as never, { versionId, from: to, to: from })).rejects.toBeInstanceOf(AnalysisValidationError);
    });
});
