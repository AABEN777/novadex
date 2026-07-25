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

  const { escrowId, recipientAddress } = req.body;

  if (!escrowId || !recipientAddress) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  try {
    // Verify this escrow actually belongs to this recipient before allowing the update
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/escrows?id=eq.${escrowId}&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await checkRes.json();
    const escrow = rows && rows[0];

    if (!escrow) {
      return res.status(404).json({ error: 'Escrow not found' });
    }
    if (escrow.recipient_address.toLowerCase() !== recipientAddress.toLowerCase()) {
      return res.status(403).json({ error: 'Only the designated recipient can mark this fulfilled' });
    }
    if (escrow.status !== 'pending') {
      return res.status(400).json({ error: 'This escrow is no longer pending' });
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
          recipient_fulfilled: true,
          recipient_fulfilled_at: new Date().toISOString()
        })
      }
    );

    if (!patchRes.ok) {
      const errData = await patchRes.json();
      return res.status(500).json({ error: 'Failed to update escrow', details: errData });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
