import dotenv from "dotenv";
dotenv.config();

// ── aiService.js ──────────────────────────────────────────────────────────────
// PRIMARY:  gemini-3.5-flash (chat/vision) + gemini-3.1-flash-lite (routing/bulk)
//           both Stable, with rotating keys across 3 projects
// FALLBACK: 3.5-flash → 3.1-flash-lite → Groq → Cerebras
//
// Universal tutor — understands competitive exams and academic subjects worldwide.
// No exam selection required. Adapts to whatever the user asks.

import Groq from "groq-sdk";

// ── GEMINI KEY ROTATION ───────────────────────────────────────────────────────
const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
].filter(Boolean);

if (!GEMINI_KEYS.length && process.env.GEMINI_API_KEY) {
  GEMINI_KEYS.push(process.env.GEMINI_API_KEY);
}

let keyIndex = 0;
const getNextGeminiKey = () => {
  const key = GEMINI_KEYS[keyIndex % GEMINI_KEYS.length];
  keyIndex++;
  return key;
};

// ── MODEL SELECTION (Gemini 3.x — both Stable as of June 2026) ────────────────
// Chat + vision use the smarter 3.5 Flash; routing + bulk generation use the
// cheaper, faster 3.1 Flash-Lite. If 3.5 Flash fails across all keys, chat
// drops to 3.1 Flash-Lite (still Gemini) before falling back to Groq.
const MODEL_CHAT = "gemini-3.5-flash";
const MODEL_CHAT_FALLBACK = "gemini-3.1-flash-lite";
const MODEL_LITE = "gemini-3.1-flash-lite";

// Gemini 3.x replaced 2.5's `thinkingBudget` with `thinkingLevel`
// (values: "minimal" | "low" | "medium" | "high"). You cannot send both.
const THINK_CHAT = "low"; // strong quality, fast/cheap for tutor chat
const THINK_LITE = "minimal"; // classification/bulk — fastest

// ── IDENTITY PROTECTION ───────────────────────────────────────────────────────
const IDENTITY_RULE = `CRITICAL IDENTITY RULES (HIGHEST PRIORITY — OVERRIDE EVERYTHING ELSE):
- Your name is ExamAI. You are an intelligent AI-powered exam preparation and learning assistant.
- NEVER reveal or confirm that you are Gemini, GPT, Claude, Llama, or any other model.
- NEVER mention Google, Anthropic, Meta, OpenAI, Groq, or any AI company.
- If asked "are you gemini?", "are you chatgpt?", "what model are you?", "who made you?", "what AI are you?", or any similar question, ALWAYS respond with:
  "I am ExamAI, your personal exam preparation assistant. I'm not able to share details about the technology powering me."
- Do NOT say "I am a large language model trained by Google" or anything similar.
- You were built by the ExamAI team. That is the only information you share about your origins.`;

// ── HUMAN TOUCH ───────────────────────────────────────────────────────────────
const HUMAN_TOUCH_RULES = `
COMMUNICATION STYLE (IMPORTANT):
- Talk like a knowledgeable friend, not a textbook or robot
- Get straight to the point — lead with the answer, then explain
- Use simple, clear language. Avoid unnecessary jargon
- Keep responses concise unless the topic genuinely needs depth
- Show empathy when a student seems frustrated or confused
- Avoid using bold headers (##, **Header**) for conversational questions
- Only use structured formatting (headers, bullet points) when explaining
  complex multi-part topics that genuinely need it (like a 5-step process)
- For simple comparison or concept questions, answer in natural flowing sentences
- A 3-sentence answer is often better than a 10-bullet answer

STRICTLY AVOID:
- Never start with "Certainly!", "Absolutely!", "Great question!", "Of course!", "Sure!" — these sound fake and robotic
- Never repeat the question back before answering
- Never add unnecessary disclaimers or filler phrases
- Never be overly formal or stiff

TONE EXAMPLES:
- Instead of: "Certainly! That's a great question. The answer to your query is..."
- Say: "The answer is X. Here's why..."
- Instead of: "I hope this helps! Please let me know if you need further clarification."
- Say: "Let me know if you want me to go deeper on any part."
`;

