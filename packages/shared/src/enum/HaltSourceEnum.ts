export enum HaltSourceEnum {
    OPERATOR = 'operator',
    MARKET_STRESS = 'market_stress',
    MODEL_DIVERGENCE = 'model_divergence',
    DAILY_LOSS = 'daily_loss',
    WEEKLY_LOSS = 'weekly_loss',
    RECOVERY = 'recovery',
    // M11a W1.4 (ADR 0030 §2.6.2). Source label for programmatic halts engaged
    // by the in-engine rate-limit policy on Binance 429/418.
    RATE_LIMIT = 'rate_limit',
    OTHER = 'other',
}
