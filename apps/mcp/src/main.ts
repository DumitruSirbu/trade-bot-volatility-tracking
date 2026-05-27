// M12 W3 — MCP server entrypoint (stdio transport).
//
// Boot sequence (ordered, intentional):
//   1. Configure stderr logging — stdout is reserved for the JSON-RPC stdio
//      transport; ANY accidental stdout write corrupts the protocol stream.
//   2. Run the runtime boundary guard FIRST so we fail fast if engine code
//      somehow loaded into this address space (ADR 0033 §2.4 layer C).
//   3. Build the @bot/analysis DataSource (the only PG handle in the
//      process) and initialize it.
//   4. Instantiate the ToolRegistry. W4 will register the five read-only
//      tools here; this wave leaves the registry empty so `tools/list`
//      returns [].
//   5. Wire the SDK request handlers (`tools/list`, `tools/call`) onto the
//      low-level Server, connect over StdioServerTransport, and install
//      SIGINT/SIGTERM hooks for clean shutdown.
//
// Boundary invariant (ADR 0033 §2.2): this file imports
// `@modelcontextprotocol/sdk`, `@bot/analysis`, and sibling MCP modules
// only. Zero edges to @bot/engine.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpDataSource } from '@bot/analysis';

import { runBoundaryGuard } from './boundary/RuntimeGuard.js';
import { McpToolError } from './errors/McpToolError.js';
import { registerAllTools } from './tools/registerAllTools.js';
import { ToolRegistry } from './tools/ToolRegistry.js';

const SERVER_NAME = '@bot/mcp';
const SERVER_VERSION = '0.0.1';

/** Stderr logger. stdout is RESERVED for the stdio transport. */
function logInfo(message: string): void {
    process.stderr.write(`[mcp] ${message}\n`);
}

function logError(message: string, cause?: unknown): void {
    const causeStr = cause instanceof Error ? `: ${cause.message}` : cause !== undefined ? `: ${String(cause)}` : '';
    process.stderr.write(`[mcp] ERROR ${message}${causeStr}\n`);
}

type AnalysisDataSource = ReturnType<typeof createMcpDataSource>;

interface IMcpRuntime {
    readonly server: Server;
    readonly transport: StdioServerTransport;
    readonly dataSource: AnalysisDataSource;
}

async function buildRuntime(): Promise<IMcpRuntime> {
    const registry = new ToolRegistry();

    const dataSource = createMcpDataSource();
    await dataSource.initialize();
    logInfo('analysis DataSource initialized');

    // W4 — register the 5 read-only tools onto the registry. `run_backtest`
    // is spawn-based and does not take the DataSource.
    registerAllTools(registry, dataSource);

    const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: registry.listTools().map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: rawArgs } = request.params;
        try {
            const result = await registry.callTool(name, rawArgs ?? {});
            return {
                content: [{ type: 'text', text: JSON.stringify(result) }],
                structuredContent: result as Record<string, unknown>,
            };
        } catch (err) {
            if (err instanceof McpToolError) {
                // Log the internal cause server-side; do NOT leak it to the client.
                logError(`tool '${name}' failed [${err.kind}]: ${err.message}`, err.getInternalCause());
                return err.toToolResult();
            }
            logError(`tool '${name}' threw unexpected error`, err);
            return McpToolError.internal('Unexpected internal error').toToolResult();
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logInfo(`stdio transport connected — listing ${registry.listTools().length} tools`);

    return { server, transport, dataSource };
}

async function shutdown(runtime: IMcpRuntime | null, signal: string, exitCode: number): Promise<void> {
    logInfo(`received ${signal}, shutting down`);
    if (runtime !== null) {
        try {
            await runtime.server.close();
        } catch (err) {
            logError('failed to close MCP server', err);
        }
        try {
            if (runtime.dataSource.isInitialized) {
                await runtime.dataSource.destroy();
            }
        } catch (err) {
            logError('failed to destroy analysis DataSource', err);
        }
    }
    process.exit(exitCode);
}

async function main(): Promise<void> {
    // Layer C boundary guard — runs BEFORE any tool registration, BEFORE
    // any DB connection. If engine modules slipped in, we exit immediately.
    runBoundaryGuard();

    let runtime: IMcpRuntime | null = null;

    const installSignalHandler = (signal: NodeJS.Signals): void => {
        process.on(signal, () => {
            void shutdown(runtime, signal, 0);
        });
    };
    installSignalHandler('SIGINT');
    installSignalHandler('SIGTERM');

    try {
        runtime = await buildRuntime();
        logInfo(`${SERVER_NAME}@${SERVER_VERSION} ready`);
    } catch (err) {
        logError('boot failed', err);
        await shutdown(runtime, 'boot-failure', 1);
    }
}

void main();
