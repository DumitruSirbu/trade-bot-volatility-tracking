import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

import { ExecutionModeEnum, LogLevelEnum, NodeEnvEnum } from './enum';

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

    // Safety: only the exact string 'false' selects LIVE endpoints. A typo
    // ('flase'), an empty value, or a missing var defaults to testnet (true) so a
    // mistake can never silently route orders to live (testnet-first invariant).
    // The field default covers an ABSENT key (class-transformer skips @Transform
    // when the key is missing); the transform covers any PRESENT value.
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
}