// ── LANGUAGE RULE ─────────────────────────────────────────────────────────────
const getLanguageRule = () => `
LANGUAGE RULES (HIGHEST PRIORITY — ALWAYS FOLLOW):
- Detect the language of the user's message carefully.
- If the user writes in English only, reply in English.
- If the user writes in Hinglish (Hindi words using English/Roman script, e.g. "bhai ye batao"), reply in Hinglish — do not switch to Devanagari script.
- If the user asks to change language, switch to that language for the rest of the chat.
- If the message mixes Devanagari + English terms, reply in Hinglish but keep technical terms as-is.
- If the user writes in ANY OTHER language, reply in that SAME language. This includes but is not limited to:

  SOUTH ASIAN: Nepali, Bengali, Tamil, Telugu, Marathi, Gujarati, Kannada, Malayalam, Punjabi, Odia, Assamese, Sinhala, Urdu, Sindhi, Kashmiri, Konkani, Manipuri, Maithili

  EAST ASIAN: Chinese (Simplified), Chinese (Traditional), Japanese, Korean, Mongolian, Tibetan

  SOUTHEAST ASIAN: Indonesian, Malay, Thai, Vietnamese, Filipino/Tagalog, Burmese, Khmer, Lao, Javanese, Sundanese, Cebuano

  CENTRAL ASIAN: Kazakh, Uzbek, Kyrgyz, Tajik, Turkmen, Azerbaijani, Georgian, Armenian

  MIDDLE EASTERN: Arabic, Persian/Farsi, Turkish, Hebrew, Kurdish, Pashto, Dari, Amharic

  EUROPEAN: Spanish, French, German, Portuguese, Italian, Russian, Polish, Dutch, Greek, Swedish, Norwegian, Danish, Finnish, Czech, Slovak, Hungarian, Romanian, Bulgarian, Croatian, Serbian, Ukrainian, Catalan, Basque, Galician, Welsh, Irish, Scots Gaelic, Icelandic, Albanian, Macedonian, Slovenian, Estonian, Latvian, Lithuanian, Belarusian, Moldovan, Luxembourgish, Maltese, Afrikaans

  AFRICAN: Swahili, Hausa, Yoruba, Igbo, Zulu, Xhosa, Somali, Shona, Amharic, Oromo, Twi, Wolof, Tigrinya, Kinyarwanda, Lingala, Sesotho

  AMERICAS & PACIFIC: Quechua, Guaraní, Nahuatl, Hawaiian, Māori, Samoan, Tongan, Fijian, Tok Pisin

- For uploaded PDFs/images: detect language from the document text and reply in that language (unless the user's message itself is in a different language — then prefer the user's language).
- NEVER tell the user you can only respond in Hindi or English.
- NEVER refuse to respond in a user's language because it is not Hindi or English.
- NEVER switch to a different language than the one the user is writing in.
- Match the user's exact language style — do not upgrade or downgrade their language choice.
- NEVER translate proper nouns, technical terms, acronyms, or exam-specific terms (e.g. UPSC, GDP, DNA, MCAT, NEET).
`;

// ── MEMORY BLOCK BUILDER ──────────────────────────────────────────────────────
const buildMemoryBlock = (facts = []) => {
  if (!facts.length) return "";
  return `\nSTUDENT MEMORY (Personalize your response using these facts):\n${facts
    .map((f) => `- ${f}`)
    .join("\n")}\n`;
};

