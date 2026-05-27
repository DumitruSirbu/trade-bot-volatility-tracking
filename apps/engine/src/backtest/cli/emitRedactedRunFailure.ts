// M12 W6 R3 #2 — defense-in-depth at the stderr SOURCE for the backtest CLI.
//
// The MCP spawn caller tails+redacts the last 2KB of stderr, but a NestJS
// unhandled-rejection stack easily blows past that budget and leaks
// `/Users/...` filesystem paths + stringified provider state. By default we
// emit ONE redacted line summarising `error.name` + truncated `error.message`.
//
// Set `BACKTEST_CLI_VERBOSE=1` for the legacy full stack (local debugging
// only — never set in MCP-spawn environments).
//
// This module is intentionally import-free so it can be unit-tested without
// dragging the full NestJS `AppModule` graph into the test harness.

const ERROR_MESSAGE_MAX_LEN = 200;

export function emitRedactedRunFailure(cause: unknown): void {
    const err = cause as Error;
    const name = typeof err?.name === 'string' && err.name.length > 0 ? err.name : 'Error';
    const rawMessage = typeof err?.message === 'string' ? err.message : String(cause);
    const message = rawMessage.length > ERROR_MESSAGE_MAX_LEN ? `${rawMessage.slice(0, ERROR_MESSAGE_MAX_LEN)}...` : rawMessage;

    process.stderr.write(`backtest run failed: ${name}: ${message}\n`);

    if (process.env.BACKTEST_CLI_VERBOSE === '1' && typeof err?.stack === 'string') {
        process.stderr.write(`${err.stack}\n`);
    }
}
