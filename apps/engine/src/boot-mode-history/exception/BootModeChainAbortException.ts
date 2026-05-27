import { DomainException } from '../../common/exception';

// Thrown by BootModeChainService.abortSecurityCritical AFTER process.exit has
// been invoked, so test harnesses that stub process.exit get a typed,
// catchable exception rather than silently advancing past the abort. In
// production process.exit terminates before the throw is reached; the
// exception only surfaces under tests. Typed (rather than raw Error) so tests
// can assert `instanceof BootModeChainAbortException` and so any logger /
// pino-pretty stack format treats it as a domain exception (ADR 0032 §D6).
export class BootModeChainAbortException extends DomainException {
    constructor(reason: string) {
        super('BOOT_MODE_CHAIN_ABORT', `process.exit returned after boot-mode-chain abort: ${reason}`);
    }
}
