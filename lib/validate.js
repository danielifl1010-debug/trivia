// ניקוי ובדיקת נתוני חידונים
const MAX_QUESTIONS = 100;
const MAX_IMAGE_DATA = 400 * 1024; // תמונה מועלית: עד כ-400KB (אחרי כיווץ בדפדפן)
const IMAGE_DATA_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const IMAGE_URL_RE = /^https?:\/\/[^\s"'<>]+$/i;

function str(v, max) { return String(v == null ? '' : v).slice(0, max); }

function cleanImage(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (s.startsWith('data:')) return s.length <= MAX_IMAGE_DATA && IMAGE_DATA_RE.test(s) ? s : '';
  return s.length <= 1000 && IMAGE_URL_RE.test(s) ? s : '';
}

// שאלה כפי שנשמרת בעורך (מותר שתהיה חלקית - טיוטה)
function cleanQuestion(q) {
  q = q && typeof q === 'object' ? q : {};
  const options = Array.isArray(q.options) ? q.options : [];
  const correct = Number.parseInt(q.correct, 10);
  const out = {
    text: str(q.text, 300),
    options: [0, 1, 2, 3].map(i => str(options[i], 120)),
    correct: correct >= 0 && correct <= 3 ? correct : 0,
    time: Math.min(120, Math.max(5, Number.parseInt(q.time, 10) || 20)),
    image: cleanImage(q.image),
  };
  if (q.ai === true) out.ai = true;
  return out;
}

function cleanQuiz(quiz) {
  quiz = quiz && typeof quiz === 'object' ? quiz : {};
  const questions = (Array.isArray(quiz.questions) ? quiz.questions : []).slice(0, MAX_QUESTIONS).map(cleanQuestion);
  return { title: str(quiz.title, 100).trim() || 'חידון ללא שם', questions };
}

// בדיקה שהשאלה מוכנה למשחק. מחזיר הודעת שגיאה או null
function questionProblem(q) {
  if (!q.text.trim()) return 'חסר נוסח שאלה';
  if (q.options.filter(o => o.trim()).length < 2) return 'צריך לפחות 2 תשובות';
  if (!q.options[q.correct].trim()) return 'התשובה שסומנה כנכונה ריקה';
  return null;
}

// מחזיר { questions } מוכנות למשחק, או { error }
function gameQuestions(quiz) {
  const qs = cleanQuiz(quiz).questions;
  if (!qs.length) return { error: 'אין שאלות בחידון' };
  for (let i = 0; i < qs.length; i++) {
    const p = questionProblem(qs[i]);
    if (p) return { error: 'שאלה ' + (i + 1) + ': ' + p, index: i };
  }
  return { questions: qs };
}

module.exports = { cleanQuiz, cleanQuestion, cleanImage, gameQuestions, questionProblem, MAX_QUESTIONS, MAX_IMAGE_DATA };
