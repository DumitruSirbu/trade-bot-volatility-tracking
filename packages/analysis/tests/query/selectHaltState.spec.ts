// M13 W1.C — selectHaltState unit tests.
//
// Stub DataSource returns fixture rows so we cover happy mapping (halted +
// not-halted), the empty-table fallback, ISO-string `date` column rendering,
// and Zod row-shape rejection. Real-PG integration sits alongside the other
// `mcp_reader` permission specs in `apps/mcp/tests`.

import { selectHaltState } from '../../src/index';

type QueryHandler = (sql: string, bindings?: readonly unknown[]) => Promise<unknown[]>;

describe('selectHaltState', () => {
    it('maps the most-recent row into IHaltStateView when halted', async () => {
        const handler: QueryHandler = async () => [
            {
                is_halted: true,
                halt_reason: 'daily_loss_breach',
                date: new Date('2026-05-26T00:00:00.000Z'),
            },
        ];
        const ds = { query: handler };

        const view = await selectHaltState(ds as never);

        expect(view).toEqual({
            isHalted: true,
            haltReason: 'daily_loss_breach',
            asOf: '2026-05-26T00:00:00.000Z',
        });
    });

    it('maps a not-halted row with null halt_reason', async () => {
        const handler: QueryHandler = async () => [
            {
                is_halted: false,
                halt_reason: null,
                date: new Date('2026-05-25T00:00:00.000Z'),
            },
        ];
        const ds = { query: handler };

        const view = await selectHaltState(ds as never);

        expect(view.isHalted).toBe(false);
        expect(view.haltReason).toBeNull();
        expect(view.asOf).toBe('2026-05-25T00:00:00.000Z');
    });

    it('accepts ISO-string `date` columns from string-coercing drivers', async () => {
        const handler: QueryHandler = async () => [
            {
                is_halted: false,
                halt_reason: null,
                date: '2026-05-24',
            },
        ];
        const ds = { query: handler };

        const view = await selectHaltState(ds as never);

        expect(view.asOf).toBe('2026-05-24T00:00:00.000Z');
    });

    it('fails closed (isHalted=true, NO_RISK_STATE_ROW) when the table is empty', async () => {
        // M13 W6 fix wave 4 (#3): a missing risk_state row means no
        // authoritative safety baseline; the agent must SKIP rather than
        // draft against an unknown state. Trade-safety invariant.
        const handler: QueryHandler = async () => [];
        const ds = { query: handler };

        const before = Date.now();
        const view = await selectHaltState(ds as never);
        const after = Date.now();

        expect(view.isHalted).toBe(true);
        expect(view.haltReason).toBe('NO_RISK_STATE_ROW');
        const asOfMs = Date.parse(view.asOf);
        expect(asOfMs).toBeGreaterThanOrEqual(before);
        expect(asOfMs).toBeLessThanOrEqual(after);
    });

    it('rejects rows whose shape drifts from the expected schema', async () => {
        const handler: QueryHandler = async () => [
            {
                // missing `is_halted`; `halt_reason` is the wrong type.
                halt_reason: 42,
                date: new Date('2026-05-26T00:00:00.000Z'),
            },
        ];
        const ds = { query: handler };

        await expect(selectHaltState(ds as never)).rejects.toThrow();
    });
});
