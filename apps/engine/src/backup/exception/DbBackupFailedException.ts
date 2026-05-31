import { DomainException } from '../../common/exception';

// Wraps any failure inside the pg_dump boundary (non-zero exit, spawn error,
// write/rename error, missing dir) so the scheduler never throws a raw Error.
// The carried `cause` is a SANITISED string — never the connection string and
// never the child argv — so no credential can leak downstream (review M3).
export class DbBackupFailedException extends DomainException {
    constructor(operation: string, cause?: string) {
        super('DB_BACKUP_FAILED', `Database backup failed during ${operation}`, cause);
    }
}
