import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const ESCROW_WALLET_ID = "d4e56011-550e-5b0f-90e6-73f2422df581";
const USDC_TOKEN_ID = "ef87c8c3-85de-598a-af50-c5135eecfa74";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { escrowId, senderAddress } = req.body;

  if (!escrowId || !senderAddress) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  try {
    // Verify the escrow, sender identity, and that recipient has already marked fulfilled
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/escrows?id=eq.${escrowId}&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await checkRes.json();
    const escrow = rows && rows[0];

    if (!escrow) {
      return res.status(404).json({ error: 'Escrow not found' });
    }
    if (escrow.sender_address.toLowerCase() !== senderAddress.toLowerCase()) {
      return res.status(403).json({ error: 'Only the original sender can confirm this escrow' });
    }
    if (escrow.status !== 'pending') {
      return res.status(400).json({ error: 'This escrow is no longer pending' });
    }
    if (!escrow.recipient_fulfilled) {
      return res.status(400).json({ error: 'Recipient has not marked their part as fulfilled yet' });
    }

    // Release USDC from the Circle escrow wallet to the recipient
    const client = initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET,
    });

    const transferResponse = await client.createTransaction({
      walletId: ESCROW_WALLET_ID,
      tokenId: USDC_TOKEN_ID,
      destinationAddress: escrow.recipient_address,
      amounts: [escrow.amount.toString()],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    const transactionId = transferResponse.data?.id;
    if (!transactionId) {
      return res.status(500).json({ error: 'Circle transaction creation failed', details: transferResponse.data, fullResponse: JSON.stringify(transferResponse) });
    }

    let currentState = transferResponse.data?.state ?? '';
    const terminalStates = new Set(['COMPLETE', 'FAILED', 'CANCELLED', 'DENIED']);
    let txHash = null;

    // Poll until the transfer completes (max ~30 seconds)
    for (let i = 0; i < 10 && !terminalStates.has(currentState); i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const pollResponse = await client.getTransaction({ id: transactionId });
      const tx = pollResponse.data?.transaction;
      currentState = tx?.state ?? '';
      txHash = tx?.txHash ?? null;
    }

    if (currentState !== 'COMPLETE') {
      return res.status(500).json({ error: `Transfer did not complete, ended in state: ${currentState}` });
    }

    // Mark escrow as released in Supabase
    await fetch(`${SUPABASE_URL}/rest/v1/escrows?id=eq.${escrowId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify({
        sender_confirmed: true,
        sender_confirmed_at: new Date().toISOString(),
        status: 'released',
        release_tx_hash: txHash
      })
    });

    return res.status(200).json({ success: true, txHash });
  } catch (err) {
    console.log('mark-confirmed error:', err);
    return res.status(500).json({
      error: err.message,
      circleError: err.response?.data || err.response?.body || null
    });
  }
}
