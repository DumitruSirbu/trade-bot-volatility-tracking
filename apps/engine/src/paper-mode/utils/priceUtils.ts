import { Decimal } from 'decimal.js';

export function isPositiveDecimalString(value: string): boolean {
    try {
        const parsed = new Decimal(value);

        return parsed.isFinite() && parsed.isPositive() && !parsed.isZero();
    } catch {
        return false;
    }
}
