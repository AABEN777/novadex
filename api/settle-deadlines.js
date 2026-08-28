import { ethers } from "ethers";

/**
 * Deadline keeper.
 *
 * Calls settle() on escrows whose deadline has passed. It has no authority over
 * the outcome: the contract reads its own state and decides who gets paid. This
 * key can only pay gas to trigger a settlement that was already going to happen
 * that way. If it leaks, the worst case is wasted gas, not redirected funds.
 *
 * Anyone can call settle(), so this is a convenience, not a dependency. If the
 * keeper stops, users can still settle from the UI themselves.
 */

const ESCROW_ABI = [
  "function settle(uint256 id)",
  "function isSettleable(uint256 id) view returns (bool)",
  "event EscrowCreated(uint256 indexed id,address indexed sender,address indexed recipient,address token,uint256 amount,uint64 deadline,bytes32 descriptionHash)"
];

// Keep each run well inside the serverless time limit. The cron runs every
// minute, so a backlog drains quickly rather than timing out in one go.
const MAX_PER_RUN = 5;

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

    const logs = await readOnly.queryFilter(readOnly.filters.EscrowCreated(), 0, "latest");

    // Ask the contract which ones are actually due. Cheap view call, and it is
    // the same condition settle() enforces, so we never send a doomed tx.
    const due = [];
    for (const log of logs) {
      if (due.length >= MAX_PER_RUN) break;
      const id = log.args.id;
      try {
        if (await readOnly.isSettleable(id)) due.push(id);
      } catch (e) { /* skip unreadable ids */ }
    }

    if (due.length === 0) {
      return res.status(200).json({ success: true, settled: 0, message: "Nothing due" });
    }

    const feeData = await provider.getFeeData();
    // Send sequentially so nonces stay in order on a single keeper wallet.
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
        results.push({ id: id.toString(), status: "settled", txHash: rec.hash });
      } catch (e) {
        // Most likely someone settled it first between our check and our send.
        results.push({ id: id.toString(), status: "skipped", reason: (e.shortMessage || e.message || "").slice(0, 120) });
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
