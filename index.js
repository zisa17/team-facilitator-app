const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(express.json({ limit: '2mb' }));

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve the facilitator app
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Team Facilitator',
    notion: !!NOTION_TOKEN,
    anthropic: !!ANTHROPIC_API_KEY
  });
});

// ─── Anthropic ────────────────────────────────────────────────

app.post('/anthropic/messages', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on server' });
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Notion ───────────────────────────────────────────────────

app.get('/notion/test/:databaseId', async (req, res) => {
  if (!NOTION_TOKEN) {
    return res.status(500).json({ error: 'NOTION_TOKEN not set on server' });
  }
  try {
    const response = await fetch(`https://api.notion.com/v1/databases/${req.params.databaseId}`, {
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28'
      }
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json({ ok: true, title: data.title?.[0]?.plain_text || 'Retrospectives' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/notion/pages', async (req, res) => {
  if (!NOTION_TOKEN) {
    return res.status(500).json({ error: 'NOTION_TOKEN not set on server' });
  }
  try {
    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json({ ok: true, id: data.id, url: data.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Team Facilitator running on port ${PORT}`);
  console.log(`Notion: ${NOTION_TOKEN ? 'configured' : 'NOT SET'}`);
  console.log(`Anthropic: ${ANTHROPIC_API_KEY ? 'configured' : 'NOT SET'}`);
});
