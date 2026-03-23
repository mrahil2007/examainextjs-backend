// ═══════════════════════════════════════════════════════════════════════════
// server.js — Main Express server
// ═══════════════════════════════════════════════════════════════════════════

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

import express from "express";
import cors from "cors";
import multer from "multer";
import { extractText } from "unpdf";
import {
  askAI,
  askAIWithImage,
  buildImageEditPrompt,
  buildTextToImagePrompt,
} from "./aiService.js";
import Groq from "groq-sdk";
import { MongoClient, ObjectId } from "mongodb";
import rateLimit from "express-rate-limit";
import admin from "firebase-admin";

// ── Separated modules ─────────────────────────────────────────────────────────
import { initFirebase, runJobFetcher, startJobCron } from "./JobFetcher.js";
import cron from "node-cron";
import createJobRouter from "./JobRouter.js";
import createResumeRouter from "./ResumeBuilder.js";

if (!process.env.GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY missing!");
  process.exit(1);
}
if (!process.env.MONGODB_URI) {
  console.error("❌ MONGODB_URI missing!");
  process.exit(1);
}

// ── Firebase Admin init ───────────────────────────────────────────────────────
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    if (!admin.apps.length) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log("✅ Firebase Admin initialized");
    }
  } catch (e) {
    console.warn("⚠️ Firebase Admin init failed:", e.message);
  }
} else {
  console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT not set — FCM push disabled.");
}

// ── FCM helper ────────────────────────────────────────────────────────────────
export const sendPushNotification = async (
  token,
  title,
  body,
  type = "general"
) => {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return;
  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      data: { type },
      android: {
        priority: "high",
        notification: {
          channelId:
            type === "job"
              ? "job_alerts"
              : type === "current_affairs"
              ? "current_affairs"
              : "general",
        },
      },
    });
  } catch (e) {
    console.warn("⚠️ FCM send failed:", e.message);
  }
};

const app = express();
app.set("trust proxy", 1);

app.use(
  cors({
    origin: [
      "https://examai-in.com",
      "https://www.examai-in.com",
      "https://ai-exam-tutor-ten.vercel.app",

      "http://localhost:3000",
    ],
    methods: ["GET", "POST", "PATCH", "DELETE"],
  })
);
app.use(express.json({ limit: "10kb" }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Too many requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: "Too many AI requests. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});
const quizLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: "Limit reached. Try again in an hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(apiLimiter);
app.use("/chat", aiLimiter);
app.use("/chart/generate", aiLimiter);
app.use("/image", aiLimiter);
app.use("/quiz/generate", quizLimiter);

// ✅ FIX: Multer with 5MB file size limit — prevents large uploads consuming RAM
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const infipApiKey = process.env.INFIP_API_KEY || "";
if (!infipApiKey)
  console.warn("⚠️  INFIP_API_KEY not set — image generation will fail.");

initFirebase();

// ── MongoDB ───────────────────────────────────────────────────────────────────
let db;
const client = new MongoClient(process.env.MONGODB_URI);

async function connectDB() {
  await client.connect();
  db = client.db("examai");
  await db.collection("quizzes").createIndex({ topic: 1, exam: 1 });
  await db
    .collection("quiz_results")
    .createIndex({ userId: 1, exam: 1, topic: 1, quizId: 1 });
  console.log("✅ MongoDB connected");
}

const getChats = () => db.collection("chats");
const getQuizResults = () => db.collection("quiz_results");
const getJobs = () => db.collection("jobs");
const getUsers = () => db.collection("users");
const getResumes = () => db.collection("resumes");
const getMemories = () => db.collection("memories");
const getQuizzes = () => db.collection("quizzes");

app.use("/jobs", createJobRouter(getJobs));
app.use("/resume", createResumeRouter(getResumes));

// ── All exams + languages ─────────────────────────────────────────────────────
const ALL_EXAMS = [
  "UPSC",
  "CLAT-UG",
  "CUET-UG",
  "NDA",
  "UGC-NET",
  "GATE",
  "GMAT",
  "SSC CGL",
  "SSC CHSL",
  "Banking",
  "Railway",
  "Defence",
  "State PSC",
  "Teaching",
  "Police",
  "General",
];
const ALL_LANGS = ["english", "hinglish"];

// ── In-progress lock ──────────────────────────────────────────────────────────
const caGenerating = new Set();

const countWords = (text = "") =>
  String(text).trim().split(/\s+/).filter(Boolean).length;

const MIN_SUMMARY_WORDS = Object.freeze({
  english: 120,
  hinglish: 140,
});
const CA_QUIZ_QUESTIONS_PER_ITEM = 5;
const CA_QUIZ_OPTIONS_PER_QUESTION = 4;
const CA_QUIZ_BATCH_SIZE = 6;

const getSummaryWordMinimum = (lang = "english") =>
  MIN_SUMMARY_WORDS[lang] || MIN_SUMMARY_WORDS.english;

const parseJSONArrayPayload = (raw) => {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end === -1) return [];
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const chunkArray = (arr, size) => {
  const safeSize = Math.max(1, Number(size) || 1);
  const out = [];
  for (let i = 0; i < arr.length; i += safeSize) {
    out.push(arr.slice(i, i + safeSize));
  }
  return out;
};

const normalizeCAQuizQuestion = (q) => {
  if (!q || typeof q !== "object") return null;

  const question = typeof q.question === "string" ? q.question.trim() : "";
  const options = Array.isArray(q.options)
    ? q.options
        .map((opt) => (typeof opt === "string" ? opt.trim() : ""))
        .filter(Boolean)
        .slice(0, CA_QUIZ_OPTIONS_PER_QUESTION)
    : [];

  let correct = Number.isInteger(q.correct) ? q.correct : Number(q.correct);
  if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) {
    correct = 0;
  }

  const explanation =
    typeof q.explanation === "string" ? q.explanation.trim() : "";

  if (!question || options.length < CA_QUIZ_OPTIONS_PER_QUESTION) return null;
  return { question, options, correct, explanation };
};

const normalizeCAQuizQuestionsFromItem = (item) => {
  const base = item && typeof item === "object" ? item : {};
  const rawQuestions = Array.isArray(base.quizQuestions)
    ? base.quizQuestions
    : base.quizQuestion
    ? [base.quizQuestion]
    : [];

  return rawQuestions
    .map(normalizeCAQuizQuestion)
    .filter(Boolean)
    .slice(0, CA_QUIZ_QUESTIONS_PER_ITEM);
};

const toMultilineSummary = (text, minLines = 8, maxLines = 9) => {
  const cleaned = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*[-*•\d.)]+\s*/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned.split(" ").filter(Boolean);
  if (words.length < minLines) return cleaned;

  const targetLines = words.length >= minLines * 14 ? maxLines : minLines;
  const baseSize = Math.floor(words.length / targetLines);
  const extra = words.length % targetLines;
  const lines = [];

  let cursor = 0;
  for (let i = 0; i < targetLines; i++) {
    const take = baseSize + (i < extra ? 1 : 0);
    if (take <= 0) continue;
    lines.push(words.slice(cursor, cursor + take).join(" "));
    cursor += take;
  }

  return lines.join("\n");
};

