/**
 * Migration ArchiveRetiredVwapShadowRows — unit test (M53 D4, docs/plans/M53-xmom-tp-arm-headroom.md).
 *
 * Two layers of coverage:
 *
 *   1. Mocked-QueryRunner SQL-shape assertions (mirrors migration.add-position-retry-attribution.spec.ts):
 *      up()/down() issue the expected bounded UPDATE, scoped by an explicit id list plus a name guard
 *      (never string-interpolated).
 *
 *   2. An in-memory fake table (a small array of {id, name, status, archived_at} rows) that actually
 *      APPLIES the migration's literal SQL semantics, so "exactly the seven ids, id=3/id=20 untouched,
 *      idempotent, reversible" is proven against real row data rather than only inspected as SQL text.
 *
 * Coverage map:
 *   - up() flips exactly ids 1,2,4,15,16,17,19 (status='shadow'→'archived', archived_at stamped)
 *   - up() leaves id=3 (volatility-vwap, status='active') and id=20 (xmom) untouched
 *   - re-running up() is a no-op (idempotent — the seven are no longer status='shadow')
 *   - down() restores status='shadow' and nulls archived_at for the seven
 *   - ADVERSARIAL (fixed): down() is scoped to the exact id list, so an out-of-band archived
 *     volatility-vwap row (id=99) this migration never touched is NOT revived by down().
 */

import { QueryRunner } from 'typeorm';

import { ArchiveRetiredVwapShadowRows20260712000000 } from '../../src/database/migrations/20260712000000-ArchiveRetiredVwapShadowRows';

const SEVEN_SHADOW_IDS = [1, 2, 4, 15, 16, 17, 19];

// ─── layer 1: mocked QueryRunner — SQL shape ──────────────────────────────────

function makeQueryRunner(): { qr: QueryRunner; querySpy: jest.Mock } {
    const querySpy = jest.fn().mockResolvedValue(undefined);
    const qr = { query: querySpy } as unknown as QueryRunner;

    return { qr, querySpy };
}

describe('Migration ArchiveRetiredVwapShadowRows — up() SQL shape', () => {
    it('issues a single bounded UPDATE parameterized by name, targeting status=shadow → archived', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new ArchiveRetiredVwapShadowRows20260712000000();

        await migration.up(qr);

        expect(querySpy).toHaveBeenCalledTimes(1);
        const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];

        expect(sql).toContain('"strategy_versions"');
        expect(sql).toMatch(/SET\s+"status"\s*=\s*'archived'/);
        expect(sql).toMatch(/"archived_at"\s*=\s*now\(\)/i);
        expect(sql).toMatch(/WHERE\s+"strategy_versions_id"\s*=\s*ANY\(\$1\)\s+AND\s+"name"\s*=\s*\$2\s+AND\s+"status"\s*=\s*'shadow'/);
        expect(params).toEqual([SEVEN_SHADOW_IDS, 'volatility-vwap']);
    });
});

describe('Migration ArchiveRetiredVwapShadowRows — down() SQL shape', () => {
    it('issues a single bounded UPDATE parameterized by name, targeting status=archived → shadow', async () => {
        const { qr, querySpy } = makeQueryRunner();
        const migration = new ArchiveRetiredVwapShadowRows20260712000000();

        await migration.down(qr);

        expect(querySpy).toHaveBeenCalledTimes(1);
        const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];

        expect(sql).toContain('"strategy_versions"');
        expect(sql).toMatch(/SET\s+"status"\s*=\s*'shadow'/);
        expect(sql).toMatch(/"archived_at"\s*=\s*NULL/i);
        expect(sql).toMatch(/WHERE\s+"strategy_versions_id"\s*=\s*ANY\(\$1\)\s+AND\s+"name"\s*=\s*\$2\s+AND\s+"status"\s*=\s*'archived'/);
        expect(params).toEqual([SEVEN_SHADOW_IDS, 'volatility-vwap']);
    });
});

// ─── layer 2: in-memory fake table — actual row-level behavior ───────────────

