// צד המנחה
const $ = id => document.getElementById(id);
const SHAPES = ['▲', '◆', '●', '■'];
const VIEWS = ['v-login', 'v-loading', 'v-edit', 'v-lobby', 'v-q', 'v-rev', 'v-end'];
let view = 'v-loading';
function show(v) { view = v; for (const x of VIEWS) $(x).classList.toggle('hidden', x !== v); }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------- תקשורת עם השרת ----------
class HttpError extends Error { constructor(m, s) { super(m); this.status = s; } }
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new HttpError('אין חיבור לשרת', 0); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new HttpError(data.error || 'נדרשת כניסה', 401); }
  if (!res.ok) throw new HttpError(data.error || 'שגיאה (' + res.status + ')', res.status);
  return data;
}

let status = {};
let socket = null;

async function boot() {
  try { status = await api('GET', '/api/status'); } catch (e) { show('v-loading'); toast(e.message); setTimeout(boot, 3000); return; }
  if (status.authRequired && !status.loggedIn) return showLogin();
  $('logout').classList.toggle('hidden', !status.authRequired);
  const warns = [];
  if (status.warning) warns.push(status.warning);
  if (!status.authRequired && !/^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname)) warns.push('לא הוגדרה סיסמת מנחה (ADMIN_PASSWORD) - כל מי שמגיע לדף הזה יכול לערוך ולנהל.');
  $('warn-banner').textContent = warns.join(' ');
  $('warn-banner').classList.toggle('hidden', !warns.length);
  await migrateLocal();
  await loadQuizList();
  connectSocket();
}

function showLogin() {
  show('v-login');
  setTimeout(() => $('password').focus(), 50);
}
$('login-form').onsubmit = async e => {
  e.preventDefault();
  $('login-err').textContent = '';
  try {
    await api('POST', '/api/login', { password: $('password').value });
    $('password').value = '';
    show('v-loading');
    if (socket) { socket.disconnect(); socket = null; } // לחבר מחדש עם העוגייה החדשה
    boot();
  } catch (err) { $('login-err').textContent = err.message; }
};
$('logout').onclick = async () => { await api('POST', '/api/logout').catch(() => {}); location.reload(); };

// מעבר חד-פעמי של חידונים מהגרסה הקודמת (שנשמרו בדפדפן)
async function migrateLocal() {
  if (localStorage.getItem('trivia-migrated')) return;
  let old = [];
  try { old = JSON.parse(localStorage.getItem('trivia-quizzes') || '[]'); } catch {}
  let moved = 0;
  for (const q of Array.isArray(old) ? old : []) {
    if (!q || q.id === 'sample' || !Array.isArray(q.questions) || !q.questions.length) continue;
    try { await api('POST', '/api/quizzes', { title: q.title, questions: q.questions }); moved++; } catch (e) { if (e.status === 401) return; }
  }
  localStorage.setItem('trivia-migrated', '1');
  if (moved) toast('הועברו ' + moved + ' חידונים מהגרסה הקודמת');
}

// ---------- עורך ----------
let list = [];      // סיכומי חידונים
let quiz = null;    // החידון הפתוח
let dirty = false, saving = null, saveTimer = null;

function setSaveState(s) {
  const m = { saved: '✓ נשמר', saving: 'שומר...', dirty: 'שומר...', error: '⚠ השמירה נכשלה - מנסה שוב' };
  $('save-state').textContent = m[s] || '';
  $('save-state').className = 'shrink save-state ' + s;
}

async function loadQuizList(selectId) {
  list = await api('GET', '/api/quizzes');
  if (!list.length) {
    const q = await api('POST', '/api/quizzes', { title: 'חידון חדש', questions: [] });
    list = [{ id: q.id, title: q.title, count: 0 }];
  }
  const want = selectId || localStorage.getItem('trivia-current');
  const id = list.find(q => q.id === want) ? want : list[0].id;
  await openQuiz(id);
  if (view === 'v-loading') show('v-edit');
}

async function openQuiz(id) {
  await flushSave();
  quiz = await api('GET', '/api/quizzes/' + encodeURIComponent(id));
  localStorage.setItem('trivia-current', id);
  renderSelect(); renderQuestions(); setSaveState('saved');
  $('edit-err').textContent = '';
}

