const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS — allow everything
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Team Facilitator v6',
    notion: !!NOTION_TOKEN,
    anthropic: !!ANTHROPIC_API_KEY,
    supabase: !!SUPABASE_URL
  });
});

// Anthropic
app.post('/anthropic/messages', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Notion test
app.get('/notion/test/:id', async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set' });
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${req.params.id}`, {
      headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' }
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json(d);
    res.json({ ok: true, title: d.title?.[0]?.plain_text || 'Retrospectives' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Notion save page
app.post('/notion/pages', async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set' });
  try {
    const r = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json(d);
    res.json({ ok: true, id: d.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Supabase proxy — all headers added server-side, none needed from browser
app.all('/supabase/*', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const subpath = req.path.replace('/supabase', '');
  const query = Object.keys(req.query).length ? '?' + new URLSearchParams(req.query).toString() : '';
  const url = `${SUPABASE_URL}/rest/v1${subpath}${query}`;
  try {
    const opts = {
      method: req.method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      }
    };
    if (['POST', 'PATCH', 'PUT'].includes(req.method) && req.body) {
      opts.body = JSON.stringify(req.body);
    }
    const r = await fetch(url, opts);
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    res.status(r.status).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Slack
app.post('/slack', async (req, res) => {
  const { webhook, text } = req.body;
  if (!webhook) return res.status(400).json({ error: 'No webhook' });
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`Team Facilitator v6 on port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL ? 'OK' : 'NOT SET'}`);
  console.log(`Notion:   ${NOTION_TOKEN ? 'OK' : 'NOT SET'}`);
  console.log(`AI:       ${ANTHROPIC_API_KEY ? 'OK' : 'NOT SET'}`);
});
