// Local server: serves the app and proxies month-end commentary requests to Groq.
//   node serve.js  →  http://localhost:5173
// On Vercel the same two endpoints are the functions in api/; both use lib/ai.js.
// The Groq API key is read from the environment (or a local .env file) and never sent to the browser.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
loadDotEnv(path.join(root, '.env'));
const ai = require('./lib/ai');

const port = Number(process.env.PORT) || 5173;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

http.createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/api/ai-status' && req.method === 'GET') return sendJson(res, 200, ai.aiStatus());
    if (urlPath === '/api/commentary' && req.method === 'POST') return await commentary(req, res);
    if (urlPath.startsWith('/api/')) return sendJson(res, 404, { error: 'Unknown endpoint' });
    return serveStatic(urlPath, res);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'Server error' });
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Serving on http://localhost:${port}`);
  const st = ai.aiStatus();
  console.log(st.configured ? `Groq commentary enabled (model ${st.model})` : 'No GROQ_API_KEY set – commentary uses the built-in template');
});

async function commentary(req, res) {
  const refused = ai.checkRequest(req.headers, Number(req.headers['content-length']) || 0);
  if (refused) return sendJson(res, refused.status, { error: refused.error });
  let body;
  try { body = JSON.parse(await readBody(req, ai.MAX_BODY)); } catch (e) { return sendJson(res, 400, { error: 'Invalid request body.' }); }
  const out = await ai.commentary(body);
  sendJson(res, out.status, out.json);
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