const normalizeCurrentAffairsItems = (affairs, lang) => {
  const isHinglish = lang === "hinglish";

  return affairs
    .map((item, idx) => {
      const base = item && typeof item === "object" ? item : {};
      const rawSummary =
        typeof base.summary === "string" ? base.summary.trim() : "";
      const normalizedQuizQuestions = normalizeCAQuizQuestionsFromItem(base);
      const normalizedSummary = isHinglish
        ? toMultilineSummary(rawSummary, 8, 9)
        : rawSummary.replace(/\s+/g, " ");

      return {
        ...base,
        id: base.id || `ca_${idx + 1}`,
        headline: typeof base.headline === "string" ? base.headline.trim() : "",
        summary: normalizedSummary,
        examRelevance:
          typeof base.examRelevance === "string"
            ? base.examRelevance.trim()
            : "",
        category:
          typeof base.category === "string" && base.category.trim()
            ? base.category.trim()
            : "National",
        importance:
          typeof base.importance === "string" && base.importance.trim()
            ? base.importance.trim().toLowerCase()
            : "medium",
        quizQuestions: normalizedQuizQuestions,
        quizQuestion: normalizedQuizQuestions[0] || undefined,
      };
    })
    .filter((item) => item.headline && item.summary);
};

const enrichAffairsWithQuizQuestions = async (affairs, exam, lang, dateKey) => {
  const needsQuiz = affairs.filter(
    (item) =>
      normalizeCAQuizQuestionsFromItem(item).length < CA_QUIZ_QUESTIONS_PER_ITEM
  );
  if (!needsQuiz.length) return affairs;

  const languageLabel =
    lang === "hinglish" ? "Hinglish (Roman Hindi)" : "English";
  const batches = chunkArray(needsQuiz, CA_QUIZ_BATCH_SIZE);

  const generatedById = new Map();
  const generatedByHeadline = new Map();

  console.log(
    `[CA] Quiz generation for ${exam} | ${lang} (${dateKey}) — ${needsQuiz.length} items in ${batches.length} batch(es)`
  );

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const prompt = `You are an expert exam question setter for ${exam} aspirants in India.

LANGUAGE RULE:
- Write question, options, and explanation in ${languageLabel}.

TASK:
Generate exactly ${CA_QUIZ_QUESTIONS_PER_ITEM} MCQs for each news item below.

STRICT FORMAT RULES:
1) Return ONLY raw JSON array (no markdown).
2) Keep id unchanged.
3) Each item must contain "quizQuestions" with exactly ${CA_QUIZ_QUESTIONS_PER_ITEM} questions.
4) Every question must have exactly ${CA_QUIZ_OPTIONS_PER_QUESTION} options.
5) "correct" must be option index 0-3.
6) Explanation should be short (1 sentence) and factual.
7) No duplicate questions within same item.

Return shape:
[{
  "id": "ca_1",
  "headline": "headline text",
  "quizQuestions": [
    {
      "question": "Question text",
      "options": ["A", "B", "C", "D"],
      "correct": 1,
      "explanation": "Brief reason."
    }
  ]
}]

News items:
${batch
  .map(
    (item, idx) =>
      `${idx + 1}) id: ${item.id}
headline: ${item.headline}
summary: ${String(item.summary || "").replace(/\s+/g, " ").slice(0, 420)}
examRelevance: ${String(item.examRelevance || "")
        .replace(/\s+/g, " ")
        .slice(0, 220)}`
  )
  .join("\n\n")}`;

    let raw = null;
    try {
      raw = await callGroqWithFallback(prompt, true);
    } catch (err) {
      console.warn(
        `[CA] Quiz batch ${i + 1}/${batches.length} generation failed:`,
        err.message
      );
    }

    const parsed = parseJSONArrayPayload(raw);
    parsed.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const normalizedQuestions = normalizeCAQuizQuestionsFromItem(entry);
      if (normalizedQuestions.length < CA_QUIZ_QUESTIONS_PER_ITEM) return;

      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      const headline =
        typeof entry.headline === "string"
          ? entry.headline.trim().toLowerCase()
          : "";

      if (id) generatedById.set(id, normalizedQuestions);
      if (headline) generatedByHeadline.set(headline, normalizedQuestions);
    });

    if (i < batches.length - 1) {
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  const merged = affairs.map((item) => {
    const existing = normalizeCAQuizQuestionsFromItem(item);
    const headlineKey = String(item.headline || "").trim().toLowerCase();
    const generated =
      generatedById.get(item.id) || generatedByHeadline.get(headlineKey);
    const quizQuestions =
      generated && generated.length >= CA_QUIZ_QUESTIONS_PER_ITEM
        ? generated.slice(0, CA_QUIZ_QUESTIONS_PER_ITEM)
        : existing.slice(0, CA_QUIZ_QUESTIONS_PER_ITEM);

    return {
      ...item,
      quizQuestions,
      quizQuestion: quizQuestions[0] || existing[0] || item.quizQuestion,
    };
  });

  const fullCount = merged.filter(
    (item) =>
      normalizeCAQuizQuestionsFromItem(item).length >= CA_QUIZ_QUESTIONS_PER_ITEM
  ).length;
  console.log(
    `[CA] Quiz generation complete for ${exam} | ${lang}: ${fullCount}/${merged.length} item(s) now have ${CA_QUIZ_QUESTIONS_PER_ITEM} questions`
  );

  return merged;
};

const rewriteShortHinglishSummaries = async (affairs, exam, today) => {
  const minWords = MIN_SUMMARY_WORDS.hinglish;
  const shortItems = affairs.filter(
    (item) => countWords(item.summary) < minWords
  );
  if (!shortItems.length) return affairs;

  console.warn(
    `[CRON] Hinglish short summaries detected: ${shortItems.length}/${affairs.length}. Starting rewrite pass.`
  );

  const prompt = `You are fixing short Hinglish summaries for ${exam} current affairs.
Today is ${today}.

TASK:
Rewrite ONLY the items below so each summary follows all rules.

STRICT RULES:
1) summary must be Hinglish only (Roman Hindi).
2) summary must be 8-9 lines separated by newline \\n.
3) summary must be minimum ${minWords} words.
4) include concrete facts: names, dates, places, numbers.
5) no bullets, no numbering, no markdown.
6) Keep each item id unchanged.

Items to rewrite:
${shortItems
  .map(
    (item) =>
      `id: ${item.id}
headline: ${item.headline}
category: ${item.category}
examRelevance: ${item.examRelevance || ""}
currentSummary: ${String(item.summary || "").replace(/\s+/g, " ").trim()}`
  )
  .join("\n\n")}

Return ONLY a raw JSON array:
[{
  "id": "ca_1",
  "headline": "specific Hinglish headline",
  "summary": "8-9 lines Hinglish with minimum ${minWords} words",
  "examRelevance": "Hinglish exam relevance"
}]`;

  let raw = await callGeminiOnce(prompt, 7000);
  if (!raw) {
    try {
      raw = await callGroqWithFallback(prompt, true);
    } catch (err) {
      console.warn("[CRON] Hinglish rewrite fallback failed:", err.message);
    }
  }

  const rewrittenItems = parseJSONArrayPayload(raw);
  if (!rewrittenItems.length) {
    console.warn("[CRON] Hinglish rewrite returned no valid JSON items");
    return affairs;
  }

  const byId = new Map();
  const byHeadline = new Map();
  rewrittenItems.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const headline =
      typeof item.headline === "string" ? item.headline.trim().toLowerCase() : "";
    if (id) byId.set(id, item);
    if (headline) byHeadline.set(headline, item);
  });

  const merged = affairs.map((item) => {
    const key = String(item.headline || "").trim().toLowerCase();
    const replacement = byId.get(item.id) || byHeadline.get(key);
    if (!replacement) return item;

    const summary =
      typeof replacement.summary === "string" && replacement.summary.trim()
        ? replacement.summary.trim()
        : item.summary;

    return {
      ...item,
      headline:
        typeof replacement.headline === "string" && replacement.headline.trim()
          ? replacement.headline.trim()
          : item.headline,
      summary: toMultilineSummary(summary, 8, 9),
      examRelevance:
        typeof replacement.examRelevance === "string" &&
        replacement.examRelevance.trim()
          ? replacement.examRelevance.trim()
          : item.examRelevance,
    };
  });

  const remainingShort = merged.filter(
    (item) => countWords(item.summary) < minWords
  ).length;
  console.log(
    `[CRON] Hinglish rewrite pass complete. Remaining short: ${remainingShort}/${merged.length}`
  );

  return merged;
};

