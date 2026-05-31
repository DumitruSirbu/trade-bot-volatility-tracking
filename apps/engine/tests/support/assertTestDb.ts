import { Client } from 'pg';

const REQUIRED_PORT = 6900;

/**
 * Asserts that TEST_DATABASE_URL is set, points to port 6900, does not
 * equal DATABASE_URL, and that the test DB is reachable. Throws on any
 * violation so globalSetup aborts before a single DELETE or migration runs.
 */
export async function assertTestDb(): Promise<void> {
    const testUrl = process.env['TEST_DATABASE_URL'];
    const soakUrl = process.env['DATABASE_URL'];

    if (!testUrl) {
        throw new Error(
            'TEST_DATABASE_URL is not set. Run: cp .env.test.example .env.test ' +
                'and start the test DB: docker compose --profile test up -d --wait postgres-test',
        );
    }

    const parsed = parseDbUrl(testUrl);

    if (parsed.port !== REQUIRED_PORT) {
        throw new Error(
            `TEST_DATABASE_URL port must be ${REQUIRED_PORT}, got ${parsed.port}. ` +
                'Refusing to run — this DSN may point at the protected soak DB.',
        );
    }

    if (soakUrl && testUrl === soakUrl) {
        throw new Error(
            'TEST_DATABASE_URL must not equal DATABASE_URL. ' +
                'The test suite must never run against the soak database.',
        );
    }

    await verifyReachable(testUrl);
}

/**
 * Rewrites only the user and password in TEST_DATABASE_URL, keeping host,
 * port, and database name. Use for role-specific connections in integration specs.
 */
export function buildRoleDbUrl(role: string, password: string): string {
    const base = process.env['TEST_DATABASE_URL'];
    if (!base) {
        throw new Error('TEST_DATABASE_URL is not set — cannot build role DB URL.');
    }
    const url = parsePostgresUrl(base);
    url.username = role;
    url.password = password;
    return url.toString();
}

export function getTestDbUrl(): string {
    const url = process.env['TEST_DATABASE_URL'];
    if (!url) {
        throw new Error('TEST_DATABASE_URL is not set.');
    }
    return url;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function parseDbUrl(rawUrl: string): { port: number } {
    // Normalise postgresql:// → postgres:// so the URL API accepts it
    const normalised = rawUrl.replace(/^postgresql:\/\//, 'postgres://');
    const parsed = new URL(normalised);
    // URL.port is '' when the scheme default (5432) is omitted
    const port = parsed.port === '' ? 5432 : parseInt(parsed.port, 10);
    return { port };
}

function parsePostgresUrl(rawUrl: string): URL {
    return new URL(rawUrl.replace(/^postgresql:\/\//, 'postgres://'));
}

async function verifyReachable(url: string): Promise<void> {
    const client = new Client({ connectionString: url });
    try {
        await client.connect();
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
            `Test DB is not reachable at TEST_DATABASE_URL. Start it with: ` +
                `docker compose --profile test up -d --wait postgres-test\n` +
                `Original error: ${msg}`,
        );
    } finally {
        await client.end().catch(() => undefined);
    }
}
