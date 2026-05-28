# ADR 0038 — Localhost HTTP transport for `apps/mcp/` (Bearer-auth, MCP_TRANSPORT selector)

**Status:** Accepted (M13 W0 — orchestrator-blessed config-row + HTTP transport + compose cron)
**Date:** 2026-05-27
**Milestone:** M13 — Agentic weekly loop
**Depends on:** ADR 0020 (auth, CORS, HS256 + JTI revocation + TTL), ADR 0027 (login endpoint — token issuance pattern), ADR 0033 (MCP module boundary), ADR 0034 (MCP DB isolation), ADR 0035 (agent structural boundary).
**Consumed by:** M13 W1 items 1–3 (HTTP transport, bearer auth, `get_halt_state` tool), M13 W6 (transport-spoofing adversarial QA).
**Related:** `docs/plans/M13-execution-plan.md` §"Open architectural questions" #2, §W1, §W6a vector 5, M12 §R3 deferral note.

## 1. Context

M12 shipped `apps/mcp/` with **stdio JSON-RPC transport** because the MCP
client at that time was a human-operated tool (Claude Code, Cursor) that
spawns the server as a child process. M13 inverts the topology:

- The MCP client is now a long-running cron-driven Node process (the
  agent in `apps/agent/`).
- Spawning the MCP server fresh per agent-loop iteration is wasteful —
  every iteration would re-bootstrap TypeORM, re-warm pools, re-allocate
  the analysis package.
- The agent runs in its own container; the MCP server runs in its own
  container; talking over stdio across container boundaries is awkward
  (requires `docker exec` from inside `apps/agent`, which then imports
  shell semantics into a TS program).

M12 §R3 deferred the HTTP transport question to M13 explicitly. This ADR
codifies it.

The orchestrator-locked inputs for M13:

> Agent runs in apps/agent/ as its own workspace; talks to MCP over
> localhost HTTP (not stdio), Bearer-auth reusing M9's HS256 path.
>
> MCP_TRANSPORT={stdio|http} env var; defaults to stdio to preserve M12
> human-MCP-client compatibility.
>
> 6th read-only tool get_halt_state.

The HTTP transport must NOT:

- Weaken ADR 0033's structural boundary (`apps/mcp/` still cannot import
  `@bot/engine`).
- Introduce a new key material (auth must reuse M9's HS256 path —
  ADR 0020).
- Become reachable from outside `127.0.0.1` / the docker-compose internal
  network.
- Block stdio operation for human-MCP-client workflows.
- Enable any **write** tool by virtue of being on the HTTP transport.

## 2. Decision

### 2.1 Bind address — `127.0.0.1` only

The HTTP server binds to `127.0.0.1` exclusively, never `0.0.0.0`,
never an interface IP. In docker-compose, the `bot-mcp` service exposes
the HTTP port on the **internal compose network only** — there is no
`ports:` mapping to the host. Other compose services (`bot-agent`,
`bot-dashboard` if it ever needs MCP access) reach the MCP at
`http://bot-mcp:<port>` via Docker's user-defined network. From the
host's perspective the port is not reachable.

Within the MCP container, the listener binds to `127.0.0.1` (not
`0.0.0.0`); the compose user-defined network publishes the container's
`127.0.0.1:<port>` via Docker's internal DNS as `bot-mcp:<port>`. The
double-layer (bind + network scoping) means even a misconfigured
compose file that exposes the port to the host would still see the
listener refuse connections from non-loopback addresses inside the
container.

**Unit-test asserted.** `apps/mcp/tests/transport/HttpTransport.bind.spec.ts`
boots the HTTP server, reads `server.address()`, and asserts
`address === '127.0.0.1'` (rejecting `'0.0.0.0'`, `'::'`,
`'::ffff:0.0.0.0'`, or any non-loopback string). Required-green in
every fix wave.

### 2.2 Authentication — Bearer HS256, reusing M9's path

No new key material is introduced. The HTTP transport's auth path is:

