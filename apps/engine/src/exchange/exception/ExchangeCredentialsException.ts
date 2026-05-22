import { DomainException } from '../../common/exception';

// Thrown when the active exchange profile requires API credentials (testnet/live
// trading) but they are absent from config. Failing fast here prevents silently
// building a degraded client that would later reject every signed request.
export class ExchangeCredentialsException extends DomainException {
    constructor(profile: string) {
        super('EXCHANGE_CREDENTIALS_MISSING', `Exchange credentials are required for the ${profile} profile but were not provided`);
    }
}
