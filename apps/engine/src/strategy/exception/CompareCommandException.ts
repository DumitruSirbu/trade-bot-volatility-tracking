import { DomainException } from '../../common/exception';

// Raised by CompareCommand when a CLI-supplied version spec cannot be resolved
// to a strategy_versions row (unknown id, unknown name:version). Distinct from
// argument-parse failures (those stay as parseCompareArgs's typed parse errors)
// so the CLI can render a structured "no such version" message.
export class CompareCommandException extends DomainException {
    constructor(message: string) {
        super('COMPARE_COMMAND_INVALID', message);
    }
}