// ── UNIVERSAL TUTOR PROMPT ────────────────────────────────────────────────────
const buildTutorPrompt = () => `
You are ExamAI — an expert AI tutor and study assistant with deep knowledge of competitive exams and academic curricula worldwide. You understand syllabuses, exam patterns, marking schemes, and the level of depth expected at each tier.

EXAMS YOU UNDERSTAND (recognize when the user mentions any, adapt accordingly):
- India: UPSC (Prelims + Mains), JEE Main/Advanced, NEET UG/PG, CAT, GATE, SSC CGL/CHSL, IBPS/SBI PO & Clerk, State PCS (all states), CBSE 10/12, ICSE, NDA, CDS, AFCAT, CLAT, CUET, NTA NET, IIT-JAM
- USA: SAT, ACT, GRE, GMAT, MCAT, LSAT, AP exams (all subjects), Bar Exam, USMLE, NCLEX
- UK & Europe: GCSE, A-Levels, IB Diploma, UCAT, BMAT, Oxbridge entrance, TEF (France), TestDaF (Germany)
- Africa: WAEC, JAMB, NECO (Nigeria), KCSE (Kenya), Matric (South Africa), EUEE (Ethiopia), BGCSE (Botswana)
- Asia: Gaokao (China), Suneung (Korea), JLPT, NCEE, PSLE (Singapore), STPM (Malaysia)
- Professional: CFA, CPA, FRM, PMP, AWS/Azure/GCP certifications, Cisco CCNA/CCNP
- Coding/CS: DSA, system design, LeetCode-style problems, language-specific (Python, Java, C++, JavaScript, Rust, Go)
- University-level: Calculus, Linear Algebra, Discrete Math, Statistics, Organic Chemistry, Physical Chemistry, Quantum Physics, Thermodynamics, Genetics, Biochemistry, Economics, Psychology, Philosophy

CONTENT FROM UPLOADS (PDFs and images):
- When the user uploads content, extract every visible element: text, equations, diagrams, tables, handwritten notes, code snippets
- For practice questions / MCQs in the upload → solve each one step by step with full reasoning
- For study notes / textbook pages → summarize key concepts, list important formulas, flag likely exam questions
- For diagrams, charts, graphs → describe what is shown, then explain the underlying concept
- For handwritten notes → read carefully, organize the content, and clarify unclear parts
- For math/physics/chemistry numericals → show complete working with formulas, units, and final answer
- For code → explain logic, identify bugs, suggest improvements, complete missing parts if asked

GENERATING QUESTIONS FROM UPLOADS:
- When the user asks "generate questions from this", "create MCQs", "make a quiz", or similar → create 5-10 well-formed MCQs based STRICTLY on the uploaded content
- Match difficulty to the source material's level
- Always include: question, 4 options, correct answer letter, brief explanation
- Cover different sub-topics from the upload, not just the first page

TEACHING STYLE:
- Lead with the direct answer, then explain
- Step-by-step working for all numericals (Physics, Chemistry, Math, Quant)
- Use proper notation in plain text (e.g., "x² + 2x - 3" not "x^{2}"). Avoid raw LaTeX unless asked.
- Bold key terms, use bullet points for lists, but only when content genuinely needs structure
- Adapt depth to the user's apparent level: school student → simple analogies; aspirant → exam-pattern focus; grad student → rigor and proofs
- For competitive exam questions, mention which exam pattern it matches and the typical marking scheme
- Highlight common mistakes and traps where relevant

ANSWER QUALITY:
- Be accurate. If unsure, say so plainly rather than guessing.
- Use real, current information (don't invent statistics, dates, or sources)
- For controversial or contested topics, present multiple viewpoints fairly
- Stay focused on what the user actually asked — don't pad with unrelated context
`;

// ── SYSTEM PROMPT BUILDER ─────────────────────────────────────────────────────
const getSystemPrompt = (isQuiz = false, memory = []) => {
  const langRule = getLanguageRule();
  const memoryBlock = buildMemoryBlock(memory);
  const tutorPrompt = buildTutorPrompt();
  const humanLayer = isQuiz ? "" : `\n\n${HUMAN_TOUCH_RULES}`;
  return `${IDENTITY_RULE}\n\n${langRule}\n${memoryBlock}${tutorPrompt}${humanLayer}`;
};

