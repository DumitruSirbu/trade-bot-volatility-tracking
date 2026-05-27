import { ExchangeEnvironmentEnum } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import { AppConfigService } from '../config/service';

// Reject token files larger than this — the legitimate file holds a short
// opaque token (typically <128 bytes). Bound prevents OOM if the operator
// accidentally points the env var at a large log file or arbitrary blob.
const LIVE_GO_AHEAD_MAX_BYTES = 4096;

// Group + other permission mask. A non-zero result means the file is readable
// outside the owning user, which defeats the "operator dropped a private file"
// intent of the two-token gate.
const FILE_MODE_NON_OWNER_MASK = 0o077;

// Two-token live-mode boot guard (ADR 0028).
//
// When EXCHANGE_ENV=LIVE, the engine refuses to start unless BOTH:
//   - LIVE_GO_AHEAD_TOKEN_FILE is set and points to a readable local file;
//   - the hex SHA-256 of that file's contents (trimmed) equals
//     LIVE_GO_AHEAD_TOKEN_HASH baked into config.
//
// Rationale: a single env variable can be edited in one place. The two-token
// dance forces an out-of-band proof-of-intent (operator dropped a file on
// disk) plus an in-config commitment (the hash baked in at deploy). Either
// half alone is not enough. TESTNET / PAPER are no-ops — this gate only fires
// for LIVE. PAPER's safety teeth live in the D8 allowlist (a tradeable key on
// PAPER fails boot) plus D6/D7 boot-mode HMAC chain — see ADR 0032 §D9.
//
// Pure / single-purpose: just verifies; does not log fingerprints or alert.
// The caller (boot orchestrator) writes the audit trail.

@Injectable()
export class LiveGoAheadVerifier {
    private readonly logger = new Logger(LiveGoAheadVerifier.name);

    constructor(private readonly appConfig: AppConfigService) {}

    // Verifies the two-token gate for the resolved env. Throws on failure with
    // a redacted message; otherwise returns. Called once at boot.
    async verifyOrThrow(env: ExchangeEnvironmentEnum): Promise<void> {
        if (env !== ExchangeEnvironmentEnum.LIVE) {
            return;
        }

        const filePath = this.appConfig.liveGoAheadTokenFile;
        const expectedHash = this.appConfig.liveGoAheadTokenHash;

        if (filePath === undefined || filePath.length === 0) {
            throw new Error('EXCHANGE_ENV=LIVE requires LIVE_GO_AHEAD_TOKEN_FILE to be set');
        }

        if (expectedHash === undefined || expectedHash.length === 0) {
            throw new Error('EXCHANGE_ENV=LIVE requires LIVE_GO_AHEAD_TOKEN_HASH to be set');
        }

        await this.assertFileSafe(filePath);

        const actualHash = await this.computeFileHash(filePath);

        if (!hashesMatch(actualHash, expectedHash.toLowerCase())) {
            // No values in the error body — only that the comparison failed.
            throw new Error('LIVE_GO_AHEAD token hash mismatch (file content does not match LIVE_GO_AHEAD_TOKEN_HASH)');
        }

        this.logger.warn('LIVE_GO_AHEAD token verified — engine permitted to boot in LIVE mode');
    }

    // Pre-flight size + mode checks. Both failure modes surface as a hash
    // mismatch (intentional — the operator-visible signal is "the gate
    // refused"; the log carries the precise diagnostic).
    private async assertFileSafe(filePath: string): Promise<void> {
        const stats = await stat(filePath);

        if (stats.size > LIVE_GO_AHEAD_MAX_BYTES) {
            this.logger.error(`LIVE_GO_AHEAD token file size ${stats.size} exceeds ${LIVE_GO_AHEAD_MAX_BYTES} bytes`);

            throw new Error('LIVE_GO_AHEAD token hash mismatch (file content does not match LIVE_GO_AHEAD_TOKEN_HASH)');
        }

        if ((stats.mode & FILE_MODE_NON_OWNER_MASK) !== 0) {
            this.logger.error(`LIVE_GO_AHEAD token file mode ${(stats.mode & 0o777).toString(8)} permits group/other read — must be 0600`);

            throw new Error('LIVE_GO_AHEAD token hash mismatch (file content does not match LIVE_GO_AHEAD_TOKEN_HASH)');
        }
    }

    private async computeFileHash(filePath: string): Promise<string> {
        const raw = await readFile(filePath, 'utf8');
        const trimmed = raw.trim();

        return createHash('sha256').update(trimmed, 'utf8').digest('hex');
    }
}

// Constant-time hex hash compare. Length-mismatch is rejected first so
// `timingSafeEqual` always sees equal-length buffers (its precondition).
function hashesMatch(actualHex: string, expectedHex: string): boolean {
    if (actualHex.length !== expectedHex.length) {
        return false;
    }

    const actualBuf = Buffer.from(actualHex, 'hex');
    const expectedBuf = Buffer.from(expectedHex, 'hex');

    if (actualBuf.length !== expectedBuf.length) {
        return false;
    }

    return timingSafeEqual(actualBuf, expectedBuf);
}
