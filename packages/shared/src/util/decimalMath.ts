import { Decimal } from 'decimal.js';

/**
 * Shared decimal math utilities for fill-simulator core.
 * Uses decimal.js with standard precision + ROUND_HALF_EVEN (banker's rounding).
 * Pure functions: no I/O, no side effects.
 */

// Type alias for Decimal instances per decimal.js d.ts pattern (avoids TS2709 namespace-collision).
type DecimalT = InstanceType<typeof Decimal>;

// Decimal.js context for shared utilities (standard precision for non-monetary calculations).
const SharedDecimal = Decimal.clone({
	precision: 28,
	rounding: Decimal.ROUND_HALF_EVEN,
});

/**
 * Parse a string as a Decimal.
 */
export function parseDecimal(value: string | number): DecimalT {
	return new SharedDecimal(value);
}

/**
 * Format a Decimal as a fixed-precision string.
 */
export function formatDecimal(value: DecimalT): string {
	return value.toFixed();
}

/**
 * Add two Decimal values.
 */
export function addDecimal(left: DecimalT, right: DecimalT): DecimalT {
	return left.plus(right);
}

/**
 * Subtract two Decimal values.
 */
export function subtractDecimal(left: DecimalT, right: DecimalT): DecimalT {
	return left.minus(right);
}

/**
 * Multiply two Decimal values.
 */
export function multiplyDecimal(left: DecimalT, right: DecimalT): DecimalT {
	return left.times(right);
}

/**
 * Divide two Decimal values.
 */
export function divideDecimal(left: DecimalT, right: DecimalT): DecimalT {
	return left.dividedBy(right);
}

/**
 * Compare two Decimal values.
 * Returns: -1 if left < right, 0 if equal, 1 if left > right.
 */
export function compareDecimal(left: DecimalT, right: DecimalT): number {
	return left.comparedTo(right);
}

/**
 * Check if left > right.
 */
export function isGreaterThan(left: DecimalT, right: DecimalT): boolean {
	return left.greaterThan(right);
}

/**
 * Check if left >= right.
 */
export function isGreaterThanOrEqual(left: DecimalT, right: DecimalT): boolean {
	return left.greaterThanOrEqualTo(right);
}

/**
 * Check if left < right.
 */
export function isLessThan(left: DecimalT, right: DecimalT): boolean {
	return left.lessThan(right);
}

/**
 * Check if left <= right.
 */
export function isLessThanOrEqual(left: DecimalT, right: DecimalT): boolean {
	return left.lessThanOrEqualTo(right);
}

/**
 * Check if left === right.
 */
export function isEqual(left: DecimalT, right: DecimalT): boolean {
	return left.equals(right);
}
