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

// ── Shared rules for all non-UPSC exams ──────────────────────────────────────
const DIFFICULTY_LINE =
  "DIFFICULTY: 90% Hard, 10% Medium. No easy questions. Every question requires deep understanding, multi-step reasoning, or application — never direct recall of a single fact.";

const ACCURACY_RULE = `
⚠️ ACCURACY RULE: If you are not 100% certain a fact, figure, term, or concept is correct — DO NOT include that question. Accuracy is more important than reaching the count. Every answer must be verifiably correct.`;

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
    // ── UNTOUCHED ─────────────────────────────────────────────────────────────
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

    // ── REWRITTEN ─────────────────────────────────────────────────────────────
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
${DIFFICULTY_LINE}
${upscGS1Formats}`,

    JEE: `You are a JEE Main/Advanced question setter.
Generate questions on "${topic}" STRICTLY from the official JEE Main/Advanced syllabus as defined by NTA.
ONLY cover topics explicitly listed in the official JEE syllabus. DO NOT include BSc-level or engineering college topics.
${DIFFICULTY_LINE}
Use a MIX of: Numerical-based MCQ, Concept application, Multi-step problem solving, Common misconception traps, Graph/diagram interpretation.
RULES:
- Include actual numerical values with options differing by small margins
- At least 40% questions must be multi-step problems requiring 2 or more concepts
- Show key formula and full working in explanation
- No question should be solvable by substitution or elimination alone
ABSOLUTE RESTRICTION: Every question must be solvable using JEE syllabus knowledge only.
${ACCURACY_RULE}`,

    NEET: `You are a NEET UG question setter.
Generate questions on "${topic}" STRICTLY from NCERT Class 11 and Class 12 Biology, Physics, and Chemistry textbooks only.
DO NOT include any topic, concept, or terminology beyond what appears in NCERT Class 11–12 textbooks.
${DIFFICULTY_LINE}
Use a MIX of: Assertion-Reason, Diagram/structure based, Multi-statement true/false, Application-based, Exception-based ("Which of the following is NOT correct?").
RULES:
- Every answer must be directly traceable to a specific NCERT Class 11 or 12 chapter and page
- At least 30% questions must test exceptions, special cases, or commonly confused concepts
- No question should be answerable by memorizing a single line from NCERT
ABSOLUTE RESTRICTION: If a concept is not in NCERT Class 11–12, do NOT include it.
${ACCURACY_RULE}`,

    CAT: `You are a CAT question setter. Generate CAT-level questions on "${topic}".
STRICTLY follow the official CAT syllabus as conducted by IIMs.
${DIFFICULTY_LINE}
Use a MIX of: VARC (Para-jumble, Para-summary, Critical Inference), DILR (Complex sets, Conditional logic), QA (Multi-step word problems, Number theory, Geometry).
RULES:
- Options must be very close — no obviously eliminable choices
- At least 30% questions must require 2 or more logical steps
- Avoid straightforward computation — reward reasoning over calculation
- Show elimination strategy + full reasoning in explanation
ABSOLUTE RESTRICTION: Only include question types that appear in official CAT papers.
${ACCURACY_RULE}`,

    SSC: `You are an SSC CGL/CHSL question setter.
Generate questions on "${topic}" STRICTLY within the official SSC CGL/CHSL syllabus as defined by SSC.
${DIFFICULTY_LINE}
Use a MIX of: Advanced Reasoning (Coding-Decoding, Blood Relations, Syllogisms, Direction sense), Quantitative Aptitude (Percentage, Profit-Loss, Time-Work, Geometry), General Awareness (Polity, History, Science), English (Error detection, Idioms).
RULES:
- For Reasoning: use multi-step logic, not single-step pattern spotting
- For Quant: show shortcut method in explanation — answer must not be reachable by brute force easily
- For GK: test application and connection between facts, not isolated facts
- Options must be tricky — wrong options should be common mistakes or adjacent facts
ABSOLUTE RESTRICTION: Do not include topics outside the official SSC CGL/CHSL syllabus.
${ACCURACY_RULE}`,

    Banking: `You are an IBPS/SBI PO question setter.