// Field name mirrors the REAL strategy_versions PK column (strategy_versions_id, per
// StrategyVersionEntity), NOT a generic `id`. The parser below keys the id predicate off the column
// name it extracts from the SQL, so a migration referencing the wrong column (e.g. "id") no longer
// matches any row and the behavior tests fail — closing the fixture-diverges-from-schema gap that let
// the `WHERE "id"` bug ship.
interface IFakeRow {
    strategy_versions_id: number;
    name: string;
    status: string;
    archived_at: Date | null;
}

/** Applies the migration's literal SQL semantics
 * (UPDATE ... SET status=X WHERE "<pk>" = ANY($1) AND name=$2 AND status=Y) against an in-memory row
 * array, so up()/down() can be proven against real row data without a live Postgres instance. The id
 * column is read from the SQL's WHERE clause (not hard-coded), so the fixture only matches rows when
 * the migration targets the real PK column name. Parses only the two fixed shapes this migration
 * ever issues. */
function makeFakeTableQueryRunner(rows: IFakeRow[]): QueryRunner {
    const query = jest.fn(async (sql: string, params?: unknown[]) => {
        const [ids, name] = params as [number[], string];
        const idSet = new Set(ids);
        const idColumn = /WHERE\s+"([^"]+)"\s*=\s*ANY\(\$1\)/.exec(sql)?.[1];
        const targetsArchived = /SET\s+"status"\s*=\s*'archived'/.test(sql);
        const fromStatus = targetsArchived ? 'shadow' : 'archived';
        const toStatus = targetsArchived ? 'archived' : 'shadow';

        for (const row of rows) {
            const rowId = idColumn === undefined ? undefined : (row as unknown as Record<string, unknown>)[idColumn];

            if (typeof rowId === 'number' && idSet.has(rowId) && row.name === name && row.status === fromStatus) {
                row.status = toStatus;
                row.archived_at = targetsArchived ? new Date() : null;
            }
        }

        return undefined;
    });

    return { query } as unknown as QueryRunner;
}

function buildRealisticRowSet(): IFakeRow[] {
    const rows: IFakeRow[] = SEVEN_SHADOW_IDS.map((id) => ({ strategy_versions_id: id, name: 'volatility-vwap', status: 'shadow', archived_at: null }));

    rows.push({ strategy_versions_id: 3, name: 'volatility-vwap', status: 'active', archived_at: null });
    rows.push({ strategy_versions_id: 20, name: 'xmom', status: 'active', archived_at: null });

    return rows;
}

describe('Migration ArchiveRetiredVwapShadowRows — up() row-level behavior', () => {
    it('archives exactly ids 1,2,4,15,16,17,19 and stamps archived_at on each', async () => {
        const rows = buildRealisticRowSet();
        const qr = makeFakeTableQueryRunner(rows);
        const migration = new ArchiveRetiredVwapShadowRows20260712000000();

        await migration.up(qr);

        for (const id of SEVEN_SHADOW_IDS) {
            const row = rows.find((candidate) => candidate.strategy_versions_id === id)!;
            expect(row.status).toBe('archived');
            expect(row.archived_at).not.toBeNull();
        }
    });

    it('leaves id=3 (volatility-vwap, status=active) untouched', async () => {
        const rows = buildRealisticRowSet();
        const qr = makeFakeTableQueryRunner(rows);
        const migration = new ArchiveRetiredVwapShadowRows20260712000000();

        await migration.up(qr);

        const activeVwap = rows.find((row) => row.strategy_versions_id === 3)!;
        expect(activeVwap.status).toBe('active');
        expect(activeVwap.archived_at).toBeNull();
    });

    it('leaves id=20 (xmom) untouched', async () => {
        const rows = buildRealisticRowSet();
        const qr = makeFakeTableQueryRunner(rows);
        const migration = new ArchiveRetiredVwapShadowRows20260712000000();

        await migration.up(qr);

        const xmom = rows.find((row) => row.strategy_versions_id === 20)!;
        expect(xmom.status).toBe('active');
        expect(xmom.archived_at).toBeNull();
    });

    it('re-running up() a second time is a no-op — no row is archived twice, no error', async () => {
        const rows = buildRealisticRowSet();
        const qr = makeFakeTableQueryRunner(rows);
        const migration = new ArchiveRetiredVwapShadowRows20260712000000();

        await migration.up(qr);
        const afterFirstRun = rows.map((row) => ({ ...row }));

        await expect(migration.up(qr)).resolves.not.toThrow();

        expect(rows).toEqual(afterFirstRun);
    });
});