function renderSelect() {
  const s = $('quiz-select');
  s.innerHTML = '';
  for (const q of list) {
    const o = el('option', '', (q.id === quiz.id ? quiz.title : q.title) || 'ללא שם');
    o.value = q.id; s.appendChild(o);
  }
  s.value = quiz.id;
  $('quiz-title').value = quiz.title;
  const auto = String(quiz.autoAdvance || 0);
  const sel = $('auto-advance');
  if (![...sel.options].some(o => o.value === auto)) { const o = el('option', '', 'אחרי ' + auto + ' שניות של הצגת התשובה'); o.value = auto; sel.appendChild(o); }
  sel.value = auto;
}

function markDirty() {
  dirty = true; setSaveState('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 700);
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (saving) await saving;
  if (!dirty || !quiz) return true;
  dirty = false;
  setSaveState('saving');
  const snapshot = { title: quiz.title, autoAdvance: quiz.autoAdvance || 0, questions: quiz.questions };
  const id = quiz.id;
  saving = api('PUT', '/api/quizzes/' + encodeURIComponent(id), snapshot)
    .then(() => {
      const item = list.find(q => q.id === id);
      if (item) { item.title = snapshot.title; item.count = snapshot.questions.length; }
      if (!dirty) setSaveState('saved');
      return true;
    })
    .catch(e => {
      dirty = true; setSaveState('error');
      if (e.status !== 401) { clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 4000); }
      if (e.status === 413) toast(e.message, 6000);
      return false;
    })
    .finally(() => { saving = null; });
  return saving;
}
window.addEventListener('beforeunload', e => { if (dirty || saving) { flushSave(); e.preventDefault(); e.returnValue = ''; } });

function emptyQuestion() { return { text: '', options: ['', '', '', ''], correct: 0, time: 20, image: '' }; }

function renderQuestions() {
  const box = $('q-list');
  box.innerHTML = '';
  $('q-count').textContent = quiz.questions.length ? '(' + quiz.questions.length + ')' : '';
  $('q-empty').classList.toggle('hidden', quiz.questions.length > 0);
  quiz.questions.forEach((q, qi) => box.appendChild(questionCard(q, qi)));
}

