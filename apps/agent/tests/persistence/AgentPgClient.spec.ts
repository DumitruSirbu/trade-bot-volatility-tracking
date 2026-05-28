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
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_PASSWORD: 'CHANGE_ME_BEFORE_PROD' }))
            .toThrow(AgentPgConfigError);
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_PASSWORD: 'CHANGE_ME_BEFORE_PROD' }))
            .toThrow(/AGENT_DB_PASSWORD/);
    });

    it('refuses a role that is not agent_writer', () => {
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_USER: 'postgres' }))
            .toThrow(/AGENT_DB_USER/);
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_USER: 'mcp_reader' }))
            .toThrow(/agent_writer/);
    });

    it('refuses a missing host', () => {
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_HOST: '' }))
            .toThrow(/AGENT_DB_HOST/);
    });

    it('refuses a missing database name', () => {
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_NAME: '' }))
            .toThrow(/AGENT_DB_NAME/);
    });

    it('refuses an out-of-range port', () => {
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_PORT: '70000' }))
            .toThrow(/AGENT_DB_PORT/);
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_PORT: 'not-a-port' }))
            .toThrow(/AGENT_DB_PORT/);
    });

    it('refuses insecure SSL modes', () => {
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_SSL: 'require' }))
            .toThrow(/AGENT_DB_SSL/);
        expect(() => new AgentPgClient({ ...BASE_ENV, AGENT_DB_SSL: 'true' }))
            .toThrow(/verify-full/);
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
