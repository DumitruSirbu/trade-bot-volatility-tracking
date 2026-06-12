import { IPositionClosedEvent } from '../../common/interface/IPositionClosedEvent';
import { IPositionOpenedEvent } from '../../common/interface/IPositionOpenedEvent';
import { DecimalValue, MoneyValue } from '../../common/utils/money';

// M32 §4.4 — pure formatters for the enriched POSITION_OPENED / POSITION_CLOSED
// Telegram message bodies. No I/O, no Date.now(), no clock (timestamps arrive on the
// event). Every function is total: a null/undefined money or date branches to `n/a`
// rather than throwing, so `publishSafe` never sees an exception from this module.
//
// Money rendering rules (ADR 0024 §2.3 + M32 §4.4):
//   - USD-denominated amounts (notional, realized PnL) render at 2dp: `$1,234.56`.
//   - Price fields (entry/exit) use ADAPTIVE precision so a sub-cent micro-priced coin
//     (e.g. SHIB at $0.00001823) is not flattened to `$0.00`.
//   - `leverage` is a DecimalValue multiplier, NOT money — it renders as `{leverage}x`.

const NOT_AVAILABLE = 'n/a';
const PRICE_DP_STANDARD = 2;
const PRICE_DP_SUB_DOLLAR = 4;
const PRICE_DP_MICRO = 8;
const USD_DP = 2;

const MILLIS_PER_SECOND = 1_000;
const MILLIS_PER_MINUTE = 60 * MILLIS_PER_SECOND;
const MILLIS_PER_HOUR = 60 * MILLIS_PER_MINUTE;
const MILLIS_PER_DAY = 24 * MILLIS_PER_HOUR;

const ONE_DOLLAR = '1';
const ONE_CENT = '0.01';

export function formatPositionOpenedBody(event: IPositionOpenedEvent): string {
    const direction = event.side.toUpperCase();
    const leverage = formatLeverage(event.leverage);
    const entry = formatPrice(event.entryPrice);
    const notional = formatUsd(event.entryNotional);
    const strat = `strat v${event.strategyVersionId}`;

    return `${direction} ${leverage} @ ${entry}  ·  notional ${notional}  ·  ${strat}`;
}

export function formatPositionClosedBody(event: IPositionClosedEvent): string {
    const direction = event.side.toUpperCase();
    const leverage = formatLeverage(event.leverage);
    const entry = formatPrice(event.entryPrice);
    const exit = formatPriceOrNa(event.exitPrice);
    const realized = formatSignedUsdOrNa(event.realizedPnl);
    const held = formatDuration(event.closedAt, event.openedAt);
    const exitReason = event.exitReason ?? 'unknown';
    const strat = `strat v${event.strategyVersionId}`;

    const firstLine = `${direction} ${leverage}  ·  entry ${entry} → exit ${exit}`;
    const secondLine = `realized ${realized} (net)  ·  held ${held}  ·  exit: ${exitReason}  ·  ${strat}`;

    return `${firstLine}\n${secondLine}`;
}

// Hold duration from open → close. Pure; null close → `n/a`; zero/negative delta
// (same-ms close or minor clock skew) → `0s`. Caller passes the event timestamps.
export function formatDuration(closedAt: Date | null | undefined, openedAt: Date): string {
    if (closedAt === null || closedAt === undefined) {
        return NOT_AVAILABLE;
    }

    const deltaMs = closedAt.getTime() - openedAt.getTime();

    if (deltaMs <= 0) {
        return '0s';
    }

    return renderDuration(deltaMs);
}

function renderDuration(deltaMs: number): string {
    if (deltaMs < MILLIS_PER_MINUTE) {
        return `${Math.floor(deltaMs / MILLIS_PER_SECOND)}s`;
    }

    if (deltaMs < MILLIS_PER_HOUR) {
        const minutes = Math.floor(deltaMs / MILLIS_PER_MINUTE);
        const seconds = Math.floor((deltaMs % MILLIS_PER_MINUTE) / MILLIS_PER_SECOND);

        return `${minutes}m ${seconds}s`;
    }

    if (deltaMs < MILLIS_PER_DAY) {
        const hours = Math.floor(deltaMs / MILLIS_PER_HOUR);
        const minutes = Math.floor((deltaMs % MILLIS_PER_HOUR) / MILLIS_PER_MINUTE);

        return `${hours}h ${minutes}m`;
    }

    const days = Math.floor(deltaMs / MILLIS_PER_DAY);
    const hours = Math.floor((deltaMs % MILLIS_PER_DAY) / MILLIS_PER_HOUR);

    return `${days}d ${hours}h`;
}

function formatLeverage(leverage: DecimalValue): string {
    return `${leverage.toFixed()}x`;
}

function formatPriceOrNa(price: MoneyValue | null | undefined): string {
    if (price === null || price === undefined) {
        return NOT_AVAILABLE;
    }

    return formatPrice(price);
}

// Adaptive-precision price. Magnitude (absolute value) chooses the decimal places so a
// negative is never miscategorised and a micro-price never collapses to `$0.00`.
function formatPrice(price: MoneyValue): string {
    const magnitude = price.abs();
    const decimalPlaces = priceDecimalPlaces(magnitude);

    return formatDollars(price, decimalPlaces);
}

function priceDecimalPlaces(magnitude: MoneyValue): number {
    if (magnitude.gte(ONE_DOLLAR)) {
        return PRICE_DP_STANDARD;
    }

    if (magnitude.gte(ONE_CENT)) {
        return PRICE_DP_SUB_DOLLAR;
    }

    return PRICE_DP_MICRO;
}

function formatSignedUsdOrNa(amount: MoneyValue | null | undefined): string {
    if (amount === null || amount === undefined) {
        return NOT_AVAILABLE;
    }

    const sign = amount.isNegative() ? '−' : '+';

    return `${sign}${formatUsd(amount.abs())}`;
}

function formatUsd(amount: MoneyValue): string {
    return formatDollars(amount, USD_DP);
}

// Render a Decimal as `$` with grouped thousands at a fixed precision, preserving the
// sign. Grouping is applied to the integer part only; never via Number() / float.
function formatDollars(value: MoneyValue, decimalPlaces: number): string {
    const fixed = value.toFixed(decimalPlaces);
    const isNegative = fixed.startsWith('-');
    const unsigned = isNegative ? fixed.slice(1) : fixed;
    const [integerPart, fractionPart] = unsigned.split('.');
    const grouped = groupThousands(integerPart);
    const body = fractionPart === undefined ? grouped : `${grouped}.${fractionPart}`;

    return `${isNegative ? '-' : ''}$${body}`;
}

function groupThousands(integerDigits: string): string {
    return integerDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