// ── Pre-generate current affairs ──────────────────────────────────────────────
const pregenerateCA = async (exam, lang) => {
  const today = new Date().toISOString().split("T")[0];
  const cacheKey = `${exam}|${lang}|${today}`;

  const existing = await db
    .collection("current_affairs")
    .findOne({ date: today, exam, lang });
  if (existing?.affairs?.length >= 15) {
    console.log(`[CRON] Already done: ${exam} | ${lang}`);
    return;
  }
  if (caGenerating.has(cacheKey)) {
    console.log(`[CRON] Already in progress: ${exam} | ${lang}`);
    return;
  }

  caGenerating.add(cacheKey);
  console.log(`[CRON] Generating: ${exam} | ${lang}`);

  try {
    const isHinglish = lang === "hinglish";
    const queries = isHinglish
      ? [
          `${exam} exam current affairs India today`,
          "India government news today hindi",
          "India economy science sports news",
        ]
      : [
          `${exam} exam current affairs India today`,
          "India government policy news today",
          "India economy science sports news",
        ];

    const fetchSerper = async (q) => {
      try {
        const r = await fetch("https://google.serper.dev/news", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": process.env.SERPER_API_KEY,
          },
          body: JSON.stringify({ q, num: 20, gl: "in", hl: "en" }),
        });
        const d = await r.json();
        return (d.news || []).map((n) => ({
          title: n.title,
          snippet: n.snippet,
          source: n.source,
        }));
      } catch {
        return [];
      }
    };

    const allResults = (await Promise.all(queries.map(fetchSerper))).flat();
    const seen = new Set();
    const unique = allResults.filter((n) => {
      if (!n.title || seen.has(n.title)) return false;
      seen.add(n.title);
      return true;
    });

    if (unique.length < 5) {
      console.warn(`[CRON] Not enough headlines for ${exam} | ${lang}`);
      caGenerating.delete(cacheKey);
      return;
    }
    console.log(
      `[CRON] ${unique.length} headlines → generating ${exam} | ${lang}`
    );

    const buildHinglishPrompt = (headlines, pickCount) =>
      `⚠️ CRITICAL: You MUST write ALL output in Hinglish (Hindi words in Roman script).

Today is ${today}. Headlines for ${exam} exam students:
${headlines
  .map(
    (n, i) =>
      `${i + 1}. ${n.title}${n.snippet ? ` — ${n.snippet}` : ""} [${
        n.source || ""
      }]`
  )
  .join("\n")}

Pick ${pickCount} most exam-relevant items.

STRICT summary rules for every item:
1) "summary" must be in Hinglish only.
2) "summary" must be 8-9 separate lines (use newline \\n between lines).
3) Minimum 140 words.
4) Include factual details like names, dates, places, or numbers.
5) No bullets, no numbering, no markdown.

Return ONLY a raw JSON array — no markdown:
[{
  "id": "ca_1",
  "category": "National",
  "headline": "Hinglish mein specific headline",
  "summary": "8-9 lines Hinglish mein (newline separated) — MINIMUM 140 words",
  "importance": "high",
  "examRelevance": "Konsa exam topic — Hinglish mein",
  "tags": ["${exam}"]
}]
category: National/International/Economy/Science & Tech/Sports/Environment/Awards/Defence/Health`;

    const buildEnglishPrompt = (headlines) =>
      `Today is ${today}. Generate current affairs for ${exam} exam students in India.

Headlines:
${headlines
  .map(
    (n, i) =>
      `${i + 1}. ${n.title}${n.snippet ? ` — ${n.snippet}` : ""} [${
        n.source || ""
      }]`
  )
  .join("\n")}

Pick 30-35 most exam-relevant items. Return ONLY a raw JSON array — no markdown:
[{
  "id": "ca_1",
  "category": "National",
  "headline": "specific headline max 12 words",
  "summary": "5-6 sentences with real facts, numbers, names, dates — MINIMUM 120 words",
  "importance": "high",
  "examRelevance": "2-3 sentences on which exam topic this covers",
  "tags": ["${exam}", "topic"]
}]
category: National/International/Economy/Science & Tech/Sports/Environment/Awards/Defence/Health`;

    let raw = null;
    if (isHinglish) {
      raw = await callGeminiForHinglish(unique, buildHinglishPrompt);
      if (!raw)
        raw = await callGroqWithFallback(
          buildHinglishPrompt(unique.slice(0, 25), 15),
          true
        );
    } else {
      raw = await callGroqWithFallback(
        buildEnglishPrompt(unique.slice(0, 50)),
        true
      );
    }

    if (!raw) throw new Error("No AI response");
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end === -1)
      throw new Error("No JSON array in response");
    const affairs = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(affairs) || affairs.length < 10)
      throw new Error(`Too few: ${affairs?.length}`);

    const normalizedAffairs = normalizeCurrentAffairsItems(affairs, lang);
    if (!Array.isArray(normalizedAffairs) || normalizedAffairs.length < 10)
      throw new Error(`Too few valid items: ${normalizedAffairs?.length}`);

    let finalAffairs = normalizedAffairs;
    if (isHinglish) {
      const minWords = getSummaryWordMinimum(lang);
      finalAffairs = await rewriteShortHinglishSummaries(
        normalizedAffairs,
        exam,
        today
      );
      finalAffairs = normalizeCurrentAffairsItems(finalAffairs, lang);

      const shortCount = finalAffairs.filter(
        (item) => countWords(item.summary) < minWords
      ).length;
      if (shortCount > 0) {
        console.warn(
          `[CRON] Dropping ${shortCount} Hinglish items below ${minWords} words`
        );
        finalAffairs = finalAffairs.filter(
          (item) => countWords(item.summary) >= minWords
        );
      }

      if (finalAffairs.length < 10) {
        throw new Error(
          `Too few Hinglish items after enforcing ${minWords} words: ${finalAffairs.length}`
        );
      }
    }

    await db.collection("current_affairs").updateOne(
      { date: today, exam, lang },
      {
        $set: {
          date: today,
          exam,
          lang,
          affairs: finalAffairs,
          generatedAt: new Date(),
          sourceCount: unique.length,
        },
      },
      { upsert: true }
    );
    console.log(
      `[CRON] ✅ Saved ${finalAffairs.length} items — ${exam} | ${lang}`
    );
  } catch (err) {
    console.error(`[CRON] ❌ Failed ${exam} | ${lang}:`, err.message);
  } finally {
    caGenerating.delete(cacheKey);
  }
};

// ── Daily pre-generation ──────────────────────────────────────────────────────
const runDailyPregeneration = async () => {
  console.log(
    "[CRON] 🌅 Daily pre-generation started —",
    new Date().toISOString()
  );
  const combos = ALL_EXAMS.flatMap((exam) =>
    ALL_LANGS.map((lang) => ({ exam, lang }))
  );
  for (const { exam, lang } of combos) {
    await pregenerateCA(exam, lang);
    await new Promise((r) => setTimeout(r, 15000));
    if (global.gc) global.gc(); // ✅ FIX: Free memory between combos
  }
  console.log("[CRON] ✅ Daily pre-generation complete");
};

