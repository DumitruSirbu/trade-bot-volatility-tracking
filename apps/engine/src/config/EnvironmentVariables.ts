import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

import { LogLevelEnum, NodeEnvEnum } from './enum';

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

    @Transform(({ value }) => Number.parseInt(String(value), 10))
    @IsInt()
    @Min(0)
    COOLDOWN_AFTER_LOSS_MS!: number;

    @Transform(({ value }) => Number.parseFloat(String(value)))
    @IsNumber()
    @Min(0)
    ACCOUNT_CAPITAL_USDT!: number;
}