function questionCard(q, qi) {
  const card = el('div', 'q-item' + (q.ai ? ' ai' : ''));
  card.dataset.index = qi;
  const touched = () => { if (q.ai) { delete q.ai; card.classList.remove('ai'); badge.remove(); } markDirty(); };

  const head = el('div', 'head');
  const title = el('span', '', 'שאלה ' + (qi + 1));
  const badge = el('span', 'badge', 'נוצר ב-AI - לבדוק');
  if (q.ai) title.appendChild(badge);
  const tools = el('span', 'tools');
  const mk = (txt, cls, tip, fn) => { const b = el('button', cls + ' small', txt); b.type = 'button'; b.title = tip; b.onclick = fn; tools.appendChild(b); return b; };
  mk('⬆', 'secondary', 'הזזה למעלה', () => move(qi, -1)).disabled = qi === 0;
  mk('⬇', 'secondary', 'הזזה למטה', () => move(qi, 1)).disabled = qi === quiz.questions.length - 1;
  mk('⧉', 'secondary', 'שכפול', () => { quiz.questions.splice(qi + 1, 0, structuredClone(q)); delete quiz.questions[qi + 1].ai; markDirty(); renderQuestions(); });
  mk('מחיקה', 'danger', 'מחיקת השאלה', () => {
    if (!confirm('למחוק את שאלה ' + (qi + 1) + '?')) return;
    quiz.questions.splice(qi, 1); markDirty(); renderQuestions();
  });
  head.append(title, tools);
  card.appendChild(head);

  const text = el('input'); text.value = q.text; text.placeholder = 'נוסח השאלה'; text.maxLength = 300;
  text.setAttribute('aria-label', 'נוסח שאלה ' + (qi + 1));
  text.oninput = () => { q.text = text.value; touched(); };
  card.appendChild(text);

  card.appendChild(el('label', '', 'תשובות (סמן את הנכונה)'));
  for (let i = 0; i < 4; i++) {
    const row = el('div', 'opt-edit');
    const r = el('input'); r.type = 'radio'; r.name = 'correct-' + qi + '-' + Math.random().toString(36).slice(2, 6); r.checked = q.correct === i; r.title = 'התשובה הנכונה';
    r.setAttribute('aria-label', 'תשובה ' + (i + 1) + ' נכונה');
    r.onchange = () => { q.correct = i; touched(); };
    const inp = el('input'); inp.value = q.options[i] || ''; inp.maxLength = 120;
    inp.placeholder = 'תשובה ' + (i + 1) + (i >= 2 ? ' (לא חובה)' : '');
    inp.oninput = () => { q.options[i] = inp.value; touched(); };
    row.append(r, el('span', 'dot o' + i), inp);
    card.appendChild(row);
  }

  const extra = el('div', 'row');
  const tWrap = el('div', 'shrink'); tWrap.appendChild(el('label', '', 'זמן (שניות)'));
  const t = el('input'); t.type = 'number'; t.min = 5; t.max = 120; t.value = q.time || 20; t.style.width = '110px';
  t.oninput = () => { const v = parseInt(t.value, 10); if (v >= 5 && v <= 120) { q.time = v; touched(); } };
  t.onblur = () => { t.value = q.time; };
  tWrap.appendChild(t);

  const iWrap = el('div'); iWrap.appendChild(el('label', '', 'תמונה (לא חובה)'));
  const imgRow = el('div', 'row');
  const url = el('input'); url.placeholder = 'קישור לתמונה https://...'; url.dir = 'ltr';
  url.value = q.image && !q.image.startsWith('data:') ? q.image : '';
  url.oninput = () => { q.image = url.value.trim(); preview(); touched(); };
  const file = el('input'); file.type = 'file'; file.accept = 'image/*'; file.className = 'hidden';
  const up = el('button', 'secondary shrink small', '📷 העלאה'); up.type = 'button'; up.onclick = () => file.click();
  const rm = el('button', 'danger shrink small', '✕'); rm.type = 'button'; rm.title = 'הסרת התמונה';
  rm.onclick = () => { q.image = ''; url.value = ''; preview(); touched(); };
  file.onchange = async () => {
    const f = file.files[0]; file.value = '';
    if (!f) return;
    up.disabled = true; up.textContent = 'מעבד...';
    try { q.image = await compressImage(f); url.value = ''; preview(); touched(); }
    catch (e) { toast(e.message); }
    finally { up.disabled = false; up.textContent = '📷 העלאה'; }
  };
  imgRow.append(url, up, rm, file);
  const thumb = el('img', 'thumb hidden'); thumb.alt = '';
  thumb.onerror = () => { if (q.image) thumb.classList.add('broken'); };
  thumb.onload = () => thumb.classList.remove('broken');
  function preview() {
    thumb.classList.toggle('hidden', !q.image); rm.classList.toggle('hidden', !q.image);
    if (q.image) thumb.src = q.image; else thumb.removeAttribute('src');
  }
  preview();
  iWrap.append(imgRow, thumb);
  extra.append(tWrap, iWrap);
  card.appendChild(extra);
  return card;
}

function move(i, d) {
  const a = quiz.questions, j = i + d;
  if (j < 0 || j >= a.length) return;
  [a[i], a[j]] = [a[j], a[i]];
  markDirty(); renderQuestions();
}

// כיווץ תמונה בדפדפן לפני השמירה
function compressImage(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('הקובץ אינו תמונה'));
    if (file.size > 25 * 1024 * 1024) return reject(new Error('התמונה גדולה מדי (מעל 25MB)'));
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const LIMIT = 380 * 1024;
      for (const [maxDim, quality] of [[1200, 0.82], [1000, 0.72], [800, 0.65], [640, 0.6], [480, 0.55]]) {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * scale)); c.height = Math.max(1, Math.round(img.height * scale));
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const data = c.toDataURL('image/jpeg', quality);
        if (data.length <= LIMIT) return resolve(data);
      }
      reject(new Error('לא הצלחתי לכווץ את התמונה מספיק'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('הדפדפן לא מצליח לקרוא את התמונה (נסה JPG או PNG)')); };
    img.src = url;
  });
}