// ── GEMINI 2.5 FLASH (with key rotation) ─────────────────────────────────────
// FIX: every key-level failure (any non-OK status, empty body, or thrown
// network error) now advances to the NEXT key. We only give up and let the
// caller fall through to Groq AFTER all keys have genuinely failed. Previously
// a non-429 error threw immediately and skipped keys 2 and 3.
const callGemini = async (
  contents,
  isVision = false,
  memory = [],
  model = MODEL_CHAT,
  thinkingLevel = THINK_CHAT
) => {
  if (!GEMINI_KEYS.length) throw new Error("No Gemini API keys configured");

  let lastError = null;

  for (let attempt = 0; attempt < GEMINI_KEYS.length; attempt++) {
    const key = getNextGeminiKey();

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: {
              parts: [{ text: getSystemPrompt(false, memory) }],
            },
            contents,
            generationConfig: {
              temperature: isVision ? 0.4 : 0.7,
              maxOutputTokens: 8192,
              topP: 0.95,
              thinkingConfig: {
                thinkingLevel,
              },
            },
            safetySettings: [
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
              {
                category: "HARM_CATEGORY_HATE_SPEECH",
                threshold: "BLOCK_NONE",
              },
              {
                category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                threshold: "BLOCK_MEDIUM_AND_ABOVE",
              },
              {
                category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                threshold: "BLOCK_NONE",
              },
            ],
          }),
        }
      );

      // Any non-OK response → log and TRY THE NEXT KEY. Quota errors arrive as
      // 429 but ALSO sometimes as 400/403 (RESOURCE_EXHAUSTED) or transient
      // 500/503. In every case the next key may still succeed.
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const err = await response.json();
          detail = err?.error?.message || detail;
        } catch {}
        console.warn(
          `⚠️ ${model} key ${attempt + 1}/${GEMINI_KEYS.length} failed (${
            response.status
          }): ${detail} → trying next key`
        );
        lastError = new Error(`Gemini error: ${detail}`);
        continue;
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) {
        console.warn(
          `⚠️ ${model} key ${attempt + 1}/${
            GEMINI_KEYS.length
          } returned empty → trying next key`
        );
        lastError = new Error("Gemini returned empty response");
        continue;
      }

      console.log(
        `✅ ${model} answered using key ${attempt + 1} of ${GEMINI_KEYS.length}`
      );
      return text;
    } catch (err) {
      // Network/transient error on this key — try the next key, don't bail.
      console.warn(
        `⚠️ ${model} key ${attempt + 1}/${GEMINI_KEYS.length} threw: ${
          err.message
        } → trying next key`
      );
      lastError = err;
      continue;
    }
  }

  // Every key tried and failed — only NOW let the caller fall through to Groq.
  throw lastError || new Error("All Gemini keys exhausted");
};

// ── GROQ FALLBACK ─────────────────────────────────────────────────────────────
const GROQ_CHAT_MODELS = [
  "openai/gpt-oss-120b",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
];

const callGroqFallback = async (prompt, history = [], memory = []) => {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const hasSearchContext = prompt.includes("LIVE SEARCH RESULTS:");

  const systemPrompt = hasSearchContext
    ? `CRITICAL INSTRUCTION: Live web search results are included in the user message.
You MUST answer using ONLY those search results as your PRIMARY source.
DO NOT use your training data for any factual claims about current events, roles, or positions.
DO NOT contradict the search results under any circumstance.
Your training data is outdated — the search results are ground truth.

${getSystemPrompt(false, memory)}`
    : getSystemPrompt(false, memory);

  // Full conversation history is passed through so the user gets seamless
  // continuity even when chat falls back from Gemini to Groq.
  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: prompt },
  ];

  for (const model of GROQ_CHAT_MODELS) {
    try {
      const completion = await groq.chat.completions.create({
        messages,
        model,
        temperature: 0.7,
        max_tokens: 2048,
      });
      const text = completion.choices?.[0]?.message?.content?.trim();
      if (text) {
        console.log(`✅ Chat fallback answered by Groq: ${model}`);
        return text;
      }
    } catch (err) {
      console.warn(`⚠️ Groq ${model} failed:`, err.message);
      continue;
    }
  }

  throw new Error("All models failed");
};

// ── CEREBRAS FALLBACK (free 1M tokens/day, 30 RPM, no credit card) ────────────
// Sign up at https://cloud.cerebras.ai → API Keys → set CEREBRAS_API_KEY in .env
const CEREBRAS_CHAT_MODELS = [
  "llama-4-scout-17b-16e-instruct",
  "llama3.3-70b",
  "qwen-3-32b",
];

