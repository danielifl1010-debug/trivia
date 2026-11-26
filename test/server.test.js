// בדיקות אינטגרציה: API, הרשאות, ומשחק מלא דרך Socket.IO
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: ioc } = require('socket.io-client');
const { createApp } = require('../server');

const quietLog = { log() {}, error() {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function start(extraEnv = {}, opts = {}) {
  const env = { ADMIN_PASSWORD: 'pw', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-')), ...extraEnv };
  const ctx = await createApp(env, { log: quietLog, ...opts });
  await new Promise(r => ctx.server.listen(0, r));
  ctx.url = 'http://127.0.0.1:' + ctx.server.address().port;
  ctx.sockets = [];
  ctx.close = async () => { ctx.sockets.forEach(s => s.close()); ctx.io.close(); await new Promise(r => ctx.server.close(r)); };
  return ctx;
}
async function http(ctx, method, url, body, cookie) {
  const res = await fetch(ctx.url + url, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
async function login(ctx) {
  const r = await http(ctx, 'POST', '/api/login', { password: 'pw' });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}
function connect(ctx, cookie) {
  const s = ioc(ctx.url, { forceNew: true, transports: ['websocket'], extraHeaders: cookie ? { cookie } : {} });
  ctx.sockets.push(s);
  return new Promise(r => s.on('connect', () => r(s)));
}
const emit = (s, ev, data) => new Promise(r => s.emit(ev, data, r));
const once = (s, ev, ms = 5000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout waiting for ' + ev)), ms);
  s.once(ev, d => { clearTimeout(t); res(d); });
});
const Q = (text, correct = 1, time = 5) => ({ text, options: ['א', 'ב', 'ג', 'ד'], correct, time });

async function newGame(ctx, cookie, questions) {
  const quiz = (await http(ctx, 'POST', '/api/quizzes', { title: 'מבחן', questions }, cookie)).body;
  const host = await connect(ctx, cookie);
  const res = await emit(host, 'host:create', { quizId: quiz.id, hostKey: 'hk-' + Math.random() });
  assert.ok(res.code, JSON.stringify(res));
  return { host, code: res.code, quiz };
}
async function player(ctx, code, name, key) {
  const s = await connect(ctx);
  const r = await emit(s, 'player:join', { code, name, playerKey: key || 'k-' + name });
  return { s, r };
}

// ---------- API והרשאות ----------
test('auth: everything protected, login works, wrong password and brute force blocked', async () => {
  const ctx = await start();
  try {
    for (const [m, u] of [['GET', '/api/quizzes'], ['POST', '/api/quizzes'], ['GET', '/api/qr?code=1234'], ['POST', '/api/generate'], ['DELETE', '/api/quizzes/x']]) {
      assert.equal((await http(ctx, m, u, m === 'GET' ? undefined : {})).status, 401, m + ' ' + u);
    }
    assert.equal((await http(ctx, 'GET', '/api/quizzes', undefined, 'trivia_admin=forged')).status, 401);
    const st = (await http(ctx, 'GET', '/api/status')).body;
    assert.deepEqual([st.authRequired, st.loggedIn, st.storage, st.ai], [true, false, 'file', false]);
    assert.equal((await http(ctx, 'POST', '/api/login', { password: 'nope' })).status, 401);
    const cookie = await login(ctx);
    assert.equal((await http(ctx, 'GET', '/api/status', undefined, cookie)).body.loggedIn, true);
    assert.equal((await http(ctx, 'GET', '/api/quizzes', undefined, cookie)).status, 200);
    // ניסיונות מרובים נחסמים (כולל הסיסמה הנכונה)
    for (let i = 0; i < 10; i++) await http(ctx, 'POST', '/api/login', { password: 'x' + i });
    const blocked = await http(ctx, 'POST', '/api/login', { password: 'pw' });
    assert.equal(blocked.status, 429);
    // socket בלי עוגייה לא יכול לפתוח משחק
    const anon = await connect(ctx);
    assert.match((await emit(anon, 'host:create', { quizId: 'x' })).error, /סיסמה/);
  } finally { await ctx.close(); }
});

test('no password configured: open access (local use)', async () => {
  const ctx = await start({ ADMIN_PASSWORD: '' });
  try {
    assert.equal((await http(ctx, 'GET', '/api/quizzes')).status, 200);
    assert.equal((await http(ctx, 'GET', '/api/status')).body.authRequired, false);
  } finally { await ctx.close(); }
});

test('quizzes CRUD over HTTP, validation, limits', async () => {
  const ctx = await start();
  try {
    const c = await login(ctx);
    const created = (await http(ctx, 'POST', '/api/quizzes', { title: '<b>x</b>', questions: [Q('ש')] }, c)).body;
    assert.equal(created.title, '<b>x</b>', 'stored as text; UI renders with textContent');
    assert.equal((await http(ctx, 'PUT', '/api/quizzes/' + created.id, { title: 'חדש', questions: [] }, c)).status, 200);
    assert.equal((await http(ctx, 'GET', '/api/quizzes/' + created.id, undefined, c)).body.title, 'חדש');
    assert.equal((await http(ctx, 'GET', '/api/quizzes/nope', undefined, c)).status, 404);
    assert.equal((await http(ctx, 'PUT', '/api/quizzes/bad%20id', {}, c)).status, 400);
    assert.equal((await http(ctx, 'POST', '/api/quizzes', '{bad json', c)).status, 400);
    const big = 'data:image/png;base64,' + 'A'.repeat(390 * 1024);
    const huge = { title: 'big', questions: Array(45).fill(0).map(() => ({ ...Q('x'), image: big })) };
    assert.equal((await http(ctx, 'POST', '/api/quizzes', huge, c)).status, 413);
    assert.equal((await http(ctx, 'DELETE', '/api/quizzes/' + created.id, undefined, c)).status, 200);
    assert.equal((await http(ctx, 'DELETE', '/api/quizzes/' + created.id, undefined, c)).status, 404);
    assert.equal((await http(ctx, 'GET', '/api/nothing', undefined, c)).status, 404);
  } finally { await ctx.close(); }
});

test('QR endpoint returns SVG pointing to play URL', async () => {
  const ctx = await start();
  try {
    const c = await login(ctx);
    const r = await http(ctx, 'GET', '/api/qr?code=1234', undefined, c);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /svg/);
    assert.match(r.body, /^<svg/);
    assert.equal((await http(ctx, 'GET', '/api/qr?code=abc', undefined, c)).status, 400);
  } finally { await ctx.close(); }
});

test('AI endpoint: success, missing key, upstream errors', async () => {
  const body = { candidates: [{ content: { parts: [{ text: JSON.stringify([{ question: 'ש', options: ['1', '2', '3', '4'], correct_index: 2 }]) }] } }] };
  let mode = 'ok';
  const fetchImpl = async () => mode === 'ok'
    ? { status: 200, ok: true, json: async () => body }
    : { status: 429, ok: false, json: async () => ({}) };
  const ctx = await start({ GEMINI_API_KEY: 'k' }, { fetchImpl });
  try {
    const c = await login(ctx);
    const r = await http(ctx, 'POST', '/api/generate', { topic: 'נושא', count: 5 }, c);
    assert.equal(r.status, 200);
    assert.equal(r.body.questions[0].options[r.body.questions[0].correct], '3');
    mode = 'limit';
    assert.equal((await http(ctx, 'POST', '/api/generate', { topic: 'נושא' }, c)).status, 429);
    assert.equal((await http(ctx, 'POST', '/api/generate', { topic: '' }, c)).status, 400);
  } finally { await ctx.close(); }
  const noKey = await start();
  try {
    const c = await login(noKey);
    const r = await http(noKey, 'POST', '/api/generate', { topic: 'x' }, c);
    assert.equal(r.status, 503); assert.match(r.body.error, /GEMINI_API_KEY/);
  } finally { await noKey.close(); }
});

test('static pages and security headers', async () => {
  const ctx = await start();
  try {
    for (const p of ['/', '/host', '/play', '/style.css', '/host.js', '/play.js']) assert.equal((await http(ctx, 'GET', p)).status, 200, p);
    const r = await http(ctx, 'GET', '/');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.equal((await http(ctx, 'GET', '/../server.js')).status, 404);
    assert.equal((await http(ctx, 'GET', '/data/quizzes.json')).status, 404);
  } finally { await ctx.close(); }
});

// ---------- משחק ----------
test('game: refuses broken quiz and points to the question', async () => {
  const ctx = await start();
  try {
    const c = await login(ctx);
    const quiz = (await http(ctx, 'POST', '/api/quizzes', { title: 't', questions: [Q('ok'), { text: 'bad', options: ['a', '', '', ''] }] }, c)).body;
    const host = await connect(ctx, c);
    const r = await emit(host, 'host:create', { quizId: quiz.id, hostKey: 'h' });
    assert.equal(r.index, 1); assert.match(r.error, /שאלה 2/);
    assert.match((await emit(host, 'host:create', { quizId: 'missing', hostKey: 'h' })).error, /לא נמצא/);
  } finally { await ctx.close(); }
});

test('game: full flow with 60 players, scoring, early reveal, results report', async () => {
  const ctx = await start();
  try {
    const c = await login(ctx);
    const { host, code } = await newGame(ctx, c, [Q('1', 1, 10), Q('2', 0, 10), Q('3', 3, 10)]);
    const N = 60;
    const players = [];
    const seen = [];
    host.on('players', l => seen.push(l.length));
    for (let i = 0; i < N; i++) {
      const p = await player(ctx, code, 'שחקן ' + i);
      assert.ok(p.r.ok, JSON.stringify(p.r));
      players.push(p.s);
    }
    await sleep(100);
    assert.equal(seen[seen.length - 1], N);
    const correctOf = [1, 0, 3];
    for (let qi = 0; qi < 3; qi++) {
      const qs = players.map(s => once(s, 'question'));
      const hq = once(host, 'question');
      host.emit('host:next');
      const hostQ = await hq;
      assert.equal(hostQ.index, qi); assert.equal(hostQ.playerCount, N);
      const pq = await Promise.all(qs);
      assert.equal(pq[0].image, undefined, 'players do not receive images');
      assert.equal(pq[0].correct, undefined, 'players never receive the answer');
      const revealP = once(host, 'reveal');
      const results = players.map(s => once(s, 'result'));
      const t0 = Date.now();
      players.forEach((s, i) => s.emit('player:answer', { choice: i % 4 === 0 ? (correctOf[qi] + 1) % 4 : correctOf[qi] }));
      const rev = await revealP;
      assert.ok(Date.now() - t0 < 2000, 'reveal happens as soon as everyone answered');
      assert.equal(rev.counts.reduce((a, b) => a + b), N);
      assert.equal(rev.counts[correctOf[qi]], 45);
      const res = await Promise.all(results);
      assert.ok(res.every(r => r.answered));
      assert.ok(res.filter(r => r.correct).every(r => r.points >= 500 && r.points <= 1000));
      assert.ok(res.filter(r => !r.correct).every(r => r.points === 0));
    }
    const ended = once(host, 'ended');
    const pe = players.map(s => once(s, 'ended'));
    host.emit('host:next');
    const end = await ended;
    assert.equal(end.leaderboard.length, N);
    assert.ok(end.leaderboard.every((p, i, a) => i === 0 || a[i - 1].score >= p.score), 'sorted');
    const pend = await Promise.all(pe);
    assert.deepEqual(pend.map(p => p.rank).sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i + 1));
    const r = end.results;
    assert.equal(r.players.length, N); assert.equal(r.questions.length, 3); assert.equal(r.played, 3);
    const p0 = r.players.find(p => p.name === 'שחקן 0');
    assert.deepEqual(p0.answers, ['wrong', 'wrong', 'wrong']);
    assert.equal(p0.score, 0);
    const p1 = r.players.find(p => p.name === 'שחקן 1');
    assert.deepEqual(p1.answers, ['right', 'right', 'right']);
    // אחרי הסיום: שחקן חדש לא נכנס, שחקן קיים מקבל את התוצאה
    assert.match((await player(ctx, code, 'מאוחר')).r.error, /הסתיים/);
    const back = await connect(ctx);
    const endAgain = once(back, 'ended');
    await emit(back, 'player:join', { code, playerKey: 'k-שחקן 1' });
    assert.equal((await endAgain).score, p1.score);
  } finally { await ctx.close(); }
});

test('game: cheating and bad input are ignored', async () => {
  const ctx = await start();
  try {
    const c = await login(ctx);
    const { host, code } = await newGame(ctx, c, [{ text: 'q', options: ['a', 'b', '', ''], correct: 1, time: 5 }]);
    const a = await player(ctx, code, 'דוד');
    const b = await player(ctx, code, 'משה');
    assert.match((await player(ctx, code, ' דוד ')).r.error, /תפוס/);
    assert.match((await player(ctx, code, '')).r.error, /שם/);
    assert.match((await player(ctx, '0000', 'x')).r.error, /לא נמצא/);
    assert.match((await emit(await connect(ctx), 'player:join', { code, name: 'x' })).error, /רענן/);
    // תשובה לפני שהשאלה התחילה - נדחית
    a.s.emit('player:answer', { choice: 1 });
    const q = once(a.s, 'question');
    host.emit('host:next'); await q;
    // תשובה לאפשרות ריקה / לא חוקית - נדחית; host:next באמצע שאלה - לא עושה כלום
    for (const bad of [2, 3, -1, 7, '1; drop', null, 1.5]) a.s.emit('player:answer', { choice: bad });
    host.emit('host:next');
    await sleep(150);
    let answered = null; host.once('answered', d => { answered = d; });
    a.s.emit('player:answer', { choice: 0 });
    a.s.emit('player:answer', { choice: 1 }); // שינוי תשובה - נדחה
    await sleep(150);
    assert.equal(answered.answered, 1);
    // שחקן שהוצא באמצע - לא נספר
    const rev = once(host, 'reveal');
    host.emit('host:kick', { name: 'משה' });
    const r = await rev;
    assert.deepEqual(r.counts, [1, 0, 0, 0]);
    assert.equal(r.leaderboard[0].score, 0, 'wrong answer scored 0 (change ignored)');
    // שחקן מוצא לא יכול לענות יותר
    b.s.emit('player:answer', { choice: 1 });
    // אורח לא יכול לשלוט במשחק
    const guest = await connect(ctx);
    guest.emit('host:next'); guest.emit('host:end');
    await sleep(150);
    assert.equal(ctx.game.rooms.get(code).state, 'reveal');
  } finally { await ctx.close(); }
});

test('game: reconnect keeps score, timer reveal, late answers rejected, disconnected players not awaited', async () => {
  const ctx = await start();
  try {
    const c = await login(ctx);
    const { host, code } = await newGame(ctx, c, [Q('1', 1, 5), Q('2', 1, 5), Q('3', 1, 5)]);
    const a = await player(ctx, code, 'א', 'key-a');
    const b = await player(ctx, code, 'ב', 'key-b');
    // שאלה 1: א עונה נכון, ב מתנתק בלי לענות -> חשיפה מיידית כי לא מחכים למנותק
    let q = once(a.s, 'question'); host.emit('host:next'); await q;
    const rev1 = once(host, 'reveal', 8000);
    a.s.emit('player:answer', { choice: 1 });
    await sleep(100);
    const tClose = Date.now();
    b.s.close();
    await rev1;
    const waited = Date.now() - tClose;
    assert.ok(waited >= 3900 && waited < 5000, 'waits ~4s grace for disconnected player, waited ' + waited);
    const scoreA = ctx.game.rooms.get(code).players.get('key-a').score;
    assert.ok(scoreA >= 500);
    // א מתחבר מחדש מטלפון "אחר" עם אותו מפתח - שומר ניקוד; החיבור הישן מקבל replaced
    const replaced = once(a.s, 'replaced');
    const a2 = await connect(ctx);
    const r = await emit(a2, 'player:join', { code, playerKey: 'key-a' });
    assert.equal(r.score, scoreA); assert.equal(r.name, 'א');
    await replaced;
    assert.equal((await player(ctx, code, 'ב-חדש', 'key-b')).r.name, 'ב', 'existing key keeps original name');
    // שאלה 2: אף אחד לא עונה -> חשיפה לפי טיימר
    q = once(a2, 'question'); host.emit('host:next'); await q;
    const t0 = Date.now();
    const res = once(a2, 'result', 8000);
    await once(host, 'reveal', 8000);
    assert.ok(Date.now() - t0 >= 4500, 'waited for timer');
    assert.equal((await res).answered, false);
    a2.emit('player:answer', { choice: 1 }); // מאוחר
    await sleep(100);
    assert.equal(ctx.game.rooms.get(code).players.get('key-a').score, scoreA);
    // המנחה מרענן באמצע החשיפה - מקבל בחזרה את המצב
    const room = ctx.game.rooms.get(code);
    const host2 = await connect(ctx, c);
    const resume = await emit(host2, 'host:resume', { code, hostKey: room.hostKey });
    assert.equal(resume.state, 'reveal'); assert.ok(resume.reveal); assert.equal(resume.question.index, 1);
    assert.match((await emit(await connect(ctx, c), 'host:resume', { code, hostKey: 'wrong' })).error, /not found/);
    // החיבור הישן של המנחה כבר לא שולט
    host.emit('host:next'); await sleep(150);
    assert.equal(room.state, 'reveal');
    // סיום באמצע שאלה
    q = once(a2, 'question'); host2.emit('host:next'); await q;
    const ended = once(host2, 'ended');
    host2.emit('host:end');
    const e = await ended;
    assert.equal(e.results.played, 3);
    assert.deepEqual(e.results.players.find(p => p.name === 'א').answers, ['right', 'none', 'none']);
  } finally { await ctx.close(); }
});

test('game: lobby cancel closes room; player limit', async () => {
  const ctx = await start();
  try {
    const c = await login(ctx);
    const { host, code } = await newGame(ctx, c, [Q('1')]);
    const s = await connect(ctx);
    const results = [];
    for (let i = 0; i < 121; i++) results.push(await emit(s, 'player:join', { code, name: 'p' + i, playerKey: 'pk' + i }));
    assert.ok(results.slice(0, 120).every(r => r.ok));
    assert.match(results[120].error, /מלא/);
    host.emit('host:close');
    await sleep(100);
    assert.equal(ctx.game.rooms.has(code), false);
  } finally { await ctx.close(); }
});

test('game: player who refreshes mid-question is waited for and can still answer', async () => {
  const ctx = await start();
  try {
    const c = await login(ctx);
    const { host, code } = await newGame(ctx, c, [Q('1', 2, 20)]);
    const a = await player(ctx, code, 'א', 'ka');
    const b = await player(ctx, code, 'ב', 'kb');
    const q = once(a.s, 'question'); host.emit('host:next'); await q;
    a.s.emit('player:answer', { choice: 2 });
    let revealed = false; host.once('reveal', () => { revealed = true; });
    b.s.close();                       // ב מרענן את הדף
    await sleep(800);
    assert.equal(revealed, false, 'not revealed while B is reconnecting');
    const b2 = await connect(ctx);
    const gotQ = once(b2, 'question');
    await emit(b2, 'player:join', { code, playerKey: 'kb' });
    assert.equal((await gotQ).index, 0, 'rejoined player receives the current question');
    const rev = once(host, 'reveal');
    b2.emit('player:answer', { choice: 2 });
    const r = await rev;
    assert.equal(r.counts[2], 2);
    await sleep(4500);                 // הטיימר של הניתוק לא גורם לשום תקלה אחר כך
    assert.equal(ctx.game.rooms.get(code).state, 'reveal');
  } finally { await ctx.close(); }
});

test('auto-advance: moves to next question and to results by itself; pause and resume work', async () => {
  const ctx = await start();
  try {
    const c = await login(ctx);
    const quiz = (await http(ctx, 'POST', '/api/quizzes', { title: 'auto', autoAdvance: 3, questions: [Q('1', 1, 5), Q('2', 1, 5), Q('3', 1, 5)] }, c)).body;
    assert.equal(quiz.autoAdvance, 3);
    const host = await connect(ctx, c);
    const { code } = await emit(host, 'host:create', { quizId: quiz.id, hostKey: 'h' });
    const a = await player(ctx, code, 'א');
    // שאלה 1 -> תשובה -> חשיפה עם ספירה לאחור -> שאלה 2 מעצמה
    let q = once(a.s, 'question'); host.emit('host:next'); await q;
    let rev = once(host, 'reveal'); a.s.emit('player:answer', { choice: 1 });
    const r1 = await rev;
    assert.equal(r1.auto.seconds, 3); assert.equal(r1.auto.paused, false);
    assert.ok(r1.auto.remainingMs > 2500 && r1.auto.remainingMs <= 3000);
    const t0 = Date.now();
    const q2 = await once(host, 'question', 6000);
    assert.equal(q2.index, 1);
    assert.ok(Date.now() - t0 >= 2800, 'waited for auto-advance');
    // שאלה 2: השהיה בזמן החשיפה -> לא ממשיך; המשך -> ממשיך
    rev = once(host, 'reveal'); a.s.emit('player:answer', { choice: 1 }); await rev;
    const paused = once(host, 'auto');
    host.emit('host:auto', { paused: true });
    assert.equal((await paused).paused, true);
    let moved = false; host.once('question', () => { moved = true; });
    await sleep(3500);
    assert.equal(moved, false, 'paused: stays on answer');
    // המשהה נשמר גם אחרי רענון של המנחה
    const host2 = await connect(ctx, c);
    const resume = await emit(host2, 'host:resume', { code, hostKey: 'h' });
    assert.equal(resume.reveal.auto.paused, true);
    const resumed = once(host2, 'auto');
    host2.emit('host:auto', { paused: false });
    assert.equal((await resumed).paused, false);
    const q3 = await once(host2, 'question', 6000);
    assert.equal(q3.index, 2);
    // שאלה אחרונה: מעבר אוטומטי לתוצאות הסופיות
    rev = once(host2, 'reveal'); a.s.emit('player:answer', { choice: 0 });
    const r3 = await rev;
    assert.equal(r3.isLast, true);
    const ended = await once(host2, 'ended', 6000);
    assert.equal(ended.results.played, 3);
    // לחיצה ידנית על "הבא" לפני הזמן עדיין עובדת, וטיימר ישן לא גורם לקפיצה כפולה
  } finally { await ctx.close(); }
});

test('auto-advance: manual "next" during countdown does not cause a double skip; off by default', async () => {
  const ctx = await start();
  try {
    const c = await login(ctx);
    const { host, code } = await newGame(ctx, c, [Q('1', 1, 5), Q('2', 1, 5), Q('3', 1, 5)]);
    let q = once(host, 'question'); host.emit('host:next'); await q;
    const r = once(host, 'reveal'); host.emit('host:reveal');
    assert.equal((await r).auto, null, 'auto-advance off by default');
    const quiz = (await http(ctx, 'POST', '/api/quizzes', { title: 'a', autoAdvance: 3, questions: [Q('1'), Q('2'), Q('3')] }, c)).body;
    const h2 = await connect(ctx, c);
    await emit(h2, 'host:create', { quizId: quiz.id, hostKey: 'x' });
    q = once(h2, 'question'); h2.emit('host:next'); await q;
    const rv = once(h2, 'reveal'); h2.emit('host:reveal'); await rv;
    const indexes = []; h2.on('question', d => indexes.push(d.index));
    h2.emit('host:next');                     // ידני לפני סיום הספירה
    await sleep(3600);                         // הטיימר הישן היה אמור להיגמר כאן
    assert.deepEqual(indexes, [1], 'only one advance');
  } finally { await ctx.close(); }
});
