/**
 * Stores the readable description for an on-chain escrow.
 *
 * This function holds no authority. The contract owns the funds, the status and
 * the truth. Only a keccak256 hash of the description lives on-chain, so this
 * keeps the plaintext available for display, and the UI verifies it against the
 * hash before showing it. A wrong entry here shows a mismatch warning; it can
 * never change who gets paid.
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { chainId, senderAddress, recipientAddress, amount, description, depositTxHash } = req.body || {};
  if (!chainId || !senderAddress || !recipientAddress) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  try {
    // One row per on-chain escrow id.
    const existing = await fetch(
      `${SUPABASE_URL}/rest/v1/escrows?chain_id=eq.${chainId}&select=id`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await existing.json();
    if (Array.isArray(rows) && rows.length > 0) {
      return res.status(200).json({ success: true, note: 'already recorded' });
    }

    const r = await fetch(`${SUPABASE_URL}/rest/v1/escrows`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        chain_id: Number(chainId),
        sender_address: String(senderAddress).toLowerCase(),
        recipient_address: String(recipientAddress).toLowerCase(),
        amount: amount ?? null,
        description: description || null,
        deposit_tx_hash: depositTxHash || null,
        deadline: new Date().toISOString(),
        status: 'onchain'
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: 'Failed to record', details: data });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
