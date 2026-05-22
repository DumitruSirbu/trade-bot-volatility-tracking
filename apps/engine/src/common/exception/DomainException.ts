// Base for all domain exceptions. Carrying a stable `code` lets the (future)
// AllExceptionsFilter map to the canonical JSON error shape without string
// matching on messages. Throw subclasses of this — never raw Error — from
// domain code so failures are typed and self-describing.
export abstract class DomainException extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly cause?: unknown,
    ) {
        super(message);
        this.name = new.target.name;
    }
}
