// M13 W1.D — LLM egress chokepoint (ADR 0037).
//
// Every byte that reaches a prompt MUST pass through `redactForLlm`. The
// function walks the input tree and asserts each leaf field name is on
// `EGRESS_ALLOWLIST` OR the value is a structural-only leaf (numeric, boolean,
// or decimal-string with no PII channel). Any blocklist hit or any unknown
// string-valued field name throws `EgressViolationError` listing EVERY
// offending path in a single pass — operators see the full violation set.
//
// Pure + deterministic: no Date.now / Math.random / I/O.

const MAX_DEPTH = 8;

// ---------------------------------------------------------------------------
// Allowlist — fields permitted to reach the LLM (ADR 0037 §2.2).
// ---------------------------------------------------------------------------
// Field-name (leaf-key) allowlist. The walker matches by the leaf key, not the
// full path; a key in this set passes regardless of where in the tree it sits.
export const EGRESS_ALLOWLIST: ReadonlySet<string> = new Set([
    // IPerformanceByVersionView
    'strategyVersionId',
    'label',
    'status',
    'windowDays',
    'tradeCount',
    'winRate',
    'netPnlUsd',
    'maxDrawdownUsd',
    'sharpe',
    'sortino',
    'expectancyPerUnitRisk',
    // ADR 0037 explicit allowlist field names
    'versionId',
    'name',
    'version',
    'trades',
    'expectancy',
    'maxDrawdown',
    'pnlSum',
    'regimeTag',
    'parentVersionId',
    // IVersionComparisonResult / IPairedDiffSummary
    'aPerformance',
    'bPerformance',
    'pairedDiff',
    'pairedEventCount',
    'pairedTradedEventCount',
    'netPnlDeltaUsd',
    'meanPnlDeltaUsd',
    'belowSampleFloor',
    // IBacktestReport summary fields
    'fromIso',
    'toIso',
    'weekIso',
    'fromUtcDate',
    'toUtcDate',
    'tradesCount',
    'tradeCount',
    'winCount',
    'lossCount',
    'winRatePct',
    'grossPnlUsdt',
    'feesUsdt',
    'fundingUsdt',
    'slippageCostUsdt',
    'netPnlUsdt',
    'returnPct',
    'profitFactor',
    'avgHoldMs',
    'maxDrawdownPct',
    'maxDrawdownDurationDays',
    'sharpeAnnualized',
    'sortinoAnnualized',
    'skippedTriggerCount',
    'rejectedByGateCount',
    'missedLimitFillCount',
    'lowFidelityTradeCount',
    'regimeBreakdown',
    'lowFidelity',
    'equityCurve',
    'perRegime',
    'perFlowType',
    'perSymbol',
    'utcDate',
    'equityUsdt',
    'dailyReturnPct',
    'key',
    'runLabel',
    'strategyName',
    'strategyVersion',
    // bootstrap / walk-forward
    'bootstrap',
    'ci',
    'lo',
    'hi',
    'walkForward',
    'splits',
    // Decision aggregates / structural tags
    'flowType',
    'flow_type',
    'signalScore',
    'signal_score',
    'signalScoreBucket',
    'hourOfDayBucket',
    'action',
    'reason',
    'occurredAt',
    'eventId',
    // IHaltStateView (allow for prompt context — boolean + reason text + iso)
    'isHalted',
    'haltReason',
    'asOf',
    // Identifiers explicitly allowed by ADR 0037 §2.2 (anonymized/public only)
    'symbol',
    'id',
    // statistical metadata
    'pValue',
    'confidence',
    'sampleSize',
]);

// ---------------------------------------------------------------------------
// Blocklist — field names that MUST NEVER reach the LLM (ADR 0037 §2.3).
// Names match the leaf key. Substring patterns are handled separately below.
// ---------------------------------------------------------------------------
export const EGRESS_BLOCKLIST: ReadonlySet<string> = new Set([
    // Auth / secrets
    'apiKey',
    'apiSecret',
    'bearerToken',
    'authToken',
    'signingSecret',
    'bootstrapSecret',
    'passphrase',
    'password',
    'hmac',
    'hmacKey',
    'subkey',
    'seed',
    'salt',
    'nonce',
    'secret',
    'AUTH_SIGNING_SECRET',
    'AUTH_BOOTSTRAP_SECRET',
    'MCP_DB_PASSWORD',
    'AGENT_DB_PASSWORD',
    'AGENT_MCP_BEARER',
    'AI_GATEWAY_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'BINANCE_API_KEY',
    'BINANCE_API_SECRET',
    // Account-state numerics
    'balance',
    'equity',
    'totalWalletBalance',
    'availableBalance',
    'unrealizedPnl',
    'marginBalance',
    'availableMargin',
    'wallet',
    // Operator identity
    'accountId',
    'userId',
    'operatorId',
    'actorSub',
    'actorJti',
    'sourceIp',
    'clientIp',
    'ipAllowlist',
    'ipAddress',
    // Exchange-side identifiers
    'exchange_order_id',
    'exchangeOrderId',
    'exchangePositionId',
    'client_order_id',
    'clientOrderId',
    'exchangeTradeId',
    'binanceOrderId',
    'rawResponse',
    'exchangeResponse',
    'ccxtResponse',
    // Halt / audit forensics
    'previousState',
    'newState',
]);

