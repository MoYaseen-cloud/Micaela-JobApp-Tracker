import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── DATABASE ──────────────────────────────────────────────────────────────────
// Use /data if it exists (Railway persistent volume), otherwise fall back to local
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e) {}
const DB_PATH = path.join(DATA_DIR, 'micaela_apps.json');

console.log('✅ Server starting');
console.log('📁 Database path:', DB_PATH);
console.log('🔑 API key present:', !!ANTHROPIC_API_KEY);

// Resolve the public directory — handle both local dev and Railway deployment
const PUBLIC_DIR = path.join(__dirname, 'public');
console.log('🌐 Public dir:', PUBLIC_DIR, '| exists:', fs.existsSync(PUBLIC_DIR));

function readDb() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const raw = fs.readFileSync(DB_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed;
    }
  } catch (e) { console.error('DB read error:', e.message); }
  return { apps: [] };
}

function writeDb(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { console.error('DB write error:', e.message); }
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve static files — must come BEFORE API routes so assets load correctly
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  console.log('✅ Serving static files from:', PUBLIC_DIR);
} else {
  console.error('❌ WARNING: public/ directory not found at', PUBLIC_DIR);
}

// ── SYNC ENDPOINTS ────────────────────────────────────────────────────────────
app.get('/api/apps', (req, res) => {
  const db = readDb();
  res.json(db.apps || []);
});

app.post('/api/apps', (req, res) => {
  const { apps } = req.body;
  if (!Array.isArray(apps)) return res.status(400).json({ error: 'apps must be an array' });
  writeDb({ apps, updated: new Date().toISOString() });
  res.json({ ok: true, count: apps.length });
});

app.patch('/api/apps/:id', (req, res) => {
  const db = readDb();
  const id = parseInt(req.params.id);
  const idx = db.apps ? db.apps.findIndex(a => a.id === id) : -1;
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  db.apps[idx] = { ...db.apps[idx], ...req.body };
  writeDb(db);
  res.json(db.apps[idx]);
});

app.delete('/api/apps/:id', (req, res) => {
  const db = readDb();
  const id = parseInt(req.params.id);
  db.apps = (db.apps || []).filter(a => a.id !== id);
  writeDb(db);
  res.json({ ok: true });
});

// Health check — useful to verify Railway deployment is alive
app.get('/api/health', (req, res) => {
  const db = readDb();
  res.json({
    ok: true,
    apps: (db.apps || []).length,
    dbPath: DB_PATH,
    publicDir: PUBLIC_DIR,
    publicExists: fs.existsSync(PUBLIC_DIR),
    apiKeyPresent: !!ANTHROPIC_API_KEY,
    uptime: process.uptime()
  });
});

// ── CLAUDE PROXY ──────────────────────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Railway environment variables.' });
  }
  const { model, max_tokens, messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid request: messages array required' });
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens, messages }),
    });
    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText.slice(0, 300));
      return res.status(response.status).json({
        error: `Anthropic API error ${response.status}: ${errText.slice(0, 300)}`
      });
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Claude proxy error:', err.message);
    res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
});


// ── JOB DISCOVERY PIPELINE ───────────────────────────────────────────────────
const PICKS_PATH = path.join(DATA_DIR, 'daily_picks.json');

function readPicks() {
  try { if (fs.existsSync(PICKS_PATH)) return JSON.parse(fs.readFileSync(PICKS_PATH, 'utf8')); }
  catch(e) {}
  return { adzuna:[], remoteok:[], jsearch:[], fetchedAt:null, status:'never' };
}
function writePicks(data) {
  try { fs.writeFileSync(PICKS_PATH, JSON.stringify(data, null, 2), 'utf8'); }
  catch(e) { console.error('Picks write error:', e.message); }
}