Generate questions on "${topic}" STRICTLY within the official IBPS/SBI PO syllabus.
${DIFFICULTY_LINE}
Use a MIX of: Complex Reasoning Puzzles (Seating, Scheduling, Floor-based), Data Interpretation (Caselet, Mixed graphs), Quantitative Aptitude (Approximation, Series, Quadratic), Banking & Financial Awareness, English (Reading Comprehension with inference).
RULES:
- At least 2 questions must be full DI sets requiring multiple calculations
- Reasoning questions must have at least 4 conditions
- Banking Awareness questions must test recent policy, rates, or regulatory knowledge
- Quant options must be numerical and close — no obviously wrong values
ABSOLUTE RESTRICTION: Only include topics from the official IBPS/SBI PO syllabus.
${ACCURACY_RULE}`,

    GATE: `You are a GATE question setter.
Generate questions on "${topic}" STRICTLY from the official GATE syllabus for the relevant engineering/science discipline.
${DIFFICULTY_LINE}
Use a MIX of: Numerical Answer Type (NAT), Multi-concept application, Derivation-based, System design/analysis.
RULES:
- At least 40% must be NAT questions with exact numerical answers
- Include formulas and intermediate steps in explanation
- Options for MCQ must be technically precise and close in value or concept
- No question should be answerable by memorizing a formula alone — require its application
ABSOLUTE RESTRICTION: Every question must be within the official GATE syllabus.
${ACCURACY_RULE}`,

    "State PCS": `You are a State PCS Preliminary Examination question setter.
Generate questions: 60% general topics + 40% state-specific topics.
Topic received: "${topic}" — Extract STATE NAME before " — " and SUBJECT TOPIC after " — ".
Generate 40% questions specifically about THAT STATE only. NEVER mix up states.
${DIFFICULTY_LINE}
STYLE: 50% Statement-based, 20% Direct, 15% Match List, 15% Statement I/II.
RULES:
- State-specific questions must reference verified facts — geography, history, economy, governance of that state only
- Statement-based questions must have at least one subtly incorrect statement
- No question should be answerable without knowing the specific state context
ABSOLUTE RESTRICTION: State-specific questions must only reference verified facts about the correct state.
${ACCURACY_RULE}`,

    "CBSE 10th": `You are a CBSE Class 10 Board Examination question setter.
Generate questions STRICTLY from NCERT Class 10 textbooks only — no other source.
${DIFFICULTY_LINE}
Use a MIX of: Case-based MCQ, Assertion-Reason, Application-based Numerical, Concept application (NOT direct definition).
RULES:
- Case-based questions must have a 3-4 line passage followed by a question requiring inference
- Assertion-Reason questions must have non-obvious relationships
- Numerical questions must require at least 2 steps
- No "What is the definition of X" type questions
ABSOLUTE RESTRICTION: Every question must be directly from NCERT Class 10.
${ACCURACY_RULE}`,

    "CBSE 12th": `You are a CBSE Class 12 Board Examination question setter.
Generate questions STRICTLY from NCERT Class 12 textbooks only — no other source.
${DIFFICULTY_LINE}
Use a MIX of: Case-based MCQ, Assertion-Reason, Derivation-based application, Multi-concept numerical, Exception/special case questions.
RULES:
- At least 30% questions must connect concepts across two different chapters
- Numerical questions must require substitution into derived formulas, not direct formula application
- Assertion-Reason questions must have non-obvious logical relationships
- No single-line recall questions
ABSOLUTE RESTRICTION: Every question must be directly from NCERT Class 12.
${ACCURACY_RULE}`,

    Railway: `You are an RRB NTPC/Group D/ALP question setter.
Generate questions on "${topic}" STRICTLY within the official RRB exam syllabus.
${DIFFICULTY_LINE}
Use a MIX of: General Awareness (Science applications, History, Polity, Current Affairs), Mathematics (Multi-step problems in Ratio, Time-Distance, Mensuration), General Intelligence (Complex analogy, Series, Coding), General Science (Applied concepts, not definitions).
RULES:
- For Math: show shortcut method in explanation — brute force should be impractical
- For GA: test application of facts, not isolated memorization
- For Reasoning: use multi-step logic requiring elimination of multiple options
- Options must be close and tricky — not obviously eliminable
ABSOLUTE RESTRICTION: Only topics from official RRB NTPC/Group D syllabus.
${ACCURACY_RULE}`,

    General: `You are an expert MCQ question setter for competitive exams.
Generate questions on "${topic}".
${DIFFICULTY_LINE}
RULES:
- No "What is X?" or "Define X" questions — every question must require reasoning or application
- All 4 options must be factually related to the topic — no obviously wrong choices
- Wrong options must be common misconceptions or related-but-incorrect facts
- At least 30% questions must be multi-statement or multi-concept
- Explanation must clearly state the reasoning behind the correct answer
${ACCURACY_RULE}`,
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