$('quiz-select').onchange = e => openQuiz(e.target.value).catch(err => toast(err.message));
$('quiz-title').oninput = e => {
  quiz.title = e.target.value;
  const o = $('quiz-select').selectedOptions[0]; if (o) o.textContent = quiz.title || 'ללא שם';
  markDirty();
};
$('auto-advance').onchange = e => { quiz.autoAdvance = Number(e.target.value); markDirty(); };
$('all-time-apply').onclick = () => {
  const v = parseInt($('all-time').value, 10);
  if (!(v >= 5 && v <= 120)) { toast('הזמן צריך להיות בין 5 ל-120 שניות'); return; }
  if (!quiz.questions.length) return;
  quiz.questions.forEach(q => { q.time = v; });
  markDirty(); renderQuestions();
  toast('כל השאלות עודכנו ל-' + v + ' שניות');
};
$('new-quiz').onclick = async () => {
  try {
    await flushSave();
    const q = await api('POST', '/api/quizzes', { title: 'חידון חדש', questions: [emptyQuestion()] });
    list.unshift({ id: q.id, title: q.title, count: 1 });
    await openQuiz(q.id);
    $('quiz-title').select();
  } catch (e) { toast(e.message); }
};
$('del-quiz').onclick = async () => {
  if (!confirm('למחוק את החידון "' + quiz.title + '" לצמיתות?')) return;
  try {
    clearTimeout(saveTimer); dirty = false;
    if (saving) await saving;
    await api('DELETE', '/api/quizzes/' + encodeURIComponent(quiz.id));
    list = list.filter(q => q.id !== quiz.id);
    await loadQuizList();
    toast('החידון נמחק');
  } catch (e) { toast(e.message); }
};
$('add-q').onclick = () => {
  quiz.questions.push(emptyQuestion()); markDirty(); renderQuestions();
  const items = document.querySelectorAll('.q-item');
  const last = items[items.length - 1];
  last.scrollIntoView({ behavior: 'smooth', block: 'center' });
  last.querySelector('input').focus({ preventScroll: true });
};

$('export').onclick = async () => {
  await flushSave();
  const data = { title: quiz.title, autoAdvance: quiz.autoAdvance || 0, questions: quiz.questions };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  download(blob, safeName(quiz.title || 'quiz') + '.json');
};
$('import').onclick = () => $('import-file').click();
$('import-file').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    let data;
    try { data = JSON.parse(await f.text()); } catch { throw new Error('הקובץ אינו קובץ חידון תקין'); }
    if (!data || !Array.isArray(data.questions)) throw new Error('הקובץ אינו קובץ חידון תקין');
    await flushSave();
    const q = await api('POST', '/api/quizzes', { title: data.title, autoAdvance: data.autoAdvance, questions: data.questions });
    list.unshift({ id: q.id, title: q.title, count: q.questions.length });
    await openQuiz(q.id);
    toast('החידון יובא בהצלחה');
  } catch (err) { toast(err.message, 5000); }
};

