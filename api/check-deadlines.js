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

export default async function handler(req, res) {
  // Optional shared secret so random internet traffic can't trigger this endpoint
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  try {
    const nowIso = new Date().toISOString();

    // Find all pending escrows past their deadline
    const res1 = await fetch(
      `${SUPABASE_URL}/rest/v1/escrows?status=eq.pending&deadline=lt.${nowIso}&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const expiredEscrows = await res1.json();

    if (!Array.isArray(expiredEscrows) || expiredEscrows.length === 0) {
      return res.status(200).json({ success: true, processed: 0, message: 'No expired escrows found' });
    }

    const client = initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET,
    });

    const results = [];

    for (const escrow of expiredEscrows) {
      try {
        if (escrow.recipient_fulfilled && !escrow.sender_disputed) {
          // Recipient did their part, sender never responded -> auto-release to recipient
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
          }
        } else if (!escrow.recipient_fulfilled) {
          // Recipient never confirmed fulfillment -> auto-refund to sender
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
          }
        }
        // If recipient_fulfilled is true AND sender_disputed is true, leave it alone - needs manual resolution
      } catch (escrowErr) {
        results.push({ id: escrow.id, action: 'error', error: escrowErr.message });
      }
    }

    return res.status(200).json({ success: true, processed: results.length, results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
