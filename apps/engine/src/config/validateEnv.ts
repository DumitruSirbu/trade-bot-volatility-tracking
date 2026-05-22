import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { EnvironmentVariables } from './EnvironmentVariables';

// @nestjs/config calls this synchronously at bootstrap. Throwing here aborts
// startup before any module initialises — the fail-fast guarantee. Each message
// names the offending variable so the operator sees exactly what to fix.
export function validateEnv(rawConfig: Record<string, unknown>): EnvironmentVariables {
    const validatedConfig = plainToInstance(EnvironmentVariables, rawConfig, {
        enableImplicitConversion: false,
    });

    const errors = validateSync(validatedConfig, {
        skipMissingProperties: false,
        whitelist: false,
    });

    if (errors.length > 0) {
        const details = errors
            .map((error) => {
                const constraints = Object.values(error.constraints ?? {}).join(', ');

                return `  - ${error.property}: ${constraints}`;
            })
            .join('\n');

        throw new Error(`Invalid environment configuration. Fix the following variable(s):\n${details}`);
    }

    return validatedConfig;
}