connectDB().then(() => {
  startJobCron(getJobs, getUsers);

  cron.schedule("30 0 * * *", runDailyPregeneration, { timezone: "UTC" });
  console.log("✅ Current affairs cron scheduled — 6:00 AM IST daily");

  // ✅ FIX: Clean caches every hour
  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of searchCache.entries()) {
      if (now - val.timestamp > SEARCH_CACHE_DURATION) searchCache.delete(key);
    }
    for (const [key, val] of userQuizCounts.entries()) {
      if (now - val.windowStart > 60 * 60 * 1000) userQuizCounts.delete(key);
    }
    console.log(
      `🧹 Cache cleaned — search:${searchCache.size} quiz:${userQuizCounts.size}`
    );
  }, 60 * 60 * 1000);

  // ✅ FIX: Monitor memory every 5 mins — auto clear if too high
  setInterval(() => {
    const mb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(`🧠 Memory: ${mb}MB`);
    if (mb > 400) {
      searchCache.clear();
      userQuizCounts.clear();
      console.log("⚠️ High memory detected — caches force cleared!");
    }
  }, 5 * 60 * 1000);

  // ✅ FIX: Clean empty chats daily at 2 AM
  cron.schedule("0 2 * * *", async () => {
    try {
      const result = await getChats().deleteMany({
        messages: { $size: 0 },
        createdAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      });
      console.log(`🧹 Deleted ${result.deletedCount} empty chats`);
    } catch (err) {
      console.warn("⚠️ Empty chat cleanup failed:", err.message);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MEMORY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

const loadMemory = async (userId) => {
  if (!userId) return [];
  try {
    const doc = await getMemories().findOne({ userId });
    return doc?.facts || [];
  } catch (err) {
    console.warn("⚠️ Memory load failed:", err.message);
    return [];
  }
};

const saveMemory = async (userId, conversation, exam) => {
  if (!userId || !conversation?.length) return;
  try {
    const existing = await loadMemory(userId);
    const extractPrompt = `
You are a memory extraction system for an exam prep app.
Analyze this conversation and extract key facts about the student.

EXISTING MEMORY (already known):
${existing.length ? existing.map((f) => `- ${f}`).join("\n") : "None yet"}

NEW CONVERSATION:
${conversation.map((m) => `${m.role}: ${m.content}`).join("\n")}

Extract and return a JSON array of short fact strings. Include:
- Their name (if mentioned)
- Exam they are preparing for
- Weak topics or subjects
- Strong topics or subjects
- Preferred language (Hindi/English/Hinglish)
- Study goals or targets
- Any personal context (job, background, etc.)

Rules:
- Merge with existing memory, don't duplicate facts
- Update outdated facts
- Max 10 facts total, each fact max 15 words
- Return ONLY a valid JSON array of strings, nothing else
- Example: ["Preparing for UPSC 2026", "Weak in Economy", "Prefers Hindi"]
`;
    const raw = await callGroqForMemory(extractPrompt);
    if (!raw) return;
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const facts = JSON.parse(cleaned);
    if (Array.isArray(facts) && facts.length) {
      await getMemories().updateOne(
        { userId },
        {
          $set: {
            facts,
            exam,
            updatedAt: new Date(),
            isAnon: userId.startsWith("anon_"),
          },
        },
        { upsert: true }
      );
      console.log(`✅ Memory saved for ${userId}: ${facts.length} facts`);
    }
  } catch (err) {
    console.warn("⚠️ Memory save failed:", err.message);
  }
};

const mergeGuestMemory = async (anonId, realUserId) => {
  if (!anonId || !realUserId) return;
  try {
    const guestDoc = await getMemories().findOne({ userId: anonId });
    if (!guestDoc?.facts?.length) return;
    const realDoc = await getMemories().findOne({ userId: realUserId });
    const existingFacts = realDoc?.facts || [];
    const merged = [
      ...existingFacts,
      ...guestDoc.facts.filter((f) => !existingFacts.includes(f)),
    ].slice(0, 10);
    await getMemories().updateOne(
      { userId: realUserId },
      { $set: { facts: merged, updatedAt: new Date(), isAnon: false } },
      { upsert: true }
    );
    await getMemories().deleteOne({ userId: anonId });
    console.log(`✅ Guest memory merged: ${anonId} → ${realUserId}`);
  } catch (err) {
    console.warn("⚠️ Memory merge failed:", err.message);
  }
};

const callGroqForMemory = async (prompt) => {
  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 500,
      }),
    }
  );
  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim();
};

// ── GROQ AGENT ROUTER ─────────────────────────────────────────────────────────
const askAIAgentGroq = async (question) => {
  try {
    const prompt = `You are a routing agent for an exam prep app.
Decide the best source to answer this question: "${question}"
Reply with ONLY one word: "web_search" or "direct"`;
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
          max_tokens: 10,
        }),
      }
    );
    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content?.trim().toLowerCase();
    if (answer?.includes("web_search"))
      return { action: "web_search", query: question };
    return { action: "direct" };
  } catch (err) {
    console.warn("⚠️ Groq agent routing failed:", err.message);
    return { action: "direct" };
  }
};

// ── Mobile config ─────────────────────────────────────────────────────────────
app.get("/mobile/config", (req, res) => {
  res.json({
    minVersion: 1,
    currentVersion: 1,
    maintenanceMode: false,
    features: {
      aiChat: true,
      voiceMode: true,
      jobAlerts: true,
      resumeBuilder: true,
    },
  });
});

// ── Live search cache (1 hour) ────────────────────────────────────────────────
const searchCache = new Map();
const SEARCH_CACHE_DURATION = 60 * 60 * 1000;

const fetchLiveSearchContext = async (query) => {
  if (!process.env.SERPER_API_KEY) return "";
  const cached = searchCache.get(query);
  const now = Date.now();
  if (cached && now - cached.timestamp < SEARCH_CACHE_DURATION)
    return cached.data;
  try {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, num: 5 }),
    });
    const data = await response.json();
    if (!data.organic?.length) return "";
    const results = data.organic
      .slice(0, 5)
      .map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}\nSource: ${r.link}`);
    const formatted = `LIVE SEARCH RESULTS:\n\n${results.join("\n\n")}`;
    searchCache.set(query, { data: formatted, timestamp: now });
    return formatted;
  } catch (err) {
    console.error("Serper error:", err.message);
    return "";
  }
};

// ── World Bank data fetcher ───────────────────────────────────────────────────
const WORLD_BANK_INDICATORS = {
  GDP: "NY.GDP.MKTP.CD",
  INFLATION: "FP.CPI.TOTL.ZG",
  POPULATION: "SP.POP.TOTL",
  LITERACY: "SE.ADT.LITR.ZS",
  UNEMPLOYMENT: "SL.UEM.TOTL.ZS",
  POVERTY: "SI.POV.DDAY",
  LIFE_EXPECTANCY: "SP.DYN.LE00.IN",
  EXPORTS: "NE.EXP.GNFS.CD",
  IMPORTS: "NE.IMP.GNFS.CD",
};

const fetchWorldBankData = async (countryCode, indicator) => {
  try {
    const indicatorCode = WORLD_BANK_INDICATORS[indicator];
    if (!indicatorCode) return "";
    const url = `https://api.worldbank.org/v2/country/${countryCode}/indicator/${indicatorCode}?format=json&mrv=3`;
    const response = await fetch(url);
    if (!response.ok) return "";
    const data = await response.json();
    const records = data?.[1]?.filter((r) => r.value !== null);
    if (!records?.length) return "";
    const lines = records
      .map((r) => `  • ${r.date}: ${Number(r.value).toLocaleString()}`)
      .join("\n");
    return `WORLD BANK DATA (${indicator} — ${countryCode}):\n${lines}\nSource: World Bank Open Data`;
  } catch (err) {
    console.warn("⚠️ World Bank fetch failed:", err.message);
    return "";
  }
};

