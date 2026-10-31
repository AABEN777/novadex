import { ethers } from "ethers";

const ESCROW_CONTRACT = "0x76D4694De06Bb3A3CDf39207FE27eD8A39EC1202";
const ESCROW_ABI = [
  "function settle(uint256 id)"
];

async function settleOnChain(env, escrowId) {
  const provider = new ethers.JsonRpcProvider(env.ARC_RPC_URL);
  const wallet = new ethers.Wallet(env.KEEPER_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(ESCROW_CONTRACT, ESCROW_ABI, wallet);

  const tx = await contract.settle(escrowId);
  const receipt = await tx.wait();
  return receipt.hash;
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

        try {
          const txHash = await settleOnChain(env, escrow.id);
          const newStatus = escrow.recipient_fulfilled ? "released" : "refunded";

          await fetch(`${SUPABASE_URL}/rest/v1/escrows?id=eq.${escrow.id}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "apikey": SUPABASE_KEY,
              "Authorization": `Bearer ${SUPABASE_KEY}`
            },
            body: JSON.stringify({ status: newStatus, release_tx_hash: txHash })
          });

          results.push({ id: escrow.id, action: newStatus, txHash });
        } catch (txErr) {
          await releaseClaim(SUPABASE_URL, SUPABASE_KEY, escrow.id, "pending");
          results.push({ id: escrow.id, action: "settle-failed", error: txErr.message });
        }
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
