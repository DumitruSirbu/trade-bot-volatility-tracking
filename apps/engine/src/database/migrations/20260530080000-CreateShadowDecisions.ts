import { MigrationInterface, QueryRunner } from 'typeorm';

// M11a W0.5 (ADR 0029 §2.3.2). Creates the `shadow_decisions` table — the
// recording surface for non-executed strategy versions (v0/v2/v3) emitting
// decisions over the same `event_id` tape v1 executes against. Owned by the
// strategy module; sibling of `decisions` rather than a column on it so the
// hot `decisions` table stays free of nullable shadow-only fields and the two
// retention policies do not collide (ADR 0029 §3).
//
// Columns:
//   shadow_decisions_id           SERIAL PK — consistent with `decisions`
//                                  (SERIAL) so BaseRepository<T>'s numeric
//                                  `id` invariant holds. Volume scales with
//                                  the event tape (ADR 0029 §3); SERIAL is
//                                  ample for the M11a soak window and is the
//                                  same surface the live `decisions` table
//                                  already uses.
//   created_at                    timestamptz NOT NULL DEFAULT now()
//   event_id                      text NOT NULL  — shared with v1's decision
//                                  for the same trigger (same-event pairing,
//                                  ADR 0017).
//   shadow_version                text NOT NULL  — discriminator 'v0' | 'v2' | 'v3'.
//   strategy_version_id           integer NOT NULL — FK → strategy_versions
//                                  ON DELETE RESTRICT (a referenced version
//                                  must not vanish from under recorded
//                                  decisions) ON UPDATE CASCADE.
//   symbol                        text NOT NULL.
//   action                        text NOT NULL  — SignalActionEnum value.
//   reject_reason                 text NULL      — gate outcome reject reason.
//   gate_allowed                  boolean NOT NULL.
//   virtual_slot_state_snapshot   jsonb NOT NULL — IVirtualLedgerSnapshot at
//                                  the moment the gate was evaluated.
//   simulated_fill                jsonb NULL     — ISimulatedFill; null when
//                                  the gate rejected or the strategy skipped.
//   market_snapshot               jsonb NOT NULL — mirrors decisions.market_snapshot.
//
// Indexes (ADR 0029 §3 + W0.5 brief):
//   uq_shadow_decisions_version_event_id — UNIQUE(shadow_version, event_id)
//                                          for idempotency on replay (ADR 0029
//                                          §2.1.2 cursor rebuild).
//   idx_shadow_decisions_version_created_at — (strategy_version_id, created_at)
//                                          drives per-version time-window reads.
//   idx_shadow_decisions_created_at      — retention prune (ADR 0029 §3 floor).
//
// Reversible: down() drops indexes → FK constraint (implicit via DROP TABLE)
// → table, in exact reverse order of up().

export class CreateShadowDecisions20260530080000 implements MigrationInterface {
    name = 'CreateShadowDecisions20260530080000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "shadow_decisions" (
                "shadow_decisions_id" SERIAL NOT NULL,
                "created_at" timestamptz NOT NULL DEFAULT now(),
                "event_id" text NOT NULL,
                "shadow_version" text NOT NULL,
                "strategy_version_id" integer NOT NULL,
                "symbol" text NOT NULL,
                "action" text NOT NULL,
                "reject_reason" text,
                "gate_allowed" boolean NOT NULL,
                "virtual_slot_state_snapshot" jsonb NOT NULL,
                "simulated_fill" jsonb,
                "market_snapshot" jsonb NOT NULL,
                CONSTRAINT "pk_shadow_decisions" PRIMARY KEY ("shadow_decisions_id"),
                CONSTRAINT "fk_shadow_decisions_strategy_version" FOREIGN KEY ("strategy_version_id")
                    REFERENCES "strategy_versions" ("strategy_versions_id") ON DELETE RESTRICT ON UPDATE CASCADE
            )
        `);

        await queryRunner.query(`CREATE UNIQUE INDEX "uq_shadow_decisions_version_event_id" ON "shadow_decisions" ("shadow_version", "event_id")`);
        await queryRunner.query(`CREATE INDEX "idx_shadow_decisions_version_created_at" ON "shadow_decisions" ("strategy_version_id", "created_at")`);
        await queryRunner.query(`CREATE INDEX "idx_shadow_decisions_created_at" ON "shadow_decisions" ("created_at")`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_shadow_decisions_created_at"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_shadow_decisions_version_created_at"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "uq_shadow_decisions_version_event_id"`);

        await queryRunner.query(`DROP TABLE IF EXISTS "shadow_decisions"`);
    }
}