1. Request arrives with `Authorization: Bearer <jwt>` header.
2. JWT is verified against `AUTH_HS256_KEY` env var (same env var the
   engine uses; loaded by `AppConfigService` per ADR 0020 §2.7).
3. The `jti` claim is checked against the `revoked_jti` table
   (shared via the same DB; MCP's read role has SELECT grant on
   `revoked_jti` for this purpose — added by the M13 W1 migration as a
   single-line additive grant).
4. The `aud` claim MUST equal `mcp` — tokens minted for the
   dashboard/operator (`aud=engine` or unset) are rejected. This
   prevents an operator-session token from being repurposed as an
   agent token.
5. The `exp` claim must be in the future. TTL semantics inherited from
   ADR 0020 (default 15 min; M13 agent uses extended TTL — see §2.3).
6. On failure, response is JSON-RPC error `-32000` with body
   `{ "code": -32000, "message": "AUTH_FAILED", "data": { "reason":
   <reason> } }` where `<reason>` is one of `MISSING_BEARER`,
   `BAD_SIGNATURE`, `EXPIRED`, `REVOKED`, `BAD_AUDIENCE`, `MALFORMED`.
   The reason set extends `IAuthFailure` from ADR 0020 §2.6.

The HTTP request handler is a thin shell around the same
`ToolRegistry` and tool implementations as the stdio transport. The
transport is the **only** swappable layer (per M13 W1.1 decision
justification); tools have no awareness of which transport invoked
them.

### 2.3 Token issuance — engine-side CLI

Agent-aud tokens are minted by an engine-side CLI:

```
pnpm --filter @bot/engine auth mint-token --aud mcp --sub agent --ttl 7d
```

Decisions:

- **`--aud mcp` is required** for any token used against the HTTP
  transport. The CLI rejects `--aud engine --transport mcp`
  combinations.
- **`--sub agent`** is documented as the convention for agent-process
  tokens; other subjects (`--sub backfill`, `--sub human-mcp-client`)
  are permitted — `sub` is informational for audit, not enforced for
  routing.
- **`--ttl 7d`** is the agent's operational sweet-spot: long enough
  that the operator does not mint per-run, short enough that a stale
  token does not outlive a typical operator absence. ADR 0020's 15-min
  TTL is for **operator-session** tokens, not for **service-account**
  tokens. M13 extends `AUTH_TOKEN_TTL_SEC`'s upper bound at the CLI to
  allow up to 30 days for `--aud mcp` tokens; the login endpoint
  (ADR 0027 §2.2) is unaffected — login still mints `read,halt` short-TTL
  tokens only.
- **Revocation works identically.** `pnpm --filter @bot/engine auth
  revoke --jti <id>` writes to `revoked_jti`; the MCP HTTP transport
  picks it up on the next request.
- **Audit row.** Token mint writes a `control_audit` row with
  `action='LOGIN_SUCCESS'`, `actor_sub='cli'`, `actor_jti=<new jti>`,
  `source_ip=null`, `reason='cli-mint --aud mcp --sub <sub>'`. Audit
  precedent matches ADR 0027 §2.6.

The agent reads its bearer from `AGENT_MCP_BEARER` env var (operator
populates `.env` after running the CLI; documented in M13 W5.5
runbook).

### 2.4 `MCP_TRANSPORT` boot selector

A single env var picks the transport at MCP boot:

- `MCP_TRANSPORT=stdio` (default — preserves M12 compatibility with
  human MCP clients).
- `MCP_TRANSPORT=http` — enables the HTTP listener; stdio is not
  started.

The two transports are mutually exclusive (no dual-listen mode in M13;
adding both is a future option if a single MCP serves both human and
agent clients simultaneously). The selector is read by
`AppConfigService` (no `process.env` access elsewhere — ADR 0020 §2.7
discipline extended to MCP). Invalid values fail boot with a clear
error.

When `MCP_TRANSPORT=http`, additional required env vars:

