import { ethers } from "ethers";

const ARC_RPC = "https://rpc.testnet.arc.network";
const ARC_CHAIN_ID = 5042002;
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
const ESCROW_WALLET_ADDRESS = "0x2c0cf9ea8f19eb05a4051f5c27b0d18dd6cc2e3c";
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

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

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  try {
    // ── Verify the deposit actually happened on-chain before trusting it ──
    const network = ethers.Network.from(ARC_CHAIN_ID);
    const provider = new ethers.JsonRpcProvider(ARC_RPC, null, { staticNetwork: network, batchMaxCount: 1 });

    const receipt = await provider.getTransactionReceipt(depositTxHash);

    if (!receipt) {
      return res.status(400).json({ error: 'Deposit transaction not found or not yet confirmed on-chain' });
    }
    if (receipt.status !== 1) {
      return res.status(400).json({ error: 'Deposit transaction failed on-chain' });
    }

    // Find the ERC20 Transfer log that matches: USDC contract, to the escrow wallet
    const transferLog = receipt.logs.find((log) =>
      log.address.toLowerCase() === USDC_ADDRESS.toLowerCase() &&
      log.topics[0] === TRANSFER_TOPIC &&
      log.topics.length === 3 &&
      ('0x' + log.topics[2].slice(26)).toLowerCase() === ESCROW_WALLET_ADDRESS.toLowerCase()
    );

    if (!transferLog) {
      return res.status(400).json({ error: 'No matching USDC transfer to the escrow wallet found in this transaction' });
    }

    const fromAddress = '0x' + transferLog.topics[1].slice(26);
    if (fromAddress.toLowerCase() !== senderAddress.toLowerCase()) {
      return res.status(400).json({ error: 'Transaction sender does not match the claimed sender address' });
    }

    const transferredRaw = BigInt(transferLog.data);
    const transferredAmount = Number(ethers.formatUnits(transferredRaw, 6));
    const claimedAmount = Number(amount);

    // Allow tiny float rounding tolerance, but reject any real mismatch
    if (Math.abs(transferredAmount - claimedAmount) > 0.000001) {
      return res.status(400).json({
        error: `Claimed amount (${claimedAmount}) does not match the actual on-chain transfer (${transferredAmount})`
      });
    }

    // Prevent the same deposit transaction being used to create multiple escrow records
    const dupeCheck = await fetch(
      `${SUPABASE_URL}/rest/v1/escrows?deposit_tx_hash=eq.${depositTxHash}&select=id`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const dupeRows = await dupeCheck.json();
    if (Array.isArray(dupeRows) && dupeRows.length > 0) {
      return res.status(400).json({ error: 'This deposit transaction has already been recorded as an escrow' });
    }

    const deadline = new Date();
    deadline.setDate(deadline.getDate() + (deadlineDays || 7));

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
        amount: transferredAmount,
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
