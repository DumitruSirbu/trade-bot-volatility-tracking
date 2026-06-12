import fs from 'node:fs';
import path from 'node:path';
import { fail, pass, REPO_ROOT } from './lib.mjs';

const adrDir = path.join(REPO_ROOT, 'docs/architecture/adr');

if (!fs.existsSync(adrDir)) {
    fail('docs/architecture/adr/ is missing');
    process.exit(1);
}

const files = fs.readdirSync(adrDir).filter((name) => name.endsWith('.md'));
const numberToFiles = new Map();
const filenamePattern = /^\d{4}-.+\.md$/;

for (const fileName of files) {
    if (fileName === 'README.md') {
        continue;
    }

    if (!filenamePattern.test(fileName)) {
        fail(`ADR filename does not match NNNN-title.md: ${fileName}`);
    }

    const number = fileName.slice(0, 4);
    const bucket = numberToFiles.get(number) ?? [];
    bucket.push(fileName);
    numberToFiles.set(number, bucket);
}

for (const [number, bucket] of numberToFiles.entries()) {
    if (bucket.length > 1) {
        fail(`duplicate ADR number ${number}: ${bucket.join(', ')}`);
    }
}

pass(`ADR integrity OK (${numberToFiles.size} numbered ADRs, no duplicates)`);
