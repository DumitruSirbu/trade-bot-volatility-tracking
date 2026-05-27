// M12 W1 — DataSourceFactory unit tests.
//
// Pure config-validation tests. The actual TypeORM `DataSource` constructor
// is exercised only indirectly via `buildMcpDataSourceOptions` so we never
// open a real Postgres connection in unit-test scope. An integration spec
// against the live `mcp_reader` role lives in the QA wave (W5).

import { buildMcpDataSourceOptions, McpDataSourceConfigError, createMcpDataSource } from '../../src/db/DataSourceFactory';

describe('buildMcpDataSourceOptions', () => {
    const baseEnv = {
        MCP_DB_HOST: 'localhost',
        MCP_DB_PORT: '5432',
        MCP_DB_NAME: 'trade_bot_dev',
        MCP_DB_PASSWORD: 'secret',
    };

    it('builds a postgres DataSource config from required env vars', () => {
        const options = buildMcpDataSourceOptions(baseEnv) as {
            type: string;
            host: string;
            port: number;
            database: string;
            username: string;
            extra: Record<string, unknown>;
            synchronize: boolean;
        };

        expect(options.type).toBe('postgres');
        expect(options.host).toBe('localhost');
        expect(options.port).toBe(5432);
        expect(options.database).toBe('trade_bot_dev');
        expect(options.username).toBe('mcp_reader');
        expect(options.synchronize).toBe(false);
        expect(options.extra.application_name).toBe('mcp_reader');
        expect(options.extra.max).toBe(3);
        expect(options.extra.min).toBe(0);
        expect(options.extra.idleTimeoutMillis).toBe(30_000);
    });

    it('honors MCP_DB_USER override when supplied', () => {
        const options = buildMcpDataSourceOptions({ ...baseEnv, MCP_DB_USER: 'mcp_reader_dev' }) as { username: string };

        expect(options.username).toBe('mcp_reader_dev');
    });

    it('defaults to port 5432 when MCP_DB_PORT is absent', () => {
        const { MCP_DB_PORT: _omit, ...env } = baseEnv;
        const options = buildMcpDataSourceOptions(env) as { port: number };

        expect(options.port).toBe(5432);
    });

    it('throws McpDataSourceConfigError when MCP_DB_HOST is missing', () => {
        const { MCP_DB_HOST: _omit, ...env } = baseEnv;

        expect(() => buildMcpDataSourceOptions(env)).toThrow(McpDataSourceConfigError);
    });

    it('throws when MCP_DB_PASSWORD is missing', () => {
        const { MCP_DB_PASSWORD: _omit, ...env } = baseEnv;

        expect(() => buildMcpDataSourceOptions(env)).toThrow(McpDataSourceConfigError);
    });

    it('refuses to initialise when MCP_DB_PASSWORD is still the migration sentinel', () => {
        // why: the role-creation migration ships a publicly-known sentinel
        // password (`mcp_reader_change_me_at_deploy`). Operators must rotate
        // the role password before pointing MCP at the database — see
        // docs/runbooks/mcp-deployment.md. Booting against the sentinel is a
        // hard configuration failure, not a warning.
        expect(() => buildMcpDataSourceOptions({ ...baseEnv, MCP_DB_PASSWORD: 'mcp_reader_change_me_at_deploy' })).toThrow(McpDataSourceConfigError);

        try {
            buildMcpDataSourceOptions({ ...baseEnv, MCP_DB_PASSWORD: 'mcp_reader_change_me_at_deploy' });
        } catch (err) {
            expect(err).toBeInstanceOf(McpDataSourceConfigError);
            expect((err as McpDataSourceConfigError).missingEnvVar).toBe('MCP_DB_PASSWORD');
            expect((err as Error).message).toContain('sentinel');
            expect((err as Error).message).toContain('docs/runbooks/mcp-deployment.md');
        }
    });

    it('throws when MCP_DB_PORT is not a valid TCP port', () => {
        expect(() => buildMcpDataSourceOptions({ ...baseEnv, MCP_DB_PORT: 'abc' })).toThrow(McpDataSourceConfigError);
        expect(() => buildMcpDataSourceOptions({ ...baseEnv, MCP_DB_PORT: '0' })).toThrow(McpDataSourceConfigError);
        expect(() => buildMcpDataSourceOptions({ ...baseEnv, MCP_DB_PORT: '99999' })).toThrow(McpDataSourceConfigError);
    });

    // M12 W6 R3 #1 — strict SSL parsing. Reject any non-empty truthy value
    // that doesn't name a verifying mode (no more silent
    // `rejectUnauthorized: false` for `MCP_DB_SSL=true|require|1`).
    it('disables SSL when MCP_DB_SSL is unset', () => {
        expect((buildMcpDataSourceOptions(baseEnv) as { ssl: boolean | object }).ssl).toBe(false);
    });

    it('disables SSL when MCP_DB_SSL names an off-like mode', () => {
        for (const val of ['', 'false', 'disable', 'off', '0']) {
            const options = buildMcpDataSourceOptions({ ...baseEnv, MCP_DB_SSL: val }) as { ssl: boolean | object };
            expect(options.ssl).toBe(false);
        }
    });

    it('enables verifying TLS for verify-full / verify-ca', () => {
        for (const mode of ['verify-full', 'verify-ca', 'VERIFY-FULL', 'Verify-Ca']) {
            const options = buildMcpDataSourceOptions({ ...baseEnv, MCP_DB_SSL: mode }) as { ssl: { rejectUnauthorized: boolean } };
            expect(options.ssl).toEqual({ rejectUnauthorized: true });
        }
    });

    it('throws McpDataSourceConfigError for insecure / ambiguous TLS modes (true, 1, require)', () => {
        for (const val of ['true', '1', 'require', 'TRUE', 'allow', 'prefer']) {
            expect(() => buildMcpDataSourceOptions({ ...baseEnv, MCP_DB_SSL: val })).toThrow(McpDataSourceConfigError);
        }

        try {
            buildMcpDataSourceOptions({ ...baseEnv, MCP_DB_SSL: 'require' });
        } catch (err) {
            expect(err).toBeInstanceOf(McpDataSourceConfigError);
            expect((err as McpDataSourceConfigError).missingEnvVar).toBe('MCP_DB_SSL');
            expect((err as Error).message).toContain('explicit verification mode required');
            expect((err as Error).message).toContain('verify-full');
        }
    });
});

describe('createMcpDataSource', () => {
    it('throws when process.env lacks required vars', () => {
        const previous = { ...process.env };

        delete process.env.MCP_DB_HOST;
        delete process.env.MCP_DB_NAME;
        delete process.env.MCP_DB_PASSWORD;

        try {
            expect(() => createMcpDataSource()).toThrow(McpDataSourceConfigError);
        } finally {
            process.env = previous;
        }
    });
});
