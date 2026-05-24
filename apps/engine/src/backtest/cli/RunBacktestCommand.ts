import { IBacktestConfig, IBacktestReport } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';

import { BacktestRunnerService } from '../service/BacktestRunnerService';

// Thin programmatic entry point for triggering a backtest run from outside the live engine
// listeners (M7). A full CLI harness (argv parsing, JSON-config loading, exit codes) is out
// of scope for W4b — this slice exposes a single `run(config)` that returns the structured
// IBacktestReport and logs the headline summary line, which is sufficient for the test
// harness and for M8 to call programmatically.
//
// Stays @Injectable so BacktestModule can wire it; the service-level Logger keeps output
// inside the nestjs-pino structured stream alongside the rest of the engine.
@Injectable()
export class RunBacktestCommand {
    private readonly logger = new Logger(RunBacktestCommand.name);

    constructor(private readonly runner: BacktestRunnerService) {}

    async run(config: IBacktestConfig): Promise<IBacktestReport> {
        const report = await this.runner.run(config);

        this.logger.log(
            `backtest done run=${report.runLabel} ` +
                `strategy=${report.strategyName}:${report.strategyVersion} ` +
                `trades=${report.tradeCount} winRate=${report.winRatePct}% netPnl=${report.netPnlUsdt}`,
        );

        return report;
    }
}