describe('Migration ArchiveRetiredVwapShadowRows — down() row-level behavior (bounded restore)', () => {
    it('restores status=shadow and nulls archived_at for the seven archived rows', async () => {
        const rows = buildRealisticRowSet();
        const qr = makeFakeTableQueryRunner(rows);
        const migration = new ArchiveRetiredVwapShadowRows20260712000000();

        await migration.up(qr);
        await migration.down(qr);

        for (const id of SEVEN_SHADOW_IDS) {
            const row = rows.find((candidate) => candidate.strategy_versions_id === id)!;
            expect(row.status).toBe('shadow');
            expect(row.archived_at).toBeNull();
        }
    });

    it('id=3 (active) and id=20 (xmom) are provably not modified by up() even with adjacent rows present', async () => {
        const rows = buildRealisticRowSet();
        const qr = makeFakeTableQueryRunner(rows);
        const migration = new ArchiveRetiredVwapShadowRows20260712000000();
        const beforeUp = rows.map((row) => ({ ...row }));

        await migration.up(qr);

        const activeVwapBefore = beforeUp.find((row) => row.strategy_versions_id === 3)!;
        const activeVwapAfter = rows.find((row) => row.strategy_versions_id === 3)!;
        const xmomBefore = beforeUp.find((row) => row.strategy_versions_id === 20)!;
        const xmomAfter = rows.find((row) => row.strategy_versions_id === 20)!;

        expect(activeVwapAfter).toEqual(activeVwapBefore);
        expect(xmomAfter).toEqual(xmomBefore);
    });
});

// ─── ADVERSARIAL (fixed) — down() blast radius is bounded to the exact id set ──────────────────
//
// down() is now scoped by the explicit id list (id = ANY($1)), so it can only ever revert the seven
// rows this migration is defined to touch. An out-of-band archived volatility-vwap row is left alone.

describe('Migration ArchiveRetiredVwapShadowRows — ADVERSARIAL: down() blast radius is bounded to the seven ids', () => {
    it('does NOT restore a pre-existing archived volatility-vwap row (id=99) that up() never touched', async () => {
        const rows = buildRealisticRowSet();
        // Fabricate an EIGHTH volatility-vwap row that was ALREADY status='archived' before this
        // migration's up() ever ran (e.g. archived by a prior, unrelated cleanup). Its archived_at is
        // an old, pre-existing timestamp — nothing this migration stamped. Its id (99) is NOT in the
        // migration's bounded id list.
        const preExistingArchivedAt = new Date('2026-01-01T00:00:00Z');
        rows.push({ strategy_versions_id: 99, name: 'volatility-vwap', status: 'archived', archived_at: preExistingArchivedAt });

        const qr = makeFakeTableQueryRunner(rows);
        const migration = new ArchiveRetiredVwapShadowRows20260712000000();

        // up() only touches the seven ids while status='shadow' — id=99 is out of scope AND already
        // 'archived', so up() is a correct no-op on it.
        await migration.up(qr);
        const preExistingRow = rows.find((row) => row.strategy_versions_id === 99)!;
        expect(preExistingRow.status).toBe('archived');
        expect(preExistingRow.archived_at).toEqual(preExistingArchivedAt);

        // down() is scoped to id = ANY([1,2,4,15,16,17,19]) — id=99 falls outside that set, so it is
        // NOT matched and NOT revived. down() is the exact inverse of up() even when an out-of-band
        // archived volatility-vwap row exists at revert time.
        await migration.down(qr);

        const afterDown = rows.find((row) => row.strategy_versions_id === 99)!;
        expect(afterDown.status).toBe('archived');
        expect(afterDown.archived_at).toEqual(preExistingArchivedAt);
    });
});
