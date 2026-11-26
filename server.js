// שרת משחק הטריוויה
const express = require('express');
const http = require('http');
const path = require('path');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { createStore } = require('./lib/store');
const { createAuth } = require('./lib/auth');
const { generateQuestions, AIError } = require('./lib/ai');
const { attachGame } = require('./lib/game');

async function createApp(env = process.env, { store: givenStore, fetchImpl, log = console } = {}) {
  const store = givenStore || await createStore({
    mongoUri: env.MONGODB_URI, dataDir: env.DATA_DIR || path.join(__dirname, 'data'), log,
  });
  const auth = createAuth({ password: env.ADMIN_PASSWORD, secret: env.SESSION_SECRET });

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
  app.use(express.json({ limit: '15mb' }));

  const page = name => (req, res) => res.sendFile(path.join(__dirname, 'public', name));
  app.get('/play', page('play.html'));
  app.get('/host', page('host.html'));
  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

  // ---------- API ----------
  const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    log.error(e);
    res.status(500).json({ error: 'שגיאת שרת' });
  });

  app.get('/api/status', (req, res) => {
    res.json({
      authRequired: auth.enabled,
      loggedIn: auth.isAdminCookieHeader(req.headers.cookie),
      storage: store.mode,
      warning: store.warning || null,
      ai: !!(env.GEMINI_API_KEY || env.GROQ_API_KEY || env.OPENROUTER_API_KEY),
    });
  });
  app.post('/api/login', (req, res) => auth.login(req, res));
  app.post('/api/logout', (req, res) => auth.logout(req, res));

  const api = express.Router();
  api.use(auth.middleware);

  api.get('/quizzes', wrap(async (req, res) => res.json(await store.list())));
  api.get('/quizzes/:id', wrap(async (req, res) => {
    const q = await store.get(req.params.id);
    q ? res.json(q) : res.status(404).json({ error: 'החידון לא נמצא' });
  }));
  api.post('/quizzes', wrap(async (req, res) => res.json(await store.save(null, req.body))));
  api.put('/quizzes/:id', wrap(async (req, res) => {
    const q = await store.save(req.params.id, req.body);
    q ? res.json({ id: q.id, updatedAt: q.updatedAt }) : res.status(400).json({ error: 'מזהה לא תקין' });
  }));
  api.delete('/quizzes/:id', wrap(async (req, res) => {
    (await store.remove(req.params.id)) ? res.json({ ok: true }) : res.status(404).json({ error: 'החידון לא נמצא' });
  }));

  let aiBusy = 0;
  api.post('/generate', wrap(async (req, res) => {
    if (aiBusy >= 3) return res.status(429).json({ error: 'יש כבר יצירה בתהליך, נסה שוב בעוד רגע' });
    aiBusy++;
    try {
      res.json({ questions: await generateQuestions(req.body || {}, env, fetchImpl) });
    } catch (e) {
      if (e instanceof AIError) return res.status(e.status).json({ error: e.message });
      throw e;
    } finally { aiBusy--; }
  }));

  api.get('/qr', wrap(async (req, res) => {
    const code = String(req.query.code || '');
    if (!/^\d{4}$/.test(code)) return res.status(400).end();
    const url = `${req.protocol}://${req.get('host')}/play?code=${code}`;
    res.type('image/svg+xml').send(await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }));
  }));

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'לא נמצא' }));
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'החידון גדול מדי (יותר מדי תמונות)' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'נתונים לא תקינים' });
    log.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  });

  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 1e6, pingInterval: 10000, pingTimeout: 8000 });
  const game = attachGame(io, { store, isAdmin: h => auth.isAdminCookieHeader(h) });

  return { app, server, io, store, game };
}

if (require.main === module) {
  createApp().then(({ server, store }) => {
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log('השרת פועל על פורט ' + PORT);
      if (!process.env.ADMIN_PASSWORD) console.log('אזהרה: לא הוגדרה סיסמת מנחה (ADMIN_PASSWORD) - כל אחד יכול לנהל');
      if (store.warning) console.log('אזהרה: ' + store.warning);
    });
  }).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { createApp };
