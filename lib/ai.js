// Month-end commentary through Groq, shared by the local server (serve.js) and the Vercel functions (api/).
// The Groq API key is read from the server's environment and never sent to the browser.

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

const MAX_BODY = 64 * 1024;

function config() {
  return {
    key: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    baseUrl: (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
  };
}

function aiStatus() {
  const c = config();
  return { configured: !!c.key, provider: 'Groq', model: c.model };
}

// Refuses requests that did not come from this app's own pages. JSON is required because a browser must
// ask permission before another site can send JSON here, and a page served from elsewhere is turned away
// by its Origin. (A script outside a browser can still call the endpoint; Groq's own limits cap that.)
function checkRequest(headers, size) {
  if (!/^application\/json\b/i.test(headers['content-type'] || '')) return { status: 415, error: 'Send the facts as JSON.' };
  if (size > MAX_BODY) return { status: 413, error: 'Request too large.' };
  const origin = headers.origin;
  if (origin) {
    const host = headers['x-forwarded-host'] || headers.host;
    let from = '';
    try { from = new URL(origin).host; } catch (e) { /* malformed origin */ }
    if (from !== host) return { status: 403, error: 'Requests are only accepted from this site.' };
  }
  return null;
}

// Returns { status, json } to send back to the browser.
async function commentary(body) {
  const c = config();
  if (!c.key) return { status: 503, json: { error: 'GROQ_API_KEY is not set on the server.' } };
  if (!body || typeof body.facts !== 'object' || body.facts === null) return { status: 400, json: { error: 'Missing facts.' } };

  let groq;
  try {
    groq = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.key}` },
      body: JSON.stringify({
        model: c.model,
        temperature: 0.2,
        max_tokens: 4000, // reasoning models spend part of this thinking before they write
        ...(/gpt-oss/.test(c.model) ? { reasoning_effort: 'low' } : {}),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: 'FACTS:\n' + JSON.stringify(body.facts, null, 2) },
        ],
      }),
      signal: AbortSignal.timeout(55000),
    });
  } catch (err) {
    return { status: 502, json: { error: `Could not reach the AI service: ${err.message}` } };
  }
  const data = await groq.json().catch(() => null);
  if (!groq.ok) {
    const detail = data && data.error && data.error.message ? data.error.message : `HTTP ${groq.status}`;
    return { status: 502, json: { error: `The AI service returned an error: ${detail}` } };
  }
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) return { status: 502, json: { error: 'The AI service returned an empty response.' } };
  return { status: 200, json: { text: text.trim(), model: data.model || c.model, provider: 'Groq' } };
}

module.exports = { SYSTEM_PROMPT, MAX_BODY, aiStatus, checkRequest, commentary };
