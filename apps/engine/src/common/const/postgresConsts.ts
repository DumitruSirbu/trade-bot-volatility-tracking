// Postgres SQLSTATE codes used in driver-error classification. Single source of
// truth so repository unique-violation catches don't re-declare the magic string
// in each file. The SQLSTATE codes are stable across Postgres versions, locales,
// and TypeORM wrapper versions — substring-matching the message text is the
// anti-pattern the reject taxonomy already eliminated.
//
// Reference: https://www.postgresql.org/docs/current/errcodes-appendix.html
export const POSTGRES_UNIQUE_VIOLATION_SQLSTATE = '23505';
