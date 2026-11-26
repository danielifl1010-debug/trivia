// בדיקות יחידה: ניקוי נתונים, AI, שמירה
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanImage, cleanQuiz, gameQuestions, MAX_QUESTIONS } = require('../lib/validate');
const { parseQuestions, generateQuestions } = require('../lib/ai');
const { fileStore, mongoStore } = require('../lib/store');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-'));

// ---------- validate ----------
test('cleanImage: accepts safe images, rejects everything else', () => {
  assert.equal(cleanImage('https://example.com/a.jpg'), 'https://example.com/a.jpg');
  assert.equal(cleanImage('data:image/jpeg;base64,AAAA'), 'data:image/jpeg;base64,AAAA');
  assert.equal(cleanImage('javascript:alert(1)'), '');
  assert.equal(cleanImage('data:text/html;base64,AAAA'), '');
  assert.equal(cleanImage('data:image/svg+xml;base64,AAAA'), '');
  assert.equal(cleanImage('https://x.com/a"onerror="x'), '');
  assert.equal(cleanImage('data:image/png;base64,' + 'A'.repeat(500 * 1024)), '');
  assert.equal(cleanImage(null), '');
});

test('cleanQuiz: normalizes and caps everything', () => {
  const q = cleanQuiz({ title: '   ', questions: Array(150).fill({ text: 'x'.repeat(999), options: ['a'], correct: 9, time: 9999 }) });
  assert.equal(q.title, 'חידון ללא שם');
  assert.equal(q.questions.length, MAX_QUESTIONS);
  assert.equal(q.questions[0].text.length, 300);
  assert.deepEqual(q.questions[0].options, ['a', '', '', '']);
  assert.equal(q.questions[0].correct, 0);
  assert.equal(q.questions[0].time, 120);
  assert.deepEqual(cleanQuiz('garbage').questions, []);
  assert.deepEqual(cleanQuiz({ questions: [null, 5, 'x'] }).questions.length, 3);
});

test('gameQuestions: reports first broken question', () => {
  const ok = { text: 'q', options: ['a', 'b', '', ''], correct: 1 };
  assert.ok(gameQuestions({ questions: [ok] }).questions);
  assert.match(gameQuestions({ questions: [] }).error, /אין שאלות/);
  let r = gameQuestions({ questions: [ok, { ...ok, text: ' ' }] });
  assert.equal(r.index, 1); assert.match(r.error, /שאלה 2/);
  r = gameQuestions({ questions: [{ ...ok, options: ['a', '', '', ''] }] });
  assert.match(r.error, /לפחות 2/);
  r = gameQuestions({ questions: [{ ...ok, correct: 3 }] });
  assert.match(r.error, /ריקה/);
});

// ---------- AI ----------
const good = [
  { question: 'ש1', options: ['נכון', 'ב', 'ג', 'ד'], correct_index: 0 },
  { question: 'ש2', options: ['א', 'ב', 'נכון', 'ד'], correct_index: 2 },
];

test('parseQuestions: keeps correct answer after shuffling', () => {
  for (let i = 0; i < 30; i++) {
    const qs = parseQuestions(JSON.stringify(good));
    assert.equal(qs.length, 2);
    for (const q of qs) { assert.equal(q.options[q.correct], 'נכון'); assert.equal(q.ai, true); assert.equal(q.options.length, 4); }
  }
});

test('parseQuestions: filters malformed items, handles fences and wrappers', () => {
  const mixed = [...good,
    { question: '', options: ['a', 'b', 'c', 'd'], correct_index: 0 },
    { question: 'x', options: ['a', 'b', 'c'], correct_index: 0 },
    { question: 'y', options: ['a', 'a', 'c', 'd'], correct_index: 0 },
    { question: 'z', options: ['a', 'b', 'c', 'd'], correct_index: 7 },
    { question: 'ש1', options: ['a', 'b', 'c', 'd'], correct_index: 0 }, // כפילות
    null, 'str'];
  assert.equal(parseQuestions('```json\n' + JSON.stringify(mixed) + '\n```').length, 2);
  assert.equal(parseQuestions(JSON.stringify({ questions: good })).length, 2);
  assert.throws(() => parseQuestions('not json'), /לא תקינה/);
  assert.throws(() => parseQuestions('[]'), /שמישות/);
  assert.throws(() => parseQuestions('{"a":1}'), /לא תקינה/);
});