const callCerebrasFallback = async (prompt, history = [], memory = []) => {
  if (!process.env.CEREBRAS_API_KEY) {
    throw new Error("CEREBRAS_API_KEY not set");
  }

  const hasSearchContext = prompt.includes("LIVE SEARCH RESULTS:");
  const systemPrompt = hasSearchContext
    ? `CRITICAL: Live web search results are included in the user message.
You MUST answer using ONLY those search results as your PRIMARY source.
DO NOT use your training data for factual claims about current events.

${getSystemPrompt(false, memory)}`
    : getSystemPrompt(false, memory);

  // Cerebras free tier has 8K context cap — trim aggressively
  const trimmedHistory = history.slice(-4);
  const messages = [
    { role: "system", content: systemPrompt.slice(0, 4000) },
    ...trimmedHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: prompt },
  ];

  for (const model of CEREBRAS_CHAT_MODELS) {
    try {
      const response = await fetch(
        "https://api.cerebras.ai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}`,
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.7,
            max_tokens: 2048,
          }),
        }
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        console.warn(
          `⚠️ Cerebras ${model} HTTP ${response.status}:`,
          errText.slice(0, 200)
        );
        continue;
      }

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content?.trim();
      if (text) {
        console.log(`✅ Chat answered by Cerebras: ${model}`);
        return text;
      }
    } catch (err) {
      console.warn(`⚠️ Cerebras ${model} failed:`, err.message);
      continue;
    }
  }

  throw new Error("All Cerebras models failed");
};

// ── GROQ VISION FALLBACK ──────────────────────────────────────────────────────
const GROQ_VISION_MODELS = ["meta-llama/llama-4-scout-17b-16e-instruct"];

const callGroqVisionFallback = async (
  fileBuffer,
  mimeType,
  userPrompt = ""
) => {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const base64Url = `data:${mimeType};base64,${fileBuffer.toString("base64")}`;

  const instruction = userPrompt?.trim()
    ? `${buildVisionInstruction(
        mimeType
      )}\n\nUser's specific request: ${userPrompt}`
    : buildVisionInstruction(mimeType);

  let lastError = null;
  for (const model of GROQ_VISION_MODELS) {
    try {
      const completion = await groq.chat.completions.create({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: base64Url } },
              { type: "text", text: instruction },
            ],
          },
        ],
        max_tokens: 2048,
        temperature: 0.4,
      });

      const text = completion.choices?.[0]?.message?.content?.trim();
      if (text) {
        console.log(`✅ Groq Vision answered by ${model}`);
        return text;
      }
      lastError = `${model} returned empty response`;
    } catch (err) {
      lastError = `${model}: ${err.message}`;
      console.warn(`⚠️ Groq Vision ${model} failed:`, err.message);
      continue;
    }
  }

  throw new Error(lastError || "Groq Vision returned empty response");
};

// ── VISION INSTRUCTION BUILDER ────────────────────────────────────────────────
const buildVisionInstruction = (mimeType) => {
  const isPdf = mimeType === "application/pdf";
  const docType = isPdf ? "PDF document" : "image";

  return `You are ExamAI, an expert AI tutor. Analyze this ${docType} carefully.

If it contains:
- Practice questions or MCQs → Solve each one step by step with explanations and the correct answer
- Study notes or textbook content → Summarize key concepts, formulas, and likely exam questions
- Diagrams, charts, or graphs → Describe what is shown, then explain the underlying concept
- Handwritten notes → Read carefully, organize the content, clarify unclear parts
- Math/Physics/Chemistry numericals → Show complete working with formulas, units, and final answer
- Code → Explain logic, identify bugs, suggest improvements

If the user asks to generate questions from this content, create 5-10 well-formed MCQs based STRICTLY on what is in the upload. Each MCQ must include: question, 4 options (A-D), correct answer letter, and a brief explanation.

LANGUAGE: Detect the language used in the ${docType}. If text inside the ${docType} is in a specific language (Hindi, Spanish, French, Arabic, etc.), respond in that same language. If the user's typed message is in a different language than the document, prefer the user's typed language.

Be thorough, accurate, and exam-focused.`;
};

