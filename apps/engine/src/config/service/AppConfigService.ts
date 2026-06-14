import { randomBytes } from 'node:crypto';

import { AuthScopeEnum, ExchangeEnvironmentEnum } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TransitionTokenFileEnvName, TransitionTokenHashEnvName } from '../../boot-mode-history/const';
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

// M10 W0.5 (ADR 0027) — login-endpoint bootstrap secret + login-issued scope
// allow-list. The bootstrap secret is the operator's sole long-lived
// credential, exchanged for short-lived JWTs at POST /v1/auth/login.
const AUTH_BOOTSTRAP_SECRET_ENV = 'AUTH_BOOTSTRAP_SECRET';
const AUTH_LOGIN_SCOPES_ENV = 'AUTH_LOGIN_SCOPES';

// M11a W1.6 (ADR 0031) — revoked-jti prune TTL + unbounded-growth alert
// threshold. Floor is enforced at boot: prune_after >= token TTL + 1 hour.
const AUTH_TOKEN_TTL_SEC_ENV = 'AUTH_TOKEN_TTL_SEC';
const AUTH_REVOKED_JTI_PRUNE_AFTER_SEC_ENV = 'AUTH_REVOKED_JTI_PRUNE_AFTER_SEC';
const REVOKED_JTI_MAX_ROWS_ENV = 'REVOKED_JTI_MAX_ROWS';
const AUTH_TOKEN_TTL_SEC_DEFAULT = 15 * 60;
const AUTH_REVOKED_JTI_PRUNE_AFTER_SEC_DEFAULT = 75 * 60;
const REVOKED_JTI_MAX_ROWS_DEFAULT = 10_000;
const AUTH_REVOKED_JTI_PRUNE_SAFETY_MARGIN_SEC = 3600;

const AUTH_HMAC_SECRET_MIN_BYTES = 32;
const AUTH_BOOTSTRAP_SECRET_MIN_BYTES = 32;
const DEV_SECRET_BYTES = 32;

// ADR 0027 §2.2 — login MUST NOT issue admin scope (admin = CLI-only).
const AUTH_LOGIN_DEFAULT_SCOPES: ReadonlyArray<AuthScopeEnum> = [AuthScopeEnum.READ, AuthScopeEnum.HALT];

