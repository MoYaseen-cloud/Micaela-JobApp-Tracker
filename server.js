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