// ── AI engine helpers ─────────────────────────────────────────────────────────
const GROQ_MODELS = [
  { id: "meta-llama/llama-4-scout-17b-16e-instruct", maxTokens: 8000 },
  { id: "llama-3.3-70b-versatile", maxTokens: 8000 },
];
const CONTEXT_EXTRA_TOKENS = 2000;
const userQuizCounts = new Map();
const USER_HOURLY_LIMIT = 15;

const checkUserRateLimit = (userId) => {
  if (!userId) return true;
  const now = Date.now();
  const entry = userQuizCounts.get(userId);
  if (!entry || now - entry.windowStart > 60 * 60 * 1000) {
    userQuizCounts.set(userId, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= USER_HOURLY_LIMIT) return false;
  entry.count++;
  return true;
};

const callGPT52 = async (prompt, hasContext = false) => {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 4000 + (hasContext ? CONTEXT_EXTRA_TOKENS : 0),
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    console.log("✅ Quiz generated by GPT-4o");
    return data.choices?.[0]?.message?.content?.trim();
  } catch {
    return null;
  }
};

const callGroqWithFallback = async (prompt, hasContext = false) => {
  for (const model of GROQ_MODELS) {
    const maxTokens = model.maxTokens + (hasContext ? CONTEXT_EXTRA_TOKENS : 0);
    try {
      const response = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model: model.id,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.2,
            max_completion_tokens: maxTokens,
          }),
        }
      );
      if (!response.ok) continue;
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim();
      if (content) return content;
    } catch {
      continue;
    }
  }
  throw new Error("All fallback models failed");
};

const generateAIContent = async (prompt, hasContext = false) => {
  const gptResult = await callGPT52(prompt, hasContext);
  if (gptResult) return gptResult;
  return callGroqWithFallback(prompt, hasContext);
};

// ── Gemini key rotation ───────────────────────────────────────────────────────
const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY,
].filter(Boolean);

let geminiKeyIndex = 0;
const getNextGeminiKey = () => {
  const key = GEMINI_KEYS[geminiKeyIndex % GEMINI_KEYS.length];
  geminiKeyIndex++;
  return key;
};

const callGeminiOnce = async (prompt, maxOutputTokens = 4000) => {
  for (let attempt = 0; attempt < GEMINI_KEYS.length; attempt++) {
    const key = getNextGeminiKey();
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens },
          }),
        }
      );
      if (response.status === 429) {
        console.warn(`⚠️ Gemini key ${attempt + 1} rate limited`);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (!response.ok) {
        console.warn(`⚠️ Gemini key ${attempt + 1} HTTP ${response.status}`);
        continue;
      }
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text) return text;
    } catch (err) {
      console.warn(`⚠️ Gemini key ${attempt + 1} error:`, err.message);
    }
  }
  return null;
};

const callGeminiForHinglish = async (headlines, buildPromptFn) => {
  if (!GEMINI_KEYS.length) {
    console.warn("⚠️ No Gemini keys set");
    return null;
  }
  const batchSize = Math.ceil(headlines.length / 4);
  const batches = [
    headlines.slice(0, batchSize),
    headlines.slice(batchSize, batchSize * 2),
    headlines.slice(batchSize * 2, batchSize * 3),
    headlines.slice(batchSize * 3),
  ].filter((b) => b.length > 0);
  console.log(
    `[CA] Gemini: ${batches.length} sequential batches of ~${batchSize} headlines`
  );
  const parse = (raw) => {
    if (!raw) return [];
    try {
      const s = raw.indexOf("[");
      const e = raw.lastIndexOf("]");
      if (s === -1 || e === -1) return [];
      return JSON.parse(raw.slice(s, e + 1));
    } catch (e) {
      console.warn("⚠️ Gemini batch JSON parse failed:", e.message);
      return [];
    }
  };
  const merged = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(
      `[CA] Gemini batch ${i + 1}/${batches.length} (${
        batch.length
      } headlines)...`
    );
    const result = await callGeminiOnce(buildPromptFn(batch, 8), 6000);
    const items = parse(result);
    console.log(`[CA] Batch ${i + 1} → ${items.length} items`);
    merged.push(...items);
    if (i < batches.length - 1) await new Promise((r) => setTimeout(r, 8000));
  }
  if (merged.length === 0) {
    console.warn("⚠️ All Gemini batches returned empty");
    return null;
  }
  merged.forEach((item, i) => {
    item.id = `ca_${i + 1}`;
  });
  console.log(`✅ Gemini total: ${merged.length} Hinglish items`);
  return JSON.stringify(merged);
};

const extractJSONArray = (text) => {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("JSON not found");
  return JSON.parse(text.slice(start, end + 1));
};

import { getQuizPrompt } from "./Quizprompts.js";

// ── INFIP image helpers ───────────────────────────────────────────────────────
const INFIP_FREE_MODELS = ["flux2-klein-9b", "img3", "img4"];
const INFIP_API_BASE = "https://api.infip.pro";

const aspectFromDimensions = (width, height) => {
  const w = Number(width) || 1024,
    h = Number(height) || 1024;
  if (w > h * 1.2) return "landscape";
  if (h > w * 1.2) return "portrait";
  return "square";
};

const infipGenerate = async (prompt, { width, height } = {}) => {
  if (!infipApiKey) throw new Error("INFIP_API_KEY not set in .env");
  const aspect = aspectFromDimensions(width, height);
  let lastError = null;
  for (const model of INFIP_FREE_MODELS) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 60000);
      const response = await fetch(`${INFIP_API_BASE}/v1/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${infipApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          prompt,
          n: 1,
          aspect,
          response_format: "url",
        }),
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (!response.ok) {
        lastError = `${model} → HTTP ${response.status}`;
        continue;
      }
      const data = await response.json();
      const imageUrl = data?.data?.[0]?.url;
      if (!imageUrl) {
        lastError = `${model} → no URL`;
        continue;
      }
      console.log(`✅ infip.pro — model: ${model}, aspect: ${aspect}`);
      return { imageUrl, modelUsed: model, aspect, promptUsed: prompt };
    } catch (err) {
      lastError =
        err.name === "AbortError"
          ? `${model} → timeout`
          : `${model} → ${err.message}`;
    }
  }
  throw new Error(lastError || "All infip.pro models failed");
};

const uploadToCatbox = async (buffer, mimetype) => {
  try {
    const ext = mimetype.includes("png")
      ? "png"
      : mimetype.includes("webp")
      ? "webp"
      : "jpg";
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append(
      "fileToUpload",
      new Blob([buffer], { type: mimetype }),
      `image.${ext}`
    );
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch("https://catbox.moe/user/api.php", {
      method: "POST",
      body: form,
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (!r.ok) return null;
    const url = (await r.text()).trim();
    return url.startsWith("https://") ? url : null;
  } catch {
    return null;
  }
};

const uploadToTmpfiles = async (buffer, mimetype) => {
  try {
    const ext = mimetype.includes("png")
      ? "png"
      : mimetype.includes("webp")
      ? "webp"
      : "jpg";
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimetype }), `image.${ext}`);
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch("https://tmpfiles.org/api/v1/upload", {
      method: "POST",
      body: form,
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (!r.ok) return null;
    const data = await r.json();
    return (
      data?.data?.url?.replace("tmpfiles.org/", "tmpfiles.org/dl/") || null
    );
  } catch {
    return null;
  }
};

const uploadToTelegraph = async (buffer, mimetype) => {
  try {
    const ext = mimetype.includes("png")
      ? "png"
      : mimetype.includes("webp")
      ? "webp"
      : "jpg";
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimetype }), `image.${ext}`);
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch("https://telegra.ph/upload", {
      method: "POST",
      body: form,
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (!r.ok) return null;
    const data = await r.json();
    const src = Array.isArray(data) ? data[0]?.src : data?.src;
    return src ? `https://telegra.ph${src}` : null;
  } catch {
    return null;
  }
};

