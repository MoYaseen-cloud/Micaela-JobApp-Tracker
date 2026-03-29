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
Honours Forensic Genetics Cum Laude + BSc Biological Sciences. GCP certified, Research Ethics certified, Code 8 licence.
Roles: Lab Demonstrator, Research Assistant (HIV/HPV/Moringa studies), Business Development Rep (promoted), Sales Rep, Perfume Promoter.
Skills: DNA extraction, PCR, GLP, QA, CRM, B2B sales, client management, scientific writing, MS Office, Google Workspace.
Rare science+sales combination. Strong communicator, self-directed, high performer.
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
    if (!seen.has(key) || (job.score||0) > (seen.get(key).score||0)) {
      seen.set(key, job);
    }
  }
  return [...seen.values()];
}

// ── FETCH: REMOTEOK (fully remote only) ───────────────────────────────────────
async function fetchRemoteOK() {
  const jobs = [];
  try {
    console.log('🌐 Fetching RemoteOK...');
    const resp = await fetch('https://remoteok.com/api', {
      headers: { 'User-Agent': 'MicaelaJobTracker/1.0' }
    });
    if (!resp.ok) throw new Error('Status ' + resp.status);
    const data = await resp.json();
    const keywords = ['clinical','lab','science','health','research','sales','admin','coordinator','medical','pharma','biology','gcp','quality','data','assistant'];
    for (const job of data.slice(1)) {
      if (!job.position || !job.company) continue;
      const text = (job.position + ' ' + (job.tags||[]).join(' ')).toLowerCase();
      if (keywords.some(k => text.includes(k))) {
        jobs.push({
          id: 'rok_' + job.id,
          title: job.position,
          company: job.company,
          location: 'Remote',
          url: job.url || ('https://remoteok.com/remote-jobs/' + job.id),
          description: (job.description||'').slice(0,2000),
          tags: job.tags||[],
          salary: job.salary||'',
          source: 'RemoteOK',
          postedAt: job.date||new Date().toISOString(),
        });
      }
    }
    console.log('✅ RemoteOK raw:', jobs.length);
  } catch(e) { console.error('❌ RemoteOK:', e.message); }
  return jobs;
}

// ── FETCH: ADZUNA (Johannesburg + remote SA only) ─────────────────────────────
async function fetchAdzuna() {
  const jobs = [];
  if (!process.env.ADZUNA_APP_ID || !process.env.ADZUNA_APP_KEY) {
    console.log('⚠️  Adzuna credentials missing'); return jobs;
  }
  const APP_ID = process.env.ADZUNA_APP_ID;
  const APP_KEY = process.env.ADZUNA_APP_KEY;
  const seen = new Set();

  const JHB_TERMS = [
    'clinical research coordinator','laboratory assistant','medical sales',
    'clinical trial assistant','healthcare administrator','research assistant',
    'quality assurance science','pharmaceutical sales','data coordinator',
    'science administrator','lab technician','clinical coordinator',
  ];
  const REMOTE_TERMS = [
    'remote clinical research','remote healthcare admin','remote medical sales',
    'remote research coordinator','remote laboratory',
  ];

  // Johannesburg searches
  for (const term of JHB_TERMS) {
    try {
      const q = encodeURIComponent(term);
      const url = `https://api.adzuna.com/v1/api/jobs/za/search/1?app_id=${APP_ID}&app_key=${APP_KEY}&results_per_page=5&what=${q}&where=Johannesburg&content-type=application/json`;
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
          description: (job.description||'').slice(0,2000),
          tags: [], salary: job.salary_min ? `R${Math.round(job.salary_min/1000)}k–R${Math.round((job.salary_max||job.salary_min)/1000)}k/yr` : '',
          source: 'Adzuna', postedAt: job.created||new Date().toISOString(),
        });
      }
      await new Promise(r => setTimeout(r, 250));
    } catch(e) { console.error('Adzuna JHB error:', term, e.message); }
  }

  // Remote SA searches
  for (const term of REMOTE_TERMS) {
    try {
      const q = encodeURIComponent(term);
      const url = `https://api.adzuna.com/v1/api/jobs/za/search/1?app_id=${APP_ID}&app_key=${APP_KEY}&results_per_page=5&what=${q}&content-type=application/json`;
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
          location: 'Remote / ' + (job.location?.display_name||'South Africa'),
          url: job.redirect_url||'',
          description: (job.description||'').slice(0,2000),
          tags: [], salary: job.salary_min ? `R${Math.round(job.salary_min/1000)}k–R${Math.round((job.salary_max||job.salary_min)/1000)}k/yr` : '',
          source: 'Adzuna', postedAt: job.created||new Date().toISOString(),
        });
      }
      await new Promise(r => setTimeout(r, 250));
    } catch(e) { console.error('Adzuna remote error:', term, e.message); }
  }

  console.log('✅ Adzuna raw:', jobs.length);
  return jobs;
}

