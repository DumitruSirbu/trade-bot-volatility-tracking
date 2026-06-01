import { ExchangeEnvironmentEnum } from '@bot/shared';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

import { ExecutionModeEnum, LogLevelEnum, NodeEnvEnum } from './enum';
import { IsFiveFieldCron } from './IsFiveFieldCron';

// Validated shape of the process environment. Every required var here aborts
// startup if missing/invalid (see AppConfigModule's fail-fast validateEnv hook).
// Secrets (exchange keys, tokens) are optional at the schema level because they
// are blank in non-live profiles; the modules that consume them enforce presence
// when actually needed. NO secret carries a committed default.
export class EnvironmentVariables {
    @IsEnum(NodeEnvEnum)
    NODE_ENV!: NodeEnvEnum;

    @Transform(({ value }) => Number.parseInt(String(value), 10))
    @IsInt()
    @Min(1)
    @Max(65535)
    ENGINE_PORT!: number;

    @IsEnum(LogLevelEnum)
    LOG_LEVEL!: LogLevelEnum;

    @IsString()
    @IsNotEmpty()
    DB_HOST!: string;

    @Transform(({ value }) => Number.parseInt(String(value), 10))
    @IsInt()
    @Min(1)
    @Max(65535)
    DB_PORT!: number;

    @IsString()
    @IsNotEmpty()
    DB_USER!: string;

    @IsString()
    @IsNotEmpty()
    DB_PASSWORD!: string;

    @IsString()
    @IsNotEmpty()
    DB_NAME!: string;

    @IsString()
    @IsNotEmpty()
    DATABASE_URL!: string;

    @Transform(({ value }) => Number.parseInt(String(value), 10))
    @IsInt()
    @Min(1)
    @Max(65535)
    ADMINER_PORT!: number;

    @IsOptional()
    @IsString()
    EXCHANGE_API_KEY?: string;

    @IsOptional()
    @IsString()
    EXCHANGE_API_SECRET?: string;

    // ADR 0032 — primary exchange-environment selector. NO default
    // — boot refuses to start when unset, so an operator must opt in
    // explicitly. Valid values: 'testnet' | 'paper' | 'live'. The legacy
    // EXCHANGE_TESTNET boolean (below) is retained read-only for the
    // CcxtBinanceExchangeClient's pre-M11a code path; new code branches on
    // EXCHANGE_ENV exclusively.
    @IsEnum(ExchangeEnvironmentEnum)
    EXCHANGE_ENV!: ExchangeEnvironmentEnum;

    // M11a W1.1 — two-token live-mode boot (ADR 0028 / M11a W0.1). When
    // EXCHANGE_ENV=LIVE, the operator must point LIVE_GO_AHEAD_TOKEN_FILE at a
    // local file whose hex-encoded SHA-256 matches LIVE_GO_AHEAD_TOKEN_HASH
    // (baked into config). Both unset is fatal for LIVE; ignored otherwise.
    @IsOptional()
    @IsString()
    LIVE_GO_AHEAD_TOKEN_FILE?: string;

    @IsOptional()
    @IsString()
    LIVE_GO_AHEAD_TOKEN_HASH?: string;

    // Transition-token inputs for the boot_mode_history HMAC chain
    // (ADR 0032 §D6 / §D7). Each transition is single-use and gated by a
    // separate file + hash pair. Hash fields are hex-encoded SHA-256 — 64
    // hex chars. Both unset means the transition is unavailable; an attempt
    // to traverse it aborts the engine with the security exit code.
    @IsOptional()
    @IsString()
    TESTNET_TO_PAPER_TOKEN_FILE?: string;

    @IsOptional()
    @IsString()
    @Matches(/^[a-fA-F0-9]{64}$/, { message: 'TESTNET_TO_PAPER_TOKEN_HASH must be a 64-character hex SHA-256' })
    TESTNET_TO_PAPER_TOKEN_HASH?: string;

    @IsOptional()
    @IsString()
    PAPER_TO_LIVE_TOKEN_FILE?: string;

    @IsOptional()
    @IsString()
    @Matches(/^[a-fA-F0-9]{64}$/, { message: 'PAPER_TO_LIVE_TOKEN_HASH must be a 64-character hex SHA-256' })
    PAPER_TO_LIVE_TOKEN_HASH?: string;

    // Safety: only the exact string 'false' selects LIVE endpoints. A typo
    // ('flase'), an empty value, or a missing var defaults to testnet (true) so a
    // mistake can never silently route orders to live (testnet-first invariant).
    // The field default covers an ABSENT key (class-transformer skips @Transform
    // when the key is missing); the transform covers any PRESENT value.
    //
    // LEGACY (pre-M11a): superseded by EXCHANGE_ENV. Retained to keep config
    // consumers that still read it compiling; the engine now switches on
    // EXCHANGE_ENV everywhere it cares about the exchange URL.
    @Transform(({ value }) => String(value).toLowerCase().trim() !== 'false')
    @IsBoolean()
    EXCHANGE_TESTNET: boolean = true;

    @IsOptional()
    @IsString()
    TELEGRAM_BOT_TOKEN?: string;

    @IsOptional()
    @IsString()
    TELEGRAM_CHAT_ID?: string;

    @IsOptional()
    @IsString()
    API_AUTH_TOKEN?: string;

    @Transform(({ value }) => Number.parseInt(String(value), 10))
    @IsInt()
    @Min(1)
    MAX_OPEN_POSITIONS!: number;

    @Transform(({ value }) => Number.parseFloat(String(value)))
    @IsNumber()
    @Min(0)
    MAX_EXPOSURE_PER_COIN_USDT!: number;

