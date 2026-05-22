import { Decimal } from 'decimal.js';

// Decimal.js precision/scale for monetary math. Exchange prices and quantities
// fit comfortably inside 28 significant digits; ROUND_DOWN avoids ever rounding
// notional UP past a risk limit. Wire-serialised money keeps full precision as a string.
export const MONEY_PRECISION = 28;

// Symbolic rounding mode (not the magic literal 1) so it can't drift if the
// decimal.js enum order ever changes. ROUND_DOWN is for sizing/notional caps only.
export const MONEY_ROUNDING = Decimal.ROUND_DOWN;