// שרת Gemini מדומה: handler מקבל (model, body, callIndex) ומחזיר {status, body} / Error / 'hang'
function mockGemini(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const gm = url.match(/models\/(.+):generateContent/);
    const model = gm ? decodeURIComponent(gm[1]) : (url.includes('openrouter') ? 'or:' : 'groq:') + body.model;
    calls.push({ url, model, body, headers: opts.headers });
    const r = await handler(model, body, calls.length - 1);
    if (r === 'hang') return new Promise((_, rej) => opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
    if (r instanceof Error) throw r;
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}
const okBody = (n, tag = '') => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: JSON.stringify(
  Array.from({ length: n }, (_, i) => ({ question: `ש${tag}${i}`, options: ['נכון', 'ב', 'ג', 'ד'], correct_index: 0 }))) }] } }] } });
const promptOf = body => body.contents ? body.contents[0].parts[0].text : body.messages[1].content;
const askedCount = body => +promptOf(body).match(/כתוב (\d+)/)[1];
const groqOk = (n, tag = '') => ({ status: 200, body: { choices: [{ message: { content: JSON.stringify({ questions:
  Array.from({ length: n }, (_, i) => ({ question: `ג${tag}${i}`, options: ['נכון', 'ב', 'ג', 'ד'], correct_index: 0 })) }) } }] } });
const env = { GEMINI_API_KEY: 'k', __log: { error() {} } };

test('AI: request shape, small request = one call', async () => {
  const f = mockGemini((m, b) => okBody(askedCount(b)));
  const qs = await generateQuestions({ topic: 'פרשת וישב', count: 5, difficulty: 'hard' }, env, f);
  assert.equal(qs.length, 5); assert.equal(f.calls.length, 1);
  assert.equal(qs[0].time, 30);
  for (const q of qs) assert.equal(q.options[q.correct], 'נכון');
  const c = f.calls[0];
  assert.equal(c.headers['x-goog-api-key'], 'k');
  assert.equal(c.model, 'gemini-flash-latest');
  assert.match(c.body.contents[0].parts[0].text, /פרשת וישב/);
  assert.equal(c.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(c.body.generationConfig.thinkingConfig.thinkingBudget, 512);
});

test('AI: big request is split into parallel batches of 5 with different angles, de-duplicated', async () => {
  let active = 0, maxActive = 0;
  const f = mockGemini(async (m, b, i) => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 50)); active--;
    return i === 1 ? okBody(5, 'A') /* חבילה עם כפילויות מול 0 */ && okBody(5) : okBody(askedCount(b), 'X' + i);
  });
  const qs = await generateQuestions({ topic: 'x', count: 15 }, env, f);
  assert.equal(f.calls.length, 3);
  assert.equal(maxActive, 3, 'batches run in parallel');
  const angles = f.calls.map(c => c.body.contents[0].parts[0].text.match(/התמקד ב: (.+)/)[1]);
  assert.equal(new Set(angles).size, 3);
  assert.equal(new Set(qs.map(q => q.text)).size, qs.length, 'no duplicates');
  assert.ok(qs.length >= 10 && qs.length <= 15);
});