const uploadImageForI2I = async (buffer, mimetype) => {
  for (const { name, fn } of [
    { name: "Catbox", fn: () => uploadToCatbox(buffer, mimetype) },
    { name: "Tmpfiles", fn: () => uploadToTmpfiles(buffer, mimetype) },
    { name: "Telegraph", fn: () => uploadToTelegraph(buffer, mimetype) },
  ]) {
    console.log(`📤 Trying ${name}...`);
    const url = await fn();
    if (url) {
      console.log(`✅ ${name} upload success:`, url);
      return url;
    }
  }
  console.warn("⚠️ All image hosts failed — falling back to prompt-remix");
  return null;
};

const infipEdit = async (buffer, mimetype, prompt, { width, height } = {}) => {
  if (!infipApiKey) throw new Error("INFIP_API_KEY not set in .env");
  const aspect = aspectFromDimensions(width, height);
  const richPrompt = await buildImageEditPrompt(buffer, mimetype, prompt);
  const base64DataUrl = `data:${mimetype};base64,${buffer.toString("base64")}`;
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 90000);
    const r = await fetch(`${INFIP_API_BASE}/v1/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${infipApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "flux2-klein-9b",
        prompt: richPrompt,
        n: 1,
        aspect,
        response_format: "url",
        images: [base64DataUrl],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (r.ok) {
      const data = await r.json();
      const imageUrl = data?.data?.[0]?.url;
      if (imageUrl)
        return {
          imageUrl,
          modelUsed: "flux2-klein-9b",
          aspect,
          promptUsed: richPrompt,
          mode: "image_to_image",
        };
    }
    const publicUrl = await uploadImageForI2I(buffer, mimetype);
    if (publicUrl) {
      const ctrl2 = new AbortController();
      const tid2 = setTimeout(() => ctrl2.abort(), 90000);
      const r2 = await fetch(`${INFIP_API_BASE}/v1/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${infipApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "flux2-klein-9b",
          prompt: richPrompt,
          n: 1,
          aspect,
          response_format: "url",
          images: [publicUrl],
        }),
        signal: ctrl2.signal,
      });
      clearTimeout(tid2);
      if (r2.ok) {
        const data2 = await r2.json();
        const imageUrl2 = data2?.data?.[0]?.url;
        if (imageUrl2)
          return {
            imageUrl: imageUrl2,
            modelUsed: "flux2-klein-9b",
            aspect,
            promptUsed: richPrompt,
            mode: "image_to_image",
          };
      }
    }
  } catch (err) {
    console.warn("⚠️ infip.pro i2i error:", err.message);
  }
  const result = await infipGenerate(richPrompt, { width, height });
  return { ...result, promptUsed: richPrompt, mode: "prompt_remix" };
};

// ═══════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get("/", (req, res) => res.send("✅ Backend running"));
app.get("/health", (req, res) => res.send("Server alive"));

// ── Privacy Policy ────────────────────────────────────────────────────────────

// ── Chat history ──────────────────────────────────────────────────────────────
app.get("/chats/:userId", async (req, res) => {
  try {
    const chats = await getChats()
      .find({ userId: req.params.userId })
      .sort({ updatedAt: -1 })
      .project({ title: 1, updatedAt: 1, exam: 1 })
      .toArray();
    res.json(chats);
  } catch {
    res.status(500).json({ error: "Failed to load chats" });
  }
});

app.get("/chats/:userId/:chatId", async (req, res) => {
  try {
    const chat = await getChats().findOne({
      _id: new ObjectId(req.params.chatId),
      userId: req.params.userId,
    });
    if (!chat) return res.status(404).json({ error: "Chat not found" });
    res.json(chat);
  } catch {
    res.status(500).json({ error: "Failed to load chat" });
  }
});

app.delete("/chats/:userId/:chatId", async (req, res) => {
  try {
    await getChats().deleteOne({
      _id: new ObjectId(req.params.chatId),
      userId: req.params.userId,
    });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Failed to delete chat" });
  }
});

app.post("/chats/:userId", async (req, res) => {
  try {
    const { exam = "General" } = req.body;
    const newChat = {
      userId: req.params.userId,
      title: "New Chat",
      exam,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await getChats().insertOne(newChat);
    res.json({ chatId: result.insertedId, ...newChat });
  } catch {
    res.status(500).json({ error: "Failed to create chat" });
  }
});

// ── Chat ──────────────────────────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  const { question, exam, history = [], userId, chatId, anonId } = req.body;
  if (!question) return res.status(400).json({ error: "Question is required" });
  try {
    const resolvedUserId = userId || anonId || null;
    const memory = await loadMemory(resolvedUserId);
    let finalPrompt = question;
    let decision = { action: "direct" };
    const isSimple =
      question.trim().length < 20 ||
      /^(hi|hello|hey|thanks|thank you|ok|okay|help|start)$/i.test(
        question.trim()
      );
    if (!isSimple) decision = await askAIAgentGroq(question, exam);
    if (decision.action === "web_search") {
      const ctx = await fetchLiveSearchContext(decision.query);
      if (ctx) finalPrompt = `${ctx}\n\nQuestion: ${question}`;
    } else if (decision.action === "world_bank") {
      const wb = await fetchWorldBankData(
        decision.country_code,
        decision.indicator
      );
      if (wb) finalPrompt = `${wb}\n\nQuestion: ${question}`;
    }
    const answer = await askAI(finalPrompt, exam, history, false, memory);
    if (chatId && (userId || anonId)) {
      await getChats().updateOne(
        { _id: new ObjectId(chatId), userId: userId || anonId },
        {
          $push: {
            messages: {
              $each: [
                { role: "user", content: question, timestamp: new Date() },
                { role: "assistant", content: answer, timestamp: new Date() },
              ],
            },
          },
          $set: { updatedAt: new Date() },
        }
      );
    }
    if (resolvedUserId) {
      const updatedHistory = [
        ...history,
        { role: "user", content: question },
        { role: "assistant", content: answer },
      ];
      saveMemory(resolvedUserId, updatedHistory, exam).catch((err) =>
        console.warn("⚠️ Memory save failed:", err.message)
      );
    }
    res.json({ answer });
  } catch (err) {
    console.error("❌ Chat error:", err.message);
    res.status(500).json({ error: "AI service failed" });
  }
});