function safeName(s) { return String(s).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'file'; }
function download(blob, name) {
  const a = el('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- AI ----------
$('ai-open').onclick = () => {
  $('ai-err').textContent = '';
  $('ai-disabled').classList.toggle('hidden', !!status.ai);
  $('ai-go').disabled = !status.ai;
  $('ai-dialog').showModal();
  $('ai-topic').focus();
};
$('ai-cancel').onclick = () => $('ai-dialog').close();
$('ai-dialog').addEventListener('cancel', e => { if (!$('ai-busy').classList.contains('hidden')) e.preventDefault(); });
$('ai-topic').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('ai-go').click(); } });
$('ai-go').onclick = async () => {
  const topic = $('ai-topic').value.trim();
  if (!topic) { $('ai-err').textContent = 'נא לכתוב נושא'; return; }
  $('ai-err').textContent = '';
  $('ai-busy').classList.remove('hidden'); $('ai-go').disabled = true; $('ai-cancel').disabled = true;
  const t0 = Date.now();
  const busyText = $('ai-busy').querySelector('p');
  const busyInt = setInterval(() => { busyText.textContent = 'יוצר שאלות... ' + Math.round((Date.now() - t0) / 1000) + ' שניות'; }, 500);
  const requested = Number($('ai-count').value);
  try {
    const { questions } = await api('POST', '/api/generate', {
      topic, count: $('ai-count').value, difficulty: $('ai-level').value, notes: $('ai-notes').value,
    });
    const target = document.querySelector('input[name=ai-target]:checked').value;
    if (target === 'new') {
      await flushSave();
      const q = await api('POST', '/api/quizzes', { title: topic.slice(0, 100), questions });
      list.unshift({ id: q.id, title: q.title, count: questions.length });
      await openQuiz(q.id);
    } else {
      // מחליפים שאלה ריקה אחת שנשארה (למשל בחידון חדש)
      quiz.questions = quiz.questions.filter(q => q.text.trim() || q.options.some(o => o.trim()));
      quiz.questions.push(...questions);
      markDirty(); renderQuestions(); await flushSave();
    }
    $('ai-dialog').close();
    toast(questions.length < requested
      ? 'נוספו ' + questions.length + ' שאלות מתוך ' + requested + ' (שירות ה-AI היה עמוס). אפשר ליצור עוד.'
      : 'נוספו ' + questions.length + ' שאלות. כדאי לעבור עליהן לפני המשחק.', 6000);
    const firstNew = document.querySelectorAll('.q-item.ai')[0];
    if (firstNew) firstNew.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    $('ai-err').textContent = e.message;
  } finally {
    clearInterval(busyInt); busyText.textContent = 'יוצר שאלות...';
    $('ai-busy').classList.add('hidden'); $('ai-go').disabled = !status.ai; $('ai-cancel').disabled = false;
  }
};

// ---------- ניהול משחק ----------
let game = null;      // { code, hostKey }
let lastQuestion = null;
let lastResults = null;
let timerInt = null;

function connectSocket() {
  if (socket) return;
  socket = io();
  socket.on('connect', () => {
    $('conn-banner').classList.add('hidden');
    const saved = game || JSON.parse(sessionStorage.getItem('trivia-game') || 'null');
    if (!saved) return;
    socket.emit('host:resume', saved, res => {
      if (res.error) { game = null; sessionStorage.removeItem('trivia-game'); if (view !== 'v-edit') { show('v-edit'); toast('המשחק הקודם כבר לא פעיל'); } return; }
      game = saved;
      renderPlayers(res.players);
      if (res.state === 'lobby') openLobby(res.title, res.code, res.players);
      if (res.question) onQuestion(res.question);
      if (res.reveal) onReveal(res.reveal);
      if (res.state === 'ended') onEnded({ leaderboard: res.leaderboard, results: res.results });
    });
  });
  socket.on('disconnect', () => { if (game) $('conn-banner').classList.remove('hidden'); });
  socket.on('players', renderPlayers);
  socket.on('question', onQuestion);
  socket.on('answered', a => { $('q-answered').textContent = a.answered; $('q-total').textContent = a.playerCount; });
  socket.on('reveal', onReveal);
  socket.on('auto', a => onAuto(a));
  socket.on('ended', onEnded);
}

$('start').onclick = async () => {
  $('edit-err').textContent = '';
  const ok = await flushSave();
  if (!ok) { $('edit-err').textContent = 'השמירה נכשלה, אי אפשר לפתוח משחק. בדוק את החיבור.'; return; }
  if (!socket || !socket.connected) { $('edit-err').textContent = 'אין חיבור לשרת. נסה שוב בעוד רגע.'; return; }
  const hostKey = crypto.getRandomValues(new Uint32Array(4)).join('-');
  $('start').disabled = true;
  socket.timeout(10000).emit('host:create', { quizId: quiz.id, hostKey }, (err, res) => {
    $('start').disabled = false;
    if (err) { $('edit-err').textContent = 'השרת לא ענה. נסה שוב.'; return; }
    if (res.error) {
      $('edit-err').textContent = res.error;
      if (res.index != null) {
        const c = document.querySelector('.q-item[data-index="' + res.index + '"]');
        if (c) { c.scrollIntoView({ behavior: 'smooth', block: 'center' }); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 2000); }
      }
      return;
    }
    game = { code: res.code, hostKey };
    sessionStorage.setItem('trivia-game', JSON.stringify(game));
    lastResults = null;
    openLobby(res.title, res.code, []);
  });
};

