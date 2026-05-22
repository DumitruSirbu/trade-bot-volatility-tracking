/**
 * Jest global teardown — destroys the shared test DataSource so the Jest
 * process can exit cleanly without the "open handles" warning.
 */

import { destroyTestDataSource } from './testDataSource';

export default async function globalTeardown(): Promise<void> {
    await destroyTestDataSource();
}
