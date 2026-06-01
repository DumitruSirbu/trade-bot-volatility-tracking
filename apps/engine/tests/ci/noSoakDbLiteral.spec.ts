import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('no-5433 soak-DB tripwire', () => {
    const testsDir = resolve(__dirname, '../..');

    it('has no :5433 URL literals in test files', () => {
        // Anchor to port boundary so :54330 or similar does not false-positive.
        const result = execSync(`grep -rEn ':5433([^0-9]|$)' "${testsDir}" --include="*.ts" || true`).toString();

        const disallowedLines = result
            .split('\n')
            .filter((line) => line.trim() !== '')
            // Allowlisted files that legitimately reference :5433 for non-soak reasons:
            //   validateEnv.spec.ts  — tests DB_PORT as a plain integer, never a DSN
            //   assertTestDb.spec.ts — uses 5433 as a deliberate reject-case input
            //   noSoakDbLiteral.spec.ts (this file) — contains the grep pattern string
            .filter((line) => !line.includes('validateEnv.spec.ts'))
            .filter((line) => !line.includes('assertTestDb.spec.ts'))
            .filter((line) => !line.includes('noSoakDbLiteral.spec.ts'));

        if (disallowedLines.length > 0) {
            throw new Error('Found :5433 URL literals in test files (only validateEnv.spec.ts is allowed):\n' + disallowedLines.join('\n'));
        }

        // If we reach here the assertion passed — no disallowed literals found.
        expect(disallowedLines).toHaveLength(0);
    });

    it('has no DB_PORT=5433 instructions in test files', () => {
        const result = execSync(`grep -rn 'DB_PORT=5433' "${testsDir}" --include="*.ts" || true`).toString();

        const matches = result
            .split('\n')
            .filter((line) => line.trim() !== '')
            // This file contains the grep pattern string itself — exclude it.
            .filter((line) => !line.includes('noSoakDbLiteral.spec.ts'));

        if (matches.length > 0) {
            throw new Error('Found stale DB_PORT=5433 instructions in test files:\n' + matches.join('\n'));
        }

        expect(matches).toHaveLength(0);
    });
});
