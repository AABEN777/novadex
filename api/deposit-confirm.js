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

  const { senderAddress, recipientAddress, amount, description, deadlineDays, depositTxHash } = req.body;

  if (!senderAddress || !recipientAddress || !amount || !depositTxHash) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const deadline = new Date();
  deadline.setDate(deadline.getDate() + (deadlineDays || 7));

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/escrows`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        sender_address: senderAddress.toLowerCase(),
        recipient_address: recipientAddress.toLowerCase(),
        amount: amount,
        description: description || null,
        deadline: deadline.toISOString(),
        deposit_tx_hash: depositTxHash,
        status: 'pending'
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({ error: 'Failed to record escrow', details: data });
    }

    return res.status(200).json({ success: true, escrow: data[0] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
