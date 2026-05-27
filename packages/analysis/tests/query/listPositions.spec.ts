// M12 W1 — listPositions unit tests.
//
// Stub DataSource returns fixture rows so we cover row-mapping, cursor
// encoding, filter composition, and validation. Real-PG integration is W5.

import { AnalysisValidationError, listPositions, decodeCursor } from '../../src/index';

type QueryHandler = (sql: string, bindings: readonly unknown[]) => Promise<unknown[]>;

function fixtureRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        positions_id: '101',
        symbol: 'BTCUSDT',
        side: 'long',
        state: 'closed',
        entry_price: '50000',
        exit_price: '51000',
        qty: '0.1',
        leverage: '5',
        realized_pnl: '100',
        opened_at: new Date('2026-01-15T12:00:00Z'),
        closed_at: new Date('2026-01-15T13:00:00Z'),
        exit_reason: 'take_profit',
        strategy_version_id: '3',
        protective_order_type: 'local',
        stop_loss_price: '49000',
        take_profit_price: '51500',
        position_slot: 'A',
        d_open_event_id: 'evt-101',
        ...overrides,
    };
}

describe('listPositions', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-01T00:00:00Z');

    it('maps closed rows into IClosedPositionView and emits no cursor when page is short', async () => {
        const handler: QueryHandler = async () => [fixtureRow()];
        const ds = { query: handler };

        const page = await listPositions(ds as never, { from, to });

        expect(page.items).toHaveLength(1);
        expect(page.items[0].id).toBe('101');
        expect(page.items[0].symbol).toBe('BTCUSDT');
        expect(page.nextCursor).toBeNull();
        expect(page.pageSize).toBe(1);
    });

    it('emits an encodable nextCursor when limit+1 rows are returned', async () => {
        const rows = Array.from({ length: 3 }, (_, idx) =>
            fixtureRow({
                positions_id: String(100 + idx),
                opened_at: new Date(`2026-01-${10 + idx}T12:00:00Z`),
            }),
        );
        const ds = { query: async () => rows };

        const page = await listPositions(ds as never, { from, to, limit: 2 });

        expect(page.items).toHaveLength(2);
        expect(page.nextCursor).not.toBeNull();
        expect(page.pageSize).toBe(2);

        const decoded = decodeCursor(page.nextCursor);

        expect(decoded).not.toBeNull();
        // Cursor ids round-trip as strings (pg BIGINT shape + UUID-future-safe).
        expect(decoded!.id).toBe('101');
    });

    it('composes WHERE clauses + bindings for symbol, versionId and status', async () => {
        let capturedSql = '';
        let capturedBindings: readonly unknown[] = [];

        const ds = {
            query: async (sql: string, bindings: readonly unknown[]) => {
                capturedSql = sql;
                capturedBindings = bindings;

                return [];
            },
        };

        await listPositions(ds as never, { from, to, symbol: 'BTCUSDT', versionId: 3, status: 'open', limit: 10 });

        expect(capturedSql).toContain('p.symbol =');
        expect(capturedSql).toContain('p.strategy_version_id =');
        // why: the state literal is now parameterised (PositionStateEnum.OPEN
        // = 'open') so the SQL contains `p.state = $N` and the bindings carry
        // the enum value — no inline magic string in the SQL anymore.
        expect(capturedSql).toContain('p.state = $');
        expect(capturedSql).not.toContain(`p.state = 'open'`);
        expect(capturedBindings).toEqual([from.toISOString(), to.toISOString(), 'BTCUSDT', 3, 'open', 11]);
    });

    it('maps open rows with the real event_id surfaced from the decisions LEFT JOIN', async () => {
        // why: pre-fix the open-row mapper synthesised `eventId: \`pos-${id}\``
        // which broke join-by-event_id downstream (e.g. dashboards looking up
        // the originating trigger). The fix wave 4b LEFT JOIN LATERAL surfaces
        // the earliest decision's event_id as the row's true trigger.
        const ds = {
            query: async () => [
                fixtureRow({
                    state: 'open',
                    closed_at: null,
                    exit_reason: null,
                    exit_price: null,
                    realized_pnl: null,
                    d_open_event_id: 'evt-trigger-42',
                }),
            ],
        };

        const page = await listPositions(ds as never, { from, to, status: 'open' });

        expect(page.items).toHaveLength(1);
        expect((page.items[0] as { eventId: string | null }).eventId).toBe('evt-trigger-42');
    });

    it('maps open rows with eventId=null when no joining decision row exists', async () => {
        // why: an adopted-via-reconciliation position can have zero decisions.
        // The shared `IOpenPositionView.eventId` is `string | null` so the
        // mapper must surface null rather than fabricate a synthetic id.
        const ds = {
            query: async () => [
                fixtureRow({
                    state: 'open',
                    closed_at: null,
                    exit_reason: null,
                    exit_price: null,
                    realized_pnl: null,
                    d_open_event_id: null,
                }),
            ],
        };

        const page = await listPositions(ds as never, { from, to, status: 'open' });

        expect((page.items[0] as { eventId: string | null }).eventId).toBeNull();
    });

    it('emits the LEFT JOIN LATERAL against decisions in the SQL', async () => {
        let capturedSql = '';
        const ds = {
            query: async (sql: string) => {
                capturedSql = sql;
                return [];
            },
        };

        await listPositions(ds as never, { from, to });

        expect(capturedSql).toContain('LEFT JOIN LATERAL');
        expect(capturedSql).toContain('FROM decisions');
        expect(capturedSql).toContain('d_open_event_id');
    });

    it('rejects symbols outside the alphanumeric-uppercase charset', async () => {
        const ds = { query: async () => [] };

        await expect(listPositions(ds as never, { from, to, symbol: "BTC'; DROP TABLE--" })).rejects.toBeInstanceOf(AnalysisValidationError);
        await expect(listPositions(ds as never, { from, to, symbol: 'btcusdt' })).rejects.toBeInstanceOf(AnalysisValidationError);
        await expect(listPositions(ds as never, { from, to, symbol: '' })).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('accepts CCXT-format symbols (engine storage form) and legacy plain form', async () => {
        // why: post-M12 live-smoke fix — the engine stores symbols in CCXT
        // notation (`BASE/QUOTE:SETTLEMENT`, e.g. `TST/USDT:USDT`). The
        // analysis SQL-injection guard accepts both forms; the `/` and `:`
        // characters are safe under parameterized binding.
        const ds = { query: async () => [] };

        await expect(listPositions(ds as never, { from, to, symbol: 'TST/USDT:USDT' })).resolves.toBeDefined();
        await expect(listPositions(ds as never, { from, to, symbol: 'BTC/USDT:USDT' })).resolves.toBeDefined();
        await expect(listPositions(ds as never, { from, to, symbol: 'BTCUSDT' })).resolves.toBeDefined();
        // Negative: malformed CCXT shapes still rejected.
        await expect(listPositions(ds as never, { from, to, symbol: 'btc/usdt:usdt' })).rejects.toBeInstanceOf(AnalysisValidationError);
        await expect(listPositions(ds as never, { from, to, symbol: 'BTC/' })).rejects.toBeInstanceOf(AnalysisValidationError);
        await expect(listPositions(ds as never, { from, to, symbol: '/USDT:USDT' })).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('round-trips a cursor with id > 2^53 without precision loss and binds as ::bigint text', async () => {
        // why: pg returns BIGINT as a string. Number()-casting a large id (e.g.
        // post-uuid-widening, or simply a BIGSERIAL above 2^53) would silently
        // corrupt it. The cursor must propagate the id as text and the SQL
        // must bind it as ::bigint (or wider) without conversion.
        const bigId = '9999999999999'; // 9_999_999_999_999 > 2^53? Actually 2^53 = 9_007_199_254_740_992
        // Use a value strictly > 2^53 for the precision-loss demonstration.
        const beyondSafeInt = '9007199254740993';
        const rows = [fixtureRow({ positions_id: beyondSafeInt }), fixtureRow({ positions_id: bigId })];
        let capturedBindings: readonly unknown[] = [];
        let capturedSql = '';
        const ds = {
            query: async (sql: string, bindings: readonly unknown[]) => {
                capturedSql = sql;
                capturedBindings = bindings;
                return rows;
            },
        };

        const page = await listPositions(ds as never, { from, to, limit: 1 });

        // hasNext (returned 2, limit 1) → nextCursor is encoded with the id as string.
        expect(page.nextCursor).not.toBeNull();
        const decoded = decodeCursor(page.nextCursor);
        expect(decoded).not.toBeNull();
        expect(typeof decoded!.id).toBe('string');
        expect(decoded!.id).toBe(beyondSafeInt);

        // Replay the cursor: it must bind as text, the SQL casts as ::bigint.
        await listPositions(ds as never, { from, to, limit: 1, cursor: page.nextCursor! });

        expect(capturedSql).toContain('::bigint');
        expect(capturedSql).not.toMatch(/::int\b/u);
        // The id binding should be the unmodified string, never Number()-coerced.
        expect(capturedBindings).toContain(beyondSafeInt);
    });

    it('binds the issued cursor to its filter set — rejects when filters change mid-pagination', async () => {
        // why: cursor anchors on (opened_at, positions_id) only. If the caller
        // changes symbol/versionId/status between pages, the anchor still
        // applies and returns an inconsistent slice. The fingerprint we bake
        // into the cursor catches this up-front.
        const rows = Array.from({ length: 3 }, (_, idx) =>
            fixtureRow({
                positions_id: String(100 + idx),
                opened_at: new Date(`2026-01-${10 + idx}T12:00:00Z`),
            }),
        );
        const ds = { query: async () => rows };

        const pageA = await listPositions(ds as never, { from, to, symbol: 'BTCUSDT', limit: 2 });

        expect(pageA.nextCursor).not.toBeNull();

        // Re-page with the SAME filters → must pass.
        await expect(listPositions(ds as never, { from, to, symbol: 'BTCUSDT', limit: 2, cursor: pageA.nextCursor! })).resolves.toBeDefined();

        // Re-page with a CHANGED filter (different symbol) → rejected.
        await expect(listPositions(ds as never, { from, to, symbol: 'ETHUSDT', limit: 2, cursor: pageA.nextCursor! })).rejects.toBeInstanceOf(
            AnalysisValidationError,
        );

        // Re-page with a CHANGED versionId → rejected.
        await expect(listPositions(ds as never, { from, to, symbol: 'BTCUSDT', versionId: 7, limit: 2, cursor: pageA.nextCursor! })).rejects.toBeInstanceOf(
            AnalysisValidationError,
        );

        // Re-page with a CHANGED status → rejected.
        await expect(listPositions(ds as never, { from, to, symbol: 'BTCUSDT', status: 'open', limit: 2, cursor: pageA.nextCursor! })).rejects.toBeInstanceOf(
            AnalysisValidationError,
        );
    });

    it('legacy cursors without a filter fingerprint are accepted (backward compat)', async () => {
        // why: a cursor minted before this fix carries no `filterHash`. We
        // forward-compat by accepting it — the next cursor we emit will carry
        // the hash, so subsequent pages are protected.
        const { encodeCursor } = await import('../../src/util/CursorCodec');
        const legacy = encodeCursor({ id: '101', createdAtMs: new Date('2026-01-15T12:00:00Z').getTime() });
        const ds = { query: async () => [fixtureRow()] };

        await expect(listPositions(ds as never, { from, to, symbol: 'BTCUSDT', limit: 5, cursor: legacy })).resolves.toBeDefined();
    });

    it('rejects limit > 200 and non-positive limit', async () => {
        const ds = { query: async () => [] };

        await expect(listPositions(ds as never, { from, to, limit: 201 })).rejects.toBeInstanceOf(AnalysisValidationError);
        await expect(listPositions(ds as never, { from, to, limit: 0 })).rejects.toBeInstanceOf(AnalysisValidationError);
        await expect(listPositions(ds as never, { from, to, limit: -1 })).rejects.toBeInstanceOf(AnalysisValidationError);
    });
});
