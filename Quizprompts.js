// ═══════════════════════════════════════════════════════════════════════════
// quizPrompts.js — AI prompt builder for quiz generation
// ═══════════════════════════════════════════════════════════════════════════

const buildGS1FormatPlan = (n) => {
  const pattern = [
    "STATEMENT-BASED",
    "MATCH-LIST",
    "STATEMENT-BASED",
    "STATEMENT-I/II",
    "STATEMENT-BASED",
    "DIRECT",
    "STATEMENT-I/II",
    "STATEMENT-BASED",
    "MATCH-LIST",
    "DIRECT",
  ];
  const plan = [];
  for (let i = 0; i < n; i++) plan.push(pattern[i % pattern.length]);
  return plan
    .map((fmt, i) => `Question ${i + 1}: MUST be ${fmt} format`)
    .join("\n");
};

const buildCSATFormatPlan = (n) => {
  const pattern = [
    "READING-COMPREHENSION",
    "LOGICAL-REASONING",
    "NUMERACY",
    "DATA-INTERPRETATION",
    "DECISION-MAKING",
    "LOGICAL-REASONING",
    "MENTAL-ABILITY",
    "NUMERACY",
    "READING-COMPREHENSION",
    "LOGICAL-REASONING",
  ];
  const plan = [];
  for (let i = 0; i < n; i++) plan.push(pattern[i % pattern.length]);
  return plan
    .map((fmt, i) => `Question ${i + 1}: MUST be ${fmt} format`)
    .join("\n");
};