test('AI: overloaded or slow model -> next model, without waiting for the full timeout', async () => {
  const f = mockGemini(m => m === 'gemini-flash-latest' ? 'hang' : m === 'gemini-3.5-flash' ? { status: 503, body: {} } : okBody(5));
  const t0 = Date.now();
  const qs = await generateQuestions({ topic: 'x', count: 5 }, { ...env, GEMINI_ATTEMPT_MS: 200 }, f);
  assert.equal(qs.length, 5);
  assert.deepEqual(f.calls.map(c => c.model), ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-2.5-flash']);
  assert.ok(Date.now() - t0 < 1500);
});

test('AI: quota on one model -> other models (separate quotas); dead models skipped by other batches', async () => {
  const f = mockGemini((m, b) => m === 'gemini-flash-latest' ? { status: 429, body: {} } : okBody(askedCount(b), m + Math.random()));
  const qs = await generateQuestions({ topic: 'x', count: 10 }, env, f);
  assert.equal(qs.length, 10);
  assert.ok(f.calls.filter(c => c.model === 'gemini-flash-latest').length <= 2);
});

test('AI: partial success returns what was made instead of failing', async () => {
  const f = mockGemini((m, b) => /התמקד ב: עובדות מרכזיות/.test(b.contents[0].parts[0].text) ? okBody(5) : { status: 503, body: {} });
  const qs = await generateQuestions({ topic: 'x', count: 15 }, { ...env, GEMINI_TIMEOUT_MS: 4000 }, f);
  assert.equal(qs.length, 5);
});

test('AI: model rejects thinking config -> same model again without it', async () => {
  const f = mockGemini((m, b, i) => i === 0 ? { status: 400, body: { error: { message: 'thinking_budget is not supported' } } } : okBody(5));
  await generateQuestions({ topic: 'x', count: 5 }, env, f);
  assert.equal(f.calls[1].model, f.calls[0].model);
  assert.equal(f.calls[1].body.generationConfig.thinkingConfig, undefined);
});

test('AI: GEMINI_MODEL is tried first; broken output -> next model', async () => {
  const f = mockGemini(m => m === 'my-model' ? { status: 200, body: { candidates: [{ content: { parts: [{ text: 'not json' }] } }] } } : okBody(5));
  assert.equal((await generateQuestions({ topic: 'x', count: 5 }, { ...env, GEMINI_MODEL: 'my-model' }, f)).length, 5);
  assert.equal(f.calls[0].model, 'my-model');
});

test('Groq backup: Gemini down -> Groq answers; request shape', async () => {
  const f = mockGemini((m, b) => m.startsWith('groq:') ? groqOk(askedCount(b)) : { status: 503, body: {} });
  const qs = await generateQuestions({ topic: 'x', count: 5 }, { ...env, GROQ_API_KEY: 'g', GEMINI_ATTEMPT_MS: 300 }, f);
  assert.equal(qs.length, 5);
  for (const q of qs) assert.equal(q.options[q.correct], 'נכון');
  const g = f.calls.find(c => c.model.startsWith('groq:'));
  assert.equal(g.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(g.headers.Authorization, 'Bearer g');
  assert.equal(g.body.model, 'openai/gpt-oss-120b');
  assert.deepEqual(g.body.response_format, { type: 'json_object' });
  assert.equal(g.body.reasoning_effort, 'low');
  assert.match(g.body.messages[0].content, /questions/);
});

test('Groq: works alone, bad Gemini key does not block it, AI_PREFER=groq goes first', async () => {
  let f = mockGemini((m, b) => groqOk(askedCount(b)));
  assert.equal((await generateQuestions({ topic: 'x', count: 3 }, { GROQ_API_KEY: 'g', __log: env.__log }, f)).length, 3);
  assert.ok(f.calls.every(c => c.model.startsWith('groq:')));
  f = mockGemini((m, b) => m.startsWith('groq:') ? groqOk(askedCount(b), Math.random()) : { status: 403, body: {} });
  assert.equal((await generateQuestions({ topic: 'x', count: 10 }, { ...env, GROQ_API_KEY: 'g' }, f)).length, 10);
  assert.ok(f.calls.filter(c => !c.model.startsWith('groq:')).length <= 2, 'bad Gemini key tried once per batch, then skipped');
  f = mockGemini((m, b) => m.startsWith('groq:') ? groqOk(askedCount(b)) : okBody(askedCount(b)));
  await generateQuestions({ topic: 'x', count: 5 }, { ...env, GROQ_API_KEY: 'g', AI_PREFER: 'groq' }, f);
  assert.equal(f.calls[0].model, 'groq:openai/gpt-oss-120b');
});

test('AI: models of both services are interleaved; a hanging service is skipped quickly', async () => {
  const f = mockGemini((m, b) => m.startsWith('groq:') ? groqOk(askedCount(b)) : 'hang');
  const t0 = Date.now();
  const qs = await generateQuestions({ topic: 'x', count: 5 }, { ...env, GROQ_API_KEY: 'g', GEMINI_ATTEMPT_MS: 300 }, f);
  assert.equal(qs.length, 5);
  assert.deepEqual(f.calls.map(c => c.model), ['gemini-flash-latest', 'groq:openai/gpt-oss-120b']);
  assert.ok(Date.now() - t0 < 1000);
});

test('Groq: reasoning option rejected -> retried without; decommissioned model -> next', async () => {
  const f = mockGemini((m, b, i) => {
    if (m === 'groq:openai/gpt-oss-120b') return i === 0 ? { status: 400, body: { error: { message: 'reasoning_effort is not supported' } } } : { status: 400, body: { error: { code: 'model_decommissioned' } } };
    return groqOk(askedCount(b));
  });
  const qs = await generateQuestions({ topic: 'x', count: 5 }, { GROQ_API_KEY: 'g', __log: env.__log }, f);
  assert.equal(qs.length, 5);
  assert.equal(f.calls[1].body.reasoning_effort, undefined);
  assert.equal(f.calls[2].model, 'groq:llama-3.3-70b-versatile');
});

test('OpenRouter: free router, no JSON mode, tolerant of text around the JSON', async () => {
  const qs5 = Array.from({ length: 5 }, (_, i) => ({ question: 'ש' + i, options: ['נכון', 'ב', 'ג', 'ד'], correct_index: 0 }));
  const f = mockGemini(() => ({ status: 200, body: { choices: [{ message: { content: '<think>hmm</think>\nבטח! הנה השאלות:\n```json\n' + JSON.stringify({ questions: qs5 }) + '\n```\nבהצלחה!' } }] } }));
  const qs = await generateQuestions({ topic: 'x', count: 5 }, { OPENROUTER_API_KEY: 'o', __log: env.__log }, f);
  assert.equal(qs.length, 5);
  const c = f.calls[0];
  assert.equal(c.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(c.body.model, 'openrouter/free');
  assert.equal(c.headers.Authorization, 'Bearer o');
  assert.equal(c.body.response_format, undefined);
  assert.equal(c.body.reasoning_effort, undefined);
});

test('OpenRouter: error inside a 200 response, 402 no-credit, and order across three services', async () => {
  let f = mockGemini(() => ({ status: 200, body: { error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } } }));
  await assert.rejects(generateQuestions({ topic: 'x', count: 5 }, { OPENROUTER_API_KEY: 'o', __log: env.__log }, f), e => e.status === 429);
  f = mockGemini(() => ({ status: 402, body: { error: { message: 'negative balance' } } }));
  await assert.rejects(generateQuestions({ topic: 'x', count: 5 }, { OPENROUTER_API_KEY: 'o', __log: env.__log }, f), e => e.status === 429);
  // שלושה שירותים: Gemini נכשל, Groq נכשל, OpenRouter מצליח - בסדר משולב
  f = mockGemini((m, b) => m.startsWith('or:') ? groqOk(askedCount(b)) : { status: 503, body: {} });
  const qs = await generateQuestions({ topic: 'x', count: 5 }, { ...env, GROQ_API_KEY: 'g', OPENROUTER_API_KEY: 'o' }, f);
  assert.equal(qs.length, 5);
  assert.deepEqual(f.calls.map(c => c.model), ['gemini-flash-latest', 'groq:openai/gpt-oss-120b', 'or:openrouter/free']);
  f = mockGemini((m, b) => groqOk(askedCount(b)));
  await generateQuestions({ topic: 'x', count: 5 }, { ...env, GROQ_API_KEY: 'g', OPENROUTER_API_KEY: 'o', AI_PREFER: 'openrouter' }, f);
  assert.equal(f.calls[0].model, 'or:openrouter/free');
});

test('AI: total failure gives the most useful Hebrew error', async () => {
  const run = (h, extra = {}) => generateQuestions({ topic: 'x', count: 5 }, { ...env, GEMINI_ATTEMPT_MS: 100, GEMINI_TIMEOUT_MS: 3000, ...extra }, mockGemini(h));
  await assert.rejects(generateQuestions({ topic: 'x' }, {}, mockGemini(() => okBody(1))), e => e.status === 503 && /OPENROUTER_API_KEY/.test(e.message));
  await assert.rejects(generateQuestions({ topic: ' ' }, env, mockGemini(() => okBody(1))), e => e.status === 400);
  await assert.rejects(run(() => ({ status: 403, body: {} })), e => /מפתח/.test(e.message));
  await assert.rejects(run(() => ({ status: 400, body: { error: { message: 'API key not valid' } } })), /מפתח/);
  await assert.rejects(run(() => ({ status: 429, body: {} })), e => e.status === 429 && /מכסת/.test(e.message));
  await assert.rejects(run(() => ({ status: 503, body: {} })), e => e.status === 503 && /עמוס/.test(e.message));
  await assert.rejects(run(() => new TypeError('fetch failed')), /אין חיבור/);
  await assert.rejects(run(() => ({ status: 404, body: {} })), /לא נמצאו/);
  await assert.rejects(run(() => ({ status: 200, body: { candidates: [] } })), /שמישות/);
  await assert.rejects(run(() => 'hang', { GEMINI_TIMEOUT_MS: 400 }), e => e.status === 504);
});

// ---------- store ----------
async function storeContract(s) {
  await s.init(); await s.init(); // זריעה פעם אחת בלבד
  let list = await s.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'חידון לדוגמה');
  assert.equal(list[0].count, 4);
  const saved = await s.save(null, { title: 'א', questions: [{ text: 'ש', options: ['1', '2'], correct: 1 }] });
  assert.match(saved.id, /^[a-f0-9]{16}$/);
  const got = await s.get(saved.id);
  assert.equal(got.questions[0].options.length, 4);
  assert.equal(got.autoAdvance, 0);
  await s.save(saved.id, { title: 'א', autoAdvance: 10, questions: [] });
  assert.equal((await s.get(saved.id)).autoAdvance, 10, 'autoAdvance round-trips');
  await s.save(saved.id, { title: 'א', autoAdvance: 999, questions: [{ text: 'ש', options: ['1', '2'], correct: 1 }] });
  assert.equal((await s.get(saved.id)).autoAdvance, 0, 'invalid autoAdvance -> off');
  got.title = 'mutated';
  assert.equal((await s.get(saved.id)).title, 'א', 'get must return a copy');
  await new Promise(r => setTimeout(r, 5));
  await s.save(saved.id, { title: 'ב', questions: [] });
  list = await s.list();
  assert.equal(list[0].title, 'ב', 'most recently updated first');
  assert.equal(list[0].count, 0);
  assert.equal(await s.get('../etc/passwd'), null);
  assert.equal(await s.save('bad id!', {}), null);
  assert.equal(await s.remove(saved.id), true);
  assert.equal(await s.remove(saved.id), false);
  assert.equal(await s.get(saved.id), null);
}

test('fileStore: contract + persistence + atomic file', async () => {
  const dir = tmpDir();
  await storeContract(fileStore(dir));
  const s2 = fileStore(dir); await s2.init();
  assert.equal((await s2.list()).length, 1, 'sample not re-seeded after deletion of others');
  const q = await s2.save(null, { title: 'נשמר', questions: [] });
  const s3 = fileStore(dir);
  assert.equal((await s3.get(q.id)).title, 'נשמר');
  assert.ok(!fs.existsSync(path.join(dir, 'quizzes.json.tmp')));
});

test('fileStore: corrupt file is backed up, not silently lost', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'quizzes.json'), '{broken');
  const s = fileStore(dir); await s.init();
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('quizzes.json.corrupt-')));
  assert.equal((await s.list()).length, 1);
});