- `MCP_HTTP_PORT` (default `7341`).
- `AUTH_HS256_KEY` (the same secret the engine uses; shared via
  compose env injection, never logged).

### 2.5 Transport layer file location

The new transport lives at `apps/mcp/src/transport/HttpTransport.ts`
(per M13 W1.1). It uses Node's built-in `http.createServer` — no
Express, no Fastify — to minimize dep surface and avoid pulling a web
framework into the boundary-checked workspace. The stdio transport
remains at `apps/mcp/src/transport/StdioTransport.ts` (refactor-renamed
in W1 if not already; same module shape).

Both transports register the same `ToolRegistry` from W1.1; ADR 0033's
runtime guard and ESLint rule are unchanged.

### 2.6 New tool: `get_halt_state`

Sixth read-only tool, added in M13 W1.3. Reads from `risk_state`:

- Input: none (or `{}`).
- Output: `IHaltStateView { isHalted: boolean; haltReason: string|null;
  date: string }`.
- Registration: via `registerReadOnlyTool` (the M12 `ToolRegistry`
  reject-by-construction primitive). The runtime guard scans the
  registry at boot and asserts no tool implements a write capability
  — `get_halt_state` cannot WRITE the halt flag because there is no
  registration primitive for write tools.

`IHaltStateView` is added to `@bot/shared` in the same wave (piggy-back
through `bot-shared-maintainer`).

### 2.7 What this transport does NOT add

- **No CORS.** The HTTP listener is loopback-bound; browsers cannot
  reach it. CORS headers are not emitted.
- **No login endpoint on this transport.** Tokens are minted by the
  engine-side CLI only. ADR 0027's `POST /v1/auth/login` is engine-only
  and is not duplicated on MCP.
- **No rate-limit beyond the existing per-tool budgets.** The MCP's
  per-tool wallclock and query budgets (ADR 0034 §2.4) apply equally
  to HTTP-invoked calls. M13's single-agent caller is a known small
  client; rate-limit is a future consideration when M14/M15 introduces
  multiple agent processes.
- **No write tools.** The 6th tool (`get_halt_state`) is read-only.
  The registry rejects write registrations by construction.
- **No streaming responses (SSE/WS).** JSON-RPC request/response only.
  `run_backtest`'s 10-minute wallclock is still a synchronous call
  with a long-lived HTTP socket; the agent's `McpClient` sets a 10-min
  + 30-sec buffer socket timeout (M13 W1.4) specifically for it.

## 3. Consequences

**Positive.**

- The agent talks to a persistent MCP server, avoiding per-iteration
  bootstrap cost.
- No new key material — auth reuses M9's HS256 + JTI revocation flow.
  Revoking a leaked agent token is a one-command operator action.
- `aud=mcp` audience claim binds tokens to the transport: a leaked
  dashboard token cannot drive the MCP, and vice versa.
- The MCP boundary (ADR 0033) is unchanged. The new file lives at
  `apps/mcp/src/transport/HttpTransport.ts` and imports only from
  `apps/mcp/src/` and `@bot/shared` — same import policy as the
  stdio transport.
- Stdio remains the default — M12's human-MCP-client workflow is
  unaffected.

**Negative.**

- One more env var to manage (`MCP_TRANSPORT`); operator must remember
  to set it for the agent compose profile. Mitigated by the M13 W5
  runbook and the `.env.example` update.
- The `revoked_jti` SELECT grant is a small additive change to the
  `mcp_reader` role (ADR 0034 §2.5 explicitly listed `revoked_jti` as
  NOT granted). This ADR amends that grant for the auth-check path
  only; documented in `docs/architecture/data-model.md`. The grant is
  SELECT-only and gives MCP no ability to mutate revocation state.

**Neutral.**

- The HTTP transport adds ~200 LOC to `apps/mcp/`; minimal.
- Both transports share the registry; tool authors do not see the
  transport choice.

### 3.1 Amendment to ADR 0034

