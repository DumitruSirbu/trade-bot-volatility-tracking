// M14 W3 — shared filesystem anchors for the CI gate entrypoints.
//
// These scripts live at apps/engine/tests/ci/, so the repo root is four levels up
// (apps/engine/tests/ci → apps/engine/tests → apps/engine → repo root).

import { join } from 'node:path';

export const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

export const AUDIT_ALLOWLIST_PATH = join(REPO_ROOT, '.github', 'audit-allowlist.json');

export const EXCHANGE_CRITICAL_DEPS_PATH = join(REPO_ROOT, '.github', 'exchange-critical-deps.json');
