// ═══════════════════════════════════════════════════════════════════════════
// Quizprompts.js — Global AI quiz prompt builder (topic + difficulty)
// ExamAI: "Turn any subject into a smart quiz, instantly."
//
// No exam presets. The app passes a free-text topic, a question count, and a
// difficulty (easy | medium | hard). Works for any subject, any region.
//
// Output contract is unchanged from the old builder, so nothing downstream
// (sanitizeJSON / extractJSONArray / the Android quiz renderer) needs to change.
// ═══════════════════════════════════════════════════════════════════════════

const ACCURACY_RULE = `
⚠️ ACCURACY RULE: If you are not 100% certain a fact, figure, term, or concept
is correct, DO NOT include that question. Accuracy matters more than reaching
the requested count. Every question must have exactly one defensibly correct
answer, and the other three options must be clearly wrong to someone who knows
the topic. Never invent facts, names, dates, or data.`;

// What changes per difficulty level — this is the part that was being ignored.
const DIFFICULTY_PROFILES = {
  easy: `
DIFFICULTY: EASY — for beginners building confidence.
- Test foundational understanding and the core facts of the topic.
- Keep questions clear, direct, and unambiguous.
- Mostly single-concept questions; light application is fine.
- Distractors should be plausible but clearly distinguishable to anyone who studied the basics.
- Avoid trick questions, multi-step reasoning, and obscure edge cases.`,

  medium: `
DIFFICULTY: MEDIUM — for learners with working knowledge.
- Test application and the ability to connect two related ideas.
- Mix direct questions with scenario/application and a few statement-based questions.
- Distractors should be close enough that a careless reader gets caught.
- At least 30% of questions should require more than simple recall.`,

  hard: `
DIFFICULTY: HARD — for advanced learners.
- Test deep understanding, multi-step reasoning, exceptions, and common misconceptions.
- Favor scenario-based, statement-based, and application questions over direct recall.
- Distractors must be highly plausible — typically common mistakes or adjacent-but-wrong facts.
- At least 50% of questions should require multi-step reasoning or connecting multiple concepts.
- No question should be answerable by memorizing a single line.`,
};

// Keep the exact JSON shape the rest of the codebase already expects.
const FORMAT_CONTRACT = (count, topic) => `
Return ONLY a valid JSON array. No markdown, no backticks, no extra text.
Format:
[
  {
    "question": "Full question text here",
    "options": ["A) option one", "B) option two", "C) option three", "D) option four"],
    "correct": 0,
    "explanation": "2-3 sentence explanation of why the correct answer is right.",
    "questionType": "direct | application | statement-based | scenario | true-false"
  }
]
- "correct" is the 0-based index of the right option (0=A, 1=B, 2=C, 3=D).
- Return EXACTLY ${count} questions on "${topic}" — no more, no less.
- Every question must have exactly 4 options.
- NEVER use "All of the above" or "None of the above" as an option.
- Vary which position (A/B/C/D) holds the correct answer across the quiz.`;

/**
 * Build a quiz-generation prompt.
 * @param {string} topic       Free-text subject, e.g. "Photosynthesis", "World War II", "React hooks".
 * @param {number} count       Number of questions (already clamped server-side).
 * @param {string} difficulty  "easy" | "medium" | "hard".
 */
export const getQuizPrompt = (topic, count = 10, difficulty = "medium") => {
  const level = ["easy", "medium", "hard"].includes(difficulty)
    ? difficulty
    : "medium";

  return `You are an expert multiple-choice question setter creating a quiz for a global audience of learners. You can quiz on ANY subject — academic, professional, technical, or general knowledge.

TOPIC: "${topic}"
${DIFFICULTY_PROFILES[level]}

GENERAL RULES:
- Every option must be relevant to the topic — no filler or obviously off-topic choices.
- Wrong options should reflect realistic misunderstandings, not random noise.
- Explanations must teach: say why the correct answer is right and, where useful, why a tempting wrong option is wrong.
- Keep each question self-contained — do not reference "the passage above" unless you include that passage in the question text itself.
- Write in clear, internationally neutral English. Do not assume any single country's context unless the topic itself is country-specific.
${ACCURACY_RULE}

Generate EXACTLY ${count} ${level}-difficulty questions on "${topic}".
${FORMAT_CONTRACT(count, topic)}`;
};

export default getQuizPrompt;