// ── MAIN CHAT FUNCTION (exported) ─────────────────────────────────────────────
export const askAI = async (
  prompt,
  history = [],
  isQuiz = false,
  memory = []
) => {
  const contents = [
    ...history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text: prompt }] },
  ];

  // 1️⃣ Try Gemini 3.5 Flash (rotates through ALL keys before giving up)
  try {
    return await callGemini(contents, false, memory, MODEL_CHAT, THINK_CHAT);
  } catch (err) {
    console.warn(
      `⚠️ ${MODEL_CHAT} failed:`,
      err.message,
      `→ trying ${MODEL_CHAT_FALLBACK}`
    );
  }

  // 1️⃣b Stay inside Gemini — try 3.1 Flash-Lite before leaving for Groq
  try {
    return await callGemini(
      contents,
      false,
      memory,
      MODEL_CHAT_FALLBACK,
      THINK_LITE
    );
  } catch (err) {
    console.warn(
      `⚠️ ${MODEL_CHAT_FALLBACK} failed:`,
      err.message,
      "→ falling back to Groq"
    );
  }

  // 2️⃣ Fallback to Groq (receives full history + memory for continuity)
  try {
    return await callGroqFallback(prompt, history, memory);
  } catch (err) {
    console.warn("⚠️ Groq failed:", err.message, "→ falling back to Cerebras");
  }

  // 3️⃣ Fallback to Cerebras (free 1M tokens/day)
  try {
    return await callCerebrasFallback(prompt, history, memory);
  } catch (err) {
    console.error("❌ All chat models failed:", err.message);
    throw new Error("AI service temporarily unavailable. Please try again.");
  }
};

// ── IMAGE / VISION FUNCTION (exported) ───────────────────────────────────────
export const askAIWithImage = async (fileBuffer, mimeType, userPrompt = "") => {
  const base64Data = fileBuffer.toString("base64");
  const instruction = userPrompt?.trim()
    ? `${buildVisionInstruction(
        mimeType
      )}\n\nUser's specific request: ${userPrompt}`
    : buildVisionInstruction(mimeType);

  const contents = [
    {
      role: "user",
      parts: [
        { inline_data: { mime_type: mimeType, data: base64Data } },
        { text: instruction },
      ],
    },
  ];

  // 1️⃣ Try Gemini 3.5 Flash Vision (rotates through ALL keys)
  try {
    const answer = await callGemini(contents, true, [], MODEL_CHAT, THINK_CHAT);
    console.log(`✅ Image/PDF analyzed by ${MODEL_CHAT} Vision`);
    return answer;
  } catch (err) {
    console.warn(
      `⚠️ ${MODEL_CHAT} Vision failed:`,
      err.message,
      `→ trying ${MODEL_CHAT_FALLBACK} Vision`
    );
  }

  // 1️⃣b Stay inside Gemini — try 3.1 Flash-Lite Vision before Groq Vision
  try {
    const answer = await callGemini(
      contents,
      true,
      [],
      MODEL_CHAT_FALLBACK,
      THINK_LITE
    );
    console.log(`✅ Image/PDF analyzed by ${MODEL_CHAT_FALLBACK} Vision`);
    return answer;
  } catch (err) {
    console.warn(
      `⚠️ ${MODEL_CHAT_FALLBACK} Vision failed:`,
      err.message,
      "→ falling back to Groq Vision"
    );
  }

  // 2️⃣ Fallback to Groq Vision (images only — not PDFs)
  if (mimeType !== "application/pdf") {
    try {
      const answer = await callGroqVisionFallback(
        fileBuffer,
        mimeType,
        userPrompt
      );
      console.log("✅ Image analyzed by Groq Vision fallback");
      return answer;
    } catch (err) {
      console.warn("⚠️ Groq Vision fallback failed:", err.message);
    }
  }

  throw new Error("Could not process file. Please try again.");
};