function openLobby(title, code, players) {
  $('toast').classList.add('hidden');
  $('lobby-title').textContent = title;
  $('lobby-code').textContent = code;
  $('join-url').textContent = location.host + '/play';
  $('lobby-qr').src = '/api/qr?code=' + code;
  renderPlayers(players);
  show('v-lobby');
}

function renderPlayers(players) {
  $('lobby-count').textContent = players.length;
  const box = $('lobby-players');
  box.innerHTML = '';
  for (const p of players) {
    const c = el('button', 'chip' + (p.online ? '' : ' off'), p.name);
    c.type = 'button'; c.title = 'הוצאה מהמשחק';
    c.onclick = () => { if (confirm('להוציא את ' + p.name + ' מהמשחק?')) socket.emit('host:kick', { name: p.name }); };
    box.appendChild(c);
  }
}

function backToEditor() {
  game = null; sessionStorage.removeItem('trivia-game');
  clearInterval(timerInt); clearInterval(autoInt);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  show('v-edit');
}
$('lobby-cancel').onclick = () => { if (game) socket.emit('host:close'); backToEditor(); };
$('end-back').onclick = backToEditor;
$('lobby-start').onclick = () => {
  if ($('lobby-count').textContent === '0' && !confirm('אין עדיין משתתפים. להתחיל בכל זאת?')) return;
  socket.emit('host:next');
};
$('q-skip').onclick = () => socket.emit('host:reveal');
$('rev-next').onclick = () => socket.emit('host:next');
$('rev-end').onclick = () => { if (confirm('לסיים את המשחק עכשיו ולהציג את המנצחים?')) socket.emit('host:end'); };

function renderOpts(box, options, correct) {
  box.innerHTML = '';
  options.forEach((o, i) => {
    if (!o.trim()) return;
    const d = el('div', 'opt o' + i + (correct === undefined ? '' : i === correct ? ' right' : ' dim'));
    d.append(el('span', 'shape', SHAPES[i]), el('span', '', o));
    box.appendChild(d);
  });
}

function onQuestion(q) {
  clearInterval(autoInt);
  lastQuestion = q;
  show('v-q');
  $('q-num').textContent = 'שאלה ' + (q.index + 1) + ' / ' + q.total;
  $('q-text').textContent = q.text;
  $('q-answered').textContent = q.answered || 0;
  $('q-total').textContent = q.playerCount;
  const img = $('q-img');
  if (q.image) { img.src = q.image; img.classList.remove('hidden'); } else { img.removeAttribute('src'); img.classList.add('hidden'); }
  renderOpts($('q-opts'), q.options);
  const end = Date.now() + q.remainingMs;
  clearInterval(timerInt);
  const tick = () => {
    const s = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    $('q-timer').textContent = s;
    $('q-timer').classList.toggle('low', s <= 5);
  };
  tick(); timerInt = setInterval(tick, 200);
}

function onReveal(r) {
  clearInterval(timerInt);
  const q = lastQuestion;
  if (!q) return;
  show('v-rev');
  $('rev-text').textContent = q.text;
  const max = Math.max(1, ...r.counts);
  const bars = $('rev-bars'); bars.innerHTML = '';
  r.counts.forEach((c, i) => {
    if (!q.options[i].trim()) return;
    const b = el('div', 'bar o' + i, (i === r.correct ? '✔ ' : '') + c);
    b.style.height = Math.max(18, (c / max) * 100) + '%';
    bars.appendChild(b);
  });
  renderOpts($('rev-opts'), q.options, r.correct);
  const board = $('rev-board'); board.innerHTML = '';
  r.leaderboard.forEach((p, i) => {
    const li = el('li');
    li.append(el('span', '', (i + 1) + '. ' + p.name), el('span', '', p.score));
    board.appendChild(li);
  });
  $('rev-next').textContent = r.isLast ? '🏆 לתוצאות הסופיות' : 'הבא ⬅️';
  $('rev-end').classList.toggle('hidden', r.isLast);
  onAuto(r.auto, r.isLast);
}

