import fs from 'node:fs';
import path from 'node:path';
import { fail, pass, readUtf8, REPO_ROOT } from './lib.mjs';

const statusPath = path.join(REPO_ROOT, 'docs/STATUS.md');
const plansIndexPath = path.join(REPO_ROOT, 'docs/plans/README.md');

if (!fs.existsSync(statusPath)) {
    fail('docs/STATUS.md is missing');
    process.exit(1);
}

if (!fs.existsSync(plansIndexPath)) {
    fail('docs/plans/README.md is missing');
    process.exit(1);
}

const statusText = readUtf8(statusPath);
const plansText = readUtf8(plansIndexPath);

const statusActiveMatch = statusText.match(/\|\s*\*\*ACTIVE\*\*\s*\|\s*\*\*(M\d+(?:\.\d+)?[a-z]?)\*\*/i);
const statusActiveId = statusActiveMatch?.[1]?.toUpperCase() ?? null;

if (!statusActiveId) {
    fail('could not parse ACTIVE milestone ID from docs/STATUS.md (expected **M##** in ACTIVE row)');
}

const activeRows = [];
const rowPattern = /^\|\s*(M\d+(?:\.\d+)?[a-z]?|00-overview)\s*\|\s*(ACTIVE|DONE|DEFERRED|INDEX)\s*\|/gim;
let rowMatch;

while ((rowMatch = rowPattern.exec(plansText)) !== null) {
    activeRows.push({
        id: rowMatch[1].toUpperCase(),
        status: rowMatch[2].toUpperCase(),
    });
}

const activeStatusRows = activeRows.filter((row) => row.status === 'ACTIVE');

if (activeStatusRows.length !== 1) {
    fail(
        `expected exactly one ACTIVE row in docs/plans/README.md, found ${activeStatusRows.length}`,
    );
}

const indexActiveId = activeStatusRows[0].id;

if (indexActiveId !== statusActiveId) {
    fail(
        `ACTIVE mismatch: docs/STATUS.md=${statusActiveId}, docs/plans/README.md=${indexActiveId}`,
    );
}

const idsByStatus = new Map();

for (const row of activeRows) {
    const existing = idsByStatus.get(row.id);

    if (existing && existing !== row.status) {
        fail(`milestone ${row.id} listed with conflicting statuses (${existing} vs ${row.status})`);
    }

    idsByStatus.set(row.id, row.status);
}

pass(`ACTIVE milestone ${statusActiveId} matches STATUS.md and plans/README.md`);