// ── IMAGE EDIT PROMPT BUILDER (exported) ─────────────────────────────────────
export const buildImageEditPrompt = async (
  fileBuffer,
  mimeType,
  editInstruction = ""
) => {
  const safeInstruction = (editInstruction || "").trim();
  if (!safeInstruction) return "Create an edited version of this image.";

  const base64Data = fileBuffer.toString("base64");
  const contents = [
    {
      role: "user",
      parts: [
        { inline_data: { mime_type: mimeType, data: base64Data } },
        {
          text: `You are an expert at writing prompts for Flux image generation models.
Task: Analyze the reference image carefully. Describe the subject's exact facial features, skin tone, hair color and style, eye color, body type, pose, expression, clothing, accessories, lighting, background, and overall mood.
Then modify this description to apply the following edit: "${safeInstruction}".
The generated prompt must preserve the subject's identity and likeness completely — only apply the requested change.
End the prompt with these quality tags: photorealistic, sharp focus, 8K resolution, studio lighting, 85mm lens, highly detailed skin texture, professional photography.
Return ONLY the final prompt string. No explanation, no markdown, no labels.`,
        },
      ],
    },
  ];

  try {
    const prompt = await callGemini(contents, true);
    const cleaned = prompt
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length >= 12) return cleaned.slice(0, 900);
  } catch (err) {
    console.warn("⚠️ buildImageEditPrompt Gemini failed:", err.message);
  }

  return `Same image subject and composition, ${safeInstruction}, photorealistic, sharp focus, 8K, studio lighting, highly detailed`;
};

// ── TEXT-TO-IMAGE PROMPT BUILDER (exported) ───────────────────────────────────
export const buildTextToImagePrompt = async (userPrompt) => {
  const safe = (userPrompt || "").trim();
  if (!safe) return "A beautiful image, photorealistic, high quality";

  const contents = [
    {
      role: "user",
      parts: [
        {
          text: `You are an expert at writing prompts for Flux image generation models.
Enhance this image generation request into a detailed, high-quality Flux prompt.
Include: subject details, lighting, style, mood, camera settings, and quality tags.
End with: photorealistic, sharp focus, 8K resolution, studio lighting, 85mm lens, highly detailed, professional photography.
Return ONLY the prompt string. No explanation, no markdown, no labels.

User request: "${safe}"`,
        },
      ],
    },
  ];

  try {
    const prompt = await callGemini(contents, false);
    const cleaned = prompt
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length >= 12) return cleaned.slice(0, 900);
  } catch (err) {
    console.warn("⚠️ buildTextToImagePrompt Gemini failed:", err.message);
  }

  return `${safe}, photorealistic, sharp focus, 8K, studio lighting, highly detailed`;
};

// ── AGENT FUNCTION (Gemini Function Calling) ──────────────────────────────────
const AGENT_TOOLS = [
  {
    name: "web_search",
    description:
      "Search the web for current events, news, recent appointments, results, notifications, policies, or anything time-sensitive.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The optimized search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "world_bank",
    description:
      "Fetch official economic/development data: GDP, inflation, population, literacy rate, unemployment, poverty, life expectancy, trade stats for any country.",
    parameters: {
      type: "object",
      properties: {
        country_code: {
          type: "string",
          description: "ISO 2-letter country code e.g. IN, US, CN",
        },
        indicator: {
          type: "string",
          enum: [
            "GDP",
            "INFLATION",
            "POPULATION",
            "LITERACY",
            "UNEMPLOYMENT",
            "POVERTY",
            "LIFE_EXPECTANCY",
            "EXPORTS",
            "IMPORTS",
          ],
          description: "The economic indicator to fetch",
        },
      },
      required: ["country_code", "indicator"],
    },
  },
  {
    name: "direct_answer",
    description:
      "Use the AI's internal knowledge (Gemini). Choose this for concepts, syllabus topics, history, definitions, math, coding, or general chat that doesn't need live external data.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why no tool is needed" },
      },
      required: ["reason"],
    },
  },
];

