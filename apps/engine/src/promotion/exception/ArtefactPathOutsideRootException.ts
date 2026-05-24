import { DomainException } from '../../common/exception';

// Raised when a `comparison_reports.artefact_uri` (or a freshly-resolved writer
// path) resolves outside `BACKTEST_ARTEFACT_ROOT`. The reader and writer both
// path-resolve against the configured root and reject if `path.relative(root, p)`
// escapes — guarding against an operator-typo'd env value or a tampered DB row
// feeding arbitrary paths to `fs.readFile` / `fs.open`.
export class ArtefactPathOutsideRootException extends DomainException {
    constructor(message: string) {
        super('ARTEFACT_PATH_OUTSIDE_ROOT', message);
    }
}
