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
Micaela Harripersadh — Honours Forensic Genetics Cum Laude, BSc Biological Sciences, UKZN.
GCP certified (ICH-GCP E6 R2), Research Ethics certified, Code 8 driver's licence.
Work history: Lab Demonstrator, Research Assistant (HIV/HPV/Moringa studies), Business Development Rep (promoted from Junior Sales Rep), Junior Sales Rep / Customer Service, Luxury Perfume Promoter.
Hard skills: DNA extraction, PCR, GLP, QA, CRM systems, B2B sales, lead generation, pipeline management, client relationship management, scientific writing, documentation, MS Office, Google Workspace, data analysis, scheduling, admin support.
Soft skills: Exceptional communicator (verbal and written), highly self-directed, thrives under deadlines, attention to detail, comfortable with targets and rejection, persuasive, empathetic.
RARE COMBINATION: science graduate who can sell and communicate — valuable in clinical sales, pharma, medtech, healthcare, and any role mixing technical knowledge with client-facing work.
She is entry-level to 2 years experience. She CAN do: any sales role, any admin/coordination role, any lab/research role, clinical research, healthcare admin, customer success, client onboarding, appointment setting, data entry/management, quality assurance, any assistant or coordinator role.
She is based in Durban, South Africa but will consider remote roles globally and Johannesburg roles.
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

// ── FETCH: REMOTEOK ───────────────────────────────────────────────────────────
// RemoteOK returns all jobs — we let the AI scorer decide fit rather than pre-filtering
async function fetchRemoteOK() {
  const jobs = [];
  try {
    console.log('🌐 Fetching RemoteOK...');
    const resp = await fetch('https://remoteok.com/api', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; JobTracker/1.0)',
        'Accept': 'application/json',
      }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const raw = await resp.text();
    // RemoteOK sometimes returns HTML on rate limit — detect that
    if (raw.trim().startsWith('<')) throw new Error('Got HTML instead of JSON — rate limited');
    const data = JSON.parse(raw);
    // Broad inclusion: skip first item (it's a legal notice object), include everything that has a title
    // No keyword filtering — let the AI scorer decide fit
    for (const job of data.slice(1)) {
      if (!job.position || !job.company) continue;
      jobs.push({
        id: 'rok_' + (job.id || Math.random()),
        title: job.position,
        company: typeof job.company === 'string' ? job.company : (job.company?.name || 'Unknown'),
        location: 'Remote',
        url: job.url || ('https://remoteok.com/remote-jobs/' + job.id),
        description: (job.description||'').replace(/<[^>]+>/g,' ').slice(0,2000),
        tags: Array.isArray(job.tags) ? job.tags : [],
        salary: job.salary || '',
        source: 'RemoteOK',
        postedAt: job.date || new Date().toISOString(),
      });
    }
    console.log('✅ RemoteOK raw:', jobs.length);
  } catch(e) { console.error('❌ RemoteOK error:', e.message); }
  return jobs;
}

