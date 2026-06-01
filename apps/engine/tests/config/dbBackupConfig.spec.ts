// M17 Wave 3 QA — config-validation tests for the DB backup env vars.
//
// Exercises validateEnv against good and bad values for DB_BACKUP_CRON,
// DB_BACKUP_RETENTION, DB_BACKUP_ENABLED, and DB_BACKUP_DIR. All cases use
// the fail-fast validateEnv path — no real DB, no real scheduler.

import { validateEnv } from '../../src/config/validateEnv';

// ─── baseline valid env ───────────────────────────────────────────────────────

const VALID_ENV: Record<string, unknown> = {
    NODE_ENV: 'development',
    ENGINE_PORT: '3000',
    LOG_LEVEL: 'log',
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_USER: 'bot',
    DB_PASSWORD: 'secret',
    DB_NAME: 'botdb',
    DATABASE_URL: 'postgresql://bot:secret@localhost:5432/botdb',
    ADMINER_PORT: '8080',
    EXCHANGE_ENV: 'testnet',
    EXCHANGE_TESTNET: 'true',
    MAX_OPEN_POSITIONS: '3',
    MAX_EXPOSURE_PER_COIN_USDT: '100',
    DAILY_LOSS_LIMIT_USDT: '50',
    COOLDOWN_AFTER_LOSS_MS: '900000',
    ACCOUNT_CAPITAL_USDT: '500',
    ACTIVE_STRATEGY_VERSION_ID: '1',
    // M17 backup vars — valid baseline
    DB_BACKUP_DIR: '/var/backups/trade-bot',
    DB_BACKUP_ENABLED: 'false',
    DB_BACKUP_CRON: '0 3 * * *',
    DB_BACKUP_RETENTION: '3',
};

function buildEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...VALID_ENV, ...overrides };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('validateEnv — M17 DB backup config', () => {
    // ── Valid configurations ──────────────────────────────────────────────────

    describe('valid backup configuration', () => {
        it('passes with the canonical default cron 0 3 * * * and retention 3', () => {
            expect(() => validateEnv(buildEnv())).not.toThrow();
        });

        it('passes with a different valid 5-field cron (every 30 min)', () => {
            expect(() => validateEnv(buildEnv({ DB_BACKUP_CRON: '*/30 * * * *' }))).not.toThrow();
        });

        it('passes with a different valid 5-field cron (midnight UTC)', () => {
            expect(() => validateEnv(buildEnv({ DB_BACKUP_CRON: '0 0 * * *' }))).not.toThrow();
        });

        it('passes with a different valid 5-field cron (weekdays only)', () => {
            expect(() => validateEnv(buildEnv({ DB_BACKUP_CRON: '0 3 * * 1-5' }))).not.toThrow();
        });

        it('coerces DB_BACKUP_RETENTION string "3" to integer 3', () => {
            const result = validateEnv(buildEnv({ DB_BACKUP_RETENTION: '3' }));
            expect(result.DB_BACKUP_RETENTION).toBe(3);
        });

        it('coerces DB_BACKUP_RETENTION string "7" to integer 7 (non-default)', () => {
            const result = validateEnv(buildEnv({ DB_BACKUP_RETENTION: '7' }));
            expect(result.DB_BACKUP_RETENTION).toBe(7);
        });

        it('accepts DB_BACKUP_RETENTION at lower boundary 1', () => {
            const result = validateEnv(buildEnv({ DB_BACKUP_RETENTION: '1' }));
            expect(result.DB_BACKUP_RETENTION).toBe(1);
        });

        it('coerces DB_BACKUP_ENABLED "true" string to boolean true', () => {
            const result = validateEnv(buildEnv({ DB_BACKUP_ENABLED: 'true' }));
            expect(result.DB_BACKUP_ENABLED).toBe(true);
        });

        it('coerces DB_BACKUP_ENABLED "false" string to boolean false', () => {
            const result = validateEnv(buildEnv({ DB_BACKUP_ENABLED: 'false' }));
            expect(result.DB_BACKUP_ENABLED).toBe(false);
        });

        it('defaults DB_BACKUP_ENABLED to false when the key is absent (safety-first)', () => {
            const env = buildEnv();
            delete env['DB_BACKUP_ENABLED'];
            const result = validateEnv(env);
            expect(result.DB_BACKUP_ENABLED).toBe(false);
        });

        it('defaults DB_BACKUP_ENABLED to false on a typo like "treu" (safety-first)', () => {
            const result = validateEnv(buildEnv({ DB_BACKUP_ENABLED: 'treu' }));
            expect(result.DB_BACKUP_ENABLED).toBe(false);
        });

        it('defaults DB_BACKUP_CRON to "0 3 * * *" when the key is absent', () => {
            const env = buildEnv();
            delete env['DB_BACKUP_CRON'];
            const result = validateEnv(env);
            expect(result.DB_BACKUP_CRON).toBe('0 3 * * *');
        });

        it('defaults DB_BACKUP_RETENTION to 3 when the key is absent', () => {
            const env = buildEnv();
            delete env['DB_BACKUP_RETENTION'];
            const result = validateEnv(env);
            expect(result.DB_BACKUP_RETENTION).toBe(3);
        });

        it('defaults DB_BACKUP_DIR to ./backups when the key is absent', () => {
            const env = buildEnv();
            delete env['DB_BACKUP_DIR'];
            const result = validateEnv(env);
            expect(result.DB_BACKUP_DIR).toBe('./backups');
        });

        it('accepts DB_BACKUP_DIR as any non-empty string', () => {
            expect(() => validateEnv(buildEnv({ DB_BACKUP_DIR: '/var/backups/trade-bot' }))).not.toThrow();
        });
    });

    // ── Invalid DB_BACKUP_CRON ────────────────────────────────────────────────

    describe('invalid DB_BACKUP_CRON rejects at validateEnv', () => {
        it('throws when DB_BACKUP_CRON is "@daily" (alias form, not 5-field)', () => {
            expect(() => validateEnv(buildEnv({ DB_BACKUP_CRON: '@daily' }))).toThrow(/DB_BACKUP_CRON/u);
        });

        it('throws when DB_BACKUP_CRON is "@weekly" (alias form, not 5-field)', () => {
            expect(() => validateEnv(buildEnv({ DB_BACKUP_CRON: '@weekly' }))).toThrow(/DB_BACKUP_CRON/u);
        });

        it('throws when DB_BACKUP_CRON is a 6-field expression with a seconds field', () => {
            // 6-field: seconds minutes hours day-of-month month day-of-week
            expect(() => validateEnv(buildEnv({ DB_BACKUP_CRON: '0 0 3 * * *' }))).toThrow(/DB_BACKUP_CRON/u);
        });

        it('throws when DB_BACKUP_CRON is a nonsense string "bad cron x"', () => {
            expect(() => validateEnv(buildEnv({ DB_BACKUP_CRON: 'bad cron x' }))).toThrow(/DB_BACKUP_CRON/u);
        });

        it('throws when DB_BACKUP_CRON is an empty string', () => {
            expect(() => validateEnv(buildEnv({ DB_BACKUP_CRON: '' }))).toThrow(/DB_BACKUP_CRON/u);
        });

        it('throws when DB_BACKUP_CRON is a 4-field cron (too few fields)', () => {
            expect(() => validateEnv(buildEnv({ DB_BACKUP_CRON: '0 3 * *' }))).toThrow(/DB_BACKUP_CRON/u);
        });

        it('throws when DB_BACKUP_CRON has an out-of-range minute field (99)', () => {
            expect(() => validateEnv(buildEnv({ DB_BACKUP_CRON: '99 3 * * *' }))).toThrow(/DB_BACKUP_CRON/u);
        });

        it('throws when DB_BACKUP_CRON has an out-of-range hour field (25)', () => {
            expect(() => validateEnv(buildEnv({ DB_BACKUP_CRON: '0 25 * * *' }))).toThrow(/DB_BACKUP_CRON/u);
        });
    });

    // ── Invalid DB_BACKUP_RETENTION ───────────────────────────────────────────

    describe('invalid DB_BACKUP_RETENTION rejects at validateEnv', () => {
        it('throws when DB_BACKUP_RETENTION is 0 (below the @Min(1) floor)', () => {
            expect(() => validateEnv(buildEnv({ DB_BACKUP_RETENTION: '0' }))).toThrow(/DB_BACKUP_RETENTION/u);
        });

        it('throws when DB_BACKUP_RETENTION is negative (-1)', () => {
            expect(() => validateEnv(buildEnv({ DB_BACKUP_RETENTION: '-1' }))).toThrow(/DB_BACKUP_RETENTION/u);
        });

        it('throws when DB_BACKUP_RETENTION is a non-numeric string', () => {
            expect(() => validateEnv(buildEnv({ DB_BACKUP_RETENTION: 'three' }))).toThrow(/DB_BACKUP_RETENTION/u);
        });

        it('accepts a float string "3.5" because parseInt truncates it to 3 (valid integer)', () => {
            // parseInt('3.5', 10) === 3, which passes @IsInt() and @Min(1).
            // The transform truncates; there is no contract to reject float strings here.
            const result = validateEnv(buildEnv({ DB_BACKUP_RETENTION: '3.5' }));
            expect(result.DB_BACKUP_RETENTION).toBe(3);
        });
    });

    // ── Invalid DB_BACKUP_DIR ─────────────────────────────────────────────────

    describe('invalid DB_BACKUP_DIR rejects at validateEnv', () => {
        it('throws when DB_BACKUP_DIR is an empty string', () => {
            expect(() => validateEnv(buildEnv({ DB_BACKUP_DIR: '' }))).toThrow(/DB_BACKUP_DIR/u);
        });
    });
});
