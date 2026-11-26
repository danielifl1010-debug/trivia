// יצירת שאלות טריוויה עם Gemini
// סדר הניסיון: מודלים מהירים ויציבים קודם. לכל מודל מכסה חינמית נפרדת
// Groq: שירות חינמי נוסף (ללא כרטיס אשראי), מהיר מאוד
const GROQ_MODELS = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'];
// OpenRouter: נתב המודלים החינמיים (בוחר מודל חינמי זמין לבד)
const OPENROUTER_MODELS = ['openrouter/free'];
const DEFAULT_MODELS = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'];

const SYSTEM = `אתה כותב שאלות טריוויה בעברית למשחק אינטראקטיבי באירועים.
כללים:
- תוכן נקי ומכובד, מתאים למשפחות ולקהל שומר תורה ומצוות.
- כתוב רק עובדות שאתה בטוח בהן לחלוטין. אם אינך בטוח בעובדה, אל תכתוב עליה שאלה.
- לכל שאלה תשובה נכונה אחת בלבד, חד-משמעית.
- 4 תשובות קצרות (עד 60 תווים), שונות זו מזו, והשגויות סבירות ומבלבלות.
- בלי "כל התשובות נכונות" ובלי "אף תשובה".
- השאלה עד 150 תווים, ברורה וקצרה.
- correct_index הוא המיקום (0-3) של התשובה הנכונה במערך options.`;

const LEVELS = { easy: 'קל - מתאים לכולם, גם לילדים', medium: 'בינוני', hard: 'קשה - למביני עניין' };

const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      question: { type: 'STRING' },
      options: { type: 'ARRAY', items: { type: 'STRING' } },
      correct_index: { type: 'INTEGER' },
    },
    required: ['question', 'options', 'correct_index'],
  },
};

class AIError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

function shuffle(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// הופך את תשובת המודל לשאלות תקינות; מסנן שאלות פגומות
function parseQuestions(text, { time = 20, rand } = {}) {
  let raw = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let arr;
  try { arr = JSON.parse(raw); } catch {
    // מודלים מסוימים מוסיפים טקסט לפני/אחרי ה-JSON - מחלצים את החלק שבין הסוגריים
    const starts = [raw.indexOf('{'), raw.indexOf('[')].filter(i => i >= 0);
    const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
    try { arr = JSON.parse(raw.slice(Math.min(...starts), end + 1)); } catch { throw new AIError('ה-AI החזיר תשובה לא תקינה. נסה שוב.'); }
  }
  if (arr && !Array.isArray(arr) && Array.isArray(arr.questions)) arr = arr.questions;
  if (!Array.isArray(arr)) throw new AIError('ה-AI החזיר תשובה לא תקינה. נסה שוב.');
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const question = String(item.question || '').trim().slice(0, 300);
    const options = Array.isArray(item.options) ? item.options.map(o => String(o == null ? '' : o).trim().slice(0, 120)) : [];
    const ci = Number(item.correct_index);
    if (!question || options.length !== 4 || options.some(o => !o)) continue;
    if (new Set(options).size !== 4) continue;
    if (!Number.isInteger(ci) || ci < 0 || ci > 3) continue;
    if (seen.has(question)) continue;
    seen.add(question);
    const right = options[ci];
    const mixed = shuffle(options, rand);
    out.push({ text: question, options: mixed, correct: mixed.indexOf(right), time, image: '', ai: true });
  }
  if (!out.length) throw new AIError('ה-AI לא החזיר שאלות שמישות. נסה לנסח את הנושא אחרת.');
  return out;
}

// כל חבילה מקבלת זווית אחרת, כדי שהשאלות בין החבילות לא יחזרו על עצמן
const ANGLES = ['עובדות מרכזיות', 'אנשים, מקומות ושמות', 'מספרים, תאריכים וסדר אירועים', 'פרטים מעניינים ופחות מוכרים'];

function buildPrompt({ topic, count, difficulty, notes, angle }) {
  let p = `כתוב ${count} שאלות טריוויה בנושא: ${topic}\nרמת קושי: ${LEVELS[difficulty] || LEVELS.medium}`;
  if (angle) p += `\nהתמקד ב: ${angle}`;
  if (notes) p += `\nהנחיות נוספות: ${notes}`;
  return p;
}

const BATCH = 5;             // שאלות לכל בקשה
const ATTEMPT_MS = 25000;    // זמן מקסימלי לניסיון אחד מול מודל
const TOTAL_MS = 70000;      // זמן מקסימלי לכל היצירה

