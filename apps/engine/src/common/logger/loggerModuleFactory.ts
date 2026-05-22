import { Params } from 'nestjs-pino';

import { NEST_TO_PINO_LEVEL } from '../const';
import { AppConfigService } from '../../config/service';
import { deepRedactLog } from './deepRedactLog';

// Builds nestjs-pino options from validated config. Outside production we render
// human-readable lines via pino-pretty; in production we emit raw structured
// JSON for log aggregation. Redaction is always on (deep, key-based — see
// deepRedactLog) so secrets never leak regardless of nesting depth.
export function createLoggerOptions(appConfig: AppConfigService): Params {
    const level = NEST_TO_PINO_LEVEL[appConfig.logLevel];

    return {
        pinoHttp: {
            level,
            formatters: {
                log: deepRedactLog,
            },
            transport: appConfig.isProduction
                ? undefined
                : {
                      target: 'pino-pretty',
                      options: {
                          singleLine: true,
                          translateTime: 'SYS:standard',
                      },
                  },
        },
    };
}
