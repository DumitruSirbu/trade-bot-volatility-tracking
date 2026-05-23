import { DomainException } from './DomainException';

// Raised by the NUMERIC↔decimal column transformer when a value reaches the wire
// path that violates ADR 0002 §money-as-decimal. Two failure modes today:
//   - 'number'      : a JS number reached to() — a float would already be corrupted
//                     before decimal.js sees it, so the transformer refuses it loudly.
//   - 'non-finite'  : a Decimal that parsed as NaN/Infinity/-Infinity reached to()
//                     or from(). decimal.js accepts the strings "NaN"/"Infinity"
//                     silently; Postgres NUMERIC would then reject the row with a
//                     raw pg error instead of a typed domain exception. Guarding
//                     here keeps the boundary contract intact in both directions.
export type MoneyTransformerDirection = 'to' | 'from';

export class MoneyTransformerException extends DomainException {
    constructor(receivedType: string);
    constructor(reason: 'non-finite', direction: MoneyTransformerDirection, offendingValue: string);
    constructor(receivedTypeOrReason: string, direction?: MoneyTransformerDirection, offendingValue?: string) {
        if (receivedTypeOrReason === 'non-finite') {
            super(
                'MONEY_TRANSFORMER_REJECTED_NON_FINITE',
                `decimalColumnTransformer refused a non-finite money value on the '${direction}' path ` +
                    `(received: ${offendingValue}). NaN/Infinity must never reach a NUMERIC column ` +
                    '(ADR 0002 §money-as-decimal).',
            );
            return;
        }

        super(
            'MONEY_TRANSFORMER_REJECTED_NUMBER',
            `decimalColumnTransformer refused a non-decimal money value (received: ${receivedTypeOrReason}). ` +
                'Money must reach the driver as a MoneyValue or decimal string, never a JS number.',
        );
    }
}