// ── FETCH: ADZUNA (South Africa — broad searches) ─────────────────────────────
async function fetchAdzuna() {
  const jobs = [];
  if (!process.env.ADZUNA_APP_ID || !process.env.ADZUNA_APP_KEY) {
    console.log('⚠️  Adzuna credentials missing'); return jobs;
  }
  const APP_ID = process.env.ADZUNA_APP_ID;
  const APP_KEY = process.env.ADZUNA_APP_KEY;
  const seen = new Set();

  // Broad search terms covering all roles she can do — not just science
  const JHB_TERMS = [
    // Science / Lab / Clinical
    'laboratory assistant', 'research assistant', 'clinical research coordinator',
    'clinical trial assistant', 'quality assurance', 'medical sales representative',
    'pharmaceutical sales', 'lab technician', 'science administrator',
    // Sales / BD / CRM
    'sales representative', 'business development', 'account manager',
    'sales administrator', 'inside sales', 'medical device sales',
    'territory sales representative',
    // Admin / Coordinator / Operations
    'administrator', 'office administrator', 'operations coordinator',
    'project coordinator', 'client services', 'customer success',
    // Healthcare admin
    'healthcare administrator', 'medical administrator', 'healthcare coordinator',
    'patient coordinator', 'clinical coordinator',
    // Customer service / support
    'customer service', 'customer support representative', 'client relationship',
  ];

  const REMOTE_TERMS = [
    'remote sales south africa', 'remote administrator south africa',
    'remote customer service south africa', 'remote coordinator south africa',
    'remote research assistant', 'remote clinical research',
    'remote healthcare admin', 'remote account manager south africa',
  ];

  for (const term of JHB_TERMS) {
    try {
      const q = encodeURIComponent(term);
      const url = `https://api.adzuna.com/v1/api/jobs/za/search/1?app_id=${APP_ID}&app_key=${APP_KEY}&results_per_page=5&what=${q}&where=Johannesburg&content-type=application/json`;
      const resp = await fetch(url);
      if (!resp.ok) { console.log('Adzuna JHB skip:', term, resp.status); continue; }
      const data = await resp.json();
      for (const job of (data.results||[])) {
        const uid = 'adz_' + job.id;
        if (seen.has(uid)) continue;
        seen.add(uid);
        jobs.push({
          id: uid, title: job.title,
          company: job.company?.display_name || 'Unknown',
          location: job.location?.display_name || 'Johannesburg',
          url: job.redirect_url || '',
          description: (job.description||'').slice(0,2000),
          tags: [],
          salary: job.salary_min ? `R${Math.round(job.salary_min/1000)}k–R${Math.round((job.salary_max||job.salary_min)/1000)}k/yr` : '',
          source: 'Adzuna',
          postedAt: job.created || new Date().toISOString(),
        });
      }
      await new Promise(r => setTimeout(r, 200));
    } catch(e) { console.error('Adzuna JHB error:', term, e.message); }
  }

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
          company: job.company?.display_name || 'Unknown',
          location: 'Remote / ' + (job.location?.display_name || 'South Africa'),
          url: job.redirect_url || '',
          description: (job.description||'').slice(0,2000),
          tags: [],
          salary: job.salary_min ? `R${Math.round(job.salary_min/1000)}k–R${Math.round((job.salary_max||job.salary_min)/1000)}k/yr` : '',
          source: 'Adzuna',
          postedAt: job.created || new Date().toISOString(),
        });
      }
      await new Promise(r => setTimeout(r, 200));
    } catch(e) { console.error('Adzuna remote error:', term, e.message); }
  }

  console.log('✅ Adzuna raw:', jobs.length);
  return jobs;
}

