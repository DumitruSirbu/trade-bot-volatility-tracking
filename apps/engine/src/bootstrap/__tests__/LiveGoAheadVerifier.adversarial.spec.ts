/**
 * Adversarial tests for LiveGoAheadVerifier (M11a W1.1).
 *
 * All negative paths: hash mismatch, file missing, file empty, whitespace-only.
 * DEMO / TESTNET env must skip the gate entirely (no file reads, no throws).
 */

import { ExchangeEnvironmentEnum } from '@bot/shared';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, unlink, chmod } from 'node:fs/promises';
import * as crypto from 'node:crypto';

import { LiveGoAheadVerifier } from '../LiveGoAheadVerifier';

// ─── factory helpers ──────────────────────────────────────────────────────────

function makeConfig(overrides: { liveGoAheadTokenFile?: string; liveGoAheadTokenHash?: string; exchangeEnv?: ExchangeEnvironmentEnum }): {
    liveGoAheadTokenFile: string | undefined;
    liveGoAheadTokenHash: string | undefined;
} {
    return {
        liveGoAheadTokenFile: overrides.liveGoAheadTokenFile,
        liveGoAheadTokenHash: overrides.liveGoAheadTokenHash,
    };
}

function sha256Hex(text: string): string {
    return crypto.createHash('sha256').update(text.trim(), 'utf8').digest('hex');
}

async function writeTempFile(content: string): Promise<string> {
    const path = join(tmpdir(), `live-go-ahead-test-${Date.now()}-${Math.random()}`);
    await writeFile(path, content, 'utf8');
    // W1 follow-up — verifier rejects group/other-readable token files.
    await chmod(path, 0o600);
    return path;
}