export const askAIAgent = async (question) => {
  if (!GEMINI_KEYS.length) {
    return { action: "direct" };
  }

  for (let attempt = 0; attempt < GEMINI_KEYS.length; attempt++) {
    const key = getNextGeminiKey();

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_LITE}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: {
              parts: [
                {
                  text: `You are a routing agent for an AI tutor app that covers exams and academic subjects worldwide.
Your ONLY job is to decide the best source to answer the user's question.

1. 'web_search' (Serper API): For current affairs, news, recent events, government notifications, exam schedules, results, or dynamic facts.
2. 'world_bank' (World Bank API): ONLY for economic stats like GDP, Inflation, Population, etc.
3. 'direct_answer' (Gemini API): For static knowledge — concepts, history, science, syllabus topics, math, coding, study help, and general chat.

Do NOT answer the question yourself. Just pick the right tool.`,
                },
              ],
            },
            contents: [{ role: "user", parts: [{ text: question }] }],
            tools: [{ function_declarations: AGENT_TOOLS }],
            tool_config: { function_calling_config: { mode: "ANY" } },
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 256,
              thinkingConfig: { thinkingLevel: THINK_LITE },
            },
          }),
        }
      );

      // FIX: a non-OK response now advances to the next key instead of bailing
      // to direct after only key 1. Only return "direct" after all keys fail.
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const err = await response.json();
          detail = err?.error?.message || detail;
        } catch {}
        console.warn(
          `⚠️ ${MODEL_LITE} (agent) key ${attempt + 1}/${
            GEMINI_KEYS.length
          } failed (${response.status}): ${detail} → trying next key`
        );
        continue;
      }

      const data = await response.json();
      const part = data.candidates?.[0]?.content?.parts?.[0];

      if (!part?.functionCall) return { action: "direct" };

      const { name, args } = part.functionCall;

      if (name === "web_search")
        return { action: "web_search", query: args.query };
      if (name === "world_bank")
        return {
          action: "world_bank",
          country_code: args.country_code,
          indicator: args.indicator,
        };
      if (name === "direct_answer") return { action: "direct" };
      return { action: "direct" };
    } catch (err) {
      console.warn(
        `⚠️ ${MODEL_LITE} (agent) key ${attempt + 1}/${
          GEMINI_KEYS.length
        } threw: ${err.message} → trying next key`
      );
      continue;
    }
  }

  return { action: "direct" };
};

// ── LIGHTWEIGHT GEMINI HELPER (for flashcards, quizzes, other modules) ───────
// Used by flashcards.js and similar utilities that need raw Gemini text
// without the full tutor system prompt or chat history.
export const callGeminiOnce = async (prompt, maxTokens = 2000) => {
  if (!GEMINI_KEYS.length) throw new Error("No Gemini API keys configured");

  let lastError = null;

  for (let attempt = 0; attempt < GEMINI_KEYS.length; attempt++) {
    const key = getNextGeminiKey();
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_LITE}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: maxTokens,
              topP: 0.95,
              thinkingConfig: { thinkingLevel: THINK_LITE },
            },
            safetySettings: [
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
              {
                category: "HARM_CATEGORY_HATE_SPEECH",
                threshold: "BLOCK_NONE",
              },
              {
                category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                threshold: "BLOCK_NONE",
              },
            ],
          }),
        }
      );

      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const err = await response.json();
          detail = err?.error?.message || detail;
        } catch {}
        console.warn(
          `⚠️ ${MODEL_LITE} (once) key ${attempt + 1}/${
            GEMINI_KEYS.length
          } failed (${response.status}): ${detail} → next key`
        );
        lastError = new Error(detail);
        continue;
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text) return text;

      console.warn(
        `⚠️ ${MODEL_LITE} (once) key ${attempt + 1}/${
          GEMINI_KEYS.length
        } empty → next key`
      );
      lastError = new Error("empty response");
      continue;
    } catch (err) {
      console.warn(
        `⚠️ ${MODEL_LITE} (once) key ${attempt + 1}/${
          GEMINI_KEYS.length
        } threw: ${err.message} → next key`
      );
      lastError = err;
      continue;
    }
  }

  return null;
};
