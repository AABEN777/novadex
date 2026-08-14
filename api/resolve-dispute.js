import crypto from 'crypto';
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const ESCROW_WALLET_ID = "d4e56011-550e-5b0f-90e6-73f2422df581";
const USDC_TOKEN_ID = "ef87c8c3-85de-598a-af50-c5135eecfa74";

// Verifies the short-lived token issued by /api/admin-login.
// Replaces the old static bearer secret, which was readable in the page source.
function verifyAdminToken(token, signingKey) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [encodedExpiry, providedSig] = token.split('.');
  let expiry;
  try {
    expiry = Buffer.from(encodedExpiry, 'base64url').toString();
  } catch {
    return false;
  }
  if (!/^\d+$/.test(expiry)) return false;
  if (Number(expiry) < Date.now()) return false;

  const expectedSig = crypto.createHmac('sha256', signingKey).update(expiry).digest('base64url');
  const a = Buffer.from(providedSig || '');
  const b = Buffer.from(expectedSig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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


// Atomically claims an escrow before any funds move. The PATCH only matches
// rows still in `fromStatus`, so if a cron run or another request already took
// it, we get zero rows back and stop. Without this, two callers can both pass a
// status check and pay out twice.
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const signingKey = process.env.ADMIN_SECRET;
  if (!signingKey) return res.status(500).json({ error: 'Server is missing ADMIN_SECRET' });

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!verifyAdminToken(token, signingKey)) {
    return res.status(401).json({ error: 'Unauthorized or expired session. Please log in again.' });
  }

  const { escrowId, decision, resolvedBy } = req.body || {};
  if (!escrowId || !decision || !['release', 'refund'].includes(decision)) {
    return res.status(400).json({ error: 'Missing or invalid fields. decision must be "release" or "refund"' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  try {
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/escrows?id=eq.${escrowId}&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await checkRes.json();
    const escrow = rows && rows[0];

    if (!escrow) return res.status(404).json({ error: 'Escrow not found' });
    if (escrow.status !== 'disputed') {
      return res.status(400).json({ error: 'This escrow is not currently disputed' });
    }

    const claimed = await claimEscrow(SUPABASE_URL, SUPABASE_KEY, escrowId, 'disputed');
    if (!claimed) {
      return res.status(409).json({ error: 'This dispute is already being settled. Refresh in a moment.' });
    }

    const client = initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET,
    });

    const destination = decision === 'release' ? escrow.recipient_address : escrow.sender_address;
    const txHash = await releaseFunds(client, destination, escrow.amount);

    if (!txHash) {
      await releaseClaim(SUPABASE_URL, SUPABASE_KEY, escrowId, 'disputed');
      return res.status(500).json({ error: 'Transfer did not complete successfully' });
    }

    const newStatus = decision === 'release' ? 'released' : 'refunded';

    await fetch(`${SUPABASE_URL}/rest/v1/escrows?id=eq.${escrowId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify({
        status: newStatus,
        release_tx_hash: txHash,
        dispute_resolved_by: resolvedBy || 'admin',
        dispute_resolved_at: new Date().toISOString()
      })
    });

    return res.status(200).json({ success: true, decision, txHash });
  } catch (err) {
    await releaseClaim(SUPABASE_URL, SUPABASE_KEY, escrowId, 'disputed');
    return res.status(500).json({ error: err.message });
  }
}
