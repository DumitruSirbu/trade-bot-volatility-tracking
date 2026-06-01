import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from 'dotenv';

import { assertTestDb } from './assertTestDb';
import { getTestDataSource } from './testDataSource';

export default async function globalSetup(): Promise<void> {
    const envTest = resolve(__dirname, '../../../../.env.test');
    if (existsSync(envTest)) {
        config({ path: envTest });
    }

    await assertTestDb();

    // Pre-migrate the integration DB once so all suites find the schema ready,
    // regardless of execution order (role specs connect via raw pg.Client and
    // cannot run migrations themselves).
    await getTestDataSource();
}
