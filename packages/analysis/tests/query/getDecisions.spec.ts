// M12 W1 — getDecisions unit tests.
//
// Stub DataSource returns fixture rows so we cover the 10_000-row hard cap,
// snapshot opt-in projection, mapping into IDecisionView, and SQL-injection
// rejection via charset validation. Live-PG integration is W5.

import { AnalysisValidationError, getDecisions } from '../../src/index';

type QueryHandler = (sql: string, bindings: readonly unknown[]) => Promise<unknown[]>;

function fixtureRow(idx: number, snapshot: unknown = null): Record<string, unknown> {
    return {
        decisions_id: String(idx),
        symbol: 'BTCUSDT',
        ts: new Date('2026-01-15T12:00:00Z'),
        event_id: `evt-${idx}`,
        signal_type: 'inflow',
        action: 'long',
        reason: 'fixture',
        strategy_version_id: '3',
        position_id: null,
        market_snapshot: snapshot,
    };
}

describe('getDecisions', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-01T00:00:00Z');

    it('maps decision rows and omits snapshots by default', async () => {
        const rows = [fixtureRow(1, { signalScore: '0.75' })];
        const ds = { query: (async () => rows) as QueryHandler };

        const result = await getDecisions(ds as never, { symbol: 'BTCUSDT', from, to });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].id).toBe('1');
        expect(result.items[0].eventId).toBe('evt-1');
        expect(result.snapshots).toBeNull();
    });

    it('projects market_snapshot when includeSnapshot=true', async () => {
        const snap = { signalScore: '0.42', custom: 'payload' };
        const rows = [fixtureRow(7, snap)];
        let capturedSql = '';
        const ds = {
            query: (async (sql: string) => {
                capturedSql = sql;

                return rows;
            }) as QueryHandler,
        };

        const result = await getDecisions(ds as never, { symbol: 'BTCUSDT', from, to, includeSnapshot: true });

        expect(capturedSql).toContain('d.market_snapshot');
        expect(result.snapshots).toEqual({ '7': snap });
        expect(result.items[0].signalScore).toBe('0.42');
    });

    it('throws AnalysisValidationError when the row cap is exceeded (ADR 0034 §2.4 — pagination mandatory)', async () => {
        // Return cap+1 to trigger the rejection branch without allocating
        // tens of thousands of rich objects: 10_001 minimal rows is enough.
        const rows = Array.from({ length: 10_001 }, (_, idx) => fixtureRow(idx));
        const ds = { query: (async () => rows) as QueryHandler };

        await expect(getDecisions(ds as never, { symbol: 'BTCUSDT', from, to })).rejects.toBeInstanceOf(AnalysisValidationError);
        await expect(getDecisions(ds as never, { symbol: 'BTCUSDT', from, to })).rejects.toThrow(/narrow the window/);
    });

    it('requests fetchLimit = cap + 1 in the SQL bindings', async () => {
        let capturedBindings: readonly unknown[] = [];
        const ds = {
            query: (async (_sql: string, bindings: readonly unknown[]) => {
                capturedBindings = bindings;

                return [];
            }) as QueryHandler,
        };

        await getDecisions(ds as never, { symbol: 'BTCUSDT', from, to });

        expect(capturedBindings).toEqual(['BTCUSDT', from.toISOString(), to.toISOString(), 10_001]);
    });

    it('rejects symbols outside the alphanumeric-uppercase charset', async () => {
        const ds = { query: (async () => []) as QueryHandler };

        await expect(getDecisions(ds as never, { symbol: "BTC' OR 1=1--", from, to })).rejects.toBeInstanceOf(AnalysisValidationError);
        await expect(getDecisions(ds as never, { symbol: '', from, to })).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('accepts CCXT-format symbols (engine storage form) and legacy plain form', async () => {
        // why: post-M12 live-smoke fix — the engine stores symbols as
        // `BASE/QUOTE:SETTLEMENT`. Both shapes now pass the guard; the `/`
        // and `:` characters are safe under positional bindings.
        const ds = { query: (async () => []) as QueryHandler };

        await expect(getDecisions(ds as never, { symbol: 'TST/USDT:USDT', from, to })).resolves.toBeDefined();
        await expect(getDecisions(ds as never, { symbol: 'BTC/USDT:USDT', from, to })).resolves.toBeDefined();
        await expect(getDecisions(ds as never, { symbol: 'BTCUSDT', from, to })).resolves.toBeDefined();
        await expect(getDecisions(ds as never, { symbol: 'btc/usdt:usdt', from, to })).rejects.toBeInstanceOf(AnalysisValidationError);
        await expect(getDecisions(ds as never, { symbol: 'BTC/', from, to })).rejects.toBeInstanceOf(AnalysisValidationError);
        await expect(getDecisions(ds as never, { symbol: '/USDT:USDT', from, to })).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('rejects reversed range', async () => {
        const ds = { query: (async () => []) as QueryHandler };

        await expect(getDecisions(ds as never, { symbol: 'BTCUSDT', from: to, to: from })).rejects.toBeInstanceOf(AnalysisValidationError);
    });
});
