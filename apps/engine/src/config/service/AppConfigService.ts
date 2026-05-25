import { randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EnvironmentVariables } from '../EnvironmentVariables';
import { ExecutionModeEnum, LogLevelEnum, NodeEnvEnum } from '../enum';

// M9 R1 #4 — env keys owned by AppConfigService (ADR 0020 §2.7 single SoT).
// These are read here (and only here) via process.env because the parent
// EnvironmentVariables schema does not enumerate every M9 key; AppConfigService
// is the boundary that performs typed coercion + boot-time validation.
const AUTH_HMAC_SECRET_ENV = 'AUTH_HMAC_SECRET';
const AUTH_CORS_ALLOWLIST_ENV = 'AUTH_CORS_ALLOWLIST';
const KILL_SWITCH_FLATTEN_DEFAULT_ENV = 'KILL_SWITCH_FLATTEN_DEFAULT';
const TRUST_PROXY_HOPS_ENV = 'TRUST_PROXY_HOPS';

const AUTH_HMAC_SECRET_MIN_BYTES = 32;
const DEV_SECRET_BYTES = 32;

// ADR 0020 §2.4 — secrets the boot-time check refuses outright. Any of these
// substrings (case-insensitive) trips the production guard so a sentinel from
// `.env.example` cannot accidentally ship.
const FORBIDDEN_SECRET_SUBSTRINGS = ['change-me', 'dev-secret', 'dev-insecure', 'changeme'];

// Typed, DI-friendly accessor over the validated environment. Other modules
// depend on this — never on raw process.env or the untyped ConfigService — so
// every config read is type-checked and resolves to a validated value.
@Injectable()
export class AppConfigService {
    private readonly logger = new Logger(AppConfigService.name);

    // Resolved once at construction so per-request reads cannot diverge and the
    // dev-fallback secret is stable for the lifetime of the process.
    private readonly resolvedAuthHmacSecret: string;
    private readonly resolvedCorsAllowlist: ReadonlyArray<string>;
    private readonly resolvedFlattenDefault: boolean;
    private readonly resolvedTrustProxy: string | number;

    constructor(private readonly configService: ConfigService<EnvironmentVariables, true>) {
        this.resolvedAuthHmacSecret = this.resolveAuthHmacSecret();
        this.resolvedCorsAllowlist = this.parseCorsAllowlist();
        this.resolvedFlattenDefault = this.parseFlattenDefault();
        this.resolvedTrustProxy = this.parseTrustProxy();
    }

    get nodeEnv(): NodeEnvEnum {
        return this.configService.get('NODE_ENV', { infer: true });
    }

    get isProduction(): boolean {
        return this.nodeEnv === NodeEnvEnum.PRODUCTION;
    }

    get enginePort(): number {
        return this.configService.get('ENGINE_PORT', { infer: true });
    }

    get logLevel(): LogLevelEnum {
        return this.configService.get('LOG_LEVEL', { infer: true });
    }

    get databaseUrl(): string {
        return this.configService.get('DATABASE_URL', { infer: true });
    }

    get exchangeApiKey(): string | undefined {
        return this.configService.get('EXCHANGE_API_KEY', { infer: true });
    }

    get exchangeApiSecret(): string | undefined {
        return this.configService.get('EXCHANGE_API_SECRET', { infer: true });
    }

    get isExchangeTestnet(): boolean {
        return this.configService.get('EXCHANGE_TESTNET', { infer: true });
    }

    get telegramBotToken(): string | undefined {
        return this.configService.get('TELEGRAM_BOT_TOKEN', { infer: true });
    }

    get telegramChatId(): string | undefined {
        return this.configService.get('TELEGRAM_CHAT_ID', { infer: true });
    }

    get apiAuthToken(): string | undefined {
        return this.configService.get('API_AUTH_TOKEN', { infer: true });
    }

    get maxOpenPositions(): number {
        return this.configService.get('MAX_OPEN_POSITIONS', { infer: true });
    }

    get maxExposurePerCoinUsdt(): number {
        return this.configService.get('MAX_EXPOSURE_PER_COIN_USDT', { infer: true });
    }

    get dailyLossLimitUsdt(): number {
        return this.configService.get('DAILY_LOSS_LIMIT_USDT', { infer: true });
    }

    get weeklyLossLimitUsdt(): number {
        return this.configService.get('WEEKLY_LOSS_LIMIT_USDT', { infer: true });
    }

    get maxSameDirectionExposureUsdt(): number {
        return this.configService.get('MAX_SAME_DIRECTION_EXPOSURE_USDT', { infer: true });
    }

