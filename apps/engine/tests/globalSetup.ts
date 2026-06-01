/**
 * Jest globalSetup entry point.
 *
 * The canonical implementation lives in tests/support/globalSetup.ts (next to
 * the support helpers it depends on). This re-export keeps a stable top-level
 * path so jest.config.js can reference either location without duplicating the
 * env-loading + assertTestDb + pre-migration logic.
 */

export { default } from './support/globalSetup';
