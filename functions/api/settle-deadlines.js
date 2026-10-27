import { ethers } from "ethers";

const ESCROW_ABI = [
  "function settle(uint256 id)",
  "function isSettleable(uint256 id) view returns (bool)",
  "function nextId() view returns (uint256)"
];

const MAX_PER_RUN = 5;
const MAX_SCAN = 300;

export async function onRequest(context) {
  const { request, env } = context;

  // Auth check
  const auth = request.headers.get("authorization");
  if (env.CRON_SECRET && auth !== `Bearer ${env.CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const RPC = env.ARC_RPC;
  const ESCROW = env.ESCROW_CONTRACT;
  const KEY = env.KEEPER_PRIVATE_KEY;
  const CHAIN_ID = Number(env.ARC_CHAIN_ID || 5042002);

  if (!RPC || !ESCROW || !KEY) {
    return new Response(JSON.stringify({ error: "Missing ARC_RPC, ESCROW_CONTRACT or KEEPER_PRIVATE_KEY" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const network = ethers.Network.from(CHAIN_ID);
    const provider = new ethers.JsonRpcProvider(RPC, null, {
      staticNetwork: network,
      batchMaxCount: 1
    });
    const wallet = new ethers.Wallet(KEY, provider);
    const readOnly = new ethers.Contract(ESCROW, ESCROW_ABI, provider);
    const writable = new ethers.Contract(ESCROW, ESCROW_ABI, wallet);

    const next = Number(await readOnly.nextId());
    if (next <= 1) {
      return new Response(JSON.stringify({ success: true, settled: 0, message: "No escrows yet" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const lowest = Math.max(1, next - MAX_SCAN);
    const due = [];
    for (let id = next - 1; id >= lowest && due.length < MAX_PER_RUN; id--) {
      try {
        if (await readOnly.isSettleable(id)) due.push(id);
      } catch (e) { /* skip */ }
    }

    if (due.length === 0) {
      return new Response(JSON.stringify({ success: true, settled: 0, scanned: next - lowest, message: "Nothing due" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const feeData = await provider.getFeeData();
    let nonce = await provider.getTransactionCount(wallet.address, "pending");
    const results = [];

    for (const id of due) {
      try {
        const tx = await writable.settle(id, {
          gasLimit: 300000n,
          gasPrice: feeData.gasPrice,
          nonce: nonce++
        });
        const rec = await tx.wait();
        results.push({ id: String(id), status: "settled", txHash: rec.hash });
      } catch (e) {
        results.push({ id: String(id), status: "skipped", reason: (e.shortMessage || e.message || "").slice(0, 120) });
        nonce = await provider.getTransactionCount(wallet.address, "pending");
      }
    }

    return new Response(JSON.stringify({
      success: true,
      settled: results.filter(r => r.status === "settled").length,
      results
    }), {
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
