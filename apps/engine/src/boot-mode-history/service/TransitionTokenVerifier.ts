import { Injectable, Logger } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import { TRANSITION_TOKEN_FILE_MODE_NON_OWNER_MASK, TRANSITION_TOKEN_MAX_BYTES } from '../const';
import { IVerifiedTransitionToken, IVerifyTransitionTokenInput } from '../interface';

// Verifies a transition-token file's trimmed-content SHA-256 matches an
// operator-baked hash (ADR 0032 §D6 step 6 c-d / §D7). Mirrors
// LiveGoAheadVerifier's posture so the two paths share the same defence
// against "leaked file alone is not enough" attacks.
//
// Returns the SHA-256 of the trimmed token content (binary) on success so the
// caller can persist it into the boot_mode_chain_rotations row's
// `transition_token_hash` column.

@Injectable()
export class TransitionTokenVerifier {
    private readonly logger = new Logger(TransitionTokenVerifier.name);

    async verifyOrThrow(input: IVerifyTransitionTokenInput): Promise<IVerifiedTransitionToken> {
        const { filePath, expectedHashHex, transitionLabel } = input;

        if (filePath.length === 0) {
            throw new Error(`transition ${transitionLabel} requires token file env var to be set`);
        }

        if (expectedHashHex.length === 0) {
            throw new Error(`transition ${transitionLabel} requires token hash env var to be set`);
        }

        await this.assertFileSafe(filePath, transitionLabel);

        const actualHashHex = await this.computeFileHashHex(filePath);
        const expectedNormalised = expectedHashHex.toLowerCase();

        if (!hashesMatch(actualHashHex, expectedNormalised)) {
            // No values in the error body — only that the comparison failed.
            // Same posture as LiveGoAheadVerifier.
            throw new Error(`transition ${transitionLabel} token hash mismatch (file content does not match configured hash)`);
        }

        return { tokenHashBinary: Buffer.from(actualHashHex, 'hex') };
    }

    private async assertFileSafe(filePath: string, transitionLabel: string): Promise<void> {
        const stats = await stat(filePath);

        if (stats.size > TRANSITION_TOKEN_MAX_BYTES) {
            this.logger.error(`transition ${transitionLabel} token file size ${stats.size} exceeds ${TRANSITION_TOKEN_MAX_BYTES} bytes`);

            // Distinguished from the hash-mismatch path so the audit row records
            // a precondition failure (operator drop misconfigured) separate from
            // a content mismatch (operator/attacker mismatch). No file path or
            // size in the thrown message — that detail lives in the structured
            // logger above; the audit row only needs the category.
            throw new Error(`transition ${transitionLabel} token file precondition failed (size/permissions)`);
        }

        if ((stats.mode & TRANSITION_TOKEN_FILE_MODE_NON_OWNER_MASK) !== 0) {
            this.logger.error(`transition ${transitionLabel} token file mode ${(stats.mode & 0o777).toString(8)} permits group/other read — must be 0600`);

            throw new Error(`transition ${transitionLabel} token file precondition failed (size/permissions)`);
        }
    }

    private async computeFileHashHex(filePath: string): Promise<string> {
        const raw = await readFile(filePath, 'utf8');
        const trimmed = raw.trim();

        return createHash('sha256').update(trimmed, 'utf8').digest('hex');
    }
}

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