const MICAELA_PROFILE = `
Micaela — Honours Forensic Genetics Cum Laude, BSc Biological Sciences, UKZN. GCP certified, Research Ethics certified, Code 8 licence.
Work history: Lab Demonstrator, Research Assistant (HIV/HPV/Moringa), Business Development Rep (promoted from Junior Sales), Sales Rep/Customer Service, Perfume Promoter.
Skills: DNA extraction, PCR, GLP, QA, CRM, B2B sales, lead generation, pipeline management, client relationships, scientific writing, documentation, MS Office, Google Workspace, data analysis, admin support, scheduling.
She can realistically do: ANY sales role, ANY admin/coordination/assistant role, ANY lab/research role, clinical research, healthcare admin, customer success, customer service, client onboarding, appointment setting, data entry, quality assurance, coordinator roles.
Entry-level to 2 years. Based in Durban SA. Open to remote globally and Johannesburg on-site.
`;

// ── DEDUPLICATION ─────────────────────────────────────────────────────────────
function normaliseKey(title, company) {
  const clean = s => (s||'').toLowerCase().replace(/[^a-z0-9]/g,' ').replace(/\s+/g,' ').trim();
  return clean(title).slice(0,30) + '|' + clean(company).slice(0,20);
}
function dedupe(jobs) {
  const seen = new Map();
  for (const job of jobs) {
    const key = normaliseKey(job.title, job.company);
    if (!seen.has(key) || (job.score||0) > (seen.get(key).score||0)) seen.set(key, job);
  }
  return [...seen.values()];
}

// ── FETCH: ARBEITNOW (replaces RemoteOK — proper API, no IP blocking) ──────────
// Free, no auth, returns remote-friendly international jobs
async function fetchRemoteOK() {
  const jobs = [];
  try {
    console.log('🌐 Fetching Arbeitnow...');
    // Arbeitnow: free job board API, remote-friendly international roles
    // Multiple pages to get enough volume
    for (let page = 1; page <= 4; page++) {
      const url = `https://www.arbeitnow.com/api/job-board-api?page=${page}`;
      const resp = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'MicaelaJobTracker/1.0' },
        signal: AbortSignal.timeout(10000),
      });
      console.log('Arbeitnow page', page, 'status:', resp.status);
      if (!resp.ok) break;
      const data = await resp.json();
      const listings = data.data || [];
      if (!listings.length) break;

      for (const job of listings) {
        if (!job.title || !job.company_name) continue;
        // Keep remote jobs and jobs mentioning relevant fields
        const text = (job.title + ' ' + (job.tags||[]).join(' ') + ' ' + (job.description||'')).toLowerCase();
        const relevant = ['sales','admin','coordinator','clinical','research','lab','health','science','assistant','customer','support','remote','data','quality','medical','pharma','biology'];
        if (!relevant.some(k => text.includes(k))) continue;

        jobs.push({
          id: 'arb_' + job.slug,
          title: job.title,
          company: job.company_name,
          location: job.remote ? 'Remote' : (job.location || 'International'),
          url: job.url || ('https://www.arbeitnow.com/jobs/' + job.slug),
          description: (job.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1500),
          tags: job.tags || [],
          salary: '',
          source: 'Arbeitnow',
          postedAt: job.created_at ? new Date(job.created_at * 1000).toISOString() : new Date().toISOString(),
        });
      }
      await new Promise(r => setTimeout(r, 300));
    }
    console.log('✅ Arbeitnow raw:', jobs.length, 'jobs');
  } catch(e) { console.error('❌ Arbeitnow:', e.message); }
  return jobs;
}

