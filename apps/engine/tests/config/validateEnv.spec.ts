import { validateEnv } from '../../src/config/validateEnv';
import { NodeEnvEnum } from '../../src/config/enum/NodeEnvEnum';
import { LogLevelEnum } from '../../src/config/enum/LogLevelEnum';

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
    EXCHANGE_TESTNET: 'true',
    MAX_OPEN_POSITIONS: '3',
    MAX_EXPOSURE_PER_COIN_USDT: '100',
    DAILY_LOSS_LIMIT_USDT: '50',
    COOLDOWN_AFTER_LOSS_MS: '900000',
    ACCOUNT_CAPITAL_USDT: '500',
    ACTIVE_STRATEGY_VERSION_ID: '1',
};

function buildEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...VALID_ENV, ...overrides };
}

describe('validateEnv', () => {
    describe('valid configuration', () => {
        it('returns a validated config object when all required vars are present and valid', () => {
            const result = validateEnv(buildEnv());

            expect(result).toBeDefined();
        });

        it('coerces ENGINE_PORT string to integer', () => {
            const result = validateEnv(buildEnv({ ENGINE_PORT: '4000' }));

            expect(result.ENGINE_PORT).toBe(4000);
            expect(typeof result.ENGINE_PORT).toBe('number');
        });

        it('coerces DB_PORT string to integer', () => {
            const result = validateEnv(buildEnv({ DB_PORT: '5433' }));

            expect(result.DB_PORT).toBe(5433);
        });

        it('coerces EXCHANGE_TESTNET "true" string to boolean true', () => {
            const result = validateEnv(buildEnv({ EXCHANGE_TESTNET: 'true' }));

            expect(result.EXCHANGE_TESTNET).toBe(true);
        });

        it('coerces EXCHANGE_TESTNET "false" string to boolean false', () => {
            const result = validateEnv(buildEnv({ EXCHANGE_TESTNET: 'false' }));

            expect(result.EXCHANGE_TESTNET).toBe(false);
        });

        it('defaults EXCHANGE_TESTNET to testnet (true) when missing — never silently selects live', () => {
            const env = buildEnv();
            delete env['EXCHANGE_TESTNET'];

            const result = validateEnv(env);

            expect(result.EXCHANGE_TESTNET).toBe(true);
        });

        it('defaults EXCHANGE_TESTNET to testnet (true) on a typo like "flase" — never silently selects live', () => {
            const result = validateEnv(buildEnv({ EXCHANGE_TESTNET: 'flase' }));

            expect(result.EXCHANGE_TESTNET).toBe(true);
        });

        it('coerces MAX_OPEN_POSITIONS string to integer', () => {
            const result = validateEnv(buildEnv({ MAX_OPEN_POSITIONS: '5' }));

            expect(result.MAX_OPEN_POSITIONS).toBe(5);
        });

        it('coerces MAX_EXPOSURE_PER_COIN_USDT string to float', () => {
            const result = validateEnv(buildEnv({ MAX_EXPOSURE_PER_COIN_USDT: '250.5' }));

            expect(result.MAX_EXPOSURE_PER_COIN_USDT).toBeCloseTo(250.5);
        });

        it('accepts all valid NODE_ENV enum values', () => {
            for (const value of Object.values(NodeEnvEnum)) {
                const result = validateEnv(buildEnv({ NODE_ENV: value }));

                expect(result.NODE_ENV).toBe(value);
            }
        });

        it('accepts all valid LOG_LEVEL enum values', () => {
            for (const value of Object.values(LogLevelEnum)) {
                const result = validateEnv(buildEnv({ LOG_LEVEL: value }));

                expect(result.LOG_LEVEL).toBe(value);
            }
        });

        it('passes when optional secrets EXCHANGE_API_KEY and EXCHANGE_API_SECRET are absent', () => {
            const env = buildEnv();
            delete env['EXCHANGE_API_KEY'];
            delete env['EXCHANGE_API_SECRET'];

            expect(() => validateEnv(env)).not.toThrow();
        });

        it('passes when optional TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are absent', () => {
            const env = buildEnv();
            delete env['TELEGRAM_BOT_TOKEN'];
            delete env['TELEGRAM_CHAT_ID'];

            expect(() => validateEnv(env)).not.toThrow();
        });

        it('passes when optional API_AUTH_TOKEN is absent', () => {
            const env = buildEnv();
            delete env['API_AUTH_TOKEN'];

            expect(() => validateEnv(env)).not.toThrow();
        });

        it('accepts ENGINE_PORT at lower boundary 1', () => {
            const result = validateEnv(buildEnv({ ENGINE_PORT: '1' }));

            expect(result.ENGINE_PORT).toBe(1);
        });

        it('accepts ENGINE_PORT at upper boundary 65535', () => {
            const result = validateEnv(buildEnv({ ENGINE_PORT: '65535' }));

            expect(result.ENGINE_PORT).toBe(65535);
        });

        it('accepts MAX_OPEN_POSITIONS at lower boundary 1', () => {
            const result = validateEnv(buildEnv({ MAX_OPEN_POSITIONS: '1' }));

            expect(result.MAX_OPEN_POSITIONS).toBe(1);
        });

        it('accepts COOLDOWN_AFTER_LOSS_MS at zero boundary', () => {
            const result = validateEnv(buildEnv({ COOLDOWN_AFTER_LOSS_MS: '0' }));

            expect(result.COOLDOWN_AFTER_LOSS_MS).toBe(0);
        });

        it('accepts DAILY_LOSS_LIMIT_USDT at zero boundary', () => {
            const result = validateEnv(buildEnv({ DAILY_LOSS_LIMIT_USDT: '0' }));

            expect(result.DAILY_LOSS_LIMIT_USDT).toBe(0);
        });
    });

    describe('fail-fast on missing required vars', () => {
        it('throws when NODE_ENV is missing and names the offending variable', () => {
            const env = buildEnv();
            delete env['NODE_ENV'];

            expect(() => validateEnv(env)).toThrow(/NODE_ENV/);
        });

        it('throws when ENGINE_PORT is missing and names the offending variable', () => {
            const env = buildEnv();
            delete env['ENGINE_PORT'];

            expect(() => validateEnv(env)).toThrow(/ENGINE_PORT/);
        });

        it('throws when DB_HOST is missing and names the offending variable', () => {
            const env = buildEnv();
            delete env['DB_HOST'];

            expect(() => validateEnv(env)).toThrow(/DB_HOST/);
        });

        it('throws when DATABASE_URL is missing and names the offending variable', () => {
            const env = buildEnv();
            delete env['DATABASE_URL'];

            expect(() => validateEnv(env)).toThrow(/DATABASE_URL/);
        });

        it('throws when MAX_OPEN_POSITIONS is missing and names the offending variable', () => {
            const env = buildEnv();
            delete env['MAX_OPEN_POSITIONS'];

            expect(() => validateEnv(env)).toThrow(/MAX_OPEN_POSITIONS/);
        });

        it('throws when ACCOUNT_CAPITAL_USDT is missing and names the offending variable', () => {
            const env = buildEnv();
            delete env['ACCOUNT_CAPITAL_USDT'];

            expect(() => validateEnv(env)).toThrow(/ACCOUNT_CAPITAL_USDT/);
        });
    });

    describe('fail-fast on invalid var values', () => {
        it('throws when NODE_ENV is not a valid enum value and names the offending variable', () => {
            expect(() => validateEnv(buildEnv({ NODE_ENV: 'staging' }))).toThrow(/NODE_ENV/);
        });

        it('throws when LOG_LEVEL is not a valid enum value and names the offending variable', () => {
            expect(() => validateEnv(buildEnv({ LOG_LEVEL: 'trace' }))).toThrow(/LOG_LEVEL/);
        });

        it('throws when ENGINE_PORT is a non-numeric string and names the offending variable', () => {
            expect(() => validateEnv(buildEnv({ ENGINE_PORT: 'notaport' }))).toThrow(/ENGINE_PORT/);
        });

        it('throws when ENGINE_PORT is below minimum of 1 and names the offending variable', () => {
            expect(() => validateEnv(buildEnv({ ENGINE_PORT: '0' }))).toThrow(/ENGINE_PORT/);
        });

        it('throws when ENGINE_PORT exceeds maximum of 65535 and names the offending variable', () => {
            expect(() => validateEnv(buildEnv({ ENGINE_PORT: '65536' }))).toThrow(/ENGINE_PORT/);
        });

        it('throws when DB_HOST is an empty string and names the offending variable', () => {
            expect(() => validateEnv(buildEnv({ DB_HOST: '' }))).toThrow(/DB_HOST/);
        });

        it('throws when DB_PORT is a non-numeric string and names the offending variable', () => {
            expect(() => validateEnv(buildEnv({ DB_PORT: 'notaport' }))).toThrow(/DB_PORT/);
        });

        it('throws when MAX_OPEN_POSITIONS is below minimum of 1 and names the offending variable', () => {
            expect(() => validateEnv(buildEnv({ MAX_OPEN_POSITIONS: '0' }))).toThrow(/MAX_OPEN_POSITIONS/);
        });

        it('throws when MAX_EXPOSURE_PER_COIN_USDT is negative and names the offending variable', () => {
            expect(() => validateEnv(buildEnv({ MAX_EXPOSURE_PER_COIN_USDT: '-1' }))).toThrow(/MAX_EXPOSURE_PER_COIN_USDT/);
        });

        it('throws when DAILY_LOSS_LIMIT_USDT is negative and names the offending variable', () => {
            expect(() => validateEnv(buildEnv({ DAILY_LOSS_LIMIT_USDT: '-0.01' }))).toThrow(/DAILY_LOSS_LIMIT_USDT/);
        });

        it('throws when ACCOUNT_CAPITAL_USDT is negative and names the offending variable', () => {
            expect(() => validateEnv(buildEnv({ ACCOUNT_CAPITAL_USDT: '-500' }))).toThrow(/ACCOUNT_CAPITAL_USDT/);
        });

        it('throws when DB_NAME is an empty string and names the offending variable', () => {
            expect(() => validateEnv(buildEnv({ DB_NAME: '' }))).toThrow(/DB_NAME/);
        });

        it('throws error that lists ALL offending variables when multiple are invalid', () => {
            const env = buildEnv();
            delete env['NODE_ENV'];
            delete env['DB_HOST'];

            const invoke = () => validateEnv(env);

            expect(invoke).toThrow(/NODE_ENV/);
            expect(invoke).toThrow(/DB_HOST/);
        });
    });
});
