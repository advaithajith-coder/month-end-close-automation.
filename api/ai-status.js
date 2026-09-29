// Vercel function: GET /api/ai-status – tells the page whether AI commentary is available.
const { aiStatus } = require('../lib/ai');

module.exports = (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET.' });
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(aiStatus());
};
