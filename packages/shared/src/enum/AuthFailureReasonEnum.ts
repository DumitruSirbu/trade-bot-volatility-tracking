export enum AuthFailureReasonEnum {
    EXPIRED = 'expired',
    REVOKED = 'revoked',
    MALFORMED = 'malformed',
    MISSING = 'missing',
    BAD_SCOPE = 'bad_scope',
    CORS_FORBIDDEN = 'cors_forbidden',
    BAD_SECRET = 'bad_secret',
}
