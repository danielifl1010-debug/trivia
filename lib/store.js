// שמירת חידונים: MongoDB (קבוע, מומלץ לשרת באינטרנט) או קובץ JSON מקומי
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cleanQuiz } = require('./validate');

const SAMPLE = {
  title: 'חידון לדוגמה',
  questions: [
    { text: 'כמה ספרים יש בתנ"ך?', options: ['22', '24', '39', '18'], correct: 1, time: 20, image: '' },
    { text: 'מהי בירת ישראל?', options: ['תל אביב', 'חיפה', 'ירושלים', 'בני ברק'], correct: 2, time: 15, image: '' },
    { text: 'באיזה חודש חל ט"ו בשבט?', options: ['אדר', 'טבת', 'ניסן', 'שבט'], correct: 3, time: 15, image: '' },
    { text: 'כמה מסכתות יש בסדר מועד?', options: ['12', '10', '7', '11'], correct: 0, time: 20, image: '' },
  ],
};

const newId = () => crypto.randomBytes(8).toString('hex');
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(id);
const summary = q => ({ id: q.id, title: q.title, count: q.questions.length, updatedAt: q.updatedAt });

// ---------- קובץ מקומי ----------
function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'quizzes.json');
  let data = { seeded: false, quizzes: {} };
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') {
      // קובץ פגום - שומרים עותק ולא דורסים בשקט
      try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch {}
      console.error('quizzes.json פגום, נשמר עותק ומתחילים מחדש');
    }
  }
  if (!data.quizzes || typeof data.quizzes !== 'object') data.quizzes = {};
  let chain = Promise.resolve();
  const persist = () => {
    chain = chain.then(() => {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    });
    return chain;
  };
  return {
    mode: 'file',
    async init() {
      if (!data.seeded) {
        const id = newId();
        data.quizzes[id] = { id, ...cleanQuiz(SAMPLE), updatedAt: Date.now() };
        data.seeded = true;
        await persist();
      }
    },
    async list() {
      return Object.values(data.quizzes).map(summary).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async get(id) { return validId(id) && data.quizzes[id] ? structuredClone(data.quizzes[id]) : null; },
    async save(id, quiz) {
      if (id != null && !validId(id)) return null;
      id = id || newId();
      const q = { id, ...cleanQuiz(quiz), updatedAt: Date.now() };
      data.quizzes[id] = q;
      await persist();
      return structuredClone(q);
    },
    async remove(id) {
      if (!validId(id) || !data.quizzes[id]) return false;
      delete data.quizzes[id];
      await persist();
      return true;
    },
  };
}

// ---------- MongoDB ----------
// db: אובייקט Db של הדרייבר (או מימוש תואם לבדיקות)
function mongoStore(db) {
  const col = db.collection('quizzes');
  const meta = db.collection('meta');
  const fromDoc = d => d && ({ id: d._id, title: d.title, questions: d.questions, updatedAt: d.updatedAt });
  return {
    mode: 'mongo',
    async init() {
      const m = await meta.findOne({ _id: 'seed' });
      if (!m) {
        const id = newId();
        await col.replaceOne({ _id: id }, { ...cleanQuiz(SAMPLE), count: SAMPLE.questions.length, updatedAt: Date.now() }, { upsert: true });
        await meta.replaceOne({ _id: 'seed' }, { at: Date.now() }, { upsert: true });
      }
    },
    async list() {
      const docs = await col.find({}, { projection: { title: 1, count: 1, updatedAt: 1 } }).sort({ updatedAt: -1 }).toArray();
      return docs.map(d => ({ id: d._id, title: d.title, count: d.count || 0, updatedAt: d.updatedAt }));
    },
    async get(id) { return validId(id) ? fromDoc(await col.findOne({ _id: id })) : null; },
    async save(id, quiz) {
      if (id != null && !validId(id)) return null;
      id = id || newId();
      const q = cleanQuiz(quiz);
      const doc = { ...q, count: q.questions.length, updatedAt: Date.now() };
      await col.replaceOne({ _id: id }, doc, { upsert: true });
      return { id, ...q, updatedAt: doc.updatedAt };
    },
    async remove(id) {
      if (!validId(id)) return false;
      const r = await col.deleteOne({ _id: id });
      return r.deletedCount > 0;
    },
  };
}

// בוחר אוטומטית. אם MongoDB מוגדר ולא מצליח להתחבר - עובר לקובץ ומסמן אזהרה
async function createStore({ mongoUri, dataDir, log = console }) {
  if (mongoUri) {
    try {
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const s = mongoStore(client.db(process.env.MONGODB_DB || 'trivia'));
      await s.init();
      log.log('שמירה: מחובר ל-MongoDB');
      return s;
    } catch (e) {
      log.error('לא הצלחתי להתחבר ל-MongoDB: ' + e.message);
      const s = fileStore(dataDir);
      await s.init();
      s.warning = 'החיבור למסד הנתונים נכשל. החידונים נשמרים זמנית בלבד. בדוק את MONGODB_URI.';
      return s;
    }
  }
  const s = fileStore(dataDir);
  await s.init();
  if (process.env.RENDER) s.warning = 'לא הוגדר מסד נתונים (MONGODB_URI). בשרת החינמי החידונים יימחקו כשהשרת יופעל מחדש.';
  log.log('שמירה: קובץ מקומי ב-' + dataDir);
  return s;
}

module.exports = { createStore, fileStore, mongoStore, validId };
