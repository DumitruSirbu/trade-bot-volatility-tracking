import { validateCronExpression } from 'cron';
import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

import { CRON_FIELD_COUNT } from './const';

// M17 — strict 5-field cron validator for DB_BACKUP_CRON. The `cron` library's
// own `validateCronExpression` also accepts 6-field (seconds) expressions and
// `@`-aliases (`@daily`), which the M17 contract forbids (standard 5-field UTC
// only). So we layer an exact-field-count check ON TOP of the library parse:
// the count guard rejects 6-field / alias forms, and validateCronExpression
// rejects an out-of-range or malformed 5-field expression. A malformed value
// here aborts startup via the fail-fast validateEnv hook.

function isFiveFieldCron(value: unknown): boolean {
    if (typeof value !== 'string') {
        return false;
    }

    const fields = value.trim().split(/\s+/u);

    if (fields.length !== CRON_FIELD_COUNT) {
        return false;
    }

    return validateCronExpression(value).valid;
}

export function IsFiveFieldCron(validationOptions?: ValidationOptions) {
    return function registerOnProperty(target: object, propertyName: string): void {
        registerDecorator({
            name: 'isFiveFieldCron',
            target: target.constructor,
            propertyName,
            options: validationOptions,
            constraints: [],
            validator: {
                validate(value: unknown): boolean {
                    return isFiveFieldCron(value);
                },
                defaultMessage(args: ValidationArguments): string {
                    return `${args.property} must be a valid standard 5-field cron expression (UTC)`;
                },
            },
        });
    };
}