// ── FETCH: JSEARCH (Indeed/LinkedIn/Glassdoor via RapidAPI) ───────────────────
async function fetchJSearch() {
  const jobs = [];
  if (!process.env.JSEARCH_API_KEY) {
    console.log('⚠️  JSearch key missing — set JSEARCH_API_KEY in Railway environment variables');
    return jobs;
  }
  const seen = new Set();

  // Broad queries — science, sales, admin, customer service, coordinator
  const QUERIES = [
    // JHB — science/lab
    { q: 'research assistant Johannesburg South Africa', remote: false },
    { q: 'laboratory technician Johannesburg South Africa', remote: false },
    { q: 'clinical research coordinator Johannesburg', remote: false },
    { q: 'quality assurance Johannesburg South Africa', remote: false },
    // JHB — sales/BD
    { q: 'sales representative Johannesburg South Africa', remote: false },
    { q: 'business development representative Johannesburg', remote: false },
    { q: 'medical sales representative Johannesburg', remote: false },
    { q: 'account manager Johannesburg South Africa', remote: false },
    // JHB — admin/coordinator
    { q: 'administrator Johannesburg South Africa', remote: false },
    { q: 'coordinator Johannesburg South Africa', remote: false },
    { q: 'customer service representative Johannesburg', remote: false },
    { q: 'healthcare administrator Johannesburg', remote: false },
    // Remote
    { q: 'remote sales representative South Africa', remote: true },
    { q: 'remote customer success South Africa', remote: true },
    { q: 'remote clinical research coordinator', remote: true },
    { q: 'remote administrator South Africa', remote: true },
    { q: 'remote research coordinator', remote: true },
    { q: 'remote account manager South Africa', remote: true },
  ];

  for (const query of QUERIES) {
    try {
      const params = new URLSearchParams({
        query: query.q,
        page: '1',
        num_pages: '1',
        date_posted: 'month',
        ...(query.remote ? { remote_jobs_only: 'true' } : {}),
      });
      const resp = await fetch('https://jsearch.p.rapidapi.com/search?' + params, {
        headers: {
          'X-RapidAPI-Key': process.env.JSEARCH_API_KEY,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
        }
      });
      if (!resp.ok) {
        console.log('JSearch skip:', query.q, resp.status);
        // 429 = rate limited, back off
        if (resp.status === 429) await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      const data = await resp.json();
      for (const job of (data.data||[])) {
        const uid = 'js_' + (job.job_id || Math.random());
        if (seen.has(uid)) continue;
        seen.add(uid);
        const loc = query.remote
          ? 'Remote'
          : (job.job_city ? job.job_city + (job.job_country ? ', ' + job.job_country : '') : 'Johannesburg');
        jobs.push({
          id: uid,
          title: job.job_title || 'Untitled',
          company: job.employer_name || 'Unknown',
          location: loc,
          url: job.job_apply_link || job.job_google_link || '',
          description: (job.job_description||'').slice(0,2000),
          tags: (job.job_required_skills||[]).slice(0,5),
          salary: job.job_min_salary
            ? `$${Math.round(job.job_min_salary/1000)}k–$${Math.round((job.job_max_salary||job.job_min_salary)/1000)}k`
            : '',
          source: 'JSearch (' + (job.job_publisher||'Indeed') + ')',
          postedAt: job.job_posted_at_datetime_utc || new Date().toISOString(),
        });
      }
      await new Promise(r => setTimeout(r, 500));
    } catch(e) { console.error('JSearch error:', query.q, e.message); }
  }
  console.log('✅ JSearch raw:', jobs.length);
  return jobs;
}

// ── SCORE A JOB ───────────────────────────────────────────────────────────────
async function scoreJob(job) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const prompt = `You are a recruiter evaluating whether Micaela is a realistic hire.

MICAELA:
${MICAELA_PROFILE}

JOB:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Description: ${(job.description||'').slice(0,1000)}

Think about transferable skills, not just direct matches. She has science + sales + admin experience. Entry-level and coordinator roles are realistic. Do NOT skip just because she lacks years of experience.

Return ONLY raw JSON (no markdown, no code blocks):
{"fit":"High" or "Medium" or "Low","probability":0-100,"score":1-10,"verdict":"1-2 sentences","top_reason":"strongest fit reason max 10 words","skip":false}

Only set skip:true if it is truly impossible (e.g. requires 5+ years, senior management, specific professional registration she cannot have).`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = data.content.map(c => c.text||'').join('');
    let parsed;
    try { parsed = JSON.parse(text.replace(/```json|```/g,'').trim()); }
    catch(e) { const m = text.match(/\{[\s\S]*?\}/); parsed = m ? JSON.parse(m[0]) : null; }
    return parsed;
  } catch(e) { return null; }
}

// ── SCORE A BATCH ─────────────────────────────────────────────────────────────
async function scoreBatch(jobs, limit) {
  const scored = [];
  for (const job of jobs) {
    const score = await scoreJob(job);
    // Only hard-skip if explicitly marked or probability is truly zero
    // Lower threshold to 15 so borderline roles still surface
    if (!score || score.skip === true || (score.probability||0) < 15) continue;
    scored.push({ ...job, ...score });
    await new Promise(r => setTimeout(r, 100));
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

    // Global dedupe across all sources, preserving source attribution
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

    // Score each batch in parallel (faster), top 25 per source
    const [remoteTop, adzunaTop, jsearchTop] = await Promise.all([
      scoreBatch(remoteDeduped, 25),
      scoreBatch(adzunaDeduped, 25),
      scoreBatch(jsearchDeduped, 25),
    ]);

    console.log('✅ Pipeline done — RemoteOK:', remoteTop.length, '| Adzuna:', adzunaTop.length, '| JSearch:', jsearchTop.length);

    writePicks({
      remoteok: remoteTop,
      adzuna: adzunaTop,
      jsearch: jsearchTop,
      fetchedAt: new Date().toISOString(),
      status: 'ready',
    });
  } catch(e) {
    console.error('Pipeline error:', e.message);
    writePicks({ adzuna:[], remoteok:[], jsearch:[], fetchedAt:new Date().toISOString(), status:'error', error: e.message });
  } finally { fetchInProgress = false; }
}

// Run 8 seconds after startup, then every 6 hours
setTimeout(() => runDiscoveryPipeline(), 8000);
setInterval(() => runDiscoveryPipeline(), 6 * 60 * 60 * 1000);

// ── PICKS ENDPOINTS ───────────────────────────────────────────────────────────
app.get('/api/picks', (req, res) => res.json(readPicks()));
app.post('/api/picks/refresh', (req, res) => {
  if (fetchInProgress) return res.json({ ok: false, message: 'Already running' });
  runDiscoveryPipeline();
  res.json({ ok: true, message: 'Pipeline started' });
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
