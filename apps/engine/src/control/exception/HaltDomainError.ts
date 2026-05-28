export class HaltDomainError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'HaltDomainError';
    }
}
