// ADX(period) result: the trend-strength index plus the +DI/−DI directional
// indices (all dimensionless, 0–100).
export interface IAdxResult {
    adx: number;
    diPlus: number;
    diMinus: number;
}
