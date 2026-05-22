// Extracts a safe, human-readable string from an unknown thrown value. Centralised
// so every catch-site stringifies errors identically (no duplicated helper).
export function describeError(cause: unknown): string {
    if (cause instanceof Error) {
        return cause.message;
    }

    return String(cause);
}