// מימוש מינימלי של MongoDB לבדיקה (הדרייבר האמיתי לא זמין בסביבת הבדיקה)
function fakeDb() {
  const cols = {};
  const clone = o => structuredClone(o);
  return {
    collection(name) {
      const m = cols[name] || (cols[name] = new Map());
      return {
        async findOne(f) { const d = m.get(f._id); return d ? clone(d) : null; },
        async replaceOne(f, doc, opts) {
          assert.ok(!('_id' in doc) || doc._id === f._id);
          if (!m.has(f._id) && !(opts && opts.upsert)) return { matchedCount: 0 };
          m.set(f._id, { ...clone(doc), _id: f._id }); return { matchedCount: 1 };
        },
        async deleteOne(f) { return { deletedCount: m.delete(f._id) ? 1 : 0 }; },
        find(f, opts) {
          let docs = [...m.values()].map(clone);
          const proj = opts && opts.projection;
          if (proj) docs = docs.map(d => { const o = { _id: d._id }; for (const k of Object.keys(proj)) if (k in d) o[k] = d[k]; return o; });
          return {
            sort(s) { const [k, dir] = Object.entries(s)[0]; docs.sort((a, b) => (a[k] - b[k]) * dir); return this; },
            async toArray() { return docs; },
          };
        },
      };
    },
  };
}

test('mongoStore: same contract as file store', async () => {
  await storeContract(mongoStore(fakeDb()));
});

module.exports = { fakeDb };
