/* eslint-disable no-console */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../../app.module';
import { ComparisonRunnerService } from '../../backtest/service/ComparisonRunnerService';
import { PromotionService } from '../../promotion/service/PromotionService';
import { ComparisonReportRepository } from '../repository/ComparisonReportRepository';
import { StrategyVersionRepository } from '../repository/StrategyVersionRepository';
import { CompareCommand, ICompareArgs, parseCompareArgs } from './CompareCommand';
import { IPromoteArgs, parsePromoteArgs, PromoteCommand } from './PromoteCommand';
import { IReactivateArgs, parseReactivateArgs, ReactivateCommand } from './ReactivateCommand';

// `pnpm engine strategy <subcommand> ...` entrypoint (ADR 0019 §2.5). Bootstraps a
// standalone Nest application context (no HTTP listener) so the same DI graph the live
// engine uses provides ComparisonRunnerService / PromotionService / repositories. The
// command classes are NOT Nest providers — they're plain classes instantiated here with
// resolved deps to keep the W7 surface ≤ 5 files (no new CLI module).
//
// Exit-code map (documented in this file; consumers grep here):
//   0   success
//   1   runtime failure (unexpected exception, DB error, etc.)
//   2   bad arguments (missing/invalid flag)
//   3   promotion gate rejected the candidate (PromoteCommand only)
//
// Non-interactive: every input arrives via argv. No prompts. Logging is structured via
// nestjs-pino on the application context; the operator-facing summary (table / report id
// / artefact path) is plain stdout so a shell can pipe / capture it.

const SUBCOMMAND_COMPARE = 'compare';
const SUBCOMMAND_PROMOTE = 'promote';
const SUBCOMMAND_REACTIVATE = 'reactivate';

export const STRATEGY_CLI_EXIT_OK = 0;
export const STRATEGY_CLI_EXIT_RUNTIME = 1;
export const STRATEGY_CLI_EXIT_BAD_ARGS = 2;
export const STRATEGY_CLI_EXIT_GATE_REJECTED = 3;

async function main(argv: readonly string[]): Promise<number> {
    const [subcommand, ...rest] = argv;

    if (subcommand === undefined) {
        console.error('strategy: missing subcommand. Expected one of: compare | promote | reactivate');
        return STRATEGY_CLI_EXIT_BAD_ARGS;
    }

    let parsedArgs: ICompareArgs | IPromoteArgs | IReactivateArgs;

    try {
        if (subcommand === SUBCOMMAND_COMPARE) {
            parsedArgs = parseCompareArgs(rest);
        } else if (subcommand === SUBCOMMAND_PROMOTE) {
            parsedArgs = parsePromoteArgs(rest);
        } else if (subcommand === SUBCOMMAND_REACTIVATE) {
            parsedArgs = parseReactivateArgs(rest);
        } else {
            console.error(`strategy: unknown subcommand '${subcommand}'. Expected one of: compare | promote | reactivate`);
            return STRATEGY_CLI_EXIT_BAD_ARGS;
        }
    } catch (cause) {
        console.error(`strategy ${subcommand}: ${(cause as Error).message}`);
        return STRATEGY_CLI_EXIT_BAD_ARGS;
    }

    const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });
    const logger = new Logger('StrategyCli');

    try {
        if (subcommand === SUBCOMMAND_COMPARE) {
            const command = new CompareCommand(
                app.get(ComparisonRunnerService),
                app.get(ComparisonReportRepository),
                app.get(StrategyVersionRepository),
            );

            const result = await command.execute(parsedArgs as ICompareArgs);

            console.log(`report_id=${result.reportId}`);
            console.log(`artefact=${result.artefactPath}`);
            console.log(result.summaryTable);

            return STRATEGY_CLI_EXIT_OK;
        }

        if (subcommand === SUBCOMMAND_PROMOTE) {
            const command = new PromoteCommand(app.get(PromotionService));
            const result = await command.execute(parsedArgs as IPromoteArgs);

            if (!result.success) {
                console.error(result.rejectionTable);
                return STRATEGY_CLI_EXIT_GATE_REJECTED;
            }

            console.log(result.summary);
            return STRATEGY_CLI_EXIT_OK;
        }

        const command = new ReactivateCommand(app.get(PromotionService), app.get(StrategyVersionRepository));
        const result = await command.execute(parsedArgs as IReactivateArgs);
        console.log(result.summary);

        return STRATEGY_CLI_EXIT_OK;
    } catch (cause) {
        logger.error(`strategy ${subcommand} failed: ${(cause as Error).message}`, (cause as Error).stack);
        console.error(`strategy ${subcommand}: ${(cause as Error).message}`);

        return STRATEGY_CLI_EXIT_RUNTIME;
    } finally {
        await app.close();
    }
}

// Entry. `require.main === module` guard keeps the file importable from tests without
// auto-running the bootstrap on require.
if (require.main === module) {
    void main(process.argv.slice(2)).then((code) => {
        process.exit(code);
    });
}

export { main as runStrategyCli };
