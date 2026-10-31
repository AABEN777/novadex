const ESCROW_WALLET_ID = "d4e56011-550e-5b0f-90e6-73f2422df581";
const USDC_TOKEN_ID = "ef87c8c3-85de-598a-af50-c5135eecfa74";

async function releaseFunds(env, recipientAddress, amount) {
  const createRes = await fetch("https://api.circle.com/v1/w3s/developer/transactions/transfer", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.CIRCLE_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      walletId: ESCROW_WALLET_ID,
      tokenId: USDC_TOKEN_ID,
      destinationAddress: recipientAddress,
      amounts: [amount.toString()],
      feeLevel: "MEDIUM",
      entitySecretCiphertext: "PLACEHOLDER"
    })
  });

  const createData = await createRes.json();
  
  // Temporary debug — return the raw Circle response
  return { error: true, circleResponse: createData, status: createRes.status };
}

async function claimEscrow(url, key, id, fromStatus) {
  const res = await fetch(`${url}/rest/v1/escrows?id=eq.${id}&status=eq.${fromStatus}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Prefer": "return=representation"
    },
    body: JSON.stringify({ status: "processing" })
  });
  const rows = await res.json();
  return Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
}

async function releaseClaim(url, key, id, backTo) {
  try {
    await fetch(`${url}/rest/v1/escrows?id=eq.${id}&status=eq.processing`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "apikey": key, "Authorization": `Bearer ${key}` },
      body: JSON.stringify({ status: backTo })
    });
  } catch (e) {}
}

export async function onRequest(context) {
  const { request, env } = context;

  const authHeader = request.headers.get("authorization");
  if (env.CRON_SECRET && authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_KEY;

  try {
    const nowIso = new Date().toISOString();

    const res1 = await fetch(
      `${SUPABASE_URL}/rest/v1/escrows?status=eq.pending&deadline=lt.${nowIso}&select=*`,
      { headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` } }
    );
    const expiredEscrows = await res1.json();

    if (!Array.isArray(expiredEscrows) || expiredEscrows.length === 0) {
      return new Response(JSON.stringify({ success: true, processed: 0, message: "No expired escrows found" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const results = [];

    for (const escrow of expiredEscrows) {
      try {
        if (escrow.sender_disputed) {
          results.push({ id: escrow.id, action: "skipped-disputed" });
          continue;
        }

        const claimed = await claimEscrow(SUPABASE_URL, SUPABASE_KEY, escrow.id, "pending");
        if (!claimed) {
          results.push({ id: escrow.id, action: "skipped-locked" });
          continue;
        }

        // Debug version — capture Circle response
        const txResult = await releaseFunds(env, escrow.sender_address, escrow.amount);
        results.push({ id: escrow.id, action: "debug", result: txResult });

        // Always release the claim for now so we don't lock the row
        await releaseClaim(SUPABASE_URL, SUPABASE_KEY, escrow.id, "pending");

      } catch (escrowErr) {
        await releaseClaim(SUPABASE_URL, SUPABASE_KEY, escrow.id, "pending");
        results.push({ id: escrow.id, action: "error", error: escrowErr.message });
      }
    }

    return new Response(JSON.stringify({ success: true, processed: results.length, results }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
