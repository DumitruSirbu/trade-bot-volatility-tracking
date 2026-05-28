// Terminal state of a weekly agent run (M13). Persisted to
// `agent_run_history.terminal_state` and surfaced as the exit-code source.
export enum TerminalStateEnum {
    COMPLETED = 'COMPLETED',
    SKIPPED_HALTED = 'SKIPPED_HALTED',
    IDEMPOTENT_SKIP = 'IDEMPOTENT_SKIP',
    FAILED = 'FAILED',
}
