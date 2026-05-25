import { ExchangeEnvironmentEnum } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { AppConfigService } from '../config/service';

// M11a W1.1 (ADR 0028 / M11a §W0.1). Two-token live-mode boot guard.
//
// When EXCHANGE_ENV=LIVE, the engine refuses to start unless BOTH:
//   - LIVE_GO_AHEAD_TOKEN_FILE is set and points to a readable local file;
//   - the hex SHA-256 of that file's contents (trimmed) equals
//     LIVE_GO_AHEAD_TOKEN_HASH baked into config.
//
// Rationale: a single env variable can be edited in one place. The two-token
// dance forces an out-of-band proof-of-intent (operator dropped a file on
// disk) plus an in-config commitment (the hash baked in at deploy). Either
// half alone is not enough. TESTNET / DEMO are no-ops — this gate only fires
// for LIVE.
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

        const actualHash = await this.computeFileHash(filePath);

        if (actualHash !== expectedHash.toLowerCase()) {
            // No values in the error body — only that the comparison failed.
            throw new Error('LIVE_GO_AHEAD token hash mismatch (file content does not match LIVE_GO_AHEAD_TOKEN_HASH)');
        }

        this.logger.warn('LIVE_GO_AHEAD token verified — engine permitted to boot in LIVE mode');
    }

    private async computeFileHash(filePath: string): Promise<string> {
        const raw = await readFile(filePath, 'utf8');
        const trimmed = raw.trim();

        return createHash('sha256').update(trimmed, 'utf8').digest('hex');
    }
}
