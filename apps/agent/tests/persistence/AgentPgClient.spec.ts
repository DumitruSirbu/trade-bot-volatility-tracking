// M13 W3 — AgentPgClient sentinel-password + env-var validation tests.
//
// No real PG connection: the constructor builds a pg.Pool but does not
// open a connection until first query, so we can exercise the config
// path in pure isolation and assert close() drains the pool cleanly.

import { AgentPgClient, AgentPgConfigError, buildAgentPoolConfig } from '../../src/persistence/AgentPgClient.js';

const BASE_ENV = {
    AGENT_DB_HOST: 'localhost',
    AGENT_DB_PORT: '5432',
    AGENT_DB_NAME: 'bot',
    AGENT_DB_USER: 'agent_writer',
    AGENT_DB_PASSWORD: 'real_secret_value',
};

describe('AgentPgClient — config validation', () => {
    it('refuses the sentinel password baked into the migration', () => {
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_PASSWORD: 'CHANGE_ME_BEFORE_PROD' })).toThrow(AgentPgConfigError);
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_PASSWORD: 'CHANGE_ME_BEFORE_PROD' })).toThrow(/AGENT_DB_PASSWORD/);
    });

    it('refuses a role that is not agent_writer', () => {
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_USER: 'postgres' })).toThrow(/AGENT_DB_USER/);
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_USER: 'mcp_reader' })).toThrow(/agent_writer/);
    });

    it('refuses a missing host', () => {
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_HOST: '' })).toThrow(/AGENT_DB_HOST/);
    });

    it('refuses a missing database name', () => {
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_NAME: '' })).toThrow(/AGENT_DB_NAME/);
    });

    it('refuses an out-of-range port', () => {
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_PORT: '70000' })).toThrow(/AGENT_DB_PORT/);
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_PORT: 'not-a-port' })).toThrow(/AGENT_DB_PORT/);
    });

    it('refuses insecure SSL modes', () => {
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_SSL: 'require' })).toThrow(/AGENT_DB_SSL/);
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_SSL: 'true' })).toThrow(/verify-full/);
    });

    it('accepts verifying SSL modes', () => {
        const cfg = buildAgentPoolConfig({ ...BASE_ENV, AGENT_DB_SSL: 'verify-full' });
        expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
    });

    it('defaults the user to agent_writer when AGENT_DB_USER is empty', () => {
        const cfg = buildAgentPoolConfig({ ...BASE_ENV, AGENT_DB_USER: '' });
        expect(cfg.user).toBe('agent_writer');
    });

    it('sizes the pool to max=2 min=0 with application_name=agent_writer', () => {
        const cfg = buildAgentPoolConfig(BASE_ENV);
        expect(cfg.max).toBe(2);
        expect(cfg.min).toBe(0);
        expect(cfg.application_name).toBe('agent_writer');
    });
});

describe('AgentPgClient — query() runs in an explicit read-write transaction', () => {
    // The agent_writer role default is `default_transaction_read_only = on`.
    // query() MUST open a transaction and issue `SET TRANSACTION READ WRITE`
    // as the FIRST statement so the SECURITY DEFINER write functions can run;
    // otherwise the SDF body's `SET LOCAL transaction_read_only = off` is
    // rejected with SQLSTATE 25006. This test stubs the pooled client so it
    // runs without a real Postgres and asserts the statement ordering.
    type FakeClient = {
        query: jest.Mock;
        release: jest.Mock;
    };

    function buildClientWithFakePool(rows: unknown[]): { client: AgentPgClient; fakeClient: FakeClient } {
        const fakeClient: FakeClient = {
            query: jest.fn().mockImplementation((sql: string) => {
                // Only the parameterised SDF call returns rows; control
                // statements (BEGIN / SET / COMMIT / ROLLBACK) return nothing.
                if (sql.includes('record_agent_run_history') || sql.includes('draft_strategy_version')) {
                    return Promise.resolve({ rows });
                }
                return Promise.resolve({ rows: [] });
            }),
            release: jest.fn(),
        };

        const client = new AgentPgClient(BASE_ENV);
        // Replace the internal pool with a stub exposing connect().
        (client as unknown as { pool: { connect: () => Promise<FakeClient> } }).pool = {
            connect: () => Promise.resolve(fakeClient),
        };

        return { client, fakeClient };
    }

    it('issues BEGIN then SET TRANSACTION READ WRITE before the statement, then COMMIT', async () => {
        const { client, fakeClient } = buildClientWithFakePool([{ agent_run_id: '7' }]);

        const rows = await client.query('SELECT record_agent_run_history($1) AS agent_run_id', ['2099-W01']);

        const calledSql = fakeClient.query.mock.calls.map(([sql]: [string]) => sql);
        expect(calledSql[0]).toBe('BEGIN');
        expect(calledSql[1]).toBe('SET TRANSACTION READ WRITE');
        expect(calledSql[2]).toContain('record_agent_run_history');
        expect(calledSql[3]).toBe('COMMIT');
        expect(fakeClient.release).toHaveBeenCalledTimes(1);
        expect(rows).toEqual([{ agent_run_id: '7' }]);
    });

    it('rolls back and releases the client when the statement throws', async () => {
        const { client, fakeClient } = buildClientWithFakePool([]);
        fakeClient.query.mockImplementation((sql: string) => {
            if (sql.includes('draft_strategy_version')) {
                return Promise.reject(new Error('boom'));
            }
            return Promise.resolve({ rows: [] });
        });

        await expect(client.query('SELECT draft_strategy_version($1)', ['x'])).rejects.toThrow('boom');

        const calledSql = fakeClient.query.mock.calls.map(([sql]: [string]) => sql);
        expect(calledSql).toContain('ROLLBACK');
        expect(calledSql).not.toContain('COMMIT');
        expect(fakeClient.release).toHaveBeenCalledTimes(1);
    });
});

describe('AgentPgClient — close()', () => {
    it('drains the pool without throwing on a fresh client', async () => {
        const client = new AgentPgClient(BASE_ENV);
        await expect(client.close()).resolves.toBeUndefined();
    });

    it('refuses a second close() because pg.Pool.end is one-shot', async () => {
        const client = new AgentPgClient(BASE_ENV);
        await client.close();
        await expect(client.close()).rejects.toBeDefined();
    });
});
