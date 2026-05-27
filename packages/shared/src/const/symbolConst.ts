// M12 fix wave 7 — single authoritative symbol regex consumed by both the
// MCP DTO layer (`apps/mcp/src/dtos/index.ts`) and the analysis query layer
// (`packages/analysis/src/query/{listPositions,getDecisions}.ts`).
//
// Previously each layer carried its own copy; they had drifted (the analysis
// copies admitted `_` in the base segment, the MCP copy did not). CCXT futures
// notation never uses `_` in any segment, so the MCP-side form is the
// authoritative one. Promoting here removes the drift surface permanently.

/**
 * Symbol regex — accepts CCXT futures notation (`BASE/QUOTE:SETTLEMENT`,
 * e.g. `BTC/USDT:USDT`, `TST/USDT:USDT` — the engine's actual storage form)
 * and legacy plain-uppercase form (e.g. `BTCUSDT`) for any older rows. The
 * `/` and `:` characters are safe under parameterized binding; this regex is
 * the defence-in-depth net and parameterization is the actual SQL-injection
 * defence. Lowercase and underscores are rejected to keep the surface tight.
 */
export const SYMBOL_REGEX = /^[A-Z0-9]{1,20}(?:\/[A-Z0-9]{1,15}:[A-Z0-9]{1,15})?$/u;

/**
 * Hard upper bound on symbol string length: `20 + 1 + 15 + 1 + 15 = 52`.
 * Used as a fast-fail length guard before applying the regex. Kept as a
 * named constant so the bound is self-documenting at the call sites.
 */
export const SYMBOL_MAX_LENGTH = 52;