// סדר העדפה בין סוגי שגיאות כשהכול נכשל (המידע הכי שימושי למשתמש)
const ERR_RANK = { auth: 5, quota: 4, overload: 3, timeout: 2, network: 1, notfound: 0.5, bad: 0 };
const ERR_MSG = {
  auth: ['מפתח ה-AI לא תקין או חסום. בדוק את המפתחות בהגדרות השרת.', 502],
  quota: ['הגעת למכסת השימוש החינמית של Gemini. נסה שוב בעוד כמה דקות.', 429],
  overload: ['שירות ה-AI של Google עמוס כרגע. נסה שוב בעוד דקה.', 503],
  timeout: ['ה-AI לא ענה בזמן. נסה שוב, אולי עם פחות שאלות.', 504],
  network: ['אין חיבור לשירות ה-AI. נסה שוב בעוד רגע.', 502],
  notfound: ['מודלי ה-AI לא נמצאו. בדוק את הגדרות המודלים בשרת.', 502],
  bad: ['ה-AI לא החזיר שאלות שמישות. נסה לנסח את הנושא אחרת.', 502],
};

async function generateQuestions(opts, env = process.env, fetchImpl = fetch) {
  if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY && !env.OPENROUTER_API_KEY) throw new AIError('יצירה ב-AI לא מוגדרת: חסר מפתח (GEMINI_API_KEY, GROQ_API_KEY או OPENROUTER_API_KEY) בהגדרות השרת.', 503);
  const topic = String(opts.topic || '').trim().slice(0, 200);
  if (!topic) throw new AIError('נא לכתוב נושא', 400);
  const count = Math.min(20, Math.max(1, Number.parseInt(opts.count, 10) || 10));
  const difficulty = LEVELS[opts.difficulty] ? opts.difficulty : 'medium';
  const notes = String(opts.notes || '').trim().slice(0, 300);
  const time = difficulty === 'hard' ? 30 : 20;
  const log = env.__log || console;
  const attemptMs = Number(env.GEMINI_ATTEMPT_MS) || ATTEMPT_MS;
  const deadline = Date.now() + (Number(env.GEMINI_TIMEOUT_MS) || TOTAL_MS);

  // כל ספק עם רשימת המודלים שלו. בסדר משולב: מודל מכל ספק בתורו, כך הגיבוי מגיע מהר
  const lists = {};
  const withPref = (pref, list) => pref ? [pref, ...list.filter(m => m !== pref)] : list;
  if (env.GEMINI_API_KEY) lists.gemini = withPref(env.GEMINI_MODEL, DEFAULT_MODELS);
  if (env.GROQ_API_KEY) lists.groq = withPref(env.GROQ_MODEL, GROQ_MODELS);
  if (env.OPENROUTER_API_KEY) lists.openrouter = withPref(env.OPENROUTER_MODEL, OPENROUTER_MODELS);
  const order = ['gemini', 'groq', 'openrouter'].filter(p => lists[p]);
  if (env.AI_PREFER && lists[env.AI_PREFER]) order.unshift(...order.splice(order.indexOf(env.AI_PREFER), 1));
  const candidates = [];
  for (let i = 0; i < Math.max(...order.map(p => lists[p].length)); i++) {
    for (const p of order) if (lists[p][i]) candidates.push({ provider: p, model: lists[p][i] });
  }

  const dead = new Set();          // "provider:model" שנפסלו בבקשה הזו
  const deadProviders = new Set(); // ספק שהמפתח שלו לא תקין
  const noThinking = new Set();

  async function post(url, headers, body) {
    const left = deadline - Date.now();
    if (left <= 0) return { err: 'timeout' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(attemptMs, left));
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
      const json = await res.json().catch(() => null);
      return { res, json };
    } catch (e) {
      return { err: e.name === 'AbortError' ? 'timeout' : 'network' };
    } finally { clearTimeout(timer); }
  }

  function classify(c, res, json) {
    const detail = JSON.stringify((json && json.error) || '').slice(0, 300);
    if (!res.ok) log.error(`${c.provider} ${c.model} -> ${res.status} ${detail}`);
    if (res.status === 400 && /thinking|reasoning/i.test(detail) && !noThinking.has(c.model)) { noThinking.add(c.model); return 'retry-same'; }
    if (res.status === 404 || /model_not_found|decommissioned|does not exist/i.test(detail)) return 'notfound';
    if (res.status === 429 || res.status === 402) return 'quota';
    if (res.status === 401 || res.status === 403 || (res.status === 400 && /api.?key/i.test(detail))) return 'auth';
    if (res.status >= 500) return 'overload';
    if (!res.ok) return 'bad';
    return null;
  }

  async function callGemini(c, prompt) {
    const base = (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
    const generationConfig = { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.7 };
    if (!noThinking.has(c.model)) generationConfig.thinkingConfig = { thinkingBudget: 512 };
    const r = await post(`${base}/v1beta/models/${encodeURIComponent(c.model)}:generateContent`, { 'x-goog-api-key': env.GEMINI_API_KEY },
      { systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig });
    if (r.err) return r;
    const err = classify(c, r.res, r.json);
    if (err) return { err };
    const parts = r.json && r.json.candidates && r.json.candidates[0] && r.json.candidates[0].content && r.json.candidates[0].content.parts;
    return { text: Array.isArray(parts) ? parts.filter(p => !p.thought).map(p => p.text || '').join('') : '' };
  }

  // Groq ו-OpenRouter מדברים באותו פורמט (תואם OpenAI)
  const COMPAT = {
    groq: { base: env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1', key: env.GROQ_API_KEY, jsonMode: true },
    // ב-OpenRouter המודל החינמי נבחר אקראית, ולא כולם תומכים במצב JSON - לכן מבקשים JSON בהנחיה בלבד
    openrouter: { base: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1', key: env.OPENROUTER_API_KEY, jsonMode: false, headers: { 'X-Title': 'Trivia Game' } },
  };
  async function callCompat(c, prompt) {
    const cfg = COMPAT[c.provider];
    const body = {
      model: c.model,
      messages: [
        { role: 'system', content: SYSTEM + '\nהחזר JSON בלבד, בלי שום טקסט נוסף, במבנה: {"questions":[{"question":"...","options":["...","...","...","..."],"correct_index":0}]}' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7, max_tokens: 4000,
    };
    if (cfg.jsonMode) body.response_format = { type: 'json_object' };
    if (c.provider === 'groq' && /gpt-oss/.test(c.model) && !noThinking.has(c.model)) body.reasoning_effort = 'low';
    const r = await post(`${cfg.base.replace(/\/$/, '')}/chat/completions`, { Authorization: 'Bearer ' + cfg.key, ...(cfg.headers || {}) }, body);
    if (r.err) return r;
    // OpenRouter לפעמים מחזיר 200 עם שגיאה בגוף התשובה
    if (r.res.ok && r.json && r.json.error && !r.json.choices) {
      const code = Number(r.json.error.code) || 502;
      return { err: classify(c, { ok: false, status: code }, r.json) || 'bad' };
    }
    const err = classify(c, r.res, r.json);
    if (err) return { err };
    const msg = r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message;
    return { text: (msg && msg.content) || '' };
  }

  async function callOnce(c, prompt) {
    const r = c.provider === 'gemini' ? await callGemini(c, prompt) : await callCompat(c, prompt);
    if (r.err) return r;
    try { return { questions: parseQuestions(r.text, { time }) }; } catch { return { err: 'bad' }; }
  }

  // חבילה אחת: עוברת בין כל המודלים של כל הספקים עד שאחד מצליח
  async function runBatch(n, angle) {
    const prompt = buildPrompt({ topic, count: n, difficulty, notes, angle });
    let worst = 'bad';
    const note = e => { if (ERR_RANK[e] > ERR_RANK[worst]) worst = e; };
    for (let round = 0; round < 2; round++) {
      const slow = new Set(); // ספק שלא ענה בזמן - מדלגים עליו עד סוף הסבב
      const others = c => candidates.some(o => o.provider !== c.provider && !deadProviders.has(o.provider) && !dead.has(o.provider + ':' + o.model) && !slow.has(o.provider));
      for (const c of candidates) {
        const key = c.provider + ':' + c.model;
        if (dead.has(key) || deadProviders.has(c.provider)) continue;
        if (slow.has(c.provider) && others(c)) continue;
        let r = await callOnce(c, prompt);
        if (r.err === 'retry-same') r = await callOnce(c, prompt);
        if (r.questions) return r.questions;
        note(r.err);
        if (r.err === 'auth') deadProviders.add(c.provider);
        if (r.err === 'notfound' || r.err === 'quota') dead.add(key);
        if (r.err === 'timeout') slow.add(c.provider);
        if (Date.now() >= deadline) throw worst;
      }
      if (candidates.every(c => dead.has(c.provider + ':' + c.model) || deadProviders.has(c.provider))) break;
      if (round === 0) await new Promise(r => setTimeout(r, 1000));
    }
    throw worst;
  }

  const sizes = [];
  for (let left = count; left > 0; left -= BATCH) sizes.push(Math.min(BATCH, left));
  const results = await Promise.allSettled(sizes.map((n, i) => runBatch(n, sizes.length > 1 ? ANGLES[i % ANGLES.length] : '')));

  const out = [];
  const seen = new Set();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const q of r.value) {
      const key = q.text.replace(/\s+/g, ' ').trim();
      if (seen.has(key)) continue;
      seen.add(key); out.push(q);
    }
  }
  if (out.length) return out.slice(0, count);

  let worst = 'bad';
  for (const r of results) {
    const e = typeof r.reason === 'string' ? r.reason : 'network';
    if (r.reason && typeof r.reason !== 'string') log.error(r.reason);
    if (ERR_RANK[e] > ERR_RANK[worst]) worst = e;
  }
  throw new AIError(...ERR_MSG[worst]);
}

module.exports = { generateQuestions, parseQuestions, buildPrompt, AIError, SYSTEM };
