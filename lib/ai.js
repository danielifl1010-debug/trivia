// יצירת שאלות טריוויה עם Gemini
const DEFAULT_MODELS = ['gemini-3.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest'];

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
  let raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let arr;
  try { arr = JSON.parse(raw); } catch { throw new AIError('ה-AI החזיר תשובה לא תקינה. נסה שוב.'); }
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

function buildPrompt({ topic, count, difficulty, notes }) {
  let p = `כתוב ${count} שאלות טריוויה בנושא: ${topic}\nרמת קושי: ${LEVELS[difficulty] || LEVELS.medium}`;
  if (notes) p += `\nהנחיות נוספות: ${notes}`;
  return p;
}

async function generateQuestions(opts, env = process.env, fetchImpl = fetch) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new AIError('יצירה ב-AI לא מוגדרת: חסר מפתח GEMINI_API_KEY בהגדרות השרת.', 503);
  const topic = String(opts.topic || '').trim().slice(0, 200);
  if (!topic) throw new AIError('נא לכתוב נושא', 400);
  const count = Math.min(20, Math.max(1, Number.parseInt(opts.count, 10) || 10));
  const difficulty = LEVELS[opts.difficulty] ? opts.difficulty : 'medium';
  const notes = String(opts.notes || '').trim().slice(0, 300);
  const time = difficulty === 'hard' ? 30 : 20;

  const base = (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const models = env.GEMINI_MODEL ? [env.GEMINI_MODEL, ...DEFAULT_MODELS.filter(m => m !== env.GEMINI_MODEL)] : DEFAULT_MODELS;
  const makeBody = withThinking => {
    const generationConfig = { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.7 };
    // זמן "חשיבה" קצר = תשובה מהירה הרבה יותר. מודל שלא תומך בזה - ננסה שוב בלי
    if (withThinking) generationConfig.thinkingConfig = { thinkingBudget: 512 };
    return JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: buildPrompt({ topic, count, difficulty, notes }) }] }],
      generationConfig,
    });
  };
  const deadline = Date.now() + (Number(env.GEMINI_TIMEOUT_MS) || 90000);
  const log = env.__log || console;

  let lastErr;
  for (const model of models) {
    let thinking = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - Date.now();
      if (left <= 0) throw new AIError('ה-AI לא ענה בזמן. נסה שוב, אולי עם פחות שאלות.', 504);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), left);
      let res, json;
      try {
        res = await fetchImpl(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: makeBody(thinking), signal: ctrl.signal,
        });
        json = await res.json().catch(() => null);
      } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') throw new AIError('ה-AI לא ענה בזמן. נסה שוב, אולי עם פחות שאלות.', 504);
        lastErr = new AIError('אין חיבור לשירות ה-AI. נסה שוב בעוד רגע.');
        break; // מודל הבא
      }
      clearTimeout(timer);
      const detail = JSON.stringify((json && json.error) || '').slice(0, 300);
      if (!res.ok) log.error(`Gemini ${model} -> ${res.status} ${detail}`);
      if (res.status === 400 && thinking && /thinking/i.test(detail)) { thinking = false; attempt--; continue; }
      if (res.status === 404) { lastErr = new AIError('מודל ה-AI לא נמצא (' + model + ')'); break; }
      if (res.status === 429) throw new AIError('הגעת למכסת השימוש החינמית של Gemini. נסה שוב בעוד דקה.', 429);
      if (res.status === 400 && /api key/i.test(detail)) throw new AIError('מפתח GEMINI_API_KEY לא תקין.', 502);
      if (res.status === 401 || res.status === 403) throw new AIError('מפתח GEMINI_API_KEY לא תקין או חסום.', 502);
      if (res.status >= 500) {
        // עומס זמני אצל Google - ניסיון נוסף קצר, ואז מודל אחר
        lastErr = new AIError('שירות ה-AI של Google עמוס כרגע. נסה שוב בעוד דקה.', 503);
        if (attempt === 0) { await new Promise(r => setTimeout(r, 1500)); continue; }
        break;
      }
      if (!res.ok) throw new AIError('שגיאה בשירות ה-AI (' + res.status + '). נסה שוב.');
      const parts = json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts;
      const text = Array.isArray(parts) ? parts.filter(p => !p.thought).map(p => p.text || '').join('') : '';
      if (!text) throw new AIError('ה-AI לא החזיר שאלות על הנושא הזה. נסה לנסח אותו אחרת.');
      return parseQuestions(text, { time }).slice(0, count);
    }
  }
  throw lastErr || new AIError('שירות ה-AI לא זמין');
}

module.exports = { generateQuestions, parseQuestions, buildPrompt, AIError, SYSTEM };
