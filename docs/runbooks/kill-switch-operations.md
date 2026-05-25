# Kill-Switch Operations

The halt flag is the bot's emergency stop. This runbook covers operator procedures for issuing auth tokens, halting/resuming, and viewing audit history.

## Prerequisites

- Engine running with `EXECUTION_MODE=live` or `EXECUTION_MODE=dry-run` (halt works on both)
- CLI access: `pnpm engine auth <command>` and `curl` or REST client for HTTP endpoints
- Auth secret configured in `.env` (AUTH_SECRET): 32+ byte hex string, not committed

## Issuing an auth token

**Command:**
```bash
pnpm engine auth issue --sub <operator_id> --scope read,halt [--ttl-sec 3600]
```

**Example:**
```bash
pnpm engine auth issue --sub ops-alice --scope read,halt --ttl-sec 7200
```

**Output:** A JWT bearer token (HS256, signed with AUTH_SECRET). Store it securely; it grants `read` and `halt` scopes.

**Scope meanings:**
- `read`: GET endpoints (positions, PnL, decisions, health)
- `halt`: POST/PUT halt/resume (state-change endpoints)

**Token lifetime:** Default `AUTH_TOKEN_DEFAULT_TTL_SEC` (currently 1 hour). Max is `AUTH_TOKEN_MAX_TTL_SEC`. Tokens expire server-side; revocation takes immediate effect.

## Halting the bot

**REST endpoint:**
```bash
POST /v1/control/halt
Authorization: Bearer <token>
Content-Type: application/json

{
  "reason": "operator-emergency",
  "flatten": true
}
```

**Using curl:**
```bash
curl -X POST http://localhost:3000/v1/control/halt \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"reason":"operator-emergency","flatten":true}'
```

**What happens:**
1. Engine rejects all new entry signals (ExecutionModule checks halt flag before opening positions)
2. If `flatten=true` (default recommended): existing positions are closed at market (reduce-market policy)
3. Audit log records: actor (token subject), timestamp, source IP, reason
4. Telegram alert fires (if configured)

**Rate limit:** 5 halts per 60 seconds per token subject (sub). Exceeding this is a 429 Too Many Requests.

## Resuming the bot

**REST endpoint:**
```bash
POST /v1/control/resume
Authorization: Bearer <token>
Content-Type: application/json

{}
```

**Using curl:**
```bash
curl -X POST http://localhost:3000/v1/control/resume \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json"
```

**What happens:**
1. Engine re-enables entry signals
2. Audit log records the resume action
3. Telegram alert fires (if configured)

## Viewing halt history

**REST endpoint:**
```bash
GET /v1/control/halt/history?limit=20&offset=0
Authorization: Bearer <token>
```

**Response (JSON):**
```json
{
  "rows": [
    {
      "id": 123,
      "actor": "ops-alice",
      "action": "halt",
      "reason": "operator-emergency",
      "flatten": true,
      "occurredAtMs": 1621234567890,
      "sourceIp": "192.168.1.100",
      "acknowledgedAtMs": null
    },
    {
      "id": 122,
      "actor": "bot-risk-gates",
      "action": "halt",
      "reason": "market-stress",
      "flatten": false,
      "occurredAtMs": 1621234567800,
      "sourceIp": null,
      "acknowledgedAtMs": 1621234568000
    }
  ],
  "total": 47,
  "cursor": "eyJvZmZzZXQiOjIwfQ=="
}
```

**Note on cursor:** The `cursor` field is an HMAC-guarded opaque token for pagination. Use it as `?cursor=<value>` to fetch the next page. Do NOT modify or decode it; tampering is detected and rejected.

## Understanding the audit log

Each row in the halt history represents one action:

- **actor:** Who triggered it. `bot-risk-gates` = automatic (market-stress halt, model-divergence kill-switch). Operator name = manual halt/resume.
- **action:** `halt` or `resume`
- **reason:** Human-readable reason. Operator-halt reasons: `operator-emergency`, `market-anomaly`, etc. Auto halts: `market-stress`, `model-divergence`, `global-halt`
- **flatten:** Boolean. `true` = close all positions at market. `false` = halt new entries only; let existing positions run or close naturally.
- **occurredAtMs:** Unix timestamp (milliseconds) when the action was applied.
- **sourceIp:** IP address of the operator (for manual halts) or null (for automatic halts).
- **acknowledgedAtMs:** When the operator acknowledged the alert (for UI workflows). null if not yet acknowledged.

## Automatic halts (read-only in read API)

Certain risk conditions trigger automatic halts with `actor: "bot-risk-gates"`:

1. **market-stress:** BTC/ETH shocks, breadth collapse, funding extreme, or spread widening. Reason: `market-stress`. Engine rejects mean-reversion entries (v1) until conditions normalize.
2. **model-divergence:** Live slippage diverges from modeled expected distribution (M9 Option β, alert-only path; does not halt, only warns).

These are **programmatically triggered** and do NOT count against the operator rate limit. They are visible in the halt history audit log and alert via Telegram.

## flatten flag

**`flatten=true`:** Close all open positions immediately at market price using reduce-market policy. Useful in emergency; incurs slippage.

**`flatten=false`:** Halt new entries but allow existing positions to close naturally (via their SL/TP or orchestrator close logic). Safer for normal risk management; slower exit.

The **default is set via config** (`HALT_FLATTEN_BY_DEFAULT`, default: `true` for safety). Operators can override per request.

## Revoking a token

**Command:**
```bash
pnpm engine auth revoke --jti <jti> [--reason "leaked" ]
```

**Example:**
```bash
pnpm engine auth revoke --jti abc123xyz --reason "suspected-leak"
```

**What happens:**
- Token is added to a revocation list (revoked_jti table)
- Any requests using that token immediately fail with 401 Unauthorized
- Revocation is permanent (no un-revoke)
- Best practice: re-issue a new token and discard the old one

## Common scenarios

### "Bot is stuck halted"
1. Check history: `GET /v1/control/halt/history`
2. Find the most recent halt row. If `actor="bot-risk-gates"`, a risk condition triggered it. Check Telegram alerts or look at engine logs for the trigger (market-stress, model-divergence).
3. If `actor="ops-<name>"`, an operator halted it. Contact them or resume manually if authorized.
4. To resume: `POST /v1/control/resume` with your auth token.
5. If the halt immediately re-engages, the risk condition is still active. Wait for it to resolve or escalate to engineering.

### "Bot halted unexpectedly"
1. Check Telegram alerts for the reason.
2. View `GET /v1/control/halt/history` to confirm the auto-halt timestamp and reason.
3. If reason is `market-stress`: anomalous market conditions are present (BTC/ETH shock, breadth collapse, or extreme funding). Wait 5–10 minutes and check if it resumes. If not, escalate.
4. If reason is `model-divergence`: live performance diverged from backtest. This is an alert-only path (does not halt under Option β); if it did halt, escalate immediately.

### "Token expired, can't authenticate"
1. Issue a new token: `pnpm engine auth issue --sub <your_id> --scope read,halt`
2. Use the new token in subsequent requests
3. Old token is still valid until it naturally expires (based on its TTL). To revoke it immediately, use `pnpm engine auth revoke --jti <old_jti>`

## Audit trail

All halt/resume actions are logged to the `control_audit` table in Postgres. The read API exposes this via `GET /v1/control/halt/history`. For forensics:
- Query the database directly: `SELECT * FROM control_audit ORDER BY occurred_at DESC;`
- Check engine logs: `docker logs <engine_container> | grep "HALT\|RESUME"`
- Check Telegram alert history (if integrated)
