const express = require('express');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const AdmZip  = require('adm-zip');

const app      = express();
const PORT     = process.env.PORT || 3000;
const GAMES_FILE = path.join(__dirname, 'games.json');
const GAMES_DIR  = path.join(__dirname, 'public', 'games');

const cloning = new Set();   // games currently being fetched
const failed  = new Set();   // games that failed to fetch

app.use(express.json());

// ── helpers ────────────────────────────────────────────────────────────────

function loadRegistry() {
  if (!fs.existsSync(GAMES_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(GAMES_FILE, 'utf8')); }
  catch { return []; }
}

function saveRegistry(games) {
  fs.writeFileSync(GAMES_FILE, JSON.stringify(games, null, 2));
}

function idFromRepo(repoUrl) {
  return repoUrl.replace(/\.git$/, '').split('/').pop()
    .toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

// download a URL to a file, following redirects
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get  = url.startsWith('https') ? https.get : http.get;
    get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => { file.close(); reject(err); });
  });
}

// fetch a GitHub repo as a zip and extract it to GAMES_DIR/<id>
async function fetchRepo(game) {
  const dest   = path.join(GAMES_DIR, game.id);
  const zipUrl = game.repo.replace(/\.git$/, '').replace(/\/$/, '') + '/archive/HEAD.zip';
  const tmpZip = path.join(os.tmpdir(), `${game.id}_${Date.now()}.zip`);

  console.log(`  fetching ${game.id} from ${zipUrl}…`);
  await download(zipUrl, tmpZip);
  console.log(`  extracting ${game.id}…`);

  const zip = new AdmZip(tmpZip);
  const entries = zip.getEntries();

  // GitHub zips have a top-level folder like "repo-HEAD/" — find its prefix
  const prefix = entries
    .filter(e => e.isDirectory)
    .map(e => e.entryName)
    .sort((a, b) => a.length - b.length)[0] || '';

  // wipe old dest and write fresh
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  entries.forEach(entry => {
    if (entry.isDirectory) return;
    // strip the top-level folder prefix
    const rel    = entry.entryName.startsWith(prefix)
      ? entry.entryName.slice(prefix.length)
      : entry.entryName;
    if (!rel) return;
    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
  });

  // cleanup
  try { fs.unlinkSync(tmpZip); } catch {}

  console.log(`  ✓ ${game.id} ready at /games/${game.id}/`);
}

async function fetchAsync(game) {
  cloning.add(game.id);
  failed.delete(game.id);
  try {
    await fetchRepo(game);
  } catch (e) {
    console.error(`  ✗ failed to fetch ${game.id}:`, e.message);
    failed.add(game.id);
    // clean up partial dest so next retry starts fresh
    const dest = path.join(GAMES_DIR, game.id);
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  } finally {
    cloning.delete(game.id);
  }
}

// ── middleware: loading / error page while game is fetching ───────────────

app.use('/games/:id/', (req, res, next) => {
  const { id } = req.params;
  if (req.path !== '/') return next();

  if (cloning.has(id)) {
    return res.send(`<!DOCTYPE html><html><head>
      <meta http-equiv="refresh" content="3">
      <style>body{background:#111008;color:#e8a020;font-family:monospace;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;gap:1rem;}
      p{font-size:1rem;} small{color:#5a4a2a;font-size:.7rem;}</style>
      </head><body>
      <p>⏳ Loading <strong>${id.replace(/_/g,' ')}</strong>…</p>
      <small>Refreshing in 3 s</small>
      </body></html>`);
  }

  if (failed.has(id)) {
    return res.status(500).send(`<!DOCTYPE html><html><head>
      <style>body{background:#111008;color:#c4647a;font-family:monospace;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;gap:1rem;}
      button{font-family:monospace;background:transparent;border:1px solid #c4647a;color:#c4647a;padding:.5rem 1rem;cursor:pointer;}</style>
      </head><body>
      <p>✗ Failed to load <strong>${id.replace(/_/g,' ')}</strong></p>
      <button onclick="fetch('/api/games/${id}/retry',{method:'POST'}).then(()=>location.reload())">RETRY</button>
      </body></html>`);
  }

  next();
});

// ── static serving ─────────────────────────────────────────────────────────

app.use('/games', express.static(GAMES_DIR));
app.use(express.static(__dirname, { index: 'index.html' }));

// ── API ────────────────────────────────────────────────────────────────────

app.get('/api/games', (req, res) => res.json(loadRegistry()));

app.get('/api/games/status', (req, res) => {
  res.json({ cloning: [...cloning], failed: [...failed] });
});

// retry a failed game
app.post('/api/games/:id/retry', (req, res) => {
  const game = loadRegistry().find(g => g.id === req.params.id);
  if (!game) return res.status(404).json({ error: 'not found' });
  if (cloning.has(game.id)) return res.json({ status: 'already cloning' });
  fetchAsync(game);
  res.json({ status: 'retrying' });
});

app.post('/api/games', (req, res) => {
  const { repo, name, id, icon, color, genre } = req.body || {};

  if (!repo || !/^https?:\/\/.+/.test(repo)) {
    return res.status(400).json({ error: 'Valid repo URL required (https://…)' });
  }

  const gameId   = (id || idFromRepo(repo)).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const games    = loadRegistry();

  if (games.find(g => g.id === gameId)) {
    return res.status(409).json({ error: `Game "${gameId}" is already registered.` });
  }

  const gameMode = ['local','iframe','external'].includes(req.body.mode) ? req.body.mode : 'local';
  const gameUrl  = req.body.url || null;

  if (gameMode !== 'local' && !gameUrl) {
    return res.status(400).json({ error: 'url is required for iframe/external modes' });
  }

  const entry = {
    id: gameId,
    name: (name || gameId.replace(/_/g, ' ').toUpperCase()).toUpperCase(),
    repo, mode: gameMode, url: gameUrl,
    icon: icon || '🎮', color: color || '#e8a020',
    genre: (genre || 'ARCADE').toUpperCase(),
    hi: 0, addedAt: new Date().toISOString(),
  };

  games.push(entry);
  saveRegistry(games);

  if (gameMode === 'local') fetchAsync(entry);

  res.status(201).json({ ok: true, game: entry, status: gameMode === 'local' ? 'fetching' : 'ready' });
});

// ── boot ──────────────────────────────────────────────────────────────────

fs.mkdirSync(GAMES_DIR, { recursive: true });

app.listen(PORT, () => {
  console.log(`🕹  Mandy's Arcade running at http://localhost:${PORT}`);
  loadRegistry().filter(g => g.mode === 'local').forEach(g => fetchAsync(g));
});
