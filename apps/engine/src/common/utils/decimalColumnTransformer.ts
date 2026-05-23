import { ValueTransformer } from 'typeorm';

import { MoneyTransformerException } from '../exception';
import { formatMoney, MoneyValue, parseMoney } from './money';

// The ONLY way a NUMERIC column maps into code (ADR 0002 §2). Every money/price
// column declares `transformer: decimalColumnTransformer` and types its property as
// MoneyValue — never `number`.
//
//   to(value)   entity → driver (write): MoneyValue | null → string | null
//   from(value) driver → entity (read):  string | null     → MoneyValue | null
//
// A JS `number` passed to to() is a programmer error: a float would already be
// corrupted before decimal.js sees it, so we throw rather than silently leak float
// money through the ORM. A decimal STRING is accepted (drivers occasionally hand a
// string back round-trip, and a pre-formatted value is already lossless).
//
// decimal.js parses "NaN"/"Infinity"/"-Infinity" as special, non-finite Decimal
// values WITHOUT throwing. Both branches of to() and the from() read path therefore
// guard with isFinite() before formatting — otherwise Postgres NUMERIC would reject
// the row with a raw pg error instead of a typed MoneyTransformerException.
export const decimalColumnTransformer: ValueTransformer = {
    to(value: MoneyValue | string | null): string | null {
        if (value === null || value === undefined) {
            return null;
        }

        if (typeof value === 'number') {
            throw new MoneyTransformerException('number');
        }

        const parsed = typeof value === 'string' ? parseMoney(value) : value;

        if (!parsed.isFinite()) {
            throw new MoneyTransformerException('non-finite', 'to', parsed.toString());
        }

        return formatMoney(parsed);
    },

    from(value: string | null): MoneyValue | null {
        if (value === null || value === undefined) {
            return null;
        }

        const parsed = parseMoney(value);

        if (!parsed.isFinite()) {
            throw new MoneyTransformerException('non-finite', 'from', parsed.toString());
        }

        return parsed;
    },
};