// ── FETCH: ADZUNA ─────────────────────────────────────────────────────────────
async function fetchAdzuna() {
  const jobs = [];
  if (!process.env.ADZUNA_APP_ID || !process.env.ADZUNA_APP_KEY) {
    console.log('⚠️  Adzuna credentials missing'); return jobs;
  }
  const APP_ID = process.env.ADZUNA_APP_ID;
  const APP_KEY = process.env.ADZUNA_APP_KEY;
  const seen = new Set();

  // Broad terms — science, sales, admin, customer service
  const JHB_TERMS = [
    'laboratory assistant','research assistant','clinical research coordinator',
    'clinical trial assistant','quality assurance','medical sales representative',
    'pharmaceutical sales','lab technician',
    'sales representative','business development','account manager',
    'sales administrator','medical device sales',
    'administrator','office administrator','operations coordinator',
    'project coordinator','client services','customer success',
    'healthcare administrator','medical administrator','clinical coordinator',
    'customer service representative','customer support',
  ];
  const REMOTE_TERMS = [
    'remote sales south africa','remote administrator south africa',
    'remote customer service','remote coordinator south africa',
    'remote research assistant','remote clinical research',
  ];

  for (const term of JHB_TERMS) {
    try {
      const url = `https://api.adzuna.com/v1/api/jobs/za/search/1?app_id=${APP_ID}&app_key=${APP_KEY}&results_per_page=5&what=${encodeURIComponent(term)}&where=Johannesburg&content-type=application/json`;
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const job of (data.results||[])) {
        const uid = 'adz_' + job.id;
        if (seen.has(uid)) continue;
        seen.add(uid);
        jobs.push({
          id: uid, title: job.title,
          company: job.company?.display_name||'Unknown',
          location: job.location?.display_name||'Johannesburg',
          url: job.redirect_url||'',
          description: (job.description||'').slice(0,1500),
          tags: [],
          salary: job.salary_min ? `R${Math.round(job.salary_min/1000)}k–R${Math.round((job.salary_max||job.salary_min)/1000)}k/yr` : '',
          source: 'Adzuna',
          postedAt: job.created||new Date().toISOString(),
        });
      }
      await new Promise(r => setTimeout(r, 150));
    } catch(e) { console.error('Adzuna JHB error:', term, e.message); }
  }
  for (const term of REMOTE_TERMS) {
    try {
      const url = `https://api.adzuna.com/v1/api/jobs/za/search/1?app_id=${APP_ID}&app_key=${APP_KEY}&results_per_page=5&what=${encodeURIComponent(term)}&content-type=application/json`;
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const job of (data.results||[])) {
        const uid = 'adz_' + job.id;
        if (seen.has(uid)) continue;
        seen.add(uid);
        jobs.push({
          id: uid, title: job.title,
          company: job.company?.display_name||'Unknown',
          location: 'Remote / '+(job.location?.display_name||'South Africa'),
          url: job.redirect_url||'',
          description: (job.description||'').slice(0,1500),
          tags: [],
          salary: job.salary_min ? `R${Math.round(job.salary_min/1000)}k–R${Math.round((job.salary_max||job.salary_min)/1000)}k/yr` : '',
          source: 'Adzuna',
          postedAt: job.created||new Date().toISOString(),
        });
      }
      await new Promise(r => setTimeout(r, 150));
    } catch(e) { console.error('Adzuna remote error:', term, e.message); }
  }
  console.log('✅ Adzuna raw:', jobs.length);
  return jobs;
}

