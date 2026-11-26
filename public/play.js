// צד השחקן
const socket = io();
const $ = id => document.getElementById(id);
const SHAPES = ['▲', '◆', '●', '■'];

function getKey() {
  let k = localStorage.getItem('trivia-player-key');
  if (!k) { k = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('trivia-player-key', k); }
  return k;
}
const playerKey = getKey();

// מונע כיבוי מסך בזמן המשחק
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && joined) keepAwake(); });
let joined = null; // { code, name }
let timerInt = null;

function show(view) {
  for (const v of ['v-join', 'v-wait', 'v-q', 'v-res']) $(v).classList.toggle('hidden', v !== view);
}

// קוד מתוך הכתובת, למשל /play?code=1234
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) $('code').value = urlCode;
$('name').value = localStorage.getItem('trivia-name') || '';

function join(code, name) {
  socket.emit('player:join', { code, name, playerKey }, res => {
    if (res.error) {
      $('join-err').textContent = res.error;
      sessionStorage.removeItem('trivia-joined');
      show('v-join');
      return;
    }
    joined = { code, name: res.name };
    sessionStorage.setItem('trivia-joined', JSON.stringify(joined));
    localStorage.setItem('trivia-name', res.name);
    $('wait-title').textContent = 'שלום ' + res.name + '!';
    keepAwake();
    if (res.state === 'lobby' || !$('v-join').classList.contains('hidden')) show('v-wait');
  });
}

$('join-btn').onclick = () => {
  $('join-err').textContent = '';
  const code = $('code').value.trim(), name = $('name').value.trim();
  if (!/^\d{4}$/.test(code)) return $('join-err').textContent = 'הקוד צריך להיות 4 ספרות';
  if (!name) return $('join-err').textContent = 'נא להזין שם';
  $('join-btn').disabled = true;
  join(code, name);
  setTimeout(() => { $('join-btn').disabled = false; }, 1500);
};
$('name').addEventListener('keydown', e => { if (e.key === 'Enter') $('join-btn').click(); });

// חיבור מחדש אוטומטי (רענון דף / ניתוק רשת)
socket.on('disconnect', () => { if (joined) $('conn').classList.remove('hidden'); });
socket.on('connect', () => {
  $('conn').classList.add('hidden');
  const saved = joined || JSON.parse(sessionStorage.getItem('trivia-joined') || 'null');
  if (saved) join(saved.code, saved.name);
});

socket.on('question', q => {
  show('v-q');
  $('q-num').textContent = 'שאלה ' + (q.index + 1) + ' מתוך ' + q.total;
  $('q-text').textContent = q.text;
  const box = $('q-opts');
  box.innerHTML = '';
  q.options.forEach((o, i) => {
    if (!o.trim()) return;
    const b = document.createElement('button');
    b.className = 'opt o' + i;
    b.innerHTML = '<span class="shape">' + SHAPES[i] + '</span><span></span>';
    b.lastChild.textContent = o;
    b.onclick = () => {
      if (b.disabled) return;
      box.querySelectorAll('button').forEach(x => { x.disabled = true; x.classList.toggle('dim', x !== b); });
      socket.emit('player:answer', { choice: i });
      if (navigator.vibrate) navigator.vibrate(40);
    };
    box.appendChild(b);
  });
  const end = Date.now() + q.remainingMs;
  clearInterval(timerInt);
  const tick = () => { $('q-time').textContent = '⏱ ' + Math.max(0, Math.ceil((end - Date.now()) / 1000)); };
  tick();
  timerInt = setInterval(tick, 250);
});

socket.on('answered', () => {
  clearInterval(timerInt);
  show('v-res');
  $('res-icon').textContent = '✅';
  $('res-title').textContent = 'התשובה נקלטה';
  $('res-sub').textContent = 'מחכים לשאר המשתתפים...';
});

socket.on('result', r => {
  clearInterval(timerInt);
  show('v-res');
  if (!r.answered) {
    $('res-icon').textContent = '⌛';
    $('res-title').textContent = 'לא הספקת לענות';
  } else if (r.correct) {
    $('res-icon').textContent = '🎉';
    $('res-title').textContent = 'נכון! +' + r.points;
  } else {
    $('res-icon').textContent = '❌';
    $('res-title').textContent = 'לא נכון';
  }
  $('res-sub').innerHTML = '';
  const lines = [];
  if (!r.correct) lines.push('התשובה הנכונה: ' + r.correctText);
  lines.push('הניקוד שלך: ' + r.score);
  lines.push('מקום ' + r.rank + ' מתוך ' + r.total);
  lines.forEach(t => { const d = document.createElement('div'); d.textContent = t; d.style.marginTop = '6px'; $('res-sub').appendChild(d); });
});

socket.on('ended', r => {
  clearInterval(timerInt);
  show('v-res');
  $('res-icon').textContent = r.rank === 1 ? '🏆' : r.rank <= 3 ? '🥇' : '🏁';
  $('res-title').textContent = 'המשחק הסתיים!';
  $('res-sub').textContent = 'סיימת במקום ' + r.rank + ' מתוך ' + r.total + ' עם ' + r.score + ' נקודות';
  sessionStorage.removeItem('trivia-joined');
  joined = null;
});

socket.on('kicked', () => {
  sessionStorage.removeItem('trivia-joined');
  joined = null;
  show('v-join');
  $('join-err').textContent = 'הוצאת מהמשחק על ידי המנחה';
});

socket.on('replaced', () => {
  joined = null;
  show('v-res');
  $('res-icon').textContent = '📱';
  $('res-title').textContent = 'המשחק נפתח בחלון אחר';
  $('res-sub').textContent = 'אפשר לסגור את החלון הזה';
});