// ── FETCH: JSEARCH (Indeed/LinkedIn/Glassdoor via RapidAPI) ───────────────────
async function fetchJSearch() {
  const jobs = [];
  if (!process.env.JSEARCH_API_KEY) {
    console.log('⚠️  JSearch key missing'); return jobs;
  }
  const seen = new Set();
  const QUERIES = [
    { q: 'clinical research Johannesburg', remote: false },
    { q: 'laboratory assistant Johannesburg', remote: false },
    { q: 'medical sales Johannesburg', remote: false },
    { q: 'healthcare administrator Johannesburg', remote: false },
    { q: 'research assistant Johannesburg', remote: false },
    { q: 'clinical trial coordinator remote', remote: true },
    { q: 'medical sales remote South Africa', remote: true },
    { q: 'research coordinator remote', remote: true },
  ];

  for (const query of QUERIES) {
    try {
      const params = new URLSearchParams({
        query: query.q,
        page: '1',
        num_pages: '1',
        date_posted: 'month',
        ...(query.remote ? { remote_jobs_only: 'true' } : { job_city: 'Johannesburg' }),
      });
      const resp = await fetch('https://jsearch.p.rapidapi.com/search?' + params, {
        headers: {
          'X-RapidAPI-Key': process.env.JSEARCH_API_KEY,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
        }
      });
      if (!resp.ok) { console.log('JSearch skip:', query.q, resp.status); continue; }
      const data = await resp.json();
      for (const job of (data.data||[])) {
        const uid = 'js_' + (job.job_id||Math.random());
        if (seen.has(uid)) continue;
        seen.add(uid);
        const loc = query.remote ? 'Remote' : (job.job_city ? job.job_city + ', ' + (job.job_country||'') : 'Johannesburg');
        jobs.push({
          id: uid, title: job.job_title||'Untitled',
          company: job.employer_name||'Unknown',
          location: loc,
          url: job.job_apply_link||job.job_google_link||'',
          description: (job.job_description||'').slice(0,2000),
          tags: (job.job_required_skills||[]).slice(0,5),
          salary: job.job_min_salary ? `$${Math.round(job.job_min_salary/1000)}k–$${Math.round((job.job_max_salary||job.job_min_salary)/1000)}k` : '',
          source: 'JSearch (' + (job.job_publisher||'Indeed') + ')',
          postedAt: job.job_posted_at_datetime_utc||new Date().toISOString(),
        });
      }
      await new Promise(r => setTimeout(r, 400));
    } catch(e) { console.error('JSearch error:', query.q, e.message); }
  }
  console.log('✅ JSearch raw:', jobs.length);
  return jobs;
}

// ── SCORE A JOB ───────────────────────────────────────────────────────────────
async function scoreJob(job) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const prompt = 'You are a recruiter. Quickly evaluate if Micaela fits this job.\n\nMICAELA:\n' + MICAELA_PROFILE + '\n\nJOB:\nTitle: ' + job.title + '\nCompany: ' + job.company + '\nLocation: ' + job.location + '\nDescription: ' + (job.description||'').slice(0,1000) + '\n\nReturn ONLY raw JSON (no markdown):\n{"fit":"High"or"Medium"or"Low","probability":0-100,"score":1-10,"verdict":"2 sentences max","top_reason":"strongest fit reason max 10 words","skip":true or false}';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:200, messages:[{role:'user',content:prompt}] }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = data.content.map(c=>c.text||'').join('');
    let parsed;
    try { parsed = JSON.parse(text.replace(/```json|```/g,'').trim()); }
    catch(e) { const m=text.match(/\{[\s\S]*\}/); parsed=m?JSON.parse(m[0]):null; }
    return parsed;
  } catch(e) { return null; }
}

