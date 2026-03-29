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
// ── JOB DISCOVERY PIPELINE ───────────────────────────────────────────────────
const PICKS_PATH = path.join(DATA_DIR, 'daily_picks.json');

function readPicks() {
  try { if (fs.existsSync(PICKS_PATH)) return JSON.parse(fs.readFileSync(PICKS_PATH, 'utf8')); }
  catch(e) {}
  return { jobs: [], fetchedAt: null, status: 'never' };
}
function writePicks(data) {
  try { fs.writeFileSync(PICKS_PATH, JSON.stringify(data, null, 2), 'utf8'); }
  catch(e) { console.error('Picks write error:', e.message); }
}

const MICAELA_PROFILE = `
Honours in Forensic Genetics Cum Laude, BSc Biological Sciences, UKZN.
GCP certified, Research Ethics certified, Code 8 licence.
Experience: Lab Demonstrator, Research Assistant (Moringa/HIV/HPV studies), Business Development Rep (promoted), Junior Sales Rep, Perfume Promoter.
Skills: DNA extraction, PCR, GLP, QA, CRM, B2B sales, client management, scientific writing, MS Office, Google Workspace.
Strong communicator, self-directed, high performer under pressure, rare science+sales combination.
`;

// South Africa searches — NO location restriction, covers all SA + remote
const SA_TERMS = [
  'clinical research coordinator',
  'laboratory assistant',
  'medical sales representative',
  'clinical trial assistant',
  'healthcare administrator',
  'research assistant biology',
  'quality assurance science',
  'GCP clinical coordinator',
  'sales representative pharmaceutical',
  'data coordinator science',
];

// Remote-specific searches
const REMOTE_TERMS = [
  'appointment setter remote',
  'clinical research remote',
  'healthcare admin remote',
  'research coordinator remote',
  'science sales remote',
];

async function fetchRemoteOK() {
  const jobs = [];
  try {
    console.log('🌐 Fetching RemoteOK...');
    const resp = await fetch('https://remoteok.com/api', {
      headers: { 'User-Agent': 'MicaelaJobTracker/1.0' }
    });
    if (!resp.ok) throw new Error('Status ' + resp.status);
    const data = await resp.json();
    const keywords = ['clinical','lab','science','health','research','sales','admin','coordinator','medical','pharma','biology','gcp','quality','data'];
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
    console.log('✅ RemoteOK:', jobs.length, 'jobs');
  } catch(e) { console.error('❌ RemoteOK:', e.message); }
  return jobs;
}

async function fetchAdzuna() {
  const jobs = [];
  if (!process.env.ADZUNA_APP_ID || !process.env.ADZUNA_APP_KEY) {
    console.log('⚠️  Adzuna credentials missing');
    return jobs;
  }
  const seen = new Set();
  const allTerms = [...SA_TERMS, ...REMOTE_TERMS];

  for (const term of allTerms) {
    try {
      const q = encodeURIComponent(term);
      const isRemote = term.includes('remote');
      // For remote terms: no location filter. For SA terms: country=za, no specific city restriction
      const locationParam = isRemote ? '' : '&where=South+Africa';
      const url = `https://api.adzuna.com/v1/api/jobs/za/search/1?app_id=${process.env.ADZUNA_APP_ID}&app_key=${process.env.ADZUNA_APP_KEY}&results_per_page=8&what=${q}${locationParam}&content-type=application/json`;
      const resp = await fetch(url);
      if (!resp.ok) { console.log('Adzuna skip', term, resp.status); continue; }
      const data = await resp.json();
      for (const job of (data.results||[])) {
        const uid = 'adz_' + job.id;
        if (seen.has(uid)) continue;
        seen.add(uid);
        const loc = job.location?.display_name || 'South Africa';
        jobs.push({
          id: uid,
          title: job.title,
          company: job.company?.display_name || 'Unknown',
          location: isRemote ? 'Remote / ' + loc : loc,
          url: job.redirect_url||'',
          description: (job.description||'').slice(0,2000),
          tags: [],
          salary: job.salary_min ? `R${Math.round(job.salary_min/1000)}k–R${Math.round((job.salary_max||job.salary_min)/1000)}k/yr` : '',
          source: 'Adzuna',
          postedAt: job.created||new Date().toISOString(),
        });
      }
      await new Promise(r => setTimeout(r, 250));
    } catch(e) { console.error('Adzuna term error', term, e.message); }
  }
  console.log('✅ Adzuna:', jobs.length, 'jobs');
  return jobs;
}

async function scoreJob(job) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const prompt = 'You are a recruiter. Evaluate if Micaela fits this job.\n\nMICAELA:\n' + MICAELA_PROFILE + '\n\nJOB:\nTitle: ' + job.title + '\nCompany: ' + job.company + '\nLocation: ' + job.location + '\nDescription: ' + (job.description||'').slice(0,1200) + '\n\nReturn ONLY raw JSON:\n{"fit":"High"or"Medium"or"Low","probability":0-100,"score":1-10,"verdict":"2 sentences max","top_reason":"strongest fit reason in 10 words","skip":true or false}';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:250, messages:[{role:'user',content:prompt}] }),
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

let fetchInProgress = false;
async function runDiscoveryPipeline() {
  if (fetchInProgress) return;
  fetchInProgress = true;
  console.log('\n🚀 Job discovery pipeline starting...');
  try {
    writePicks({ jobs:[], fetchedAt:new Date().toISOString(), status:'fetching' });
    const [remoteJobs, adzunaJobs] = await Promise.all([fetchRemoteOK(), fetchAdzuna()]);
    const allJobs = [...remoteJobs, ...adzunaJobs];
    console.log('📋 Total to evaluate:', allJobs.length);
    if (!allJobs.length) { writePicks({jobs:[],fetchedAt:new Date().toISOString(),status:'no_jobs'}); return; }
    const scored = [];
    for (const job of allJobs) {
      const score = await scoreJob(job);
      if (!score || score.skip || score.probability < 30) continue;
      scored.push({...job,...score});
      await new Promise(r => setTimeout(r, 150));
    }
    scored.sort((a,b) => b.score - a.score);
    const top = scored.slice(0,15);
    console.log('✅ Pipeline done:', top.length, 'top jobs');
    writePicks({ jobs:top, fetchedAt:new Date().toISOString(), status:'ready', totalEvaluated:allJobs.length });
  } catch(e) {
    console.error('Pipeline error:', e.message);
    writePicks({ jobs:[], fetchedAt:new Date().toISOString(), status:'error', error:e.message });
  } finally { fetchInProgress = false; }
}

setTimeout(() => runDiscoveryPipeline(), 8000);
setInterval(() => runDiscoveryPipeline(), 6 * 60 * 60 * 1000);

// ── PICKS ENDPOINTS ───────────────────────────────────────────────────────────
app.get('/api/picks', (req, res) => res.json(readPicks()));
app.post('/api/picks/refresh', (req, res) => {
  if (fetchInProgress) return res.json({ ok:false, message:'Already running' });
  runDiscoveryPipeline();
  res.json({ ok:true, message:'Pipeline started' });
});

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
