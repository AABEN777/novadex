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
      return res.status(403).json({ error: 'Only the original sender can dispute this escrow' });
    }
    if (escrow.status !== 'pending') {
      return res.status(400).json({ error: 'This escrow is no longer pending, cannot dispute' });
    }
    if (!escrow.recipient_fulfilled) {
      return res.status(400).json({ error: 'Recipient has not marked fulfilled yet, no need to dispute' });
    }

    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/escrows?id=eq.${escrowId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        },
        body: JSON.stringify({
          sender_disputed: true,
          status: 'disputed'
        })
      }
    );

    if (!patchRes.ok) {
      const errData = await patchRes.json();
      return res.status(500).json({ error: 'Failed to dispute escrow', details: errData });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
