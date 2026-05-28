// M12 W4 — single registration entrypoint for the 5 MCP read-only tools.
//
// `main.ts` calls `registerAllTools(registry, ds)` exactly once at boot. The
// 4 query tools share the analysis DataSource; `run_backtest` is spawn-based
// (no DataSource — it talks to the engine over an OS process boundary) and
// uses the module-level single-slot semaphore in its own file.
//
// Boundary invariant (ADR 0033 §2.2): imports `@bot/analysis`-using tool
// modules and the spawn-based tool. Zero `@bot/engine` edges.

import type { createMcpDataSource } from '@bot/analysis';

import { buildCompareVersionsTool } from './compareVersions.tool.js';
import { buildGetDecisionsTool } from './getDecisions.tool.js';
import { buildGetHaltStateTool } from './getHaltState.tool.js';
import { buildGetPerformanceTool } from './getPerformance.tool.js';
import { buildListPositionsTool } from './listPositions.tool.js';
import { buildRunBacktestTool } from './runBacktest.tool.js';
import type { ToolRegistry } from './ToolRegistry.js';

type AnalysisDataSource = ReturnType<typeof createMcpDataSource>;

export function registerAllTools(registry: ToolRegistry, ds: AnalysisDataSource): void {
    registry.registerReadOnlyTool(buildGetPerformanceTool(ds));
    registry.registerReadOnlyTool(buildCompareVersionsTool(ds));
    registry.registerReadOnlyTool(buildListPositionsTool(ds));
    registry.registerReadOnlyTool(buildGetDecisionsTool(ds));
    registry.registerReadOnlyTool(buildGetHaltStateTool(ds));
    registry.registerReadOnlyTool(buildRunBacktestTool());
}