// ── SCORE A BATCH ─────────────────────────────────────────────────────────────
async function scoreBatch(jobs, limit) {
  const scored = [];
  for (const job of jobs) {
    const score = await scoreJob(job);
    if (!score || score.skip || (score.probability||0) < 25) continue;
    scored.push({ ...job, ...score });
    await new Promise(r => setTimeout(r, 120));
  }
  scored.sort((a, b) => (b.score||0) - (a.score||0));
  return scored.slice(0, limit);
}

// ── MAIN PIPELINE ─────────────────────────────────────────────────────────────
let fetchInProgress = false;

async function runDiscoveryPipeline() {
  if (fetchInProgress) { console.log('Pipeline already running'); return; }
  fetchInProgress = true;
  console.log('\n🚀 Job discovery pipeline starting...');
  try {
    writePicks({ adzuna:[], remoteok:[], jsearch:[], fetchedAt:new Date().toISOString(), status:'fetching' });

    // Fetch all sources in parallel
    const [remoteRaw, adzunaRaw, jsearchRaw] = await Promise.all([
      fetchRemoteOK(), fetchAdzuna(), fetchJSearch()
    ]);

    console.log('📋 Raw counts — RemoteOK:', remoteRaw.length, '| Adzuna:', adzunaRaw.length, '| JSearch:', jsearchRaw.length);

    // Deduplicate within each source, then cross-source
    const allForDedupe = [
      ...remoteRaw.map(j => ({...j, _src:'remoteok'})),
      ...adzunaRaw.map(j => ({...j, _src:'adzuna'})),
      ...jsearchRaw.map(j => ({...j, _src:'jsearch'})),
    ];
    const deduped = dedupe(allForDedupe);
    const remoteDeduped = deduped.filter(j => j._src === 'remoteok');
    const adzunaDeduped = deduped.filter(j => j._src === 'adzuna');
    const jsearchDeduped = deduped.filter(j => j._src === 'jsearch');
    console.log('After dedupe — RemoteOK:', remoteDeduped.length, '| Adzuna:', adzunaDeduped.length, '| JSearch:', jsearchDeduped.length);

    // Score each batch, get top 25 per source
    const [remoteTop, adzunaTop, jsearchTop] = await Promise.all([
      scoreBatch(remoteDeduped, 25),
      scoreBatch(adzunaDeduped, 25),
      scoreBatch(jsearchDeduped, 25),
    ]);

    console.log('✅ Pipeline done. RemoteOK:', remoteTop.length, '| Adzuna:', adzunaTop.length, '| JSearch:', jsearchTop.length);

    writePicks({
      remoteok: remoteTop,
      adzuna: adzunaTop,
      jsearch: jsearchTop,
      fetchedAt: new Date().toISOString(),
      status: 'ready',
    });
  } catch(e) {
    console.error('Pipeline error:', e.message);
    writePicks({ adzuna:[], remoteok:[], jsearch:[], fetchedAt:new Date().toISOString(), status:'error', error:e.message });
  } finally { fetchInProgress = false; }
}

// Run 8 seconds after startup, then every 6 hours
setTimeout(() => runDiscoveryPipeline(), 8000);
setInterval(() => runDiscoveryPipeline(), 6 * 60 * 60 * 1000);

// ── PICKS ENDPOINTS ───────────────────────────────────────────────────────────
app.get('/api/picks', (req, res) => res.json(readPicks()));
app.post('/api/picks/refresh', (req, res) => {
  if (fetchInProgress) return res.json({ ok:false, message:'Already running' });
  runDiscoveryPipeline();
  res.json({ ok:true, message:'Pipeline started' });
});
