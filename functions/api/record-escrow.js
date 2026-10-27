export async function onRequest(context) {
  const { request, env } = context;

  // CORS
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" }
    });
  }

  const body = await request.json();
  const { chainId, senderAddress, recipientAddress, amount, description, depositTxHash } = body || {};

  if (!chainId || !senderAddress || !recipientAddress) {
    return new Response(JSON.stringify({ error: "Missing required fields" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_KEY;

  try {
    const existing = await fetch(
      `${SUPABASE_URL}/rest/v1/escrows?chain_id=eq.${chainId}&select=id`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await existing.json();
    if (Array.isArray(rows) && rows.length > 0) {
      return new Response(JSON.stringify({ success: true, note: "already recorded" }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const r = await fetch(`${SUPABASE_URL}/rest/v1/escrows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        chain_id: Number(chainId),
        sender_address: String(senderAddress).toLowerCase(),
        recipient_address: String(recipientAddress).toLowerCase(),
        amount: amount ?? null,
        description: description || null,
        deposit_tx_hash: depositTxHash || null,
        deadline: new Date().toISOString(),
        status: "onchain"
      })
    });

    const data = await r.json();
    if (!r.ok) {
      return new Response(JSON.stringify({ error: "Failed to record", details: data }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
}
