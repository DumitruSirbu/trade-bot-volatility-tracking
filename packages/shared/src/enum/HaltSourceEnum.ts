export enum HaltSourceEnum {
    OPERATOR = 'operator',
    MARKET_STRESS = 'market_stress',
    MODEL_DIVERGENCE = 'model_divergence',
    DAILY_LOSS = 'daily_loss',
    WEEKLY_LOSS = 'weekly_loss',
    RECOVERY = 'recovery',
    OTHER = 'other',
}