// ── User profile ──────────────────────────────────────────────────────────────
app.post("/user/sync", async (req, res) => {
  const { userId, userName, exam, xp = 0 } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    await getUsers().updateOne(
      { userId },
      { $set: { userName, exam, updatedAt: new Date() }, $inc: { xp } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Failed to sync user" });
  }
});

app.get("/user/:userId", async (req, res) => {
  try {
    const user = await getUsers().findOne({ userId: req.params.userId });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch {
    res.status(500).json({ error: "Failed to load user" });
  }
});

app.post("/user/fcm-token", async (req, res) => {
  const { userId, token } = req.body;
  if (!userId || !token)
    return res.status(400).json({ error: "userId and token required" });
  try {
    await getUsers().updateOne(
      { userId },
      { $set: { fcmToken: token, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Failed to save FCM token" });
  }
});

app.post("/user/merge-memory", async (req, res) => {
  const { anonId, userId } = req.body;
  if (!anonId || !userId)
    return res.status(400).json({ error: "anonId and userId required" });
  try {
    await mergeGuestMemory(anonId, userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Memory merge failed" });
  }
});

// ── Quiz ──────────────────────────────────────────────────────────────────────
app.post("/quiz/generate", async (req, res) => {
  const { topic, exam = "General", count = 10, userId, state } = req.body;
  if (!checkUserRateLimit(userId))
    return res.status(429).json({ error: "Limit reached" });
  if (!topic) return res.status(400).json({ error: "Topic required" });
  const safeCount = Math.min(Number(count) || 10, 20);
  const finalTopic =
    exam === "State PCS" && state ? `${state} — ${topic}` : topic;
  if (userId) {
    const solvedResults = await getQuizResults()
      .find({ userId, exam, topic: finalTopic, quizId: { $ne: null } })
      .project({ quizId: 1 })
      .toArray();
    const solvedIds = solvedResults.map((r) => r.quizId).filter(Boolean);
    const existingQuiz = await getQuizzes().findOne({
      topic: finalTopic,
      exam,
      ...(solvedIds.length ? { _id: { $nin: solvedIds } } : {}),
      createdAt: { $exists: true },
    });
    if (existingQuiz) {
      console.log(`♻️ Serving pooled quiz ${existingQuiz._id} to ${userId}`);
      return res.json({
        quizId: existingQuiz._id,
        questions: existingQuiz.questions,
        contextUsed: false,
        reused: true,
      });
    }
  }
  const contextBlock =
    exam === "Current Affairs"
      ? await fetchLiveSearchContext(
          `${finalTopic} India government PIB official`
        )
      : "";
  const prompt = getQuizPrompt(exam, finalTopic, safeCount, contextBlock);
  try {
    const content = await generateAIContent(prompt, !!contextBlock);
    const questions = extractJSONArray(
      content.replace(/```json|```/gi, "").trim()
    );
    const quizDoc = {
      topic: finalTopic,
      exam,
      questions,
      createdAt: new Date(),
    };
    const result = await getQuizzes().insertOne(quizDoc);
    res.json({
      quizId: result.insertedId,
      questions,
      contextUsed: !!contextBlock,
      reused: false,
    });
  } catch (err) {
    console.error("❌ Quiz generation error:", err.message);
    res.status(500).json({ error: "Quiz failed" });
  }
});

app.post("/quiz/result", async (req, res) => {
  const { userId, topic, exam, score, total, timeTaken, quizId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    await getQuizResults().insertOne({
      userId,
      topic,
      exam,
      score,
      total,
      percentage: Math.round((score / total) * 100),
      timeTaken,
      quizId: quizId ? new ObjectId(quizId) : null,
      createdAt: new Date(),
    });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Failed to save result" });
  }
});

app.get("/quiz/history/:userId", async (req, res) => {
  try {
    const results = await getQuizResults()
      .find({ userId: req.params.userId })
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();
    res.json(results);
  } catch {
    res.status(500).json({ error: "Failed to load history" });
  }
});

// ── Current affairs ───────────────────────────────────────────────────────────
app.get("/current-affairs/:exam", async (req, res) => {
  const { exam } = req.params;
  const lang = req.query.lang === "hinglish" ? "hinglish" : "english";
  const today = new Date().toISOString().split("T")[0];
  const cacheKey = `${exam}|${lang}|${today}`;
  const minWords = getSummaryWordMinimum(lang);
  try {
    const cached = await db
      .collection("current_affairs")
      .findOne({ date: today, exam, lang });
    if (cached?.affairs?.length >= 10) {
      let affairs = normalizeCurrentAffairsItems(cached.affairs, lang);
      let shouldPersist = false;
      if (lang === "hinglish") {
        const shortCount = affairs.filter(
          (item) => countWords(item.summary) < minWords
        ).length;
        if (shortCount > 0) {
          console.warn(
            `[CA] Cached Hinglish has ${shortCount} short items. Running repair pass for ${exam}.`
          );
          affairs = await rewriteShortHinglishSummaries(affairs, exam, today);
          affairs = normalizeCurrentAffairsItems(affairs, lang).filter(
            (item) => countWords(item.summary) >= minWords
          );
          if (affairs.length >= 10) shouldPersist = true;
        }
      }
      const quizMissingBefore = affairs.filter(
        (item) =>
          normalizeCAQuizQuestionsFromItem(item).length <
          CA_QUIZ_QUESTIONS_PER_ITEM
      ).length;
      if (quizMissingBefore > 0) {
        affairs = await enrichAffairsWithQuizQuestions(affairs, exam, lang, today);
        affairs = normalizeCurrentAffairsItems(affairs, lang);
        const quizMissingAfter = affairs.filter(
          (item) =>
            normalizeCAQuizQuestionsFromItem(item).length <
            CA_QUIZ_QUESTIONS_PER_ITEM
        ).length;
        if (quizMissingAfter < quizMissingBefore) shouldPersist = true;
      }

      if (shouldPersist && affairs.length >= 10) {
        await db.collection("current_affairs").updateOne(
          { date: today, exam, lang },
          {
            $set: {
              affairs,
              generatedAt: new Date(),
            },
          }
        );
      }
      if (affairs.length >= 10) {
        console.log(`[CA] ✅ DB hit: ${exam} | ${lang} | ${today}`);
        return res.json({
          date: today,
          exam,
          lang,
          affairs,
          cached: true,
        });
      }
    }
    if (caGenerating.has(cacheKey)) {
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const poll = await db
          .collection("current_affairs")
          .findOne({ date: today, exam, lang });
        if (poll?.affairs?.length >= 10) {
          const normalizedPoll = normalizeCurrentAffairsItems(poll.affairs, lang);
          let eligiblePoll =
            lang === "hinglish"
              ? normalizedPoll.filter(
                  (item) => countWords(item.summary) >= minWords
                )
              : normalizedPoll;
          const pollQuizMissingBefore = eligiblePoll.filter(
            (item) =>
              normalizeCAQuizQuestionsFromItem(item).length <
              CA_QUIZ_QUESTIONS_PER_ITEM
          ).length;
          if (pollQuizMissingBefore > 0) {
            eligiblePoll = await enrichAffairsWithQuizQuestions(
              eligiblePoll,
              exam,
              lang,
              today
            );
            eligiblePoll = normalizeCurrentAffairsItems(eligiblePoll, lang);
            const pollQuizMissingAfter = eligiblePoll.filter(
              (item) =>
                normalizeCAQuizQuestionsFromItem(item).length <
                CA_QUIZ_QUESTIONS_PER_ITEM
            ).length;
            if (pollQuizMissingAfter < pollQuizMissingBefore) {
              await db.collection("current_affairs").updateOne(
                { date: today, exam, lang },
                {
                  $set: {
                    affairs: eligiblePoll,
                    generatedAt: new Date(),
                  },
                }
              );
            }
          }
          if (eligiblePoll.length >= 10) {
            return res.json({
              date: today,
              exam,
              lang,
              affairs: eligiblePoll,
              cached: true,
            });
          }
        }
      }
    }
    const stale = await db
      .collection("current_affairs")
      .findOne({ exam, lang }, { sort: { date: -1 } });
    if (stale?.affairs?.length) {
      const staleAffairs = normalizeCurrentAffairsItems(stale.affairs, lang);
      let eligibleStale =
        lang === "hinglish"
          ? staleAffairs.filter((item) => countWords(item.summary) >= minWords)
          : staleAffairs;
      if (!eligibleStale.length) {
        return res.status(202).json({
          error:
            "Current affairs refresh runs once daily at 6:00 AM IST. Please retry after the next refresh window.",
        });
      }
      const staleQuizMissingBefore = eligibleStale.filter(
        (item) =>
          normalizeCAQuizQuestionsFromItem(item).length <
          CA_QUIZ_QUESTIONS_PER_ITEM
      ).length;
      if (staleQuizMissingBefore > 0) {
        eligibleStale = await enrichAffairsWithQuizQuestions(
          eligibleStale,
          exam,
          lang,
          stale.date
        );
        eligibleStale = normalizeCurrentAffairsItems(eligibleStale, lang);
        const staleQuizMissingAfter = eligibleStale.filter(
          (item) =>
            normalizeCAQuizQuestionsFromItem(item).length <
            CA_QUIZ_QUESTIONS_PER_ITEM
        ).length;
        if (staleQuizMissingAfter < staleQuizMissingBefore) {
          await db.collection("current_affairs").updateOne(
            { date: stale.date, exam, lang },
            {
              $set: {
                affairs: eligibleStale,
                generatedAt: new Date(),
              },
            }
          );
        }
      }
      console.log(`[CA] Serving stale: ${exam} | ${lang} | ${stale.date}`);
      return res.json({
        date: stale.date,
        exam,
        lang,
        affairs: eligibleStale,
        cached: true,
        stale: true,
      });
    }
    res.status(202).json({
      error:
        "Current affairs refresh runs once daily at 6:00 AM IST. Please retry after the next refresh window.",
    });
  } catch (err) {
    console.error("[CA] ❌", err.message);
    res.status(500).json({ error: "Failed to fetch current affairs" });
  }
});

// ── Image generation ──────────────────────────────────────────────────────────
app.post("/image/generate", async (req, res) => {
  const prompt =
    typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt) return res.status(400).json({ error: "Prompt required" });
  try {
    const richPrompt = await buildTextToImagePrompt(prompt);
    const result = await infipGenerate(richPrompt, {
      width: req.body?.width,
      height: req.body?.height,
    });
    return res.json({
      imageUrl: result.imageUrl,
      modelUsed: result.modelUsed,
      routeType: result.aspect,
      promptUsed: richPrompt,
      attemptCount: 1,
    });
  } catch (err) {
    console.error("❌ /image/generate:", err.message);
    return res
      .status(502)
      .json({ error: err.message || "Image generation failed" });
  }
});

app.post("/image/edit", upload.single("image"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: "Image file required" });
    if (req.file.mimetype === "application/pdf")
      return res
        .status(400)
        .json({ error: "PDF not supported for image edit" });
    const prompt =
      typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (!prompt) return res.status(400).json({ error: "Edit prompt required" });
    const result = await infipEdit(req.file.buffer, req.file.mimetype, prompt, {
      width: req.body?.width,
      height: req.body?.height,
    });
    req.file.buffer = null; // ✅ FIX: Free buffer
    return res.json({
      imageUrl: result.imageUrl,
      modelUsed: result.modelUsed,
      routeType: result.aspect,
      promptUsed: result.promptUsed,
      attemptCount: 1,
      mode: result.mode,
    });
  } catch (err) {
    console.error("❌ /image/edit:", err.message);
    return res.status(502).json({ error: err.message || "Image edit failed" });
  }
});

app.post("/image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "File required" });
    if (req.file.mimetype === "application/pdf") {
      try {
        const buffer = req.file.buffer;
        const { text } = await extractText(buffer);
        req.file.buffer = null; // ✅ FIX: Free PDF buffer immediately
        if (text && text.trim().length > 50) {
          const answer = await askAI(text, req.body.exam);
          return res.json({ answer });
        }
      } catch {
        console.log(
          "⚠️ Local PDF extraction failed, switching to Vision AI..."
        );
      }
    }
    const answer = await askAIWithImage(
      req.file.buffer,
      req.file.mimetype,
      req.body.exam
    );
    req.file.buffer = null; // ✅ FIX: Free buffer
    res.json({ answer });
  } catch {
    res.status(500).json({ error: "Image failed" });
  }
});

