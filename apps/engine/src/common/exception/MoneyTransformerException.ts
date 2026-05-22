import { DomainException } from './DomainException';

// Raised by the NUMERIC↔decimal column transformer when a JS `number` reaches the
// write path. A float would already be corrupted before decimal.js sees it, so the
// transformer refuses it loudly rather than letting float money leak through the ORM
// (ADR 0002 §2). Mirrors parseMoney's refusal of `number`.
export class MoneyTransformerException extends DomainException {
    constructor(receivedType: string) {
        super(
            'MONEY_TRANSFORMER_REJECTED_NUMBER',
            `decimalColumnTransformer refused a non-decimal money value (received: ${receivedType}). ` +
                'Money must reach the driver as a MoneyValue or decimal string, never a JS number.',
        );
    }
}