function buildVerifier(configOverrides: { liveGoAheadTokenFile?: string; liveGoAheadTokenHash?: string }): LiveGoAheadVerifier {
    const appConfig = {
        ...makeConfig(configOverrides),
    };
    // Inject appConfig via constructor; LiveGoAheadVerifier is a plain service.
    return new LiveGoAheadVerifier(appConfig as never);
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('LiveGoAheadVerifier — adversarial', () => {
    describe('TESTNET env — gate is skipped', () => {
        it('does not read any file and resolves without throwing', async () => {
            // BUILD
            const appConfig = {
                liveGoAheadTokenFile: '/does/not/exist.txt',
                liveGoAheadTokenHash: 'deadbeef',
            } as never;
            const verifier = new LiveGoAheadVerifier(appConfig);

            // OPERATE + CHECK
            await expect(verifier.verifyOrThrow(ExchangeEnvironmentEnum.TESTNET)).resolves.toBeUndefined();
        });
    });

    describe('DEMO env — gate is skipped', () => {
        it('does not read any file and resolves without throwing', async () => {
            // BUILD
            const appConfig = {
                liveGoAheadTokenFile: '/does/not/exist.txt',
                liveGoAheadTokenHash: 'deadbeef',
            } as never;
            const verifier = new LiveGoAheadVerifier(appConfig);

            // OPERATE + CHECK
            await expect(verifier.verifyOrThrow(ExchangeEnvironmentEnum.DEMO)).resolves.toBeUndefined();
        });
    });

    describe('LIVE env — gate is enforced', () => {
        it('throws when LIVE_GO_AHEAD_TOKEN_FILE is not configured', async () => {
            // BUILD
            const appConfig = {
                liveGoAheadTokenFile: undefined,
                liveGoAheadTokenHash: sha256Hex('my-token'),
            } as never;
            const verifier = new LiveGoAheadVerifier(appConfig);

            // OPERATE + CHECK
            await expect(verifier.verifyOrThrow(ExchangeEnvironmentEnum.LIVE)).rejects.toThrow('LIVE_GO_AHEAD_TOKEN_FILE');
        });

        it('throws when LIVE_GO_AHEAD_TOKEN_FILE is an empty string', async () => {
            // BUILD
            const appConfig = {
                liveGoAheadTokenFile: '',
                liveGoAheadTokenHash: sha256Hex('my-token'),
            } as never;
            const verifier = new LiveGoAheadVerifier(appConfig);

            // OPERATE + CHECK
            await expect(verifier.verifyOrThrow(ExchangeEnvironmentEnum.LIVE)).rejects.toThrow('LIVE_GO_AHEAD_TOKEN_FILE');
        });

        it('throws when LIVE_GO_AHEAD_TOKEN_HASH is not configured', async () => {
            // BUILD
            const filePath = await writeTempFile('some-token');
            try {
                const appConfig = {
                    liveGoAheadTokenFile: filePath,
                    liveGoAheadTokenHash: undefined,
                } as never;
                const verifier = new LiveGoAheadVerifier(appConfig);

                // OPERATE + CHECK
                await expect(verifier.verifyOrThrow(ExchangeEnvironmentEnum.LIVE)).rejects.toThrow('LIVE_GO_AHEAD_TOKEN_HASH');
            } finally {
                await unlink(filePath).catch(() => undefined);
            }
        });

        it('throws when the token file does not exist on disk', async () => {
            // BUILD
            const appConfig = {
                liveGoAheadTokenFile: '/tmp/nonexistent-live-go-ahead-token-file.txt',
                liveGoAheadTokenHash: sha256Hex('my-token'),
            } as never;
            const verifier = new LiveGoAheadVerifier(appConfig);

            // OPERATE + CHECK
            await expect(verifier.verifyOrThrow(ExchangeEnvironmentEnum.LIVE)).rejects.toThrow();
        });

        it('throws when the token file exists but is empty', async () => {
            // BUILD
            const filePath = await writeTempFile('');
            try {
                const token = 'real-token';
                const appConfig = {
                    liveGoAheadTokenFile: filePath,
                    liveGoAheadTokenHash: sha256Hex(token),
                } as never;
                const verifier = new LiveGoAheadVerifier(appConfig);

                // OPERATE + CHECK — empty file trims to '', hash differs from 'real-token'
                await expect(verifier.verifyOrThrow(ExchangeEnvironmentEnum.LIVE)).rejects.toThrow('hash mismatch');
            } finally {
                await unlink(filePath).catch(() => undefined);
            }
        });

        it('throws when the token file contains only whitespace', async () => {
            // BUILD
            const filePath = await writeTempFile('   \n\t  ');
            try {
                const token = 'real-token';
                const appConfig = {
                    liveGoAheadTokenFile: filePath,
                    liveGoAheadTokenHash: sha256Hex(token),
                } as never;
                const verifier = new LiveGoAheadVerifier(appConfig);

                // OPERATE + CHECK — whitespace-only trims to '' -> hash mismatch
                await expect(verifier.verifyOrThrow(ExchangeEnvironmentEnum.LIVE)).rejects.toThrow('hash mismatch');
            } finally {
                await unlink(filePath).catch(() => undefined);
            }
        });

        it('throws when the file content does not match LIVE_GO_AHEAD_TOKEN_HASH', async () => {
            // BUILD
            const filePath = await writeTempFile('wrong-token');
            try {
                const appConfig = {
                    liveGoAheadTokenFile: filePath,
                    liveGoAheadTokenHash: sha256Hex('correct-token'),
                } as never;
                const verifier = new LiveGoAheadVerifier(appConfig);

                // OPERATE + CHECK
                await expect(verifier.verifyOrThrow(ExchangeEnvironmentEnum.LIVE)).rejects.toThrow('hash mismatch');
            } finally {
                await unlink(filePath).catch(() => undefined);
            }
        });

        it('resolves when file content (trimmed) hash matches config hash', async () => {
            // BUILD
            const token = 'correct-token-value';
            const filePath = await writeTempFile(`  ${token}  \n`);
            try {
                const appConfig = {
                    liveGoAheadTokenFile: filePath,
                    // verifier lowercases the actual hash; provide a matching hash
                    liveGoAheadTokenHash: sha256Hex(token),
                } as never;
                const verifier = new LiveGoAheadVerifier(appConfig);

                // OPERATE + CHECK
                await expect(verifier.verifyOrThrow(ExchangeEnvironmentEnum.LIVE)).resolves.toBeUndefined();
            } finally {
                await unlink(filePath).catch(() => undefined);
            }
        });

        it('is case-insensitive on the expected hash (uppercased hash in config is accepted)', async () => {
            // BUILD
            const token = 'my-live-token';
            const filePath = await writeTempFile(token);
            try {
                const appConfig = {
                    liveGoAheadTokenFile: filePath,
                    liveGoAheadTokenHash: sha256Hex(token).toUpperCase(),
                } as never;
                const verifier = new LiveGoAheadVerifier(appConfig);

                // OPERATE + CHECK
                await expect(verifier.verifyOrThrow(ExchangeEnvironmentEnum.LIVE)).resolves.toBeUndefined();
            } finally {
                await unlink(filePath).catch(() => undefined);
            }
        });
    });
});