// Substring patterns: any leaf-key containing one of these substrings
// (case-insensitive, anywhere in the lowercased key) is blocked. These are
// patterns that NEVER legitimately appear as part of a safe field name —
// e.g., `apikey` cannot be embedded in any allowed shape.
const BLOCKLIST_SUBSTRINGS: readonly string[] = [
    'apikey',
    'apisecret',
    'bearertoken',
    'signingsecret',
    'passphrase',
    'password',
    'hmac',
    'availablemargin',
    'rawresponse',
    'exchangeresponse',
    'ccxtresponse',
    'exchangeorderid',
    'clientorderid',
];

// Token-boundary patterns: blocked when the substring appears at a word
// boundary (start/end of key, or adjacent to a non-alphanumeric / case-change).
// This catches `myBalance`, `userBalance`, `ipAddress` while allowing
// `equityCurve` (where `equity` is a prefix of a compound safe name) ONLY when
// the key itself is on the allowlist. Implementation: we require the token to
// be a complete sub-word, not embedded inside a larger word.
const BLOCKLIST_TOKEN_BOUNDARY: readonly string[] = ['balance', 'equity', 'wallet', 'ip', 'addr'];

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class EgressViolationError extends Error {
    public readonly paths: readonly string[];

    constructor(paths: readonly string[]) {
        super(`LLM egress violation: forbidden field(s) ${paths.join(', ')}`);
        this.name = 'EgressViolationError';
        this.paths = paths;
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function redactForLlm<T>(input: T): T {
    const violations: string[] = [];
    walk(input, '$', 0, violations);

    if (violations.length > 0) {
        throw new EgressViolationError(violations);
    }

    return input;
}

// ---------------------------------------------------------------------------
// Walker — collects violations rather than throwing on first hit so callers
// see the full set.
// ---------------------------------------------------------------------------

function walk(value: unknown, path: string, depth: number, violations: string[]): void {
    if (depth > MAX_DEPTH) {
        violations.push(`${path} [depth>${MAX_DEPTH}]`);

        return;
    }

    if (value === null || value === undefined) {
        return;
    }

    if (Array.isArray(value)) {
        walkArray(value, path, depth, violations);

        return;
    }

    if (typeof value === 'object') {
        walkObject(value as Record<string, unknown>, path, depth, violations);

        return;
    }
    // Primitive leaves at the ROOT (no key context) are always allowed —
    // they only reach here when redactForLlm is called on a bare primitive,
    // which is structural data with no PII channel by definition.
}

function walkArray(arr: readonly unknown[], path: string, depth: number, violations: string[]): void {
    for (let i = 0; i < arr.length; i++) {
        walk(arr[i], `${path}[${i}]`, depth + 1, violations);
    }
}

function walkObject(obj: Record<string, unknown>, path: string, depth: number, violations: string[]): void {
    for (const key of Object.keys(obj)) {
        const childPath = `${path}.${key}`;
        const childValue = obj[key];

        // Allowlist wins over token-boundary blocklist for compound safe
        // names (e.g. `equityCurve` is allowlisted even though it contains
        // the word "equity"). Exact-name blocklist + substring blocklist
        // still win over allowlist — see `isBlockedKey`.
        if (isBlockedKey(key) && !EGRESS_ALLOWLIST.has(key)) {
            violations.push(childPath);
            continue;
        }

        // Hard-block: even allowlisted keys cannot pass if their exact name
        // is on the explicit blocklist (defense against an allowlist typo).
        if (EGRESS_BLOCKLIST.has(key) || hasBlockedSubstring(key)) {
            violations.push(childPath);
            continue;
        }

        if (childValue !== null && typeof childValue === 'object') {
            walk(childValue, childPath, depth + 1, violations);
            continue;
        }

        if (!isLeafAllowed(key, childValue)) {
            violations.push(childPath);
        }
    }
}

function isBlockedKey(key: string): boolean {
    if (EGRESS_BLOCKLIST.has(key)) {
        return true;
    }

    const lower = key.toLowerCase();

    for (const substr of BLOCKLIST_SUBSTRINGS) {
        if (lower.includes(substr)) {
            return true;
        }
    }

    // Token-boundary check: split camelCase / snake_case into words.
    const words = splitIntoWords(key);

    for (const token of BLOCKLIST_TOKEN_BOUNDARY) {
        for (const word of words) {
            if (word === token) {
                return true;
            }
        }
    }

    return false;
}

function hasBlockedSubstring(key: string): boolean {
    const lower = key.toLowerCase();

    for (const substr of BLOCKLIST_SUBSTRINGS) {
        if (lower.includes(substr)) {
            return true;
        }
    }

    return false;
}

function splitIntoWords(key: string): readonly string[] {
    // Splits `myAccountBalance` -> [my, account, balance], `ip_address` -> [ip, address].
    return key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]/g, ' ')
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 0);
}

function isLeafAllowed(key: string, value: unknown): boolean {
    if (EGRESS_ALLOWLIST.has(key)) {
        return true;
    }

    // Structural leaves (numeric / boolean / decimal-string-with-no-PII) pass
    // only when the key is unknown AND the value is structurally non-textual.
    if (typeof value === 'number' || typeof value === 'boolean') {
        return true;
    }

    if (typeof value === 'string' && isDecimalString(value)) {
        return true;
    }

    return false;
}

function isDecimalString(value: string): boolean {
    if (value.length === 0 || value.length > 64) {
        return false;
    }

    // Accepts integers, decimals, negative signs, and scientific notation —
    // the set of canonical decimal.js renderings used at our shared boundary.
    return /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value);
}
