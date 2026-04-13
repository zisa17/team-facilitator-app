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

// ── Helpers ───────────────────────────────────────────────────

async function supabase(method, table, body, query) {
  const q = query ? '?' + new URLSearchParams(query).toString() : '';
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    }
  };
  if (['POST', 'PATCH', 'PUT'].includes(method) && body) opts.body = JSON.stringify(body);
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${q}`, opts);
  const text = await r.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function callAI(prompt, systemPrompt) {
  if (!ANTHROPIC_API_KEY) throw new Error('No Anthropic key');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      system: systemPrompt || 'You are an expert team facilitator. Be warm, direct and concise. Format for Slack using *bold* and bullet points.',
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.content[0].text;
}

async function postSlack(webhook, text) {
  if (!webhook) return;
  await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
}

// ── Agent logic ───────────────────────────────────────────────

async function getTeamContext(teamId) {
  const [teams, retros, actions, pulse] = await Promise.all([
    supabase('GET', 'teams', null, { id: `eq.${teamId}` }),
    supabase('GET', 'retros', null, { team_id: `eq.${teamId}`, order: 'created_at.desc', limit: 5 }),
    supabase('GET', 'actions', null, { team_id: `eq.${teamId}`, order: 'created_at.desc' }),
    supabase('GET', 'pulse', null, { team_id: `eq.${teamId}`, order: 'created_at.desc', limit: 20 })
  ]);
  const team = Array.isArray(teams) ? teams[0] : teams;
  return { team, retros: retros || [], actions: actions || [], pulse: pulse || [] };
}

// 1. Weekly Monday briefing
async function weeklyBriefing(teamId) {
  const { team, retros, actions, pulse } = await getTeamContext(teamId);
  if (!team?.slack_webhook) return;

  const open = actions.filter(a => !a.done);
  const overdue = open.filter(a => a.due && new Date(a.due) < new Date());
  const wk = new Date(Date.now() - 7 * 864e5).toISOString();
  const closedThisWeek = actions.filter(a => a.done && a.closed_at && a.closed_at > wk);
  const lastRetro = retros[0];
  const daysSinceRetro = lastRetro ? Math.floor((Date.now() - new Date(lastRetro.created_at)) / 864e5) : 999;
  const recentPulse = pulse.slice(0, 5);
  const avgPulse = recentPulse.length ? (recentPulse.reduce((s, p) => s + (p.energy + p.clarity + p.collab) / 3, 0) / recentPulse.length).toFixed(1) : null;

  const prompt = `Generate a Monday morning team briefing for ${team.name}.

Current state:
- Open actions: ${open.length} (${overdue.length} overdue)
- Overdue actions: ${overdue.map(a => `${a.text}${a.owner ? ' (' + a.owner + ')' : ''}`).join(', ') || 'none'}
- Closed this week: ${closedThisWeek.length}
- Days since last retro: ${daysSinceRetro === 999 ? 'never' : daysSinceRetro}
- Team pulse avg: ${avgPulse || 'no data'}/5
- Team focus: ${team.focus || 'not set'}

Write a warm, motivating 4-6 line Monday briefing. Include:
1. A brief energy-setting opener
2. Key focus for the week based on open/overdue actions
3. Call out overdue owners by name if any
4. One concrete suggestion for the week
5. Whether a retro is due soon

Format nicely for Slack. Start with an emoji.`;

  const message = await callAI(prompt);
  await postSlack(team.slack_webhook, `*Good morning, ${team.name}! 👋*\n\n${message}`);
  console.log(`[Agent] Weekly briefing sent to ${team.name}`);
}

// 2. Retro overdue reminder
async function retroReminder(teamId) {
  const { team, retros, actions } = await getTeamContext(teamId);
  if (!team?.slack_webhook) return;

  const lastRetro = retros[0];
  const daysSince = lastRetro ? Math.floor((Date.now() - new Date(lastRetro.created_at)) / 864e5) : 999;
  if (daysSince < 12) return; // Not overdue yet

  const overdue = actions.filter(a => !a.done && a.due && new Date(a.due) < new Date());
  const themes = retros.flatMap(r => r.improve || []).slice(0, 5);

  const prompt = `Write a retro reminder for ${team.name}.
Days since last retro: ${daysSince === 999 ? 'never had one' : daysSince + ' days'}.
Overdue actions: ${overdue.length}
Recent improvement themes: ${themes.join(', ') || 'none yet'}

Write a friendly 3-4 line reminder that:
1. Notes how long it's been
2. References 1-2 recent themes worth revisiting
3. Suggests scheduling a retro this week
Format for Slack.`;

  const message = await callAI(prompt);
  await postSlack(team.slack_webhook, `📅 *Retro reminder for ${team.name}*\n\n${message}`);
  console.log(`[Agent] Retro reminder sent to ${team.name}`);
}

// 3. Auto-summary after retro save (called directly from the save endpoint)
async function retroSummary(teamId, retro) {
  const { team } = await getTeamContext(teamId);
  if (!team?.slack_webhook) return;

  const prompt = `Write a concise retro summary for Slack for ${team.name}.

What went well: ${(retro.well || []).join(', ') || 'nothing noted'}
What to improve: ${(retro.improve || []).join(', ') || 'nothing noted'}
Actions committed: ${(retro.actions || []).join(', ') || 'none'}
Experiments: ${(retro.experiments || []).join(', ') || 'none'}

Write a 4-6 line summary that:
1. Celebrates what went well (pick the best 1-2)
2. Names the top improvement theme
3. Lists the committed actions clearly
4. Ends with an encouraging line

