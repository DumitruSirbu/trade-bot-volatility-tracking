import { Client } from 'pg';

jest.mock('pg');

const MockedClient = Client as jest.MockedClass<typeof Client>;

const VALID_TEST_URL = 'postgres://testuser:testpass@localhost:6900/trade_bot_test';
const SOAK_URL = 'postgres://bot:secret@localhost:5432/trade_bot';

describe('assertTestDb', () => {
    let originalTestUrl: string | undefined;
    let originalSoakUrl: string | undefined;

    beforeEach(() => {
        originalTestUrl = process.env['TEST_DATABASE_URL'];
        originalSoakUrl = process.env['DATABASE_URL'];

        MockedClient.mockClear();
        MockedClient.prototype.connect = jest.fn().mockResolvedValue(undefined);
        MockedClient.prototype.end = jest.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
        if (originalTestUrl === undefined) {
            delete process.env['TEST_DATABASE_URL'];
        } else {
            process.env['TEST_DATABASE_URL'] = originalTestUrl;
        }

        if (originalSoakUrl === undefined) {
            delete process.env['DATABASE_URL'];
        } else {
            process.env['DATABASE_URL'] = originalSoakUrl;
        }
    });

    // We re-import assertTestDb after each env mutation so the module
    // reads the up-to-date process.env at call time (it does not cache env).
    function loadAssertTestDb() {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('./assertTestDb') as typeof import('./assertTestDb');
    }

    describe('assertTestDb()', () => {
        it('throws with setup-instructions message when TEST_DATABASE_URL is unset', async () => {
            delete process.env['TEST_DATABASE_URL'];
            delete process.env['DATABASE_URL'];

            const { assertTestDb } = loadAssertTestDb();

            await expect(assertTestDb()).rejects.toThrow(/cp .env\.test\.example/);
        });

        it('throws when the port is 5433 (soak DB port)', async () => {
            process.env['TEST_DATABASE_URL'] = 'postgres://testuser:testpass@localhost:5433/trade_bot_test';
            delete process.env['DATABASE_URL'];

            const { assertTestDb } = loadAssertTestDb();

            await expect(assertTestDb()).rejects.toThrow(/port must be 6900, got 5433/);
        });

        it('throws when the port is omitted because the URL API returns empty string which resolves to 5432', async () => {
            process.env['TEST_DATABASE_URL'] = 'postgres://testuser:testpass@localhost/trade_bot_test';
            delete process.env['DATABASE_URL'];

            const { assertTestDb } = loadAssertTestDb();

            await expect(assertTestDb()).rejects.toThrow(/port must be 6900, got 5432/);
        });

        it('throws when TEST_DATABASE_URL equals DATABASE_URL', async () => {
            // The port check fires before the equality check when SOAK_URL uses port 5432.
            // Use a 6900 URL for both to isolate the equality guard.
            const sharedUrl = 'postgres://testuser:testpass@localhost:6900/trade_bot';
            process.env['TEST_DATABASE_URL'] = sharedUrl;
            process.env['DATABASE_URL'] = sharedUrl;

            const { assertTestDb } = loadAssertTestDb();

            await expect(assertTestDb()).rejects.toThrow(/must not equal DATABASE_URL/);
        });

        it('passes without throwing for a valid port-6900 DSN when the pg Client connects successfully', async () => {
            process.env['TEST_DATABASE_URL'] = VALID_TEST_URL;
            delete process.env['DATABASE_URL'];

            const { assertTestDb } = loadAssertTestDb();

            await expect(assertTestDb()).resolves.toBeUndefined();
            expect(MockedClient.prototype.connect).toHaveBeenCalledTimes(1);
        });

        it('throws a reachability error when pg.Client.connect() rejects', async () => {
            process.env['TEST_DATABASE_URL'] = VALID_TEST_URL;
            delete process.env['DATABASE_URL'];

            MockedClient.prototype.connect = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

            const { assertTestDb } = loadAssertTestDb();

            await expect(assertTestDb()).rejects.toThrow(/Test DB is not reachable/);
            await expect(assertTestDb()).rejects.toThrow(/ECONNREFUSED/);
        });
    });

    describe('buildRoleDbUrl(role, password)', () => {
        it('returns a URL with the given role as username and given password keeping host/port/db', () => {
            process.env['TEST_DATABASE_URL'] = VALID_TEST_URL;

            const { buildRoleDbUrl } = loadAssertTestDb();

            const result = buildRoleDbUrl('migration_runner', 'migrationpass');
            const parsed = new URL(result);

            expect(parsed.username).toBe('migration_runner');
            expect(parsed.password).toBe('migrationpass');
            expect(parsed.hostname).toBe('localhost');
            expect(parsed.port).toBe('6900');
            expect(parsed.pathname).toBe('/trade_bot_test');
        });

        it('throws when TEST_DATABASE_URL is unset', () => {
            delete process.env['TEST_DATABASE_URL'];

            const { buildRoleDbUrl } = loadAssertTestDb();

            expect(() => buildRoleDbUrl('any_role', 'any_pass')).toThrow(/TEST_DATABASE_URL is not set/);
        });
    });

    describe('getTestDbUrl()', () => {
        it('returns TEST_DATABASE_URL when set', () => {
            process.env['TEST_DATABASE_URL'] = VALID_TEST_URL;

            const { getTestDbUrl } = loadAssertTestDb();

            expect(getTestDbUrl()).toBe(VALID_TEST_URL);
        });

        it('throws when TEST_DATABASE_URL is unset', () => {
            delete process.env['TEST_DATABASE_URL'];

            const { getTestDbUrl } = loadAssertTestDb();

            expect(() => getTestDbUrl()).toThrow(/TEST_DATABASE_URL is not set/);
        });
    });
});