// ── FETCH: JSEARCH ────────────────────────────────────────────────────────────
// KEY FIX: removed job_city filter (unreliable), use country in query string instead
// Reduced to 6 queries to protect free tier (10 req/month on basic plan)
async function fetchJSearch() {
  const jobs = [];
  if (!process.env.JSEARCH_API_KEY) {
    console.log('⚠️  JSearch key missing — set JSEARCH_API_KEY in Railway vars'); return jobs;
  }
  const seen = new Set();

  // Include country in query text — more reliable than the city param
  // 6 broad queries covering her key role categories
  const QUERIES = [
    'research assistant OR laboratory assistant South Africa',
    'sales representative OR business development South Africa',
    'administrator OR coordinator South Africa',
    'customer service OR customer success South Africa',
    'clinical research OR healthcare administrator South Africa',
    'remote sales OR remote coordinator South Africa',
  ];

  for (const q of QUERIES) {
    try {
      const params = new URLSearchParams({ query: q, page: '1', num_pages: '1', date_posted: 'month' });
      const resp = await fetch('https://jsearch.p.rapidapi.com/search?' + params, {
        headers: {
          'X-RapidAPI-Key': process.env.JSEARCH_API_KEY,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
        }
      });
      // Log every status so we can see exactly what's happening
      console.log('JSearch query:', q.slice(0,40), '— status:', resp.status);
      if (resp.status === 429) { await new Promise(r => setTimeout(r, 3000)); continue; }
      if (!resp.ok) continue;
      const data = await resp.json();
      console.log('JSearch results for', q.slice(0,30), ':', (data.data||[]).length);
      for (const job of (data.data||[])) {
        const uid = 'js_' + (job.job_id||Math.random());
        if (seen.has(uid)) continue;
        seen.add(uid);
        const loc = job.job_is_remote ? 'Remote' : [job.job_city, job.job_country].filter(Boolean).join(', ') || 'South Africa';
        jobs.push({
          id: uid,
          title: job.job_title||'Untitled',
          company: job.employer_name||'Unknown',
          location: loc,
          url: job.job_apply_link||job.job_google_link||'',
          description: (job.job_description||'').slice(0,1500),
          tags: (job.job_required_skills||[]).slice(0,5),
          salary: job.job_min_salary ? `$${Math.round(job.job_min_salary/1000)}k–$${Math.round((job.job_max_salary||job.job_min_salary)/1000)}k` : '',
          source: 'JSearch ('+(job.job_publisher||'Indeed')+')',
          postedAt: job.job_posted_at_datetime_utc||new Date().toISOString(),
        });
      }
      await new Promise(r => setTimeout(r, 600));
    } catch(e) { console.error('JSearch error:', q.slice(0,30), e.message); }
  }
  console.log('✅ JSearch raw:', jobs.length);
  return jobs;
}

// ── SCORE A JOB ───────────────────────────────────────────────────────────────
async function scoreJob(job) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const prompt = `Recruiter evaluating entry-level candidate fit. Return ONLY raw JSON.

MICAELA: ${MICAELA_PROFILE}

JOB: ${job.title} at ${job.company} (${job.location})
${(job.description||'').slice(0,800)}

Think about transferable skills. She can do sales, admin, lab, coordination, customer service.
Only skip if truly impossible (requires 5+ years senior experience OR specific licence she can't have).

{"fit":"High"or"Medium"or"Low","probability":0-100,"score":1-10,"verdict":"1 sentence","top_reason":"max 8 words","skip":false}`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:150, messages:[{role:'user',content:prompt}] }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = (data.content||[]).map(c=>c.text||'').join('');
    let parsed;
    try { parsed = JSON.parse(text.replace(/```json|```/g,'').trim()); }
    catch(e) { const m=text.match(/\{[\s\S]*?\}/); parsed=m?JSON.parse(m[0]):null; }
    return parsed;
  } catch(e) { return null; }
}

// ── SCORE IN PARALLEL BATCHES (5 at a time — 5x faster than sequential) ───────
async function scoreBatch(jobs, limit) {
  const BATCH = 5; // score 5 jobs simultaneously
  const scored = [];

  for (let i = 0; i < jobs.length; i += BATCH) {
    const chunk = jobs.slice(i, i + BATCH);
    const results = await Promise.all(chunk.map(async job => {
      const score = await scoreJob(job);
      if (!score || score.skip === true || (score.probability||0) < 20) return null;
      return { ...job, ...score };
    }));
    results.forEach(r => { if (r) scored.push(r); });
  }

  scored.sort((a,b) => (b.score||0) - (a.score||0));
  return scored.slice(0, limit);
}

// ── DIAGNOSTIC: raw counts before scoring ─────────────────────────────────────
let lastDiag = { remoteok:0, adzuna:0, jsearch:0 };

