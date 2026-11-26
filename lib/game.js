// לוגיקת המשחק בזמן אמת
const { gameQuestions } = require('./validate');

const MAX_PLAYERS = 120;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const GRACE_MS = 4000; // זמן המתנה לשחקן שהתנתק רגע (מסך ננעל, החלפת רשת)

function attachGame(io, { store, isAdmin }) {
  const rooms = new Map(); // code -> room

  function newCode() {
    let code;
    do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(code));
    return code;
  }

  const ranked = room => [...room.players.values()].sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
  const leaderboard = room => ranked(room).map(p => ({ name: p.name, score: p.score }));
  const rankOf = (room, p) => ranked(room).indexOf(p) + 1;
  const playersList = room => [...room.players.values()].map(p => ({ name: p.name, online: !!p.socketId }));
  const sendToHost = (room, ev, data) => { if (room.hostSocket) io.to(room.hostSocket).emit(ev, data); };

  function questionData(room, forHost) {
    const q = room.questions[room.index];
    const d = {
      index: room.index, total: room.questions.length, text: q.text, options: q.options,
      time: q.time, remainingMs: Math.max(0, room.endsAt - Date.now()),
    };
    if (forHost) { d.image = q.image; d.answered = answeredCount(room); d.playerCount = activeCount(room); }
    return d;
  }

  function answeredCount(room) {
    let n = 0;
    for (const p of room.players.values()) if (p.answer !== null) n++;
    return n;
  }
  // שחקנים שמחוברים, שכבר ענו, או שהתנתקו לפני רגע - אליהם מחכים
  function activeCount(room) {
    let n = 0;
    const now = Date.now();
    for (const p of room.players.values()) if (p.socketId || p.answer !== null || now - (p.leftAt || 0) < GRACE_MS) n++;
    return n;
  }
  function maybeReveal(room) {
    if (room.state === 'question' && room.players.size && answeredCount(room) >= activeCount(room)) reveal(room);
  }

  function startQuestion(room) {
    clearTimeout(room.timer);
    room.autoAt = null;
    room.state = 'question';
    const q = room.questions[room.index];
    room.endsAt = Date.now() + q.time * 1000;
    for (const p of room.players.values()) { p.answer = null; p.lastPoints = 0; }
    io.to('players:' + room.code).emit('question', questionData(room, false));
    sendToHost(room, 'question', questionData(room, true));
    room.timer = setTimeout(() => reveal(room), q.time * 1000 + 300);
  }

  function revealData(room) {
    const q = room.questions[room.index];
    const counts = q.options.map(() => 0);
    for (const p of room.players.values()) if (p.answer !== null) counts[p.answer]++;
    return {
      correct: q.correct, counts, leaderboard: leaderboard(room).slice(0, 5), isLast: room.index >= room.questions.length - 1,
      auto: autoData(room),
    };
  }

  // ---------- מעבר אוטומטי ----------
  function autoData(room) {
    if (!room.autoAdvance) return null;
    return { seconds: room.autoAdvance, paused: !!room.autoPaused, remainingMs: room.autoAt ? Math.max(0, room.autoAt - Date.now()) : null };
  }
  function next(room) {
    if (room.state === 'question' || room.state === 'ended') return;
    if (room.index >= room.questions.length - 1) return endGame(room);
    room.index++;
    startQuestion(room);
  }
  function scheduleAuto(room) {
    clearTimeout(room.timer);
    room.autoAt = null;
    if (!room.autoAdvance || room.autoPaused || room.state !== 'reveal') return;
    room.autoAt = Date.now() + room.autoAdvance * 1000;
    room.timer = setTimeout(() => { room.autoAt = null; next(room); }, room.autoAdvance * 1000);
  }

  function sendResult(room, p) {
    const q = room.questions[room.index];
    io.to(p.socketId).emit('result', {
      answered: p.answer !== null, correct: p.answer === q.correct, correctText: q.options[q.correct],
      points: p.lastPoints, score: p.score, rank: rankOf(room, p), total: room.players.size,
    });
  }

  function reveal(room) {
    if (room.state !== 'question') return;
    clearTimeout(room.timer);
    room.state = 'reveal';
    for (const p of room.players.values()) {
      p.answers[room.index] = p.answer === null ? null : { choice: p.answer, points: p.lastPoints };
    }
    scheduleAuto(room);
    sendToHost(room, 'reveal', revealData(room));
    for (const p of room.players.values()) if (p.socketId) sendResult(room, p);
  }

  function results(room) {
    return {
      title: room.title,
      questions: room.questions.map(q => ({ text: q.text, correct: q.options[q.correct] })),
      players: ranked(room).map((p, i) => ({
        rank: i + 1, name: p.name, score: p.score,
        answers: room.questions.map((q, qi) => {
          if (qi > room.index) return 'skip';
          const a = p.answers[qi];
          if (!a) return 'none';
          return a.choice === q.correct ? 'right' : 'wrong';
        }),
      })),
      played: room.index + 1,
    };
  }

  function endGame(room) {
    if (room.state === 'ended') return;
    if (room.state === 'question') reveal(room);
    clearTimeout(room.timer);
    room.autoAt = null;
    room.state = 'ended';
    sendToHost(room, 'ended', { leaderboard: leaderboard(room), results: results(room) });
    for (const p of room.players.values()) {
      if (p.socketId) io.to(p.socketId).emit('ended', { score: p.score, rank: rankOf(room, p), total: room.players.size });
    }
  }

  setInterval(() => {
    const limit = Date.now() - ROOM_TTL_MS;
    for (const [code, room] of rooms) if (room.createdAt < limit) { clearTimeout(room.timer); rooms.delete(code); }
  }, 30 * 60 * 1000).unref();

  io.on('connection', socket => {
    const admin = () => isAdmin(socket.handshake.headers.cookie);

    // ===== מנחה =====
    socket.on('host:create', async (payload, cb) => {
      if (typeof cb !== 'function') return;
      if (!admin()) return cb({ error: 'נדרשת כניסה עם סיסמה' });
      const { quizId, hostKey } = payload || {};
      let quiz;
      try { quiz = await store.get(quizId); } catch { return cb({ error: 'שגיאה בטעינת החידון' }); }
      if (!quiz) return cb({ error: 'החידון לא נמצא' });
      const g = gameQuestions(quiz);
      if (g.error) return cb({ error: g.error, index: g.index });
      const code = newCode();
      rooms.set(code, {
        code, title: quiz.title, hostKey: String(hostKey || '').slice(0, 64), hostSocket: socket.id,
        questions: g.questions, index: -1, state: 'lobby', players: new Map(), timer: null, createdAt: Date.now(),
        autoAdvance: g.autoAdvance, autoPaused: false, autoAt: null,
      });
      socket.data.hostOf = code;
      cb({ code, title: quiz.title, total: g.questions.length });
    });

    socket.on('host:resume', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const { code, hostKey } = payload || {};
      const room = rooms.get(String(code));
      if (!room || !hostKey || room.hostKey !== hostKey || !admin()) return cb({ error: 'not found' });
      room.hostSocket = socket.id;
      socket.data.hostOf = room.code;
      const res = { code: room.code, title: room.title, state: room.state, players: playersList(room) };
      if (room.state === 'question' || room.state === 'reveal') res.question = questionData(room, true);
      if (room.state === 'reveal') res.reveal = revealData(room);
      if (room.state === 'ended') { res.leaderboard = leaderboard(room); res.results = results(room); }
      cb(res);
    });

    const hostRoom = () => {
      const room = rooms.get(socket.data.hostOf);
      return room && room.hostSocket === socket.id ? room : null;
    };

    socket.on('host:next', () => { const r = hostRoom(); if (r) next(r); });
    // השהיה / המשך של המעבר האוטומטי
    socket.on('host:auto', payload => {
      const room = hostRoom(); if (!room || !room.autoAdvance) return;
      room.autoPaused = !!(payload && payload.paused);
      if (room.state === 'reveal') scheduleAuto(room);
      sendToHost(room, 'auto', autoData(room));
    });
    socket.on('host:reveal', () => { const r = hostRoom(); if (r) reveal(r); });
    socket.on('host:end', () => { const r = hostRoom(); if (r) endGame(r); });
    socket.on('host:close', () => {
      const r = hostRoom(); if (!r) return;
      endGame(r);
      rooms.delete(r.code);
    });
    socket.on('host:kick', payload => {
      const room = hostRoom(); if (!room) return;
      const name = String((payload && payload.name) || '');
      for (const [key, p] of room.players) {
        if (p.name === name) {
          if (p.socketId) {
            io.to(p.socketId).emit('kicked');
            const s = io.sockets.sockets.get(p.socketId);
            if (s) { s.leave('players:' + room.code); s.data.playerOf = null; }
          }
          room.players.delete(key);
        }
      }
      sendToHost(room, 'players', playersList(room));
      maybeReveal(room);
    });

    // ===== שחקן =====
    socket.on('player:join', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const { code, name: rawName, playerKey: rawKey } = payload || {};
      const room = rooms.get(String(code || '').trim());
      if (!room) return cb({ error: 'לא נמצא משחק עם הקוד הזה' });
      const name = String(rawName || '').replace(/\s+/g, ' ').trim().slice(0, 20);
      const playerKey = String(rawKey || '').slice(0, 64);
      if (!playerKey) return cb({ error: 'שגיאה, רענן את הדף' });

      // אם השחקן היה במשחק אחר באותו חיבור - מנתקים משם
      if (socket.data.playerOf && socket.data.playerOf !== room.code) socket.leave('players:' + socket.data.playerOf);

      let p = room.players.get(playerKey);
      if (!p) {
        if (!name) return cb({ error: 'נא להזין שם' });
        if (room.state === 'ended') return cb({ error: 'המשחק הסתיים' });
        if (room.players.size >= MAX_PLAYERS) return cb({ error: 'המשחק מלא' });
        for (const other of room.players.values()) {
          if (other.name.toLowerCase() === name.toLowerCase()) return cb({ error: 'השם תפוס, בחר שם אחר' });
        }
        p = { name, score: 0, answer: null, lastPoints: 0, socketId: null, answers: [], joinedAt: Date.now() };
        room.players.set(playerKey, p);
      }
      // חיבור חדש של אותו שחקן (טאב נוסף) - הישן מתנתק מהחדר
      if (p.socketId && p.socketId !== socket.id) {
        const old = io.sockets.sockets.get(p.socketId);
        if (old) { old.leave('players:' + room.code); old.data.playerOf = null; old.emit('replaced'); }
      }
      p.socketId = socket.id;
      socket.data.playerOf = room.code;
      socket.data.playerKey = playerKey;
      socket.join('players:' + room.code);
      cb({ ok: true, name: p.name, title: room.title, score: p.score, state: room.state });
      sendToHost(room, 'players', playersList(room));

      if (room.state === 'question') {
        socket.emit('question', questionData(room, false));
        if (p.answer !== null) socket.emit('answered');
      } else if (room.state === 'reveal') {
        sendResult(room, p);
      } else if (room.state === 'ended') {
        socket.emit('ended', { score: p.score, rank: rankOf(room, p), total: room.players.size });
      }
    });

    socket.on('player:answer', payload => {
      const room = rooms.get(socket.data.playerOf);
      if (!room || room.state !== 'question') return;
      const p = room.players.get(socket.data.playerKey);
      if (!p || p.socketId !== socket.id || p.answer !== null) return;
      const q = room.questions[room.index];
      const choice = payload ? payload.choice : undefined;
      if (typeof choice !== 'number' || !Number.isInteger(choice) || choice < 0 || choice > 3 || !q.options[choice].trim()) return;
      const now = Date.now();
      if (now > room.endsAt + 500) return;
      p.answer = choice;
      if (choice === q.correct) {
        const ratio = Math.min(1, Math.max(0, (room.endsAt - now) / (q.time * 1000)));
        p.lastPoints = Math.round(500 + 500 * ratio);
        p.score += p.lastPoints;
      }
      socket.emit('answered');
      sendToHost(room, 'answered', { answered: answeredCount(room), playerCount: activeCount(room) });
      maybeReveal(room);
    });

    socket.on('disconnect', () => {
      const hostOf = rooms.get(socket.data.hostOf);
      if (hostOf && hostOf.hostSocket === socket.id) hostOf.hostSocket = null;
      const room = rooms.get(socket.data.playerOf);
      if (!room) return;
      const p = room.players.get(socket.data.playerKey);
      if (p && p.socketId === socket.id) {
        p.socketId = null;
        p.leftAt = Date.now();
        sendToHost(room, 'players', playersList(room));
        if (room.state === 'question') {
          const idx = room.index;
          setTimeout(() => {
            if (room.index !== idx || room.state !== 'question' || p.socketId) return;
            sendToHost(room, 'answered', { answered: answeredCount(room), playerCount: activeCount(room) });
            maybeReveal(room);
          }, GRACE_MS + 50);
        }
      }
    });
  });

  return { rooms };
}

module.exports = { attachGame, MAX_PLAYERS };