ADR 0034 §2.5 listed `auth_tokens`/`revoked_jti` in the
"Not granted (sensitive)" set. This ADR amends that: **`revoked_jti`
gains SELECT for `mcp_reader`** (the role MCP uses for both transports
— the auth-check is in the same process). `auth_tokens` remains
NOT granted; revocation state is the only auth-table read MCP needs.
The amendment is reflected in the M13 W1 migration.

## 4. Alternatives considered

- **A. Keep stdio; spawn MCP per agent-loop iteration.** Rejected:
  TypeORM cold-start per iteration is ~1–2 sec, multiplied across
  ~7 tool calls per run is wasteful — and the spawn happens inside
  the `apps/agent` container, which would require Docker-in-Docker or
  a host-socket mount to spawn a sibling. Operationally heavy for
  no boundary benefit (stdio across containers is awkward; HTTP
  across containers is the native Docker idiom).
- **B. Unix domain socket between containers.** Possible (shared
  volume mount of the socket file). Rejected: less portable to M15's
  ECS/k8s topology where containers don't share volumes by default.
  HTTP loopback inside the compose network is the same property
  (in-network only) with cloud parity.
- **C. mTLS instead of Bearer.** Stronger in principle. Rejected for
  M13 for the same reasons ADR 0020 §4 rejected mTLS for M9: cert
  provisioning workflow exceeds the M13 budget; revocation via CRL is
  harder than JTI revocation. Revisit at M15 if external exposure is
  in scope.
- **C. New HS256 key dedicated to MCP.** Considered. Rejected: two
  key materials to rotate, two boot-time validations to maintain, two
  loss-of-key incidents to handle. M9's `AUTH_HS256_KEY` is already
  the single auth secret; reusing it with audience scoping (`aud=mcp`)
  achieves separation cheaper.
- **D. Bind to `0.0.0.0` and rely on Docker network for isolation.**
  Rejected: bind-to-loopback is a defense-in-depth layer. A
  misconfigured compose `ports:` mapping exposing the port to the
  host would still see the listener refuse non-loopback connections.
- **E. Run both stdio and HTTP listeners simultaneously.** Possible
  but unnecessary in M13 — only one client per MCP instance.
  Deferred; M14 or M15 may revisit if a single MCP serves both human
  and agent clients.
- **F. Provide a login endpoint on MCP (ADR 0027 shape).** Rejected:
  MCP has no operator-facing UX. Tokens are minted by the engine-side
  CLI; agent reads them from env. Adding a login endpoint widens the
  attack surface for no operator benefit.
- **G. Use the existing engine `POST /v1/auth/login` and have the
  agent log in once per run.** Considered. Rejected for M13: introduces
  an engine ↔ agent runtime dependency (engine must be up for agent
  to start). The CLI-mint + `.env` pattern decouples the boot order
  (agent can run against a stopped engine — and will exit cleanly via
  the MCP `get_halt_state` early-exit).
- **H. JWT `aud` claim as a list, allowing one token to serve multiple
  surfaces.** Rejected: precision over convenience. A leaked
  "multi-aud" token is a multi-surface leak. Mint one token per
  audience.

## 5. References

- `docs/plans/M13-execution-plan.md` §"Open architectural questions"
  #2 (HTTP-over-stdio decision rationale), §W1 items 1–3,
  §W6a vector 5, §Risks R3 + R6.
- ADR 0020 §2.1 (HS256 token shape), §2.2 (revocation), §2.6
  (`IAuthFailure` envelope), §2.7 (typed env access).
- ADR 0027 §2.6 (CLI coexistence pattern this ADR extends with
  `--aud mcp`).
- ADR 0033 §2.4 (MCP boundary unchanged), §2.5 (transport-only
  swappable layer principle).
- ADR 0034 §2.5 (`mcp_reader` table grants — this ADR amends to add
  `revoked_jti`).
- ADR 0035 (agent structural boundary — the agent reaches MCP **only**
  through this HTTP transport, never through code-import).
