export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const body = await request.json();
  const { escrowId, submittedBy, explanation, proofLink } = body || {};

  if (!escrowId || !submittedBy || !explanation) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_KEY;

  try {
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/escrows?chain_id=eq.${escrowId}&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await checkRes.json();
    const escrow = rows && rows[0];

    if (!escrow) {
      return new Response(JSON.stringify({ error: 'Escrow not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const addr = submittedBy.toLowerCase();
    let role = null;
    if (escrow.sender_address.toLowerCase() === addr) role = 'sender';
    else if (escrow.recipient_address.toLowerCase() === addr) role = 'recipient';

    if (!role) {
      return new Response(JSON.stringify({ error: 'You are not a party to this escrow' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
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
      return new Response(JSON.stringify({ error: 'Failed to submit evidence', details: data }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    return new Response(JSON.stringify({ success: true, evidence: data[0] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