// ADR 0020 §2.4 — secrets the boot-time check refuses outright. Any of these
// substrings (case-insensitive) trips the production guard so a sentinel from
// `.env.example` cannot accidentally ship.
//
// M10 R2 #5 — added `change_me` (underscore form). `.env.example` ships
// `change_me_local_only`; the hyphen and no-separator variants were caught
// already, the underscore form was not. Closes the last sentinel-leak path
// where an operator copies the example value verbatim into `.env`.
const FORBIDDEN_SECRET_SUBSTRINGS = ['change-me', 'change_me', 'dev-secret', 'dev-insecure', 'changeme'];

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
    private readonly resolvedAuthBootstrapSecret: string;
    private readonly resolvedAuthLoginScopes: ReadonlyArray<AuthScopeEnum>;
    private readonly resolvedAuthTokenTtlSec: number;
    private readonly resolvedRevokedJtiPruneAfterSec: number;
    private readonly resolvedRevokedJtiMaxRows: number;
    private readonly resolvedMarketStressAutoResumeEnabled: boolean;
    private readonly resolvedPaperRelaxMarketStress: boolean;
    private readonly resolvedPaperRelaxConsecutiveLossHalt: boolean;

    constructor(private readonly configService: ConfigService<EnvironmentVariables, true>) {
        this.resolvedAuthHmacSecret = this.resolveAuthHmacSecret();
        this.resolvedCorsAllowlist = this.parseCorsAllowlist();
        this.resolvedFlattenDefault = this.parseFlattenDefault();
        this.resolvedTrustProxy = this.parseTrustProxy();
        // M10 W0.5 — login-scope parse runs first so a bad list fails fast
        // before the bootstrap-secret-vs-signing-secret check below; both
        // surface as a clear boot error rather than a deferred 5xx at runtime.
        this.resolvedAuthLoginScopes = this.parseAuthLoginScopes();
        this.resolvedAuthBootstrapSecret = this.resolveAuthBootstrapSecret(this.resolvedAuthHmacSecret);
        // M11a W1.6 — token TTL parsed before prune-after so the floor check
        // has a real value to compare against; misconfigured floor is a fatal
        // boot error (ADR 0031 §2.2).
        this.resolvedAuthTokenTtlSec = this.parsePositiveIntEnv(AUTH_TOKEN_TTL_SEC_ENV, AUTH_TOKEN_TTL_SEC_DEFAULT);
        this.resolvedRevokedJtiPruneAfterSec = this.resolveRevokedJtiPruneAfterSec(this.resolvedAuthTokenTtlSec);
        this.resolvedRevokedJtiMaxRows = this.parsePositiveIntEnv(REVOKED_JTI_MAX_ROWS_ENV, REVOKED_JTI_MAX_ROWS_DEFAULT);
        this.resolvedMarketStressAutoResumeEnabled = this.resolveMarketStressAutoResumeEnabled();
        this.resolvedPaperRelaxMarketStress = this.resolvePaperRelaxMarketStress();
        this.resolvedPaperRelaxConsecutiveLossHalt = this.resolvePaperRelaxConsecutiveLossHalt();
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

    // M11a W1.1 — exchange-environment selector. NO default; an unset value
    // throws at boot via the class-validator @IsEnum(EnvironmentVariables).
    get exchangeEnv(): ExchangeEnvironmentEnum {
        return this.configService.get('EXCHANGE_ENV', { infer: true });
    }

    // M23 (ADR 0004 §6d) — master switch for breadth market-stress auto-resume.
    // When false, the gate keeps the pre-M23 full-day lock for every stress halt
    // (M23 inert). Default derives from EXCHANGE_ENV (paper → on, else off) so a
    // live deploy never inherits the loosening; an explicit env override is the
    // only way to enable it on live. Read once at boot — constant within a run,
    // so the gate's determinism invariant is preserved.
    get marketStressAutoResumeEnabled(): boolean {
        return this.resolvedMarketStressAutoResumeEnabled;
    }

    // M25 (ADR 0042 §2/§6) — effective paper-only stress-relax switch consumed by
    // StressHaltEvaluator (through RiskGateService). True ONLY when both
    // EXCHANGE_ENV=paper AND PAPER_RELAX_MARKET_STRESS=true (the two-condition
    // gate of ADR 0042 §1) — a live/testnet boot can never see it on, so a
    // non-paper boot is byte-identical to pre-M25. Resolved once at boot, constant
    // within a run, so the gate's determinism invariant holds. Never relaxes the
    // invalid-inputs guard or the breadth leg (§2).
    get paperRelaxMarketStress(): boolean {
        return this.resolvedPaperRelaxMarketStress;
    }

    // M36 — effective paper-only consecutive-loss-halt relax switch. True ONLY when
    // both EXCHANGE_ENV=paper AND PAPER_RELAX_CONSECUTIVE_LOSS_HALT=true (the same
    // two-condition gate as paperRelaxMarketStress) — a live/testnet boot can never
    // see it on, so a non-paper boot is byte-identical to pre-M36. Resolved once at
    // boot, constant within a run, so the gate's determinism invariant holds.
    get paperRelaxConsecutiveLossHalt(): boolean {
        return this.resolvedPaperRelaxConsecutiveLossHalt;
    }

    // M25 (ADR 0042 §3) — optional paper override for the idiosyncratic-slot
    // count. Returns the validated value (already capped at <= 2 by the boot
    // guard in EnvironmentVariables, which rejects > 2) or undefined when no
    // override is set. The slot ceiling stays at A/B/C = 3 in every env; this
    // never raises capacity above the 3-slot contract.
    get paperMaxIdiosyncraticSlots(): number | undefined {
        return this.configService.get('PAPER_MAX_IDIOSYNCRATIC_SLOTS', { infer: true });
    }

    // M11a W1.1 — two-token live-mode boot inputs. Both optional at schema
    // level; the LIVE branch of LiveGoAheadVerifier requires both to be set.
    get liveGoAheadTokenFile(): string | undefined {
        return this.configService.get('LIVE_GO_AHEAD_TOKEN_FILE', { infer: true });
    }

    get liveGoAheadTokenHash(): string | undefined {
        return this.configService.get('LIVE_GO_AHEAD_TOKEN_HASH', { infer: true });
    }

    // Boot-mode transition tokens (ADR 0032 §D6 / §D7). The BootModeChainService
    // looks each pair up by env-var name from the TRANSITION_ENV_VARS table;
    // these name-keyed helpers keep the config-read posture identical to
    // LiveGoAheadVerifier (typed access through AppConfigService — no direct
    // process.env reads in services).
    get testnetToPaperTokenFile(): string | undefined {
        return this.configService.get('TESTNET_TO_PAPER_TOKEN_FILE', { infer: true });
    }

    get testnetToPaperTokenHash(): string | undefined {
        return this.configService.get('TESTNET_TO_PAPER_TOKEN_HASH', { infer: true });
    }

    get paperToLiveTokenFile(): string | undefined {
        return this.configService.get('PAPER_TO_LIVE_TOKEN_FILE', { infer: true });
    }

    get paperToLiveTokenHash(): string | undefined {
        return this.configService.get('PAPER_TO_LIVE_TOKEN_HASH', { infer: true });
    }

    // Name-keyed accessors used by BootModeChainService, which routes through
    // the TRANSITION_ENV_VARS table to keep the transition matrix declarative.
    // Each env-var name is whitelisted against the typed getters above so a
    // mistyped name returns undefined rather than reaching the raw env. Adding
    // a new transition requires extending both the schema and this switch.
    readTransitionTokenFile(envVarName: TransitionTokenFileEnvName): string | undefined {
        switch (envVarName) {
            case 'TESTNET_TO_PAPER_TOKEN_FILE':
                return this.testnetToPaperTokenFile;
            case 'PAPER_TO_LIVE_TOKEN_FILE':
                return this.paperToLiveTokenFile;
            default:
                // `satisfies never` fails compilation if the union grows
                // without this switch being extended; the runtime throw
                // guards against an `as`-bypass at a future call site
                // falling through to implicit `undefined`.
                throw new Error(`Unhandled transition env name: ${envVarName satisfies never}`);
        }
    }

    readTransitionTokenHash(envVarName: TransitionTokenHashEnvName): string | undefined {
        switch (envVarName) {
            case 'TESTNET_TO_PAPER_TOKEN_HASH':
                return this.testnetToPaperTokenHash;
            case 'PAPER_TO_LIVE_TOKEN_HASH':
                return this.paperToLiveTokenHash;
            default:
                // See readTransitionTokenFile for the rationale on the
                // `satisfies never` compile-time guard.
                throw new Error(`Unhandled transition env name: ${envVarName satisfies never}`);
        }
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

    // ADR 0032 §D11 — PAPER soak cold-start equity (USDT). See env-schema
    // comment for default + restricted-profile rationale.
    get paperStartingEquityUsdt(): number {
        return this.configService.get('PAPER_STARTING_EQUITY_USDT', { infer: true });
    }

    // ADR 0032 §D13 — PAPER nullity-probe cadence + backoff ceiling. R2d
    // surfaces these env-vars so the operator can tune cadence under a
    // future symbol-fan-out widening without a code change.
    get paperNullityProbeIntervalMs(): number {
        return this.configService.get('PAPER_NULLITY_PROBE_INTERVAL_MS', { infer: true });
    }

    get paperNullityProbeBackoffMaxMs(): number {
        return this.configService.get('PAPER_NULLITY_PROBE_BACKOFF_MAX_MS', { infer: true });
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

    // M10 W0.5 (ADR 0027 §2.3) — bootstrap secret exchanged at the login
    // endpoint for a short-lived JWT. Required in every environment (no dev
    // fallback): the endpoint is opt-in and only mounted when this is set
    // intentionally. Boot-validated: >= 32 bytes, no forbidden sentinels,
    // MUST differ from AUTH_HMAC_SECRET (key-reuse would let a compromised
    // signing secret forge logins and vice versa).
    get authBootstrapSecret(): string {
        return this.resolvedAuthBootstrapSecret;
    }

    // M10 W0.5 (ADR 0027 §2.2) — scopes the login endpoint stamps onto
    // returned tokens. `admin` is rejected at boot — admin is the revocation
    // path and remains CLI-only.
    get authLoginScopes(): ReadonlyArray<AuthScopeEnum> {
        return this.resolvedAuthLoginScopes;
    }

    // M11a W1.6 (ADR 0031). Token TTL (the issuer's hard ceiling) + prune
    // after (when the row becomes eligible for deletion) + the row-count
    // unbounded-growth alert threshold. Boot fails if prune_after < TTL + 1h.
    get authTokenTtlSec(): number {
        return this.resolvedAuthTokenTtlSec;
    }

    get revokedJtiPruneAfterSec(): number {
        return this.resolvedRevokedJtiPruneAfterSec;
    }

    get revokedJtiMaxRows(): number {
        return this.resolvedRevokedJtiMaxRows;
    }

    // M17 — automated daily DB backup. Directory the engine writes dumps to,
    // the enable flag (test/CI default off), the 5-field UTC cron schedule, and
    // the retention depth. All validated in EnvironmentVariables so these
    // getters return already-coerced, already-checked values.
    get dbBackupDir(): string {
        return this.configService.get('DB_BACKUP_DIR', { infer: true });
    }

    get dbBackupEnabled(): boolean {
        return this.configService.get('DB_BACKUP_ENABLED', { infer: true });
    }

    get dbBackupCron(): string {
        return this.configService.get('DB_BACKUP_CRON', { infer: true });
    }

    get dbBackupRetention(): number {
        return this.configService.get('DB_BACKUP_RETENTION', { infer: true });
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

    private resolveAuthBootstrapSecret(signingSecret: string): string {
        const raw = process.env[AUTH_BOOTSTRAP_SECRET_ENV];

        if (typeof raw === 'string' && raw.length > 0) {
            this.assertBootstrapSecretIsStrong(raw, signingSecret);

            return raw;
        }

        if (this.isProduction) {
            throw new Error(
                `${AUTH_BOOTSTRAP_SECRET_ENV} is required in production (>= ${AUTH_BOOTSTRAP_SECRET_MIN_BYTES} bytes,` +
                    ' MUST differ from AUTH_HMAC_SECRET) — see ADR 0027 §2.3.',
            );
        }

        // Dev / test: generate a per-process random secret distinct from the
        // (also-generated) signing secret. The login endpoint is opt-in so dev
        // workflows that do not exercise it never need to set this env var.
        // The operator MUST set a real value before any non-dev deploy.
        let generated = randomBytes(DEV_SECRET_BYTES).toString('hex');

        // Vanishingly unlikely but cheap guarantee that the two random secrets
        // are not equal; loop only on collision.
        while (generated === signingSecret) {
            generated = randomBytes(DEV_SECRET_BYTES).toString('hex');
        }

        this.logger.warn(`${AUTH_BOOTSTRAP_SECRET_ENV} unset — generated a per-process random bootstrap secret (forbidden in production)`);

        return generated;
    }

    private assertBootstrapSecretIsStrong(raw: string, signingSecret: string): void {
        if (Buffer.byteLength(raw, 'utf8') < AUTH_BOOTSTRAP_SECRET_MIN_BYTES) {
            throw new Error(`${AUTH_BOOTSTRAP_SECRET_ENV} must be >= ${AUTH_BOOTSTRAP_SECRET_MIN_BYTES} bytes`);
        }

        const lower = raw.toLowerCase();

        for (const sentinel of FORBIDDEN_SECRET_SUBSTRINGS) {
            if (lower.includes(sentinel)) {
                throw new Error(`${AUTH_BOOTSTRAP_SECRET_ENV} contains forbidden sentinel substring '${sentinel}'`);
            }
        }

        if (raw === signingSecret) {
            throw new Error(`${AUTH_BOOTSTRAP_SECRET_ENV} must not equal AUTH_HMAC_SECRET — key-reuse forbidden (ADR 0027 §2.3)`);
        }
    }

    private parseAuthLoginScopes(): ReadonlyArray<AuthScopeEnum> {
        const raw = process.env[AUTH_LOGIN_SCOPES_ENV];

        if (raw === undefined || raw.length === 0) {
            return AUTH_LOGIN_DEFAULT_SCOPES;
        }

        const parsed: AuthScopeEnum[] = [];
        const allowed = new Set<string>(Object.values(AuthScopeEnum));

        for (const entry of raw.split(',')) {
            const trimmed = entry.trim();

            if (trimmed.length === 0) {
                continue;
            }

            if (!allowed.has(trimmed)) {
                throw new Error(`${AUTH_LOGIN_SCOPES_ENV} contains unknown scope '${trimmed}' (allowed: ${Object.values(AuthScopeEnum).join(',')})`);
            }

            if (trimmed === AuthScopeEnum.ADMIN) {
                throw new Error(`${AUTH_LOGIN_SCOPES_ENV} must not contain 'admin' — admin scope is CLI-only per ADR 0027 §2.2`);
            }

            parsed.push(trimmed as AuthScopeEnum);
        }

        if (parsed.length === 0) {
            return AUTH_LOGIN_DEFAULT_SCOPES;
        }

        return parsed;
    }

    // M11a W1.6 (ADR 0031 §2.2). Reads AUTH_REVOKED_JTI_PRUNE_AFTER_SEC and
    // boot-fails when below the floor `tokenTtlSec + 1h`. A misconfigured
    // floor risks pruning a still-valid token's revocation entry.
    private resolveRevokedJtiPruneAfterSec(tokenTtlSec: number): number {
        const floor = tokenTtlSec + AUTH_REVOKED_JTI_PRUNE_SAFETY_MARGIN_SEC;
        const raw = process.env[AUTH_REVOKED_JTI_PRUNE_AFTER_SEC_ENV];

        if (raw === undefined || raw.length === 0) {
            if (AUTH_REVOKED_JTI_PRUNE_AFTER_SEC_DEFAULT < floor) {
                throw new Error(
                    `${AUTH_REVOKED_JTI_PRUNE_AFTER_SEC_ENV} default ${AUTH_REVOKED_JTI_PRUNE_AFTER_SEC_DEFAULT}s is below floor ` +
                        `${floor}s (=${AUTH_TOKEN_TTL_SEC_ENV}+${AUTH_REVOKED_JTI_PRUNE_SAFETY_MARGIN_SEC}s) — see ADR 0031 §2.2`,
                );
            }

            return AUTH_REVOKED_JTI_PRUNE_AFTER_SEC_DEFAULT;
        }

        const parsed = Number.parseInt(raw, 10);

        if (Number.isNaN(parsed) || parsed <= 0) {
            throw new Error(`${AUTH_REVOKED_JTI_PRUNE_AFTER_SEC_ENV} must be a positive integer; got '${raw}'`);
        }

        if (parsed < floor) {
            throw new Error(
                `${AUTH_REVOKED_JTI_PRUNE_AFTER_SEC_ENV}=${parsed}s is below floor ${floor}s ` +
                    `(=${AUTH_TOKEN_TTL_SEC_ENV}+${AUTH_REVOKED_JTI_PRUNE_SAFETY_MARGIN_SEC}s) — see ADR 0031 §2.2`,
            );
        }

        return parsed;
    }

    // M23 (ADR 0004 §6d). The schema field is optional with no default, so an
    // absent key surfaces here as `undefined` — distinguishing "unset" (derive
    // from EXCHANGE_ENV) from "explicitly set false". Present values are already
    // coerced to boolean by the @Transform on the schema field.
    private resolveMarketStressAutoResumeEnabled(): boolean {
        const configured = this.configService.get('MARKET_STRESS_AUTO_RESUME_ENABLED', { infer: true });

        if (configured !== undefined) {
            return configured;
        }

        return this.exchangeEnv === ExchangeEnvironmentEnum.PAPER;
    }

    // M25 (ADR 0042 §1/§2). Two-condition gate: the relax is effective only when
    // EXCHANGE_ENV=paper AND the flag is true. Unlike the M23 auto-resume flag,
    // this does NOT derive on-by-default in paper — skipping multiple stress legs
    // is a sharper loosening that requires an explicit paper opt-in (ADR 0042 §1).
    // The schema field is already coerced to a strict boolean (exact 'true'),
    // defaulting to false when absent.
    private resolvePaperRelaxMarketStress(): boolean {
        const flagEnabled = this.configService.get('PAPER_RELAX_MARKET_STRESS', { infer: true });
        const isPaperEnv = this.exchangeEnv === ExchangeEnvironmentEnum.PAPER;

        if (flagEnabled && !isPaperEnv) {
            this.logger.warn(
                `PAPER_RELAX_MARKET_STRESS=true but EXCHANGE_ENV=${this.exchangeEnv} (not paper) — the flag has been NEUTRALIZED ` +
                    '(non-breadth stress legs stay active, identical to pre-M25). If this is intentional (e.g. a copied .env under ' +
                    'inspection), no action needed; if not, check EXCHANGE_ENV.',
            );
        }

        return flagEnabled && isPaperEnv;
    }

    // M36 — same two-condition gate as resolvePaperRelaxMarketStress: the relax is
    // effective only when EXCHANGE_ENV=paper AND the flag is true. Does NOT derive
    // on-by-default in paper — relaxing the consecutive-loss halt requires an
    // explicit paper opt-in. The schema field is already coerced to a strict
    // boolean (exact 'true'), defaulting to false when absent.
    private resolvePaperRelaxConsecutiveLossHalt(): boolean {
        const flagEnabled = this.configService.get('PAPER_RELAX_CONSECUTIVE_LOSS_HALT', { infer: true });
        const isPaperEnv = this.exchangeEnv === ExchangeEnvironmentEnum.PAPER;

        if (flagEnabled && !isPaperEnv) {
            this.logger.warn(
                `PAPER_RELAX_CONSECUTIVE_LOSS_HALT=true but EXCHANGE_ENV=${this.exchangeEnv} (not paper) — the flag has been ` +
                    'NEUTRALIZED (the consecutive-loss halt stays active, identical to pre-M36). If this is intentional (e.g. a ' +
                    'copied .env under inspection), no action needed; if not, check EXCHANGE_ENV.',
            );
        }

        return flagEnabled && isPaperEnv;
    }

    private parsePositiveIntEnv(envName: string, defaultValue: number): number {
        const raw = process.env[envName];

        if (raw === undefined || raw.length === 0) {
            return defaultValue;
        }

        const parsed = Number.parseInt(raw, 10);

        if (Number.isNaN(parsed) || parsed <= 0) {
            throw new Error(`${envName} must be a positive integer; got '${raw}'`);
        }

        return parsed;
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
