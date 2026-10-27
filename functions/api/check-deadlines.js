import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const ESCROW_WALLET_ID = "d4e56011-550e-5b0f-90e6-73f2422df581";
const USDC_TOKEN_ID = "ef87c8c3-85de-598a-af50-c5135eecfa74";

async function releaseFunds(client, recipientAddress, amount) {
  const transferResponse = await client.createTransaction({
    walletId: ESCROW_WALLET_ID,
    tokenId: USDC_TOKEN_ID,
    destinationAddress: recipientAddress,
    amounts: [amount.toString()],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  const transactionId = transferResponse.data?.id;
  if (!transactionId) return null;

  let currentState = transferResponse.data?.state ?? '';
  const terminalStates = new Set(['COMPLETE', 'FAILED', 'CANCELLED', 'DENIED']);
  let txHash = null;

  for (let i = 0; i < 10 && !terminalStates.has(currentState); i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const pollResponse = await client.getTransaction({ id: transactionId });
    const tx = pollResponse.data?.transaction;
    currentState = tx?.state ?? '';
    txHash = tx?.txHash ?? null;
  }

  return currentState === 'COMPLETE' ? txHash : null;
}

async function claimEscrow(url, key, id, fromStatus) {
  const res = await fetch(`${url}/rest/v1/escrows?id=eq.${id}&status=eq.${fromStatus}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({ status: 'processing' })
  });
  const rows = await res.json();
  return Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
}

async function releaseClaim(url, key, id, backTo) {
  try {
    await fetch(`${url}/rest/v1/escrows?id=eq.${id}&status=eq.processing`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ status: backTo })
    });
  } catch (e) {}
}

export async function onRequest(context) {
  const { request, env } = context;

  const authHeader = request.headers.get('authorization');
  if (env.CRON_SECRET && authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_KEY;

  try {
    const nowIso = new Date().toISOString();

    const res1 = await fetch(
      `${SUPABASE_URL}/rest/v1/escrows?status=eq.pending&deadline=lt.${nowIso}&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const expiredEscrows = await res1.json();

    if (!Array.isArray(expiredEscrows) || expiredEscrows.length === 0) {
      return new Response(JSON.stringify({ success: true, processed: 0, message: 'No expired escrows found' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const client = initiateDeveloperControlledWalletsClient({
      apiKey: env.CIRCLE_API_KEY,
      entitySecret: env.CIRCLE_ENTITY_SECRET,
    });

    const results = [];

    for (const escrow of expiredEscrows) {
      try {
        if (escrow.sender_disputed) {
          results.push({ id: escrow.id, action: 'skipped-disputed' });
          continue;
        }

        const claimed = await claimEscrow(SUPABASE_URL, SUPABASE_KEY, escrow.id, 'pending');
        if (!claimed) {
          results.push({ id: escrow.id, action: 'skipped-locked' });
          continue;
        }

        if (escrow.recipient_fulfilled) {
          const txHash = await releaseFunds(client, escrow.recipient_address, escrow.amount);
          if (txHash) {
            await fetch(`${SUPABASE_URL}/rest/v1/escrows?id=eq.${escrow.id}`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`
              },
              body: JSON.stringify({ status: 'released', release_tx_hash: txHash })
            });
            results.push({ id: escrow.id, action: 'auto-released', txHash });
          } else {
            await releaseClaim(SUPABASE_URL, SUPABASE_KEY, escrow.id, 'pending');
            results.push({ id: escrow.id, action: 'release-failed' });
          }
        } else {
          const txHash = await releaseFunds(client, escrow.sender_address, escrow.amount);
          if (txHash) {
            await fetch(`${SUPABASE_URL}/rest/v1/escrows?id=eq.${escrow.id}`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`
              },
              body: JSON.stringify({ status: 'refunded', release_tx_hash: txHash })
            });
            results.push({ id: escrow.id, action: 'auto-refunded', txHash });
          } else {
            await releaseClaim(SUPABASE_URL, SUPABASE_KEY, escrow.id, 'pending');
            results.push({ id: escrow.id, action: 'refund-failed' });
          }
        }
      } catch (escrowErr) {
        await releaseClaim(SUPABASE_URL, SUPABASE_KEY, escrow.id, 'pending');
        results.push({ id: escrow.id, action: 'error', error: escrowErr.message });
      }
    }

    return new Response(JSON.stringify({ success: true, processed: results.length, results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
