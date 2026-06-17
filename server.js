const express  = require('express');
const { execSync, execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const app      = express();
const PORT     = process.env.PORT || 3000;
const GAMES_FILE = path.join(__dirname, 'games.json');
const GAMES_DIR  = path.join(__dirname, 'public', 'games');

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
  return repoUrl
    .replace(/\.git$/, '')
    .split('/')
    .pop()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_');
}

function cloneOrPull(game) {
  const dest = path.join(GAMES_DIR, game.id);
  if (fs.existsSync(path.join(dest, '.git'))) {
    console.log(`  pulling ${game.id}…`);
    execFileSync('git', ['-C', dest, 'pull', '--ff-only'], { timeout: 30_000 });
  } else {
    fs.mkdirSync(dest, { recursive: true });
    console.log(`  cloning ${game.id} from ${game.repo}…`);
    execFileSync('git', ['clone', '--depth', '1', game.repo, dest], { timeout: 60_000 });
  }
  console.log(`  ✓ ${game.id} ready at /games/${game.id}/`);
}

// ── startup: clone all registered games ───────────────────────────────────

fs.mkdirSync(GAMES_DIR, { recursive: true });

const registry = loadRegistry();
registry.forEach(g => {
  try { cloneOrPull(g); }
  catch (e) { console.error(`  ✗ failed to clone ${g.id}:`, e.message); }
});

// ── static serving ─────────────────────────────────────────────────────────

// serve cloned game directories
app.use('/games', express.static(GAMES_DIR));

// serve arcade root files (index.html, game.html, etc.)
app.use(express.static(__dirname, { index: 'index.html' }));

// ── API ────────────────────────────────────────────────────────────────────

// GET /api/games  — return current registry
app.get('/api/games', (req, res) => {
  res.json(loadRegistry());
});

// POST /api/games  — register + clone a new game
// Body: { repo, name?, id?, icon?, color?, genre? }
app.post('/api/games', (req, res) => {
  const { repo, name, id, icon, color, genre } = req.body || {};

  if (!repo || !/^https?:\/\/.+/.test(repo)) {
    return res.status(400).json({ error: 'Valid repo URL required (https://…)' });
  }

  const gameId = (id || idFromRepo(repo)).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const games  = loadRegistry();

  if (games.find(g => g.id === gameId)) {
    return res.status(409).json({ error: `Game "${gameId}" is already registered.` });
  }

  const gameMode = ['local','iframe','external'].includes(req.body.mode) ? req.body.mode : 'local';
  const gameUrl  = req.body.url || null;

  if (gameMode !== 'local' && !gameUrl) {
    return res.status(400).json({ error: 'url is required for iframe/external modes' });
  }

  const entry = {
    id:    gameId,
    name:  (name || gameId.replace(/_/g, ' ').toUpperCase()).toUpperCase(),
    repo,
    mode:  gameMode,
    url:   gameUrl,
    icon:  icon  || '🎮',
    color: color || '#e8a020',
    genre: (genre || 'ARCADE').toUpperCase(),
    hi:    0,
    addedAt: new Date().toISOString(),
  };

  if (gameMode === 'local') {
    try {
      cloneOrPull(entry);
    } catch (e) {
      return res.status(500).json({ error: `Clone failed: ${e.message}` });
    }
  }

  games.push(entry);
  saveRegistry(games);

  res.status(201).json({ ok: true, game: entry, url: `/games/${gameId}/` });
});

// ── start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🕹  Mandy's Arcade running at http://localhost:${PORT}`);
});
