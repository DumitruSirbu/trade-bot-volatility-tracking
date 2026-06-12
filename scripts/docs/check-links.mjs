import fs from 'node:fs';
import {
    collectDocScanTargets,
    extractMarkdownLinks,
    fail,
    pass,
    resolveMarkdownTarget,
} from './lib.mjs';

const broken = [];

for (const filePath of collectDocScanTargets()) {
    const content = fs.readFileSync(filePath, 'utf8');

    for (const rawTarget of extractMarkdownLinks(content)) {
        const resolved = resolveMarkdownTarget(filePath, rawTarget);

        if (resolved === null) {
            continue;
        }

        if (!fs.existsSync(resolved)) {
            broken.push({ filePath, rawTarget, resolved });
        }
    }
}

if (broken.length > 0) {
    for (const item of broken) {
        fail(`${item.filePath}: broken link "${item.rawTarget}" → ${item.resolved}`);
    }
} else {
    pass('all internal markdown links resolve');
}
