import crypto from 'crypto';

// Issues a short-lived signed token in exchange for the admin password.
// The password and signing key live only in Vercel env vars — never in the browser.
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function sign(payload, key) {
  return crypto.createHmac('sha256', key).update(payload).digest('base64url');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const adminPassword = process.env.ADMIN_PASSWORD;
  const signingKey = process.env.ADMIN_SECRET;

  if (!adminPassword || !signingKey) {
    return res.status(500).json({ error: 'Server is missing ADMIN_PASSWORD or ADMIN_SECRET' });
  }

  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ error: 'Password required' });
  }

  // Constant-time comparison so response timing does not leak the password
  const given = Buffer.from(password);
  const expected = Buffer.from(adminPassword);
  const match =
    given.length === expected.length && crypto.timingSafeEqual(given, expected);

  if (!match) {
    // Small delay to blunt rapid brute-force attempts
    await new Promise((r) => setTimeout(r, 750));
    return res.status(401).json({ error: 'Incorrect password' });
  }

  const expiry = String(Date.now() + TOKEN_TTL_MS);
  const token = `${Buffer.from(expiry).toString('base64url')}.${sign(expiry, signingKey)}`;

  return res.status(200).json({ success: true, token, expiresAt: Number(expiry) });
}
