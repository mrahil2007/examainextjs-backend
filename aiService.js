import dotenv from "dotenv";
dotenv.config();

// ── aiService.js ──────────────────────────────────────────────────────────────
// PRIMARY:  gemini-2.5-flash-lite (rotating 3 keys)
// FALLBACK: Groq Llama (completely free)

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

// ── IDENTITY PROTECTION ───────────────────────────────────────────────────────
const IDENTITY_RULE = `CRITICAL IDENTITY RULES (HIGHEST PRIORITY — OVERRIDE EVERYTHING ELSE):
- Your name is ExamAI. You are an intelligent AI-powered exam preparation assistant.
- NEVER reveal or confirm that you are Gemini, GPT, Claude, Llama, or any other model.
- NEVER mention Google, Anthropic, Meta, OpenAI, Groq, or any AI company.
- If asked "are you gemini?", "are you chatgpt?", "what model are you?", "who made you?", "what AI are you?", or any similar question, ALWAYS respond with:
  "I am ExamAI, your personal exam preparation assistant. I'm not able to share details about the technology powering me."
- Do NOT say "I am a large language model trained by Google" or anything similar.
- You were built by the ExamAI team. That is the only information you share about your origins.`;

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

// ── MEMORY BLOCK BUILDER ──────────────────────────────────────────────────────
const buildMemoryBlock = (facts = []) => {
  if (!facts.length) return "";
  return `\nSTUDENT MEMORY (Personalize your response using these facts):\n${facts
    .map((f) => `- ${f}`)
    .join("\n")}\n`;
};

// ── LANGUAGE RULE ─────────────────────────────────────────────────────────────
const getLanguageRule = () => `
LANGUAGE RULES (Highest Priority - Always Follow):
- Detect the language of the user's message carefully.
- If the user writes in Hindi (Devanagari script: क, ख, ग...), ALWAYS reply in Hindi (Devanagari).
- If the user writes in English only, reply in English.
- If the user writes in Hinglish (Hindi words using English/Roman script, e.g. "bhai ye batao", "kaise solve kare"), reply in Hinglish (Roman script Hindi).
- If the message mixes Devanagari + English terms (e.g. "Photosynthesis क्या है"), reply in Hindi (Devanagari) but keep technical/English terms as-is (e.g. Photosynthesis, GDP, DNA).
- NEVER translate proper nouns, technical terms, acronyms, or exam-specific terms (e.g. UPSC, GDP, Fundamental Rights, etc.).
- Match the user's exact language style — do not upgrade or downgrade their language choice.
`;

