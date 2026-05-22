import { MoneyValue } from '../../common/utils/money';

// Bollinger Bands: middle (SMA) and ± multiplier×σ bands as decimal prices, plus
// %B — where the close sits within the bands (dimensionless ratio).
export interface IBollingerResult {
    upper: MoneyValue;
    lower: MoneyValue;
    middle: MoneyValue;
    percentB: number;
}
