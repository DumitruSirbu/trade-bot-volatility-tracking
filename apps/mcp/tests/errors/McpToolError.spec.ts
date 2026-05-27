// M12 W3 — McpToolError typed-kind + cause-confinement tests.

import { McpToolError, McpToolErrorKindEnum } from '../../src/errors/McpToolError';

describe('McpToolError', () => {
    it('constructs each kind via its static factory with the expected public message', () => {
        const cases: Array<readonly [() => McpToolError, string]> = [
            [() => McpToolError.validation('bad params'), McpToolErrorKindEnum.VALIDATION],
            [() => McpToolError.timeout('took too long'), McpToolErrorKindEnum.TIMEOUT],
            [() => McpToolError.internal('boom'), McpToolErrorKindEnum.INTERNAL],
            [() => McpToolError.boundaryViolation('engine import detected'), McpToolErrorKindEnum.BOUNDARY_VIOLATION],
            [() => McpToolError.notFound('no such tool'), McpToolErrorKindEnum.NOT_FOUND],
        ];

        for (const [factory, expectedKind] of cases) {
            const err = factory();
            expect(err).toBeInstanceOf(McpToolError);
            expect(err.kind).toBe(expectedKind);
            expect(err.message.length).toBeGreaterThan(0);
        }
    });

    it('keeps the internal cause out of toToolResult() — only the public kind + message leak', () => {
        const secret = new Error('postgres://user:hunter2@host/db connection refused');
        const err = McpToolError.internal('Backend query failed', secret);

        const result = err.toToolResult();

        expect(result.isError).toBe(true);
        expect(result.structuredContent.kind).toBe(McpToolErrorKindEnum.INTERNAL);
        const flat = JSON.stringify(result);
        expect(flat).not.toContain('hunter2');
        expect(flat).not.toContain('postgres://');
    });

    it('exposes the cause via getInternalCause() for server-side logging', () => {
        const cause = { sqlState: '42501' };
        const err = McpToolError.boundaryViolation('engine module loaded', cause);

        expect(err.getInternalCause()).toBe(cause);
    });

    it('produces a tool-result wire shape with text content carrying the kind prefix', () => {
        const err = McpToolError.validation('range reversed');
        const result = err.toToolResult();

        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toContain('VALIDATION');
        expect(result.content[0].text).toContain('range reversed');
    });
});
