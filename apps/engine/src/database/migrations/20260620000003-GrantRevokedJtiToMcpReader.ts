import { MigrationInterface, QueryRunner } from 'typeorm';

// M13 W1.B (ADR 0038) — grant `mcp_reader` SELECT on `revoked_jti`.
//
// Background — the M12 migration (`20260619000000-CreateMcpReaderRole.ts`)
// deliberately excluded auth-adjacent tables (`auth_tokens`, `revoked_jti`)
// from the mcp_reader whitelist on least-privilege grounds: at the time,
// MCP did not need to consult auth state, and locking the role out of those
// tables made the grant set easy to audit.
//
// ADR 0038 §2.2 changed that: the MCP HTTP transport's bearer-verification
// path reuses the SAME JTI revocation table as the engine — when an operator
// revokes a token via the engine's `POST /halt` flow (or any future revocation
// endpoint), the row lands in `revoked_jti` and EVERY downstream verifier
// (engine + MCP) must honour it. Without SELECT on `revoked_jti`, the MCP
// HTTP transport's revocation check throws `permission denied for table
// revoked_jti` (SQLSTATE 42501); the verifier's catch-all mislabels the DB
// error as `MALFORMED`, and every legitimate bearer fails closed — locking
// the agent out entirely.
//
// Scope of this grant is narrowly SELECT only (read for the existence check).
// INSERT / UPDATE / DELETE on `revoked_jti` remain reserved to the engine's
// privileged role, preserving the M9 invariant that revocation lifecycle is
// engine-owned. The `default_transaction_read_only = on` setting on
// mcp_reader is a belt-and-suspenders guarantee even against accidental
// writes from the MCP side.
//
// Reversible: down() revokes the grant; the role remains intact.

export class GrantRevokedJtiToMcpReader20260620000003 implements MigrationInterface {
    name = 'GrantRevokedJtiToMcpReader20260620000003';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`GRANT SELECT ON TABLE "revoked_jti" TO "mcp_reader"`);
        // Belt-and-suspenders — explicitly REVOKE every write privilege so
        // the grant set matches the policy documented in
        // `docs/architecture/data-model.md` and is easy to audit via `\dp`.
        await queryRunner.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "revoked_jti" FROM "mcp_reader"`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`REVOKE SELECT ON TABLE "revoked_jti" FROM "mcp_reader"`);
    }
}