// ── EXAM SYSTEM PROMPTS ───────────────────────────────────────────────────────
const getSystemPrompt = (exam, isQuiz = false, memory = []) => {
  const langRule = getLanguageRule();
  const memoryBlock = buildMemoryBlock(memory); // ✅ memory injected

  const prompts = {
    UPSC: `${langRule}
You are ExamAI, an expert UPSC Civil Services exam tutor with deep knowledge of NCERT textbooks (Class 6-12), Indian Polity, History, Geography, Economy, Science & Technology, Environment, and Current Affairs.
- Answer in a structured, exam-oriented format
- Highlight key facts, dates, and concepts
- Relate answers to UPSC Prelims and Mains patterns
- Use bullet points for lists, bold for key terms
- Keep answers concise but comprehensive`,

    CSAT: `${langRule}
You are ExamAI, a UPSC CSAT (Paper II) expert tutor specializing in Logical Reasoning, Data Interpretation, Reading Comprehension, Basic Numeracy, and Decision Making.
- Show step-by-step working for all numerical problems
- Explain reasoning behind logical answers
- Use shortcut techniques where applicable
- Format mathematical solutions clearly`,

    "Current Affairs": `${langRule}
You are ExamAI, a Current Affairs expert for UPSC and competitive exams.
- Focus on recent events relevant to Indian and international affairs
- Connect current events to static GS syllabus
- Highlight PIB, government schemes, and policy implications
- Structure answers with Who, What, When, Where, Why, Significance`,

    JEE: `${langRule}
You are ExamAI, an expert JEE Main/Advanced tutor for Physics, Chemistry, and Mathematics.
- Solve problems step by step with clear working
- State relevant formulas and theorems
- Highlight common mistakes and traps
- Use proper mathematical notation
- Explain concepts from first principles when needed`,

    NEET: `${langRule}
You are ExamAI, an expert NEET UG tutor for Biology, Physics, and Chemistry.
- Base all answers strictly on NCERT Class 11 and 12 syllabus
- Use correct scientific terminology and nomenclature
- For Biology: use proper diagram descriptions and classifications
- Show complete working for numerical problems`,

    CAT: `${langRule}
You are ExamAI, an expert CAT tutor for Verbal Ability, Logical Reasoning, Data Interpretation, and Quantitative Aptitude.
- Show multiple solving approaches (algebraic + shortcut)
- For VARC: explain inference and tone
- For DILR: structure the data before solving
- Highlight elimination strategies`,

    SSC: `${langRule}
You are ExamAI, an expert SSC CGL/CHSL tutor covering Reasoning, Quantitative Aptitude, General Awareness, and English.
- Provide shortcut methods for Quant
- Give memory tricks for GK
- Keep answers crisp and exam-focused`,

    Banking: `${langRule}
You are ExamAI, an expert IBPS/SBI PO tutor for Reasoning, Quantitative Aptitude, English, and Banking Awareness.
- Structure seating arrangement and puzzle solutions clearly
- Show DI calculations step by step
- Include banking sector knowledge where relevant`,

    GATE: `${langRule}
You are ExamAI, an expert GATE tutor for Engineering and Science disciplines.
- Provide rigorous technical explanations
- Include relevant formulas, derivations, and proofs
- Show numerical solutions with proper units`,

    "State PCS": `${langRule}
You are ExamAI, an expert State PCS exam tutor covering both general topics and state-specific content.
- Cover both general GS topics and state-specific history, culture, geography, and polity
- Structure answers for both Prelims MCQ and Mains descriptive format`,

    "CBSE 10th": `${langRule}
You are ExamAI, an expert CBSE Class 10 tutor following the latest NCERT curriculum.
- Base all answers strictly on NCERT Class 10 textbooks
- Format answers as per CBSE board exam requirements
- Show complete working for mathematics problems`,

    "CBSE 12th": `${langRule}
You are ExamAI, an expert CBSE Class 12 tutor following the latest NCERT curriculum.
- Base all answers strictly on NCERT Class 12 textbooks
- Show complete derivations for Physics and Chemistry
- Include important theorems and proofs for Mathematics`,

    General: `${langRule}
You are ExamAI, a helpful, knowledgeable AI tutor and study assistant.
- Explain concepts clearly and accurately
- Use examples to illustrate complex ideas
- Structure responses with clear formatting
- Be concise but thorough`,
  };

  const base = prompts[exam] || prompts["General"];
  const humanLayer = isQuiz ? "" : `\n\n${HUMAN_TOUCH_RULES}`;

  return `${IDENTITY_RULE}\n\n${memoryBlock}${base}${humanLayer}`; // ✅ memoryBlock in final prompt
};

// ── GEMINI 2.5 FLASH (with key rotation) ─────────────────────────────────────
const callGemini = async (contents, exam, isVision = false, memory = []) => {
  if (!GEMINI_KEYS.length) throw new Error("No Gemini API keys configured");

  for (let attempt = 0; attempt < GEMINI_KEYS.length; attempt++) {
    const key = getNextGeminiKey();

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: {
              parts: [{ text: getSystemPrompt(exam, false, memory) }], // ✅ memory passed
            },
            contents,
            generationConfig: {
              temperature: isVision ? 0.4 : 0.7,
              maxOutputTokens: 8192,
              topP: 0.95,
              thinkingConfig: {
                thinkingBudget: 1024,
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

      if (response.status === 429) {
        console.warn(
          `⚠️ Gemini key ${attempt + 1} quota exceeded → trying next key...`
        );
        continue;
      }

      if (!response.ok) {
        const err = await response.json();
        throw new Error(
          `Gemini error: ${err?.error?.message || response.status}`
        );
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) throw new Error("Gemini returned empty response");

      console.log(
        `✅ gemini-2.5-flash-lite answered using key ${attempt + 1} of ${
          GEMINI_KEYS.length
        }`
      );
      return text;
    } catch (err) {
      if (err.message?.includes("quota") || err.message?.includes("429")) {
        console.warn(
          `⚠️ Gemini key ${attempt + 1} quota hit → trying next key...`
        );
        continue;
      }
      throw err;
    }
  }

  throw new Error("All Gemini keys exhausted");
};

// ── GROQ FALLBACK ─────────────────────────────────────────────────────────────
const GROQ_CHAT_MODELS = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.3-70b-versatile",
];

