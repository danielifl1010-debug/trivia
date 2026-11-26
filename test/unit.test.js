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

function mockFetch(responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}
const geminiOk = arr => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: JSON.stringify(arr) }] } }] } });
const env = { GEMINI_API_KEY: 'k' };

test('generateQuestions: success path, request shape, count limit', async () => {
  const f = mockFetch([geminiOk([...good, { question: 'ש3', options: ['1', '2', '3', '4'], correct_index: 1 }])]);
  const qs = await generateQuestions({ topic: 'פרשת וישב', count: 2, difficulty: 'hard' }, env, f);
  assert.equal(qs.length, 2);
  assert.equal(qs[0].time, 30);
  assert.equal(f.calls[0].headers['x-goog-api-key'], 'k');
  assert.match(f.calls[0].url, /gemini-3\.5-flash:generateContent$/);
  assert.match(f.calls[0].body.contents[0].parts[0].text, /פרשת וישב/);
  assert.equal(f.calls[0].body.generationConfig.responseMimeType, 'application/json');
});

test('generateQuestions: errors are clear Hebrew messages with right status', async () => {
  await assert.rejects(generateQuestions({ topic: 'x' }, {}, mockFetch([])), e => e.status === 503);
  await assert.rejects(generateQuestions({ topic: '  ' }, env, mockFetch([])), e => e.status === 400);
  await assert.rejects(generateQuestions({ topic: 'x' }, env, mockFetch([{ status: 429, body: {} }])), e => e.status === 429 && /מכסת/.test(e.message));
  await assert.rejects(generateQuestions({ topic: 'x' }, env, mockFetch([{ status: 403, body: {} }])), /מפתח/);
  await assert.rejects(generateQuestions({ topic: 'x' }, env, mockFetch([{ status: 400, body: { error: { message: 'API key not valid' } } }])), /מפתח/);
  await assert.rejects(generateQuestions({ topic: 'x' }, env, mockFetch([{ status: 500, body: {} }])), /500/);
  await assert.rejects(generateQuestions({ topic: 'x' }, env, mockFetch([{ status: 200, body: { candidates: [] } }])), /לא החזיר/);
  await assert.rejects(generateQuestions({ topic: 'x' }, env, mockFetch([new TypeError('fetch failed')])), /אין חיבור/);
});

test('generateQuestions: falls back to next model on 404, honors GEMINI_MODEL', async () => {
  const f = mockFetch([{ status: 404, body: {} }, geminiOk(good)]);
  const qs = await generateQuestions({ topic: 'x' }, { ...env, GEMINI_MODEL: 'my-model' }, f);
  assert.equal(qs.length, 2);
  assert.match(f.calls[0].url, /my-model/);
  assert.match(f.calls[1].url, /gemini-3\.5-flash/);
  const all404 = mockFetch([{ status: 404, body: {} }, { status: 404, body: {} }, { status: 404, body: {} }]);
  await assert.rejects(generateQuestions({ topic: 'x' }, env, all404), /לא נמצא/);
});

test('generateQuestions: timeout', async () => {
  const slow = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
  await assert.rejects(generateQuestions({ topic: 'x' }, { ...env, GEMINI_TIMEOUT_MS: 50 }, slow), e => e.status === 504);
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
