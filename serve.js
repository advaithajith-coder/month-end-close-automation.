// Local server: serves the app and proxies month-end commentary requests to Groq.
//   node serve.js  →  http://localhost:5173
// The Groq API key is read from the environment (or a local .env file) and never sent to the browser.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
loadDotEnv(path.join(root, '.env'));

const port = Number(process.env.PORT) || 5173;
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_BASE_URL = (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const SYSTEM_PROMPT = `You are a senior CFO advising the owner of Quincy Bookstore, a small bookstore with a café.
From the FACTS JSON you are given, write the month-end commentary and your recommendations.

Think like a CFO reviewing the month before sign-off:
- Liquidity and cash: is there enough cash cover, what is tied up in stock and receivables, what is owed soon.
- Profitability by line: book margin versus café, and what the sales mix means.
- Sales rhythm: which days of the week are strongest and weakest, how weekends compare with weekdays, and the best and quietest single days. Use the average per day to compare weekdays fairly (some weekdays occur more often in the month), and say what the pattern means for staffing, opening hours, events and promotions.
- Cost structure: wages, rent and card fees as a share of sales, and any unusual movements.
- Break-even: how far sales are above break-even (margin of safety), which weekdays fall below the daily break-even, and what the café-cost caveat means.
- Cash movement: what brought cash in and what took it out, from the cash bridge.
- Sales mix: card versus cash and what card fees cost, and how much café spend each $100 of book sales brings (the café attach rate).
- Suppliers: how concentrated purchases are, and whether the shop bought more or less stock than it sold.
- Working capital: inventory days and how quickly publishers are paid.
- Debt: the loan and its interest cost.
- Close quality and data: control findings, shrinkage, and any costs that are not being recorded.

Rules:
- Use only the facts provided. Do not assume anything that is not in them.
- Copy every number exactly as it is written in the facts (same dollar sign, commas, decimals and % sign).
- Never calculate, round or invent a number, percentage, target or comparison that is not already in the facts.
- Do not cite industry benchmarks, outside statistics, or tax and legal advice.
- Do not mention entry numbers or control codes (such as JE-0004 or C5); describe them in words.
- If the data has a gap (for example a cost that is not recorded), say so plainly instead of guessing.
- Counts are not money: "3 items" is never "$3". Only put a $ sign on figures that have one in the facts.
- Timing items in the bank reconciliation (deposits in transit, uncleared payments) are normal unless the facts say otherwise; do not treat them as a problem.
- Recommend only actions that would change an outcome for the business. Do not recommend routine things that already happen (such as paying scheduled interest or continuing reconciliations) unless the facts show a problem with them.
- Plain, direct business English. No hype. Under 600 words in total.

Format exactly as plain text with these nine headings, each on its own line:
Headline
Performance
Sales by day of week
Sales mix
Break-even
Cash and balance sheet
Suppliers and stock
Close quality and items to watch
CFO recommendations

Under the first eight headings write 1-3 sentences or "- " bullets. Under "Cash and balance sheet", explain the biggest cash inflows and outflows from the cash movement facts. Under "Sales by day of week", name the strongest and weakest days with their average per day, compare weekends with weekdays, and give one sentence on what the pattern means for the business.
At least one CFO recommendation should act on the day-of-week pattern if it shows a clear gap.
Under "CFO recommendations" write 4 to 6 bullets, most important first. Each bullet must look like:
- [High] <the action to take> — <the fact from the data that justifies it>
Use [High], [Medium] or [Low] for priority. Each action must be specific and practical for a small shop owner.`;

http.createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/api/ai-status' && req.method === 'GET') {
      return sendJson(res, 200, { configured: !!GROQ_API_KEY, provider: 'Groq', model: GROQ_MODEL });
    }
    if (urlPath === '/api/commentary' && req.method === 'POST') return await commentary(req, res);
    if (urlPath.startsWith('/api/')) return sendJson(res, 404, { error: 'Unknown endpoint' });
    return serveStatic(urlPath, res);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'Server error' });
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Serving on http://localhost:${port}`);
  console.log(GROQ_API_KEY ? `Groq commentary enabled (model ${GROQ_MODEL})` : 'No GROQ_API_KEY set – commentary uses the built-in template');
});

async function commentary(req, res) {
  // JSON only: browsers must ask permission before another website can send JSON here, so a page
  // elsewhere cannot quietly spend this key through a plain form or text post.
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Send the facts as JSON.' });
  if (!GROQ_API_KEY) return sendJson(res, 503, { error: 'GROQ_API_KEY is not set on the server.' });
  let body;
  try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch (e) { return sendJson(res, 400, { error: 'Invalid request body.' }); }
  if (!body || typeof body.facts !== 'object' || body.facts === null) return sendJson(res, 400, { error: 'Missing facts.' });

  let groq;
  try {
    groq = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        max_tokens: 4000, // reasoning models spend part of this thinking before they write
        ...(/gpt-oss/.test(GROQ_MODEL) ? { reasoning_effort: 'low' } : {}),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: 'FACTS:\n' + JSON.stringify(body.facts, null, 2) },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    });
  } catch (err) {
    return sendJson(res, 502, { error: `Could not reach the AI service: ${err.message}` });
  }
  const data = await groq.json().catch(() => null);
  if (!groq.ok) {
    const detail = data && data.error && data.error.message ? data.error.message : `HTTP ${groq.status}`;
    return sendJson(res, 502, { error: `The AI service returned an error: ${detail}` });
  }
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) return sendJson(res, 502, { error: 'The AI service returned an empty response.' });
  sendJson(res, 200, { text: text.trim(), model: data.model || GROQ_MODEL, provider: 'Groq' });
}

// Only the app itself is served: the page, its scripts, styles and the bundled Excel library.
// Everything else in the folder (tests, tools, the Python engine, .env) stays private.
const PUBLIC = ['index.html', 'js', 'css', 'vendor'];
function serveStatic(urlPath, res) {
  const file = path.resolve(root, '.' + (urlPath === '/' ? '/index.html' : urlPath));
  const rel = path.relative(root, file);
  const top = rel.split(path.sep)[0];
  if (rel.startsWith('..') || path.isAbsolute(rel) || !PUBLIC.includes(top) || rel.split(path.sep).some(p => p.startsWith('.'))) {
    res.writeHead(404); return res.end('Not found');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Minimal .env reader (KEY=VALUE lines); real environment variables take precedence.
function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}
