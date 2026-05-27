// M12 W3 — typed tool-error class for the MCP server.
//
// Each kind carries a public message safe for the LLM caller. The `cause`
// chain is logged on the server side but is NEVER serialized into the MCP
// tool-error response — it can hold raw stderr, DB paths, SQL text, etc.
//
// Boundary invariant (ADR 0033 §2.2): this file imports nothing from
// @bot/engine, @bot/analysis, or any sibling MCP module. It is pure infra.

export const McpToolErrorKindEnum = {
    VALIDATION: 'VALIDATION',
    TIMEOUT: 'TIMEOUT',
    INTERNAL: 'INTERNAL',
    BOUNDARY_VIOLATION: 'BOUNDARY_VIOLATION',
    NOT_FOUND: 'NOT_FOUND',
} as const;

export type McpToolErrorKind = (typeof McpToolErrorKindEnum)[keyof typeof McpToolErrorKindEnum];

/**
 * MCP tool-layer error. Carries a discriminated `kind` plus a public message.
 * The optional `cause` is for server-side logging only; never include it in
 * tool-error payloads sent to the model.
 */
export class McpToolError extends Error {
    readonly kind: McpToolErrorKind;
    private readonly internalCause: unknown;

    constructor(kind: McpToolErrorKind, message: string, cause?: unknown) {
        super(message);
        this.name = 'McpToolError';
        this.kind = kind;
        this.internalCause = cause;
    }

    static validation(message: string, cause?: unknown): McpToolError {
        return new McpToolError(McpToolErrorKindEnum.VALIDATION, message, cause);
    }

    static timeout(message: string, cause?: unknown): McpToolError {
        return new McpToolError(McpToolErrorKindEnum.TIMEOUT, message, cause);
    }

    static internal(message: string, cause?: unknown): McpToolError {
        return new McpToolError(McpToolErrorKindEnum.INTERNAL, message, cause);
    }

    static boundaryViolation(message: string, cause?: unknown): McpToolError {
        return new McpToolError(McpToolErrorKindEnum.BOUNDARY_VIOLATION, message, cause);
    }

    static notFound(message: string, cause?: unknown): McpToolError {
        return new McpToolError(McpToolErrorKindEnum.NOT_FOUND, message, cause);
    }

    /**
     * Server-side accessor for the underlying cause. Use ONLY in logger sinks.
     * Never inline the result into a value returned to the client.
     */
    getInternalCause(): unknown {
        return this.internalCause;
    }

    /**
     * MCP tool-error wire shape. Per the MCP protocol, a tool can signal an
     * error to the client by setting `isError: true` and returning text
     * content with the (public) message. The `cause` is intentionally absent.
     */
    toToolResult(): { isError: true; content: Array<{ type: 'text'; text: string }>; structuredContent: { kind: McpToolErrorKind } } {
        return {
            isError: true,
            content: [{ type: 'text', text: `[${this.kind}] ${this.message}` }],
            structuredContent: { kind: this.kind },
        };
    }
}
