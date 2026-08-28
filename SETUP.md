# Deadline keeper — setup

Restores automatic settlement now that escrow lives in the contract.

**12/12 tests passing** against the real contract on a live chain (`keepertest.js`):
auth rejection, no-op before deadline, release to recipient, refund to sender,
disputes left untouched, idempotent across repeated runs, and batching that
drains a backlog without timing out.

## What this key can and cannot do

The keeper calls `settle(id)`. The contract reads its own state and decides the
outcome — the caller is irrelevant. So:

- It **cannot** change who gets paid.
- It **cannot** settle anything early; `settle()` reverts before the deadline.
- It **cannot** touch a disputed escrow; that path reverts too.
- If the key leaks, the worst case is someone burning your gas triggering
  settlements that were already going to happen exactly that way.

It is also not load-bearing. `settle()` is public, so if the keeper stops, users
settle from the UI themselves. This is convenience, not a dependency.

## 1. Create a dedicated keeper wallet

Make a **new** wallet. Do not reuse your deployer. Fund it with a small amount of
USDC for gas only — it never needs to hold escrow funds.

## 2. Environment variables on Vercel

```
KEEPER_PRIVATE_KEY = <private key of the new keeper wallet>
ESCROW_CONTRACT    = 0x76D4694De06Bb3A3CDf39207FE27eD8A39EC1202
ARC_RPC            = https://arc-testnet.g.alchemy.com/v2/<your key>
ARC_CHAIN_ID       = 5042002
CRON_SECRET        = <the value you already use>
```

`CRON_SECRET` already exists. The other four are new.

## 3. Deploy

Add `api/settle-deadlines.js` to the repo.

## 4. Point the cron at it

On cron-job.org, edit the existing job:

- URL: `https://novaonarc.xyz/api/settle-deadlines`
- Header: `Authorization: Bearer <CRON_SECRET>`
- Every 1 minute is fine.

The old `check-deadlines` endpoint is gone; if the job still points there it will
404 silently.

## 5. Verify

Call it once by hand:

```js
fetch('https://novaonarc.xyz/api/settle-deadlines',{
  headers:{'Authorization':'Bearer <CRON_SECRET>'}
}).then(r=>r.json()).then(console.log)
```

Expect `{success:true, settled:0, message:"Nothing due"}` when nothing has
expired. That confirms auth, RPC and contract wiring in one call.

## Operational notes

- **Watch the gas balance.** If the keeper runs dry, settlement stops being
  automatic. Funds are never at risk, but users have to click Settle themselves.
- **Capped at 5 settlements per run** to stay inside the serverless time limit.
  At one run a minute a backlog clears quickly.
- **Scanning is full-history.** Fine at testnet volume. If escrow counts grow
  into the thousands, switch to scanning from a stored last-seen block.