Format nicely for Slack.`;

  const message = await callAI(prompt);
  await postSlack(team.slack_webhook,
    `✅ *${team.name} just completed a retro!*\n\n${message}\n\n_Full details saved to Notion →_`
  );
  console.log(`[Agent] Retro summary sent to ${team.name}`);
}

// 4. Pulse drop alert
async function pulseAlert(teamId) {
  const { team, pulse } = await getTeamContext(teamId);
  if (!team?.slack_webhook) return;

  const recent = pulse.slice(0, 3);
  if (recent.length < 2) return;
  const avg = (recent.reduce((s, p) => s + (p.energy + p.clarity + p.collab) / 3, 0) / recent.length).toFixed(1);
  if (parseFloat(avg) >= 3.5) return; // Not low enough to alert

  const prompt = `Write a supportive check-in message for ${team.name}.
Recent team pulse average: ${avg}/5 (this is below healthy threshold).
Dimensions: Energy avg ${(recent.reduce((s,p)=>s+p.energy,0)/recent.length).toFixed(1)}, Clarity ${(recent.reduce((s,p)=>s+p.clarity,0)/recent.length).toFixed(1)}, Collaboration ${(recent.reduce((s,p)=>s+p.collab,0)/recent.length).toFixed(1)}.

Write a warm, non-alarmist 3-4 line message that:
1. Acknowledges the team may be going through a tough patch
2. Asks what would help
3. Suggests a short team check-in or retro
Do NOT be preachy. Be human and direct.`;

  const message = await callAI(prompt);
  await postSlack(team.slack_webhook, `💛 *Team check-in for ${team.name}*\n\n${message}`);
  console.log(`[Agent] Pulse alert sent to ${team.name}`);
}

// Run all agent checks for all teams
async function runAgentChecks() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  console.log('[Agent] Running checks at', new Date().toISOString());
  try {
    const teams = await supabase('GET', 'teams', null, {});
    if (!Array.isArray(teams)) return;
    for (const team of teams) {
      if (!team.slack_webhook) continue;
      try { await weeklyBriefing(team.id); } catch(e) { console.error('[Agent] briefing error', e.message); }
      try { await retroReminder(team.id); } catch(e) { console.error('[Agent] retro reminder error', e.message); }
      try { await pulseAlert(team.id); } catch(e) { console.error('[Agent] pulse alert error', e.message); }
    }
  } catch(e) { console.error('[Agent] runAgentChecks error', e.message); }
}

// Schedule agent: runs every hour, checks the time to decide what to do
function startAgentScheduler() {
  setInterval(async () => {
    const now = new Date();
    const day = now.getDay(); // 0=Sun, 1=Mon
    const hour = now.getHours();
    // Monday at 8am → weekly briefing + retro reminder + pulse alert
    if (day === 1 && hour === 8) await runAgentChecks();
    // Every day at 9am → just retro reminder and pulse alert (not briefing)
    if (day !== 1 && hour === 9) {
      if (!SUPABASE_URL || !SUPABASE_KEY) return;
      try {
        const teams = await supabase('GET', 'teams', null, {});
        if (!Array.isArray(teams)) return;
        for (const t of teams) {
          if (!t.slack_webhook) continue;
          try { await retroReminder(t.id); } catch(e) {}
          try { await pulseAlert(t.id); } catch(e) {}
        }
      } catch(e) {}
    }
  }, 60 * 60 * 1000); // check every hour
  console.log('[Agent] Scheduler started');
}

// ── HTTP Routes ───────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Team Facilitator v6',
    notion: !!NOTION_TOKEN,
    anthropic: !!ANTHROPIC_API_KEY,
    supabase: !!SUPABASE_URL,
    agent: 'active'
  });
});

// Anthropic
app.post('/anthropic/messages', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
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

// Notion save
app.post('/notion/pages', async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set' });
  try {
    const r = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json(d);
    res.json({ ok: true, id: d.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Supabase proxy
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
    if (['POST', 'PATCH', 'PUT'].includes(req.method) && req.body) opts.body = JSON.stringify(req.body);
    const r = await fetch(url, opts);
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    res.status(r.status).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Slack
app.post('/slack', async (req, res) => {
  const { webhook, text } = req.body;
  if (!webhook) return res.status(400).json({ error: 'No webhook' });
  try {
    await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Agent trigger endpoints (for testing or manual triggers)
app.post('/agent/briefing/:teamId', async (req, res) => {
  try { await weeklyBriefing(req.params.teamId); res.json({ ok: true, message: 'Briefing sent' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/agent/retro-reminder/:teamId', async (req, res) => {
  try { await retroReminder(req.params.teamId); res.json({ ok: true, message: 'Reminder sent' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/agent/retro-summary/:teamId', async (req, res) => {
  try { await retroSummary(req.params.teamId, req.body); res.json({ ok: true, message: 'Summary sent' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/agent/pulse-alert/:teamId', async (req, res) => {
  try { await pulseAlert(req.params.teamId); res.json({ ok: true, message: 'Pulse alert sent' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/agent/run-all', async (req, res) => {
  try { await runAgentChecks(); res.json({ ok: true, message: 'All agent checks run' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Team Facilitator v6 on port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL ? 'OK' : 'NOT SET'}`);
  console.log(`Notion:   ${NOTION_TOKEN ? 'OK' : 'NOT SET'}`);
  console.log(`AI:       ${ANTHROPIC_API_KEY ? 'OK' : 'NOT SET'}`);
  startAgentScheduler();
});