// ספירה לאחור של המעבר האוטומטי
let autoInt = null, autoIsLast = false;
function onAuto(a, isLast) {
  if (isLast !== undefined) autoIsLast = isLast;
  clearInterval(autoInt);
  const box = $('auto-box');
  if (!a) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.classList.toggle('paused', a.paused);
  $('auto-toggle').textContent = a.paused ? '▶️ המשך מעבר אוטומטי' : '⏸ עצירה';
  $('auto-toggle').onclick = () => socket.emit('host:auto', { paused: !a.paused });
  const where = autoIsLast ? 'התוצאות הסופיות' : 'השאלה הבאה';
  if (a.paused || a.remainingMs == null) { $('auto-text').textContent = '⏸ המעבר האוטומטי מושהה'; return; }
  const end = Date.now() + a.remainingMs;
  const tick = () => { $('auto-text').textContent = '⏭️ ' + where + ' בעוד ' + Math.max(0, Math.ceil((end - Date.now()) / 1000)) + ' שניות'; };
  tick(); autoInt = setInterval(tick, 250);
}

function onEnded(r) {
  clearInterval(timerInt); clearInterval(autoInt);
  if (!game) return;
  lastResults = r.results;
  show('v-end');
  const top = r.leaderboard;
  const pod = $('podium'); pod.innerHTML = '';
  if (!top.length) pod.appendChild(el('p', '', 'לא היו משתתפים'));
  [[1, 'p2', '🥈'], [0, 'p1', '🥇'], [2, 'p3', '🥉']].forEach(([idx, cls, medal]) => {
    if (!top[idx]) return;
    const d = el('div', cls);
    d.append(el('span', 'medal', medal), el('span', 'pname', top[idx].name), el('span', '', top[idx].score));
    pod.appendChild(d);
  });
  const board = $('end-board'); board.innerHTML = '';
  top.slice(3, 10).forEach((p, i) => {
    const li = el('li');
    li.append(el('span', '', (i + 4) + '. ' + p.name), el('span', '', p.score));
    board.appendChild(li);
  });
  $('end-csv').classList.toggle('hidden', !lastResults || !lastResults.players.length);
}

$('end-csv').onclick = () => {
  const r = lastResults; if (!r) return;
  const esc = v => { let s = String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const mark = { right: '✓', wrong: '✗', none: 'לא ענה', skip: '' };
  const rows = [['מקום', 'שם', 'ניקוד', 'תשובות נכונות', ...r.questions.map((q, i) => (i + 1) + '. ' + q.text)]];
  for (const p of r.players) rows.push([p.rank, p.name, p.score, p.answers.filter(a => a === 'right').length, ...p.answers.map(a => mark[a])]);
  rows.push([]);
  rows.push(['', '', '', 'התשובה הנכונה:', ...r.questions.map(q => q.correct)]);
  const csv = '﻿' + rows.map(row => row.map(esc).join(',')).join('\r\n');
  const date = new Date().toISOString().slice(0, 10);
  download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), safeName(r.title) + ' - תוצאות ' + date + '.csv');
};

// מסך מלא ושלט/מקלדת
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}
document.querySelectorAll('.fs-btn').forEach(b => b.onclick = toggleFullscreen);
document.addEventListener('keydown', e => {
  if (!['v-lobby', 'v-q', 'v-rev'].includes(view)) return;
  if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target.tagName) || $('ai-dialog').open) return;
  if (e.key === 'f' || e.key === 'F' || e.key === 'כ') { toggleFullscreen(); return; }
  if ((e.key === 'p' || e.key === 'P' || e.key === 'פ') && view === 'v-rev' && !$('auto-box').classList.contains('hidden')) { $('auto-toggle').click(); return; }
  if (![' ', 'Enter', 'PageDown', 'ArrowLeft'].includes(e.key)) return;
  e.preventDefault();
  if (view === 'v-lobby') $('lobby-start').click();
  else if (view === 'v-q') $('q-skip').click();
  else if (view === 'v-rev') $('rev-next').click();
});

boot();
