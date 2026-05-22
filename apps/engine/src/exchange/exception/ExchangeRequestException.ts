import { DomainException } from '../../common/exception';

// Wraps any failure that originates inside the ccxt boundary (network, auth,
// rate-limit, bad-response). The carried `cause` is the SANITIZED error message
// (a string with credentials redacted), never the raw ccxt error object, so ccxt
// types never leak past ExchangeModule and no unredacted key/signature can be
// serialized downstream (e.g. by AllExceptionsFilter).
export class ExchangeRequestException extends DomainException {
    constructor(operation: string, cause?: string) {
        super('EXCHANGE_REQUEST_FAILED', `Exchange request failed during ${operation}`, cause);
    }
}
