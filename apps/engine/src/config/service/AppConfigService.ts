import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EnvironmentVariables } from '../EnvironmentVariables';
import { LogLevelEnum, NodeEnvEnum } from '../enum';

// Typed, DI-friendly accessor over the validated environment. Other modules
// depend on this — never on raw process.env or the untyped ConfigService — so
// every config read is type-checked and resolves to a validated value.
@Injectable()
export class AppConfigService {
    constructor(private readonly configService: ConfigService<EnvironmentVariables, true>) {}

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

    get cooldownAfterLossMs(): number {
        return this.configService.get('COOLDOWN_AFTER_LOSS_MS', { infer: true });
    }

    get accountCapitalUsdt(): number {
        return this.configService.get('ACCOUNT_CAPITAL_USDT', { infer: true });
    }

    get activeStrategyVersionId(): number {
        return this.configService.get('ACTIVE_STRATEGY_VERSION_ID', { infer: true });
    }
}
