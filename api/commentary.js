// Vercel function: POST /api/commentary – writes the month-end commentary through Groq.
// Set GROQ_API_KEY (and optionally GROQ_MODEL) in the Vercel project's Environment Variables.
const { checkRequest, commentary } = require('../lib/ai');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  const size = Number(req.headers['content-length']) || 0;
  const refused = checkRequest(req.headers, size);
  if (refused) return res.status(refused.status).json({ error: refused.error });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch (e) { body = null; }
  if (!body) return res.status(400).json({ error: 'Invalid request body.' });
  const out = await commentary(body);
  res.status(out.status).json(out.json);
};