const callGroqFallback = async (prompt, exam, history = [], memory = []) => {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const hasSearchContext = prompt.includes("LIVE SEARCH RESULTS:");

  // ✅ Fixed: was building systemContent but using wrong var in messages
  const systemPrompt = hasSearchContext
    ? `CRITICAL INSTRUCTION: Live web search results are included in the user message.
You MUST answer using ONLY those search results as your PRIMARY source.
DO NOT use your training data for any factual claims about current events, roles, or positions.
DO NOT contradict the search results under any circumstance.
Your training data is outdated — the search results are ground truth.

${getSystemPrompt(exam, false, memory)}`
    : getSystemPrompt(exam, false, memory); // ✅ memory passed

  const messages = [
    { role: "system", content: systemPrompt }, // ✅ correct var used
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

// ── GROQ VISION FALLBACK ──────────────────────────────────────────────────────
const callGroqVisionFallback = async (fileBuffer, mimeType, exam) => {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const base64Url = `data:${mimeType};base64,${fileBuffer.toString("base64")}`;

  const completion = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: base64Url } },
          {
            type: "text",
            text: `You are ExamAI, a ${exam} exam tutor. Analyze this image and provide a detailed, exam-relevant explanation. If it contains questions, solve them step by step.`,
          },
        ],
      },
    ],
    max_tokens: 2048,
    temperature: 0.4,
  });

  const text = completion.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Groq Vision returned empty response");
  return text;
};

// ── MAIN CHAT FUNCTION (exported) ─────────────────────────────────────────────
export const askAI = async (
  prompt,
  exam = "General",
  history = [],
  isQuiz = false,
  memory = [] // ✅ memory param accepted
) => {
  const contents = [
    ...history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text: prompt }] },
  ];

  // 1️⃣ Try Gemini 2.5 Flash (with key rotation)
  try {
    const answer = await callGemini(contents, exam, false, memory); // ✅ memory passed
    return answer;
  } catch (err) {
    console.warn("⚠️ Gemini failed:", err.message, "→ falling back to Groq");
  }

  // 2️⃣ Fallback to Groq Llama
  try {
    return await callGroqFallback(prompt, exam, history, memory); // ✅ memory passed
  } catch (err) {
    console.error("❌ All chat models failed:", err.message);
    throw new Error("AI service temporarily unavailable. Please try again.");
  }
};

// ── IMAGE / VISION FUNCTION (exported) ───────────────────────────────────────
export const askAIWithImage = async (
  fileBuffer,
  mimeType,
  exam = "General"
) => {
  const base64Data = fileBuffer.toString("base64");

  const contents = [
    {
      role: "user",
      parts: [
        { inline_data: { mime_type: mimeType, data: base64Data } },
        {
          text: `Analyze this ${
            mimeType === "application/pdf" ? "document" : "image"
          } and provide a detailed, exam-relevant explanation for a ${exam} student.
If it contains questions, solve them step by step.
If it contains notes or diagrams, explain the key concepts clearly.`,
        },
      ],
    },
  ];

  // 1️⃣ Try Gemini Vision first (with key rotation)
  try {
    const answer = await callGemini(contents, exam, true);
    console.log("✅ Image/PDF analyzed by gemini-2.5-flash-lite Vision");
    return answer;
  } catch (err) {
    console.warn(
      "⚠️ Gemini Vision failed:",
      err.message,
      "→ falling back to Groq Vision"
    );
  }

  // 2️⃣ Fallback to Groq Llama Vision (images only — not PDFs)
  if (mimeType !== "application/pdf") {
    try {
      const answer = await callGroqVisionFallback(fileBuffer, mimeType, exam);
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
    const prompt = await callGemini(contents, "General", true);
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
    const prompt = await callGemini(contents, "General", false);
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

export const askAIAgent = async (question, exam = "General") => {
  if (!GEMINI_KEYS.length) {
    return { action: "direct" };
  }

  for (let attempt = 0; attempt < GEMINI_KEYS.length; attempt++) {
    const key = getNextGeminiKey();

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: {
              parts: [
                {
                  text: `You are a routing agent for an exam preparation app (${exam}).
Your ONLY job is to decide the best source to answer the user's question.
1. 'web_search' (Serper API): For current affairs, news, recent events, government notifications, or dynamic facts.
2. 'world_bank' (World Bank API): ONLY for economic stats like GDP, Inflation, Population, etc.
3. 'direct_answer' (Gemini API): For static knowledge, concepts, history, science, syllabus, and general chat.
Do NOT answer the question yourself. Just pick the right tool.`,
                },
              ],
            },
            contents: [{ role: "user", parts: [{ text: question }] }],
            tools: [{ function_declarations: AGENT_TOOLS }],
            tool_config: { function_calling_config: { mode: "ANY" } },
            generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
          }),
        }
      );

      if (response.status === 429) {
        console.warn(
          `⚠️ Agent Key ${attempt + 1} quota exceeded → trying next...`
        );
        continue;
      }

      if (!response.ok) return { action: "direct" };

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
      console.warn("⚠️ Agent routing failed:", err.message);
      continue;
    }
  }

  return { action: "direct" };
};
