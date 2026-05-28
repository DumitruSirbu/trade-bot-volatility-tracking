// M13 W3 — composition layer that satisfies `runWeeklyLoop`'s
// `IPersistencePort`. Thin facade over the two raw-SQL primitives
// (`draftStrategyVersion` + `insertAgentRunHistory`); keeps the loop
// agnostic of which client implementation backs the DB calls so test
// stubs can swap either side.

import type { IAgentPgClient } from './AgentPgClient.js';
import { draftStrategyVersion, type IDraftStrategyVersionArgs } from './draftStrategyVersion.js';
import { insertAgentRunHistory, type IAgentRunHistoryRow } from './agentRunHistory.js';

export class AgentPersistence {
    constructor(private readonly pg: IAgentPgClient) {}

    draftStrategyVersion(args: IDraftStrategyVersionArgs): Promise<number | null> {
        return draftStrategyVersion(this.pg, args);
    }

    recordHistory(row: IAgentRunHistoryRow): Promise<number | null> {
        return insertAgentRunHistory(this.pg, row);
    }
}
