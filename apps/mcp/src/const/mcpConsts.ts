// M12 W6 fix wave 4b — MCP module-level constants.
//
// Authoritative `const/` placement per `docs/best-practices/code-conventions.md`
// "Constants Placement". Previously these lived at the top of
// `apps/mcp/src/dtos/index.ts`; the clean-code reviewer flagged the
// top-of-file `export const` pattern alongside Zod schemas as a convention
// violation.

// ---- range cap constants ---------------------------------------------------

/** Read-tool soft cap: queries longer than this require `acknowledgedLargeRange=true`. */
export const READ_QUERY_SOFT_RANGE_DAYS = 90;
/** Read-tool hard cap: queries longer than this are rejected unconditionally. */
export const READ_QUERY_HARD_RANGE_DAYS = 365;
/** Backtest hard cap: rejected unconditionally — ADR 0034 §2.6. */
export const BACKTEST_HARD_RANGE_DAYS = 180;
/** Decisions-tool hard cap (per execution plan W4 §4): 30 days. */
export const DECISIONS_HARD_RANGE_DAYS = 30;

/** Pagination limit hard ceiling for list_positions. */
export const LIST_POSITIONS_MAX_LIMIT = 200;

// ---- shared primitives -----------------------------------------------------

// Symbol validation primitives are owned by `@bot/shared` so the MCP DTO layer
// and the analysis query layer share a single authoritative source. Re-exported
// here so existing MCP import paths (`../const/index.js`) remain stable.
export { SYMBOL_REGEX, SYMBOL_MAX_LENGTH } from '@bot/shared';