// ── TTS & transcription ───────────────────────────────────────────────────────
app.post("/speak", async (req, res) => {
  const { text, voice } = req.body;
  try {
    const response = await groq.audio.speech.create({
      model: "canopylabs/orpheus-v1-english",
      voice: voice || "hannah",
      input: text.slice(0, 200),
      response_format: "wav",
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    res.set("Content-Type", "audio/wav");
    res.send(buffer);
  } catch {
    res.status(500).json({ error: "Voice generation failed" });
  }
});

// Add temporarily in server.js to debug
app.get("/debug/categories", async (req, res) => {
  const cats = await db.collection("jobs").distinct("category");
  res.json(cats);
});

app.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    const transcription = await groq.audio.transcriptions.create({
      file: new File([req.file.buffer], "audio.webm", { type: "audio/webm" }),
      model: "whisper-large-v3-turbo",
      language: "en",
    });
    req.file.buffer = null; // ✅ FIX: Free audio buffer
    res.json({ text: transcription.text });
  } catch {
    res.status(500).json({ error: "Transcription failed" });
  }
});

// ── Chart generation ──────────────────────────────────────────────────────────
app.post("/chart/generate", async (req, res) => {
  const { question, exam = "General" } = req.body;
  if (!question) return res.status(400).json({ error: "Question required" });
  const prompt = `You are a data visualization expert for Indian competitive exams.
Generate a chart for this topic: "${question}" for a ${exam} student.
Return ONLY a valid JSON object:
{ "type": "bar"|"line"|"pie"|"doughnut", "title": "...", "labels": [...], "datasets": [{ "label": "...", "data": [...] }], "insight": "..." }
Use real accurate data. Max 8 data points. Return ONLY the JSON.`;
  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
          max_tokens: 1000,
        }),
      }
    );
    if (!response.ok) throw new Error(`Groq error: ${response.status}`);
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error("Empty response");
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON found");
    res.json(JSON.parse(cleaned.slice(start, end + 1)));
  } catch (err) {
    console.error("❌ Chart error:", err.message);
    res.status(500).json({ error: "Chart generation failed" });
  }
});

// ── Data deletion ─────────────────────────────────────────────────────────────
app.delete("/user/:userId/delete-data", async (req, res) => {
  const { userId } = req.params;
  try {
    await Promise.all([
      getUsers().deleteOne({ userId }),
      getChats().deleteMany({ userId }),
      getQuizResults().deleteMany({ userId }),
      getResumes().deleteMany({ userId }),
      getMemories().deleteMany({ userId }),
    ]);
    res.json({ success: true, message: "All user data deleted successfully." });
  } catch {
    res.status(500).json({ error: "Failed to delete user data" });
  }
});

// ── Error handlers ────────────────────────────────────────────────────────────
// ── Error handlers ────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: "Route not found" }));

app.use((err, req, res, next) => {
  // ✅ Handle file too large error
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: "File too large. Maximum allowed size is 5MB.",
    });
  }
  console.error("❌ Server error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(5050, () =>
  console.log("✅ Backend running on http://localhost:5050")
);
