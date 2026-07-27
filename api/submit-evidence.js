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

  const { escrowId, submittedBy, explanation, proofLink } = req.body;

  if (!escrowId || !submittedBy || !explanation) {
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

    const addr = submittedBy.toLowerCase();
    let role = null;
    if (escrow.sender_address.toLowerCase() === addr) role = 'sender';
    else if (escrow.recipient_address.toLowerCase() === addr) role = 'recipient';

    if (!role) {
      return res.status(403).json({ error: 'You are not a party to this escrow' });
    }
    if (escrow.status !== 'disputed') {
      return res.status(400).json({ error: 'This escrow is not currently disputed' });
    }

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/escrow_evidence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        escrow_id: escrowId,
        submitted_by: addr,
        role: role,
        explanation: explanation,
        proof_link: proofLink || null
      })
    });

    const data = await insertRes.json();

    if (!insertRes.ok) {
      return res.status(500).json({ error: 'Failed to submit evidence', details: data });
    }

    return res.status(200).json({ success: true, evidence: data[0] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
