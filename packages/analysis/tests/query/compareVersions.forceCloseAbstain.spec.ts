// M39 W2 — compareVersions force-close abstain guard unit tests.
//
// Covers the `forceCloseAbstain` field and its effect on `meanPnlDeltaUsd`:
//
//   FC1 — active vs active: both sides return forceCloseFraction=null → forceCloseAbstain=false.
//   FC2 — shadow side with forceCloseFraction=0 (no force_close exits) → forceCloseAbstain=false.
//   FC3 — shadow side at exactly MAX_FORCE_CLOSE_FRACTION (0.5) → NOT abstain (strictly >).
//   FC4 — shadow side at 0.5001 (strictly above threshold) → forceCloseAbstain=true.
//   FC5 — meanPnlDeltaUsd suppressed when forceCloseAbstain (shadow side fraction=1, n≥30).
//
// Stub DataSource mirrors the compareVersions.spec.ts pattern:
//   - LIMIT 1 queries return the version lookup row.
//   - paired_event_count queries return the paired diff row.
//   - all other queries return the per-version aggregation row.

import { MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN, MAX_FORCE_CLOSE_FRACTION } from '@bot/shared';

import { compareVersions } from '../../src/index';

type QueryHandler = (sql: string, bindings: readonly unknown[]) => Promise<unknown[]>;

function isVersionLookupSql(sql: string): boolean {
    return sql.includes('LIMIT 1');
}

function isPairedDiffSql(sql: string): boolean {
    return sql.includes('paired_event_count');
}

// Builds a stub DataSource that returns the given rows for each query category.
// `versionRowByBinding` allows per-versionId status routing (active vs shadow).
function makeStubDs(options: {
    statusByVersionId?: Record<number, string>;
    defaultStatus?: string;
    forceCloseFraction?: string | null;
    missRate?: string | null;
    pairedTradedEventCount?: number;
    netPnlDeltaUsd?: string;
}): { query: QueryHandler } {
    const {
        statusByVersionId = {},
        defaultStatus = 'shadow',
        forceCloseFraction = null,
        missRate = null,
        pairedTradedEventCount = MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN + 10,
        netPnlDeltaUsd = '50',
    } = options;

    const handler: QueryHandler = async (sql, bindings) => {
        if (isVersionLookupSql(sql)) {
            const versionId = Number(bindings[0]);
            const status = statusByVersionId[versionId] ?? defaultStatus;
            return [{ label: 'test@v1', status }];
        }

        if (isPairedDiffSql(sql)) {
            return [
                {
                    paired_event_count: String(pairedTradedEventCount + 5),
                    paired_traded_event_count: String(pairedTradedEventCount),
                    net_pnl_delta_usd: netPnlDeltaUsd,
                },
            ];
        }

        // Per-version aggregation row
        return [
            {
                trade_count: String(pairedTradedEventCount),
                win_count: String(Math.floor(pairedTradedEventCount / 2)),
                net_pnl_usd: '100',
                force_close_fraction: forceCloseFraction,
                miss_rate: missRate,
                label: 'test@v1',
                status: defaultStatus,
            },
        ];
    };

    return { query: handler };
}

describe('compareVersions — forceCloseAbstain guard (M39 W2)', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-01T00:00:00Z');

    // ── FC1 ──────────────────────────────────────────────────────────────────
    it('FC1: active vs active — both forceCloseFractions are null → forceCloseAbstain=false', async () => {
        // Active versions return NULL for force_close_fraction (no shadow fills)
        const ds = makeStubDs({
            statusByVersionId: { 1: 'active', 2: 'active' },
            defaultStatus: 'active',
            forceCloseFraction: null,
        });

        const result = await compareVersions(ds as never, { aVersionId: 1, bVersionId: 2, from, to });

        expect(result.pairedDiff.forceCloseAbstain).toBe(false);
        // meanPnlDeltaUsd is NOT suppressed by the force-close guard
        expect(result.aPerformance.forceCloseFraction).toBeNull();
        expect(result.bPerformance.forceCloseFraction).toBeNull();
    });

    // ── FC2 ──────────────────────────────────────────────────────────────────
    it('FC2: shadow side with forceCloseFraction=0 (all time_stop exits) → forceCloseAbstain=false', async () => {
        // Shadow side where every traded fill exited via time_stop (none force_close)
        const ds = makeStubDs({
            statusByVersionId: { 1: 'active', 2: 'shadow' },
            defaultStatus: 'shadow',
            forceCloseFraction: '0.00000000',
        });

        const result = await compareVersions(ds as never, { aVersionId: 1, bVersionId: 2, from, to });

        expect(result.pairedDiff.forceCloseAbstain).toBe(false);
    });

    // ── FC3 ──────────────────────────────────────────────────────────────────
    it(`FC3: shadow side with forceCloseFraction exactly at MAX_FORCE_CLOSE_FRACTION (${MAX_FORCE_CLOSE_FRACTION}) → forceCloseAbstain=false (strictly >)`, async () => {
        // Boundary: 0.5 is NOT strictly greater than 0.5 → no abstain
        const ds = makeStubDs({
            defaultStatus: 'shadow',
            forceCloseFraction: String(MAX_FORCE_CLOSE_FRACTION),
        });

        const result = await compareVersions(ds as never, { aVersionId: 1, bVersionId: 2, from, to });

        expect(result.pairedDiff.forceCloseAbstain).toBe(false);
        // meanPnlDeltaUsd must still be present (not suppressed by abstain)
        expect(result.pairedDiff.meanPnlDeltaUsd).not.toBeNull();
    });

    // ── FC4 ──────────────────────────────────────────────────────────────────
    it('FC4: shadow side with forceCloseFraction=0.5001 (above threshold) → forceCloseAbstain=true', async () => {
        // 0.5001 > 0.5 → abstain
        const ds = makeStubDs({
            defaultStatus: 'shadow',
            forceCloseFraction: '0.50010000',
        });

        const result = await compareVersions(ds as never, { aVersionId: 1, bVersionId: 2, from, to });

        expect(result.pairedDiff.forceCloseAbstain).toBe(true);
        // meanPnlDeltaUsd is suppressed when abstaining
        expect(result.pairedDiff.meanPnlDeltaUsd).toBeNull();
    });

    // ── FC5 ──────────────────────────────────────────────────────────────────
    it('FC5: meanPnlDeltaUsd is null when forceCloseAbstain=true, even with sufficient data (n≥30)', async () => {
        // Shadow side 100% force_close exits (fraction=1.0) — well above threshold.
        // Paired traded count is above the sample floor so belowSampleFloor=false.
        // The only suppression reason should be forceCloseAbstain.
        const aboveFloor = MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN + 5;
        const ds = makeStubDs({
            defaultStatus: 'shadow',
            forceCloseFraction: '1.00000000',
            pairedTradedEventCount: aboveFloor,
            netPnlDeltaUsd: '200',
        });

        const result = await compareVersions(ds as never, { aVersionId: 1, bVersionId: 2, from, to });

        expect(result.pairedDiff.pairedTradedEventCount).toBe(aboveFloor);
        expect(result.pairedDiff.belowSampleFloor).toBe(false);
        expect(result.pairedDiff.forceCloseAbstain).toBe(true);
        // Suppressed despite above-floor n because abstain fired
        expect(result.pairedDiff.meanPnlDeltaUsd).toBeNull();
        // The sum (netPnlDeltaUsd) is still surfaced — totals are not misleading
        expect(result.pairedDiff.netPnlDeltaUsd).toBe('200');
    });
});