export const getQuizPrompt = (exam, topic, count, contextBlock = "") => {
  const upscGS1Formats = `
STYLE REQUIREMENTS (MUST MIRROR REAL UPSC GS PAPER I):

FORMAT 1 — STATEMENT-BASED (60% minimum)
"Consider the following statements:
1. [Conceptual statement]
2. [Conceptual statement]
3. [Conceptual statement]
Which of the statements given above is/are correct?"
Options: A) 1 only  B) 1 and 2 only  C) 2 and 3 only  D) 1, 2 and 3
Rules: At least ONE statement must be subtly incorrect.

FORMAT 2 — STATEMENT I / STATEMENT II (20%)
A) Both Statement I and II are correct and Statement II explains Statement I
B) Both Statement I and II are correct but Statement II does NOT explain Statement I
C) Statement I is correct but Statement II is incorrect
D) Statement I is incorrect but Statement II is correct

FORMAT 3 — MATCH LIST I / LIST II (10%)
List I | List II
A. Term/Item | 1. Description/Match
B. Term/Item | 2. Description/Match
C. Term/Item | 3. Description/Match
"How many of the above pairs are correctly matched?"
Options: A) Only one  B) Only two  C) Only three  D) All three

FORMAT 4 — DIRECT (10%)
One precise factual/conceptual question with 4 distinct options.

DIFFICULTY: 50% Moderate, 40% Hard, 10% Easy
NEVER use "All of the above" or "None of the above" as options.
`;

  const examInstructions = {
    UPSC: `You are a UPSC Civil Services Preliminary Examination question setter for GS Paper I.
Generate questions STRICTLY based on UPSC Prelims GS Paper I PYQs (2014–2025) and NCERT textbooks Class 6–12.
ABSOLUTE RESTRICTIONS: DO NOT invent Articles, Acts, committees, schemes, or facts not in NCERT or PYQs.
Every single question must be 100% traceable to either a UPSC PYQ (2014–2025) or an NCERT Class 6–12 textbook.
Topic: "${topic}"
${upscGS1Formats}`,

    CSAT: `You are a UPSC CSAT (Paper II) question setter. Generate questions STRICTLY in the style of UPSC CSAT PYQs (2014–2025).
TOPIC: "${topic}"
Cover: READING COMPREHENSION, LOGICAL REASONING, DECISION MAKING, BASIC NUMERACY, DATA INTERPRETATION, GENERAL MENTAL ABILITY.
RULES: Every numerical answer uniquely correct. DIFFICULTY: 50% Moderate, 50% Hard. Show full working in explanation.
STRICT: Only include question types that appear in official UPSC CSAT PYQs. Do not go beyond CSAT scope.`,

    "Current Affairs": `You are a UPSC Current Affairs question setter. Use the LIVE CONTEXT below as PRIMARY source.
Topic: "${topic}"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LIVE CONTEXT FROM THE WEB:
${
  contextBlock ||
  "⚠️ No live context available — use your best known recent facts on this topic for UPSC."
}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRICT: Only generate questions based on verified facts from the live context above or well-established current affairs. Do NOT invent events, data, or facts.
${upscGS1Formats}`,

    JEE: `You are a JEE Main/Advanced question setter.
Generate questions on "${topic}" STRICTLY from the official JEE Main/Advanced syllabus as defined by NTA.
ONLY cover topics explicitly listed in the official JEE syllabus. DO NOT include BSc-level or engineering college topics.
Use a MIX of: Numerical-based MCQ, Concept application, Common misconception traps, Graph/diagram interpretation.
RULES: Include actual numerical values. Options differ by small margins. 60% hard, 40% medium. Show key formula in explanation.
ABSOLUTE RESTRICTION: Every question must be solvable using JEE syllabus knowledge only.`,

    NEET: `You are a NEET UG question setter.
Generate questions on "${topic}" STRICTLY from NCERT Class 11 and Class 12 Biology, Physics, and Chemistry textbooks only.
DO NOT include any topic, concept, or terminology beyond what appears in NCERT Class 11–12 textbooks.
Use a MIX of: Assertion-Reason, Diagram/structure based, Statement true/false, Application-based.
RULES: Every answer must be directly traceable to a specific NCERT Class 11 or 12 chapter. 50% hard, 50% medium.
ABSOLUTE RESTRICTION: If a concept is not in NCERT Class 11–12, do NOT include it.`,

    CAT: `You are a CAT question setter. Generate CAT-level questions on "${topic}".
STRICTLY follow the official CAT syllabus as conducted by IIMs.
Use a MIX of: VARC (Para-jumble, Para-summary, Inference), DILR, QA (Word problems).
RULES: Options very close. Avoid straightforward computation. Show elimination strategy. 60% hard, 40% medium.
ABSOLUTE RESTRICTION: Only include question types that appear in official CAT papers.`,

    SSC: `You are an SSC CGL/CHSL question setter.
Generate questions on "${topic}" STRICTLY within the official SSC CGL/CHSL syllabus as defined by SSC.
Mix: Reasoning, Quant, GK, English.
RULES: Options tricky. For Quant show shortcut. 40% hard, 60% medium.
ABSOLUTE RESTRICTION: Do not include topics outside the official SSC CGL/CHSL syllabus.`,

    Banking: `You are an IBPS/SBI PO question setter.
Generate questions on "${topic}" STRICTLY within the official IBPS/SBI PO syllabus.
Mix: Reasoning puzzles, Quant (DI, simplification), Banking Awareness, English.
RULES: Include at least 2 DI questions. Options numerical and close. 50% hard, 50% medium.
ABSOLUTE RESTRICTION: Only include topics from the official IBPS/SBI PO syllabus.`,

    GATE: `You are a GATE question setter.
Generate questions on "${topic}" STRICTLY from the official GATE syllabus for the relevant engineering/science discipline.
Mix: Numerical Answer Type, Concept application, Multi-step technical problems.
RULES: Include formulas and derivations. Options technically precise. 60% hard, 40% medium.
ABSOLUTE RESTRICTION: Every question must be within the official GATE syllabus.`,

    "State PCS": `You are a State PCS Preliminary Examination question setter.
Generate questions: 60% general topics + 40% state-specific topics.
Topic received: "${topic}" — Extract STATE NAME before " — " and SUBJECT TOPIC after " — ".
Generate 40% questions specifically about THAT STATE only. NEVER mix up states.
STYLE: 50% Statement-based, 20% Direct, 15% Match List, 15% Statement I/II.
ABSOLUTE RESTRICTION: State-specific questions must only reference verified facts about the correct state.`,

    "CBSE 10th": `You are a CBSE Class 10 Board Examination question setter.
Generate questions STRICTLY from NCERT Class 10 textbooks only — no other source.
Mix: 40% MCQ, 25% Short Answer, 20% Case-based/Assertion-Reason, 15% Numerical.
DIFFICULTY: 60% Easy-Medium, 40% Medium-Hard. Topic: "${topic}"
ABSOLUTE RESTRICTION: Every question must be directly from NCERT Class 10.`,

    "CBSE 12th": `You are a CBSE Class 12 Board Examination question setter.
Generate questions STRICTLY from NCERT Class 12 textbooks only — no other source.
Mix: 35% MCQ, 25% Short Answer, 20% Long Answer/Case-based, 20% Numerical/Derivation.
DIFFICULTY: 30% Easy, 40% Medium, 30% Hard. Topic: "${topic}"
ABSOLUTE RESTRICTION: Every question must be directly from NCERT Class 12.`,

    Railway: `You are an RRB NTPC/Group D/ALP question setter.
Generate questions on "${topic}" STRICTLY within the official RRB exam syllabus.
Mix: 30% General Awareness, 25% Mathematics, 25% General Intelligence & Reasoning, 20% General Science.
RULES: Options tricky. For Math show shortcut method. 40% hard, 60% medium.
ABSOLUTE RESTRICTION: Only topics from official RRB NTPC/Group D syllabus.`,

    General: `You are an expert question setter. Generate well-structured MCQ questions on "${topic}".
Mix easy, medium and hard difficulty. Make distractors plausible but clearly wrong on reflection.
Explanation must be 2-3 sentences with the reasoning behind the correct answer.`,
  };

  const instruction = examInstructions[exam] || examInstructions["General"];

  let formatPlan = "";
  if (exam === "UPSC" || exam === "Current Affairs") {
    formatPlan = `\nMANDATORY FORMAT ASSIGNMENT:\n${buildGS1FormatPlan(count)}\n
NOTE: If a required format cannot be created using only in-syllabus content for "${topic}", use FORMAT 4 (DIRECT) instead. NEVER invent out-of-syllabus content to satisfy a format requirement.\n`;
  } else if (exam === "CSAT") {
    formatPlan = `\nMANDATORY FORMAT ASSIGNMENT:\n${buildCSATFormatPlan(
      count
    )}\n`;
  }

  return `${instruction}${formatPlan}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ FINAL SYLLABUS RULE — THIS OVERRIDES EVERYTHING ABOVE:
1. Every question must come 100% from the official ${exam} syllabus for topic "${topic}".
2. If you are not fully certain a fact, scheme, article, term, or concept is in the ${exam} syllabus — DO NOT include it.
3. When in doubt, leave it out. Accuracy over variety.
4. Do NOT invent or hallucinate facts, names, dates, schemes, or data under any circumstance.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Generate EXACTLY ${count} questions on the topic: "${topic}" for ${exam} exam.

Return ONLY a valid JSON array. No markdown, no extra text.
Format:
[
  {
    "question": "Full question text here",
    "options": ["A) option1", "B) option2", "C) option3", "D) option4"],
    "correct": 0,
    "explanation": "Detailed explanation. Minimum 2-3 sentences.",
    "questionType": "statement-based | statement-I-II | match-list | direct | comprehension | logical | numeracy | data-interpretation | decision-making | mental-ability | current-affairs"
  }
]
- "correct" is the 0-based index (0=A, 1=B, 2=C, 3=D)
- Return exactly ${count} questions, no more, no less
- NEVER use "All of the above" or "None of the above" as options`;
};
