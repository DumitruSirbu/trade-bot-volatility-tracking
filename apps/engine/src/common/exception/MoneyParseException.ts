import { DomainException } from './DomainException';

// Raised when a value cannot be parsed into a money Decimal. Wraps the
// underlying decimal.js error so callers see a typed domain failure with the
// offending input, never a leaked third-party error.
export class MoneyParseException extends DomainException {
    constructor(rawValue: string, cause: unknown) {
        super('MONEY_PARSE_FAILED', `Cannot parse money value: ${rawValue}`, cause);
    }
}
