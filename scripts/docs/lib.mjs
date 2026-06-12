import fs from 'node:fs';
import path from 'node:path';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

export function readUtf8(filePath) {
    return fs.readFileSync(filePath, 'utf8');
}

export function listMarkdownFiles(rootDir) {
    const results = [];

    function walk(dir) {
        if (!fs.existsSync(dir)) {
            return;
        }

        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                walk(fullPath);
                continue;
            }

            if (entry.isFile() && entry.name.endsWith('.md')) {
                results.push(fullPath);
            }
        }
    }

    walk(rootDir);
    return results;
}

export function collectDocScanTargets() {
    const targets = [];

    const docsDir = path.join(REPO_ROOT, 'docs');
    if (fs.existsSync(docsDir)) {
        targets.push(...listMarkdownFiles(docsDir));
    }

    for (const rel of ['AGENTS.md', 'CLAUDE.md']) {
        const filePath = path.join(REPO_ROOT, rel);

        if (fs.existsSync(filePath)) {
            targets.push(filePath);
        }
    }

    const agentsDir = path.join(REPO_ROOT, '.claude/agents');
    if (fs.existsSync(agentsDir)) {
        targets.push(...listMarkdownFiles(agentsDir));
    }

    return targets;
}

export function extractMarkdownLinks(content) {
    const links = [];
    const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
    let match;

    while ((match = pattern.exec(content)) !== null) {
        links.push(match[1].trim());
    }

    return links;
}

export function resolveMarkdownTarget(sourceFile, rawTarget) {
    const target = rawTarget.split('#')[0].trim();

    if (
        target === '' ||
        target.startsWith('http://') ||
        target.startsWith('https://') ||
        target.startsWith('mailto:') ||
        target.startsWith('#')
    ) {
        return null;
    }

    // Skip pseudo-links from inline math / prose (e.g. `[1 − abs(btc5mMovePct](...)`).
    if (!/^(\.{1,2}\/|\/|[A-Za-z0-9._-]+\.md)/.test(target)) {
        return null;
    }

    if (/[^\w./\-+#%]/.test(target.replace(/%[0-9A-Fa-f]{2}/g, ''))) {
        return null;
    }

    return path.normalize(path.resolve(path.dirname(sourceFile), target));
}

export function fail(message) {
    console.error(`ERROR: ${message}`);
    process.exitCode = 1;
}

export function pass(label) {
    console.log(`OK: ${label}`);
}