    @Transform(({ value }) => Number.parseFloat(String(value)))
    @IsNumber()
    @Min(0)
    DAILY_LOSS_LIMIT_USDT!: number;

    // Rolling-7d loss limit + same-direction exposure cap (ADR 0004 §5). Defaulted so an
    // existing profile without these keys still boots; the @Transform only fires when the key
    // is present (class-transformer skips absent keys), so the field initializer is the default.
    @Transform(({ value }) => Number.parseFloat(String(value)))
    @IsNumber()
    @Min(0)
    WEEKLY_LOSS_LIMIT_USDT: number = 150;

    @Transform(({ value }) => Number.parseFloat(String(value)))
    @IsNumber()
    @Min(0)
    MAX_SAME_DIRECTION_EXPOSURE_USDT: number = 600;

    @Transform(({ value }) => Number.parseInt(String(value), 10))
    @IsInt()
    @Min(0)
    COOLDOWN_AFTER_LOSS_MS!: number;

    @Transform(({ value }) => Number.parseFloat(String(value)))
    @IsNumber()
    @Min(0)
    ACCOUNT_CAPITAL_USDT!: number;

    // Selects the active strategy_versions.id the engine runs on each trigger (ADR 0003
    // §7). Switching the active version is a config change + restart — no code change.
    @Transform(({ value }) => Number.parseInt(String(value), 10))
    @IsInt()
    @Min(1)
    ACTIVE_STRATEGY_VERSION_ID!: number;

    // M5 execution gate. Defaults to DRY_RUN so the slice never fires real orders without an
    // explicit operator opt-in. Only the exact string 'live' (case-insensitive) selects LIVE
    // — any typo or empty value collapses back to DRY_RUN (testnet-first invariant, matches
    // EXCHANGE_TESTNET's defensive parser).
    @Transform(({ value }) => (String(value).toLowerCase().trim() === ExecutionModeEnum.LIVE ? ExecutionModeEnum.LIVE : ExecutionModeEnum.DRY_RUN))
    @IsEnum(ExecutionModeEnum)
    EXECUTION_MODE: ExecutionModeEnum = ExecutionModeEnum.DRY_RUN;

    // ADR 0032 §D11 — PAPER starting equity in USDT. Defaults to $500 to
    // match the live restricted-profile lower bound (security round 2 L2 —
    // keeps trust-posture-relevant magic numbers at the config boundary). The
    // PaperAccountStateService seeds `balanceUsdt` and `peakEquity` to this
    // value on a fresh soak; subsequent boots restore from
    // paper_account_snapshots so this value only takes effect at cold start.
    @Transform(({ value }) => Number.parseFloat(String(value)))
    @IsNumber()
    @Min(0)
    PAPER_STARTING_EQUITY_USDT: number = 500;

    // M11a R2d Item 2 (ADR 0032 §D13). Cadence (ms) at which
    // `PaperExchangeNullityProbe` issues a `fetchOpenOrders` +
    // `fetchPositions` pair against the live Binance sub-account holding the
    // PAPER key. Pinned at 60_000 ms per the D13 cadence specification; the
    // token-bucket budget reserves 2 calls/minute × symbol-fan-out for this
    // probe in the restricted profile.
    @Transform(({ value }) => Number.parseInt(String(value), 10))
    @IsInt()
    @Min(1000)
    PAPER_NULLITY_PROBE_INTERVAL_MS: number = 60_000;

    // M11a R2d Item 2 (ADR 0032 §D13). Maximum exponential-backoff ceiling
    // (ms) after 5 consecutive transport failures. Capped at 1 hour per the
    // D13 failure-class taxonomy so a Binance outage cannot halt the soak.
    @Transform(({ value }) => Number.parseInt(String(value), 10))
    @IsInt()
    @Min(60_000)
    PAPER_NULLITY_PROBE_BACKOFF_MAX_MS: number = 3_600_000;

    // M17 — automated daily DB backup (local disk, 3-deep retention). The
    // directory the engine writes dumps to; its value differs by run context
    // (compose container → /var/backups/trade-bot, host dev → ./backups). A
    // sensible host-dev default keeps `cp .env.example .env` working, but the
    // value must always be a non-empty string. NO committed secret.
    @IsString()
    @IsNotEmpty()
    DB_BACKUP_DIR: string = './backups';

    // M17 — feature flag. Only the exact string 'true' (case-insensitive)
    // enables the scheduler; any typo / empty / missing value collapses to
    // false (safety-first default), so test/CI never spawns pg_dump unless an
    // operator explicitly opts in. Mirrors the EXCHANGE_TESTNET defensive parse.
    @Transform(({ value }) => String(value).toLowerCase().trim() === 'true')
    @IsBoolean()
    DB_BACKUP_ENABLED: boolean = false;

    // M17 — daily dump schedule. Standard 5-field cron, interpreted in UTC by
    // the scheduler. Default 03:00 UTC is offset from the 00:00 PnL summary and
    // the overnight partition crons (low contention for a read-only dump). A
    // malformed cron aborts startup via the fail-fast validateEnv (review H1).
    @IsString()
    @IsFiveFieldCron()
    DB_BACKUP_CRON: string = '0 3 * * *';

    // M17 — number of dumps to keep on disk (current + previous). Must be at
    // least 1; a non-positive value aborts startup.
    @Transform(({ value }) => Number.parseInt(String(value), 10))
    @IsInt()
    @Min(1)
    DB_BACKUP_RETENTION: number = 3;
}
