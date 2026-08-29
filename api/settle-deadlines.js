import { ethers } from "ethers";

/**
 * Deadline keeper.
 *
 * Calls settle() on escrows whose deadline has passed. It has no authority over
 * the outcome: the contract reads its own state and decides who gets paid. This
 * key can only pay gas to trigger a settlement that was already going to happen
 * that way. If it leaks, the worst case is wasted gas, not redirected funds.
 *
 * Escrows are found by walking ids from nextId() rather than by scanning event
 * logs, because Alchemy's free tier caps eth_getLogs at a 10 block range which
 * makes log scanning unusable here.
 *
 * Anyone can call settle(), so this is a convenience, not a dependency. If the
 * keeper stops, users can still settle from the UI themselves.
 */

const ESCROW_ABI = [
  "function settle(uint256 id)",
  "function isSettleable(uint256 id) view returns (bool)",
  "function nextId() view returns (uint256)"
];

// Keep each run inside the serverless time limit. The cron runs every minute,
// so a backlog drains quickly rather than timing out in one go.
const MAX_PER_RUN = 5;
// How far back to look. Older escrows are long settled.
const MAX_SCAN = 300;

export default async function handler(req, res) {
  const auth = req.headers["authorization"];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const RPC = process.env.ARC_RPC;
  const ESCROW = process.env.ESCROW_CONTRACT;
  const KEY = process.env.KEEPER_PRIVATE_KEY;
  const CHAIN_ID = Number(process.env.ARC_CHAIN_ID || 5042002);

  if (!RPC || !ESCROW || !KEY) {
    return res.status(500).json({ error: "Missing ARC_RPC, ESCROW_CONTRACT or KEEPER_PRIVATE_KEY" });
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
      return res.status(200).json({ success: true, settled: 0, message: "No escrows yet" });
    }

    // isSettleable is the same condition settle() enforces, so we never send a
    // transaction that is going to revert.
    const lowest = Math.max(1, next - MAX_SCAN);
    const due = [];
    for (let id = next - 1; id >= lowest && due.length < MAX_PER_RUN; id--) {
      try {
        if (await readOnly.isSettleable(id)) due.push(id);
      } catch (e) { /* unreadable id, skip */ }
    }

    if (due.length === 0) {
      return res.status(200).json({ success: true, settled: 0, scanned: next - lowest, message: "Nothing due" });
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
        // Most likely someone settled it first between our check and our send.
        results.push({ id: String(id), status: "skipped", reason: (e.shortMessage || e.message || "").slice(0, 120) });
        nonce = await provider.getTransactionCount(wallet.address, "pending");
      }
    }

    return res.status(200).json({
      success: true,
      settled: results.filter(r => r.status === "settled").length,
      results
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