// ── MAIN PIPELINE ─────────────────────────────────────────────────────────────
let fetchInProgress = false;

async function runDiscoveryPipeline() {
  if (fetchInProgress) { console.log('Pipeline already running'); return; }
  fetchInProgress = true;
  console.log('\n🚀 Discovery pipeline starting...');
  try {
    writePicks({ adzuna:[], remoteok:[], jsearch:[], fetchedAt:new Date().toISOString(), status:'fetching' });

    const [remoteRaw, adzunaRaw, jsearchRaw] = await Promise.all([
      fetchRemoteOK(), fetchAdzuna(), fetchJSearch()
    ]);

    console.log('📋 RAW — Arbeitnow:', remoteRaw.length, '| Adzuna:', adzunaRaw.length, '| JSearch:', jsearchRaw.length);
    lastDiag = { remoteok: remoteRaw.length, adzuna: adzunaRaw.length, jsearch: jsearchRaw.length };

    const allForDedupe = [
      ...remoteRaw.map(j=>({...j,_src:'remoteok'})),
      ...adzunaRaw.map(j=>({...j,_src:'adzuna'})),
      ...jsearchRaw.map(j=>({...j,_src:'jsearch'})),
    ];
    const deduped = dedupe(allForDedupe);
    const remoteDeduped = deduped.filter(j=>j._src==='remoteok');
    const adzunaDeduped = deduped.filter(j=>j._src==='adzuna');
    const jsearchDeduped = deduped.filter(j=>j._src==='jsearch');
    console.log('📋 DEDUPED — Arbeitnow:', remoteDeduped.length, '| Adzuna:', adzunaDeduped.length, '| JSearch:', jsearchDeduped.length);

    // Score all 3 sources in parallel (not sequential) — much faster
    const [remoteTop, adzunaTop, jsearchTop] = await Promise.all([
      scoreBatch(remoteDeduped, 25),
      scoreBatch(adzunaDeduped, 25),
      scoreBatch(jsearchDeduped, 25),
    ]);

    console.log('✅ SCORED — Arbeitnow:', remoteTop.length, '| Adzuna:', adzunaTop.length, '| JSearch:', jsearchTop.length);

    writePicks({
      remoteok: remoteTop,
      adzuna: adzunaTop,
      jsearch: jsearchTop,
      fetchedAt: new Date().toISOString(),
      status: 'ready',
      _diag: lastDiag,
    });
  } catch(e) {
    console.error('Pipeline error:', e.message);
    writePicks({ adzuna:[], remoteok:[], jsearch:[], fetchedAt:new Date().toISOString(), status:'error', error:e.message });
  } finally { fetchInProgress = false; }
}

// Run 10 seconds after startup, then every 6 hours
setTimeout(() => runDiscoveryPipeline(), 10000);
setInterval(() => runDiscoveryPipeline(), 6 * 60 * 60 * 1000);

// ── PICKS ENDPOINTS ───────────────────────────────────────────────────────────
app.get('/api/picks', (req, res) => res.json(readPicks()));
app.post('/api/picks/refresh', (req, res) => {
  if (fetchInProgress) return res.json({ ok:false, message:'Already running' });
  runDiscoveryPipeline();
  res.json({ ok:true, message:'Pipeline started' });
});
// Diagnostic endpoint — hit this to see raw fetch counts without triggering a full run
app.get('/api/picks/diag', (req, res) => res.json({ ...readPicks(), lastDiag }));

// ── SPA FALLBACK ──────────────────────────────────────────────────────────────
// This MUST be last — catches everything that isn't an API route or static file
app.get('*', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('index.html not found. Make sure public/index.html exists in your repository.');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Micaela tracker running at http://localhost:${PORT}`);
  console.log(`📁 Data stored at: ${DB_PATH}`);
  console.log(`🌐 Serving frontend from: ${PUBLIC_DIR}\n`);
});