    get cooldownAfterLossMs(): number {
        return this.configService.get('COOLDOWN_AFTER_LOSS_MS', { infer: true });
    }

    get accountCapitalUsdt(): number {
        return this.configService.get('ACCOUNT_CAPITAL_USDT', { infer: true });
    }

    get activeStrategyVersionId(): number {
        return this.configService.get('ACTIVE_STRATEGY_VERSION_ID', { infer: true });
    }

    get executionMode(): ExecutionModeEnum {
        return this.configService.get('EXECUTION_MODE', { infer: true });
    }

    get isExecutionLive(): boolean {
        return this.executionMode === ExecutionModeEnum.LIVE;
    }

    // M9 (ADR 0020 §2.4) — HS256 signing secret. Required in production; a
    // per-process random 32-byte secret is generated in non-prod so dev/test
    // never exercises a hard-coded sentinel. A loud WARN is logged once at
    // boot when the random fallback is in use so the operator notices.
    get authHmacSecret(): string {
        return this.resolvedAuthHmacSecret;
    }

    // M9 (ADR 0020 §2.3) — comma-separated origin allow-list. Empty in prod
    // means deny-all cross-origin; the operator must populate explicitly.
    get corsAllowlist(): ReadonlyArray<string> {
        return this.resolvedCorsAllowlist;
    }

    // M9 (ADR 0021 §2.4) — default value for `flattenOpenPositions` when the
    // operator omits the flag. Case-insensitive boolean parse; unknown values
    // collapse to `false` (safety-first default).
    get flattenDefault(): boolean {
        return this.resolvedFlattenDefault;
    }

    // M9 R1 H6 — Express `trust proxy` setting. Default `'loopback'` so
    // `req.ip` is trustworthy on the docker-compose network without false
    // attribution; behind a real ingress the operator sets `TRUST_PROXY_HOPS`
    // to a hop count (positive integer).
    get trustProxy(): string | number {
        return this.resolvedTrustProxy;
    }

    private resolveAuthHmacSecret(): string {
        const raw = process.env[AUTH_HMAC_SECRET_ENV];

        if (typeof raw === 'string' && raw.length > 0) {
            this.assertSecretIsStrong(raw);

            return raw;
        }

        if (this.isProduction) {
            throw new Error(`${AUTH_HMAC_SECRET_ENV} is required in production (>= ${AUTH_HMAC_SECRET_MIN_BYTES} bytes)`);
        }

        // Dev / test: per-process random secret. Never a literal — a hard-coded
        // fallback was the prior vulnerability (M9 R1 security blocker).
        const generated = randomBytes(DEV_SECRET_BYTES).toString('hex');
        this.logger.warn(`${AUTH_HMAC_SECRET_ENV} unset — generated a per-process random secret (forbidden in production)`);

        return generated;
    }

    private assertSecretIsStrong(value: string): void {
        const lower = value.toLowerCase();

        for (const sentinel of FORBIDDEN_SECRET_SUBSTRINGS) {
            if (lower.includes(sentinel)) {
                throw new Error(`${AUTH_HMAC_SECRET_ENV} contains forbidden sentinel substring '${sentinel}'`);
            }
        }

        if (Buffer.byteLength(value, 'utf8') < AUTH_HMAC_SECRET_MIN_BYTES) {
            throw new Error(`${AUTH_HMAC_SECRET_ENV} must be >= ${AUTH_HMAC_SECRET_MIN_BYTES} bytes`);
        }
    }

    private parseCorsAllowlist(): ReadonlyArray<string> {
        const raw = process.env[AUTH_CORS_ALLOWLIST_ENV] ?? '';

        return raw
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
    }

    private parseFlattenDefault(): boolean {
        const raw = process.env[KILL_SWITCH_FLATTEN_DEFAULT_ENV];

        if (raw === undefined || raw.length === 0) {
            return false;
        }

        const normalised = raw.toLowerCase().trim();

        if (normalised === 'true' || normalised === '1' || normalised === 'yes') {
            return true;
        }

        if (normalised === 'false' || normalised === '0' || normalised === 'no') {
            return false;
        }

        throw new Error(`${KILL_SWITCH_FLATTEN_DEFAULT_ENV} must be a boolean (true|false|1|0|yes|no); got '${raw}'`);
    }

    private parseTrustProxy(): string | number {
        const raw = process.env[TRUST_PROXY_HOPS_ENV];

        if (raw === undefined || raw.length === 0) {
            return 'loopback';
        }

        const parsed = Number.parseInt(raw, 10);

        if (Number.isNaN(parsed) || parsed < 0) {
            // Allow string presets ('loopback', 'linklocal', 'uniquelocal') verbatim.
            return raw;
        }

        return parsed;
    }
}
