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

import { initFirebase, startJobCron } from "./JobFetcher.js";
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
      "http://localhost:5173",
      "http://10.0.2.2:5050",
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
  // Leaderboard index
  await db.collection("users").createIndex({ exam: 1, coins: -1 });
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

const caGenerating = new Set();
const searchCache = new Map();
const SEARCH_CACHE_DURATION = 60 * 60 * 1000;

// ── RSS ───────────────────────────────────────────────────────────────────────
import Parser from "rss-parser";
const rssParser = new Parser({ timeout: 8000 });
const parseRSSWithFallback = async (url) => {
  if (url.includes("pib.gov.in")) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(tid);
      if (!r.ok) return null;
      let xml = await r.text();
      xml = xml.replace(
        /&(?!(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/g,
        "&amp;"
      );
      return await rssParser.parseString(xml);
    } catch (err) {
      console.warn(`[RAW] PIB clean failed: ${err.message}`);
      return null;
    }
  }
  return await rssParser.parseURL(url);
};

const RSS_NEWS_SOURCES = [
  "https://www.pib.gov.in/RssMain.aspx?ModID=6&reg=3&lang=2",
  "https://www.thehindu.com/news/national/?service=rss",
  "https://indianexpress.com/feed/",
  "https://timesofindia.indiatimes.com/rssfeeds/296589292.cms",
  "https://www.pib.gov.in/RssMain.aspx?ModId=6&Lang=2&Regid=3&reg=3",
  "",
];

const fetchRSSFallback = async (query) => {
  try {
    const keywords = query
      .toLowerCase()
      .split(" ")
      .filter((w) => w.length > 3);
    for (const url of RSS_NEWS_SOURCES) {
      try {
        const feed = await parseRSSWithFallback(url);
        if (!feed) {
          console.warn(`[RAW] Skipping ${url}`);
          continue;
        }
        const items = (feed.items || [])
          .filter((item) => {
            const text = `${item.title} ${
              item.contentSnippet || ""
            }`.toLowerCase();
            return keywords.some((kw) => text.includes(kw));
          })
          .slice(0, 5)
          .map(
            (item, i) =>
              `${i + 1}. ${item.title}\n${
                item.contentSnippet || ""
              }\nSource: ${url}`
          );
        if (items.length >= 2)
          return `LIVE SEARCH RESULTS:\n\n${items.join("\n\n")}`;
      } catch {
        continue;
      }
    }
    return "";
  } catch (err) {
    console.warn("⚠️ RSS fallback failed:", err.message);
    return "";
  }
};

const fetchLiveSearchContext = async (query) => {
  if (!process.env.SERPER_API_KEY) return await fetchRSSFallback(query);
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
    if (!response.ok) throw new Error(`Serper HTTP ${response.status}`);
    const data = await response.json();
    if (!data.organic?.length) throw new Error("No results");
    const results = data.organic
      .slice(0, 5)
      .map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}\nSource: ${r.link}`);
    const formatted = `LIVE SEARCH RESULTS:\n\n${results.join("\n\n")}`;
    searchCache.set(query, { data: formatted, timestamp: now });
    return formatted;
  } catch (err) {
    console.warn("⚠️ Serper failed:", err.message);
    return await fetchRSSFallback(query);
  }
};

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
    const response = await fetch(
      `https://api.worldbank.org/v2/country/${countryCode}/indicator/${indicatorCode}?format=json&mrv=3`
    );
    if (!response.ok) return "";
    const data = await response.json();
    const records = data?.[1]?.filter((r) => r.value !== null);
    if (!records?.length) return "";
    return `WORLD BANK DATA (${indicator} — ${countryCode}):\n${records
      .map((r) => `  • ${r.date}: ${Number(r.value).toLocaleString()}`)
      .join("\n")}\nSource: World Bank Open Data`;
  } catch (err) {
    console.warn("⚠️ World Bank fetch failed:", err.message);
    return "";
  }
};

// ── AI helpers ────────────────────────────────────────────────────────────────
const GROQ_MODELS = [
  { id: "llama-3.1-8b-instant", MaxCompletionTokens: 8000 },
  { id: "llama-3.3-70b-versatile", MaxCompletionTokens: 8000 },
  { id: "openai/gpt-oss-20b", MaxCompletionTokens: 8000 },
  { id: "openai/gpt-oss-120b", MaxCompletionTokens: 8000 },
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
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_completion_tokens: 4000 + (hasContext ? CONTEXT_EXTRA_TOKENS : 0),
      }),
    });
    if (!response.ok) {
      const err = await response.json();
      console.warn("⚠️ GPT-5.4-mini failed:", err?.error?.message);
      return null;
    }
    const data = await response.json();
    console.log("✅ Quiz generated by gpt-5.4-mini");
    return data.choices?.[0]?.message?.content?.trim();
  } catch (err) {
    console.warn("⚠️ GPT error:", err.message);
    return null;
  }
};

const callGroqWithFallback = async (prompt, hasContext = false) => {
  for (const model of GROQ_MODELS) {
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
            max_tokens: 7000,
          }),
        }
      );
      if (!response.ok) {
        console.warn(
          `⚠️ Groq model ${model.id} failed with status: ${response.status}`
        );
        try {
          const errorBody = await response.json();
          console.warn(
            "⚠️ Groq error body:",
            JSON.stringify(errorBody, null, 2)
          );
        } catch {}
        continue;
      }
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim();
      if (content) return content;
    } catch (err) {
      console.warn(`⚠️ Groq model ${model.id} threw an error:`, err.message);
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
].filter(Boolean);

let geminiKeyIndex = 0;
const getNextGeminiKey = () => {
  const key = GEMINI_KEYS[geminiKeyIndex % GEMINI_KEYS.length];
  geminiKeyIndex++;
  return key;
};

const callGeminiOnce = async (prompt, maxOutputTokens = 3000) => {
  for (let attempt = 0; attempt < GEMINI_KEYS.length; attempt++) {
    const key = getNextGeminiKey();
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`,
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
        console.warn(`⚠️ Gemini key ${attempt + 1} rate limited → trying next`);
        continue;
      }
      if (!response.ok) {
        console.warn(`⚠️ Gemini key ${attempt + 1} HTTP ${response.status}`);
        continue;
      }
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text) {
        console.log(`✅ Gemini key ${attempt + 1} succeeded`);
        return text;
      }
    } catch (err) {
      console.warn(`⚠️ Gemini key ${attempt + 1} error:`, err.message);
    }
  }
  return null;
};

const sanitizeJSON = (text) => {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("No JSON array found");
  const raw = text.slice(start, end + 1);
  return raw.replace(/"(?:[^"\\]|\\.)*"/g, (match) => {
    return match
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
  });
};

const extractJSONArray = (text) => {
  const sanitized = sanitizeJSON(text);
  return JSON.parse(sanitized);
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
      signal: ctrl,
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

const askAIAgentGroq = async (question) => {
  try {
    const prompt = `You are a routing agent for an exam prep app.\nDecide the best source to answer this question: "${question}"\nReply with ONLY one word: "web_search" or "direct"`;
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

// ═══════════════════════════════════════════════════════════════════════════
// COINS HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const calculateCoins = (score, total, timeTaken, streak) => {
  const baseCoins = score * 10; // +10 per correct
  const wrongDeduction = (total - score) * 3; // -3 per wrong
  const speedBonus = timeTaken < 60 ? 20 : timeTaken < 120 ? 10 : 0; // fast = bonus
  const streakBonus = streak >= 7 ? 30 : streak >= 3 ? 15 : 0; // streak bonus
  const perfectBonus = score === total ? 50 : 0; // perfect score bonus
  return Math.max(
    0,
    baseCoins - wrongDeduction + speedBonus + streakBonus + perfectBonus
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// CURRENT AFFAIRS
// ═══════════════════════════════════════════════════════════════════════════

const fetchAndStoreRawNews = async () => {
  const today = new Date().toISOString().split("T")[0];

  const existing = await db.collection("raw_news").findOne({ date: today });
  if (existing?.items?.length >= 10) {
    console.log(`[RAW] Already have ${existing.items.length} items for today`);
    return;
  }

  console.log("[RAW] Fetching fresh news from RSS feeds...");
  const allItems = [];
  const seen = new Set();

  const sources = [
    "https://pib.gov.in/RssMain.aspx",
    "https://www.thehindu.com/news/national/?service=rss",
    "https://www.thehindu.com/business/?service=rss",
    "https://www.thehindu.com/sci-tech/?service=rss",
    "https://indianexpress.com/feed/",
    "https://timesofindia.indiatimes.com/rssfeeds/296589292.cms",
    "https://timesofindia.indiatimes.com/rssfeeds/1898055.cms",
    "https://www.thehindu.com/sport/?service=rss",
    "https://pib.gov.in/RssMain.aspx?ModID=6",
  ];

  for (const url of sources) {
    if (allItems.length >= 100) break;
    try {
      const feed = await rssParser.parseURL(url);
      let count = 0;
      for (const item of feed.items || []) {
        if (count >= 15) break;
        if (allItems.length >= 100) break;
        if (!item.title || seen.has(item.title)) continue;
        const pubDate = item.pubDate ? new Date(item.pubDate) : null;
        const isToday =
          pubDate && pubDate.toISOString().split("T")[0] === today;
        const isRecent =
          pubDate && Date.now() - pubDate.getTime() < 48 * 60 * 60 * 1000;
        if (!pubDate || isToday || isRecent) {
          seen.add(item.title);
          const rawSnippet = item.contentSnippet || item.summary || "";
          const cleanSnippet = rawSnippet
            .replace(/[\r\n\t]+/g, " ")
            .replace(/\s{2,}/g, " ")
            .trim()
            .slice(0, 300);
          allItems.push({
            title: item.title.replace(/[\r\n\t]+/g, " ").trim(),
            snippet: cleanSnippet,
            source: new URL(url).hostname,
            pubDate: pubDate?.toISOString() || null,
          });
          count++;
        }
      }
      console.log(`[RAW] ${new URL(url).hostname} → ${count} items`);
    } catch (err) {
      console.warn(`[RAW] Failed: ${url} —`, err.message);
    }
  }

  if (allItems.length < 5) {
    console.warn("[RAW] ⚠️ Too few RSS items — trying Serper as fallback");
    if (process.env.SERPER_API_KEY) {
      try {
        const r = await fetch("https://google.serper.dev/news", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": process.env.SERPER_API_KEY,
          },
          body: JSON.stringify({
            q: "India news today",
            num: 20,
            gl: "in",
            hl: "en",
            tbs: "qdr:d",
          }),
        });
        const d = await r.json();
        (d.news || []).forEach((n) => {
          if (allItems.length >= 100) return;
          if (!seen.has(n.title)) {
            seen.add(n.title);
            allItems.push({
              title: n.title,
              snippet: (n.snippet || "").slice(0, 300),
              source: n.source,
            });
          }
        });
      } catch {}
    }
  }

  const capped = allItems.slice(0, 100);
  await db
    .collection("raw_news")
    .updateOne(
      { date: today },
      { $set: { date: today, items: capped, fetchedAt: new Date() } },
      { upsert: true }
    );
  console.log(`[RAW] ✅ Stored ${capped.length} headlines — 0 API cost`);
};

const buildEnglishPrompt = (headlines, exam, today) =>
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

Pick 40 most exam-relevant items. Return ONLY a raw JSON array — no markdown, no extra text:
[{
  "id": "ca_1",
  "category": "National",
  "headline": "factual headline max 12 words",
  "summary": "4-5 sentences with key facts, numbers, names. Max 80 words. Do not use quotes inside text.",
  "importance": "high",
  "examRelevance": "1 sentence on which exam topic this covers",
  "tags": ["${exam}"]
}]
category: National/International/Economy/Science & Tech/Sports/Environment/Awards/Defence/Health`;

const buildHinglishPromptBatch = (headlines, exam, today) =>
  `ROLE: You are a senior editorial journalist writing Hinglish news for competitive exam students.

STYLE:
- Write in Roman Hindi (no Devanagari)
- Formal newsroom tone — not social media
- Natural Hinglish: Hindi structure + English terms for institutions/policies
- Example: "Sarkar ne fiscal deficit target maintain karte hue naye reforms announce kiye."
- Numbers in digits, names unchanged, no repetition

STRICTLY AVOID:
- "ye ek important khabar hai", "students ko dhyan dena chahiye", "ye behad zaroori hai"
- Casual tone, dramatization, bullet points, emojis
- Quotes inside text fields

Headlines for ${exam} students (today: ${today}):
${headlines
  .map((n, i) => `${i + 1}. ${n.title}${n.snippet ? ` — ${n.snippet}` : ""}`)
  .join("\n")}

Pick 8-10 most exam-relevant items. Return ONLY a raw JSON array — no markdown:
[{
  "id": "ca_1",
  "category": "National",
  "headline": "Hinglish mein sharp factual headline — max 12 words",
  "summary": "4-5 sentences. Har sentence ek alag fact. Min 100 words total.",
  "importance": "high",
  "examRelevance": "Konsa exam topic cover hota hai — 1-2 sentences",
  "tags": ["${exam}"]
}]
category: National/International/Economy/Science & Tech/Sports/Environment/Awards/Defence/Health`;

const generateHinglishInBatches = async (rawItems, exam, today) => {
  console.log(`[Hinglish] Splitting into 3 parts → all 3 Gemini keys parallel`);

  const chunkSize = Math.ceil(rawItems.length / 3);
  const chunks = [
    rawItems.slice(0, chunkSize),
    rawItems.slice(chunkSize, chunkSize * 2),
    rawItems.slice(chunkSize * 2),
  ].filter((c) => c.length > 0);

  const results = await Promise.all(
    chunks.map(async (chunk, i) => {
      const key = GEMINI_KEYS[i % GEMINI_KEYS.length];
      const prompt = buildHinglishPromptBatch(chunk, exam, today);

      console.log(`[Hinglish] Key ${i + 1} → ${chunk.length} headlines`);

      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.3, maxOutputTokens: 3000 },
            }),
          }
        );
        if (!response.ok) {
          console.warn(
            `⚠️ Gemini key ${i + 1} HTTP ${response.status} → Groq fallback`
          );
          throw new Error("Gemini failed");
        }
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!text) throw new Error("Empty response");
        console.log(`✅ Gemini key ${i + 1} succeeded`);
        return text;
      } catch {
        console.warn(`[Hinglish] Key ${i + 1} failed → Groq fallback`);
        try {
          return await callGroqWithFallback(prompt, true);
        } catch {
          console.warn(`[Hinglish] Key ${i + 1} Groq also failed`);
          return null;
        }
      }
    })
  );

  const allItems = [];
  results.forEach((raw, i) => {
    if (!raw) return;
    try {
      const sanitized = sanitizeJSON(raw);
      const items = JSON.parse(sanitized);
      allItems.push(...items);
      console.log(`[Hinglish] Key ${i + 1} → ${items.length} items`);
    } catch (err) {
      console.warn(`[Hinglish] Key ${i + 1} parse failed:`, err.message);
    }
  });

  allItems.forEach((item, i) => {
    item.id = `ca_${i + 1}`;
  });
  console.log(`✅ [Hinglish] Total: ${allItems.length} items`);
  return allItems;
};

const generateForExamLang = async (exam, lang) => {
  const today = new Date().toISOString().split("T")[0];

  let lock;
  try {
    lock = await db
      .collection("current_affairs")
      .findOneAndUpdate(
        { date: today, exam, lang, status: { $exists: false } },
        { $set: { status: "generating", lockedAt: new Date() } },
        { upsert: true, returnDocument: "after" }
      );
  } catch {
    return;
  }

  if (!lock || lock.status !== "generating") return;

  try {
    let rawDoc = await db.collection("raw_news").findOne({ date: today });
    if (!rawDoc?.items?.length) {
      console.log("[CA] Raw news missing — fetching now...");
      await fetchAndStoreRawNews();
      rawDoc = await db.collection("raw_news").findOne({ date: today });
    }
    if (!rawDoc?.items?.length) throw new Error("No raw news available");

    let affairs = [];

    if (lang === "hinglish") {
      affairs = await generateHinglishInBatches(
        rawDoc.items.slice(0, 40),
        exam,
        today
      );
    } else {
      const prompt = buildEnglishPrompt(rawDoc.items.slice(0, 30), exam, today);
      const raw = await callGroqWithFallback(prompt, true);
      if (!raw) throw new Error("Groq returned nothing");
      const cleaned = raw.replace(/```json|```/gi, "").trim();
      const sanitized = sanitizeJSON(cleaned);
      affairs = JSON.parse(sanitized);
    }

    if (!Array.isArray(affairs) || affairs.length < 10)
      throw new Error(`Too few items: ${affairs?.length}`);

    await db.collection("current_affairs").updateOne(
      { date: today, exam, lang },
      {
        $set: {
          affairs,
          status: "done",
          generatedAt: new Date(),
          sourceCount: rawDoc.items.length,
        },
      }
    );
    console.log(`✅ [CA] ${exam} | ${lang} | ${affairs.length} items stored`);
  } catch (err) {
    console.error(`❌ [CA] ${exam} | ${lang}:`, err.message);
    await db
      .collection("current_affairs")
      .updateOne({ date: today, exam, lang }, { $set: { status: "failed" } });
  }
};

const runDailyPregeneration = async () => {
  console.log("[CRON] 🌅 Fetching raw news —", new Date().toISOString());
  await fetchAndStoreRawNews();
  const today = new Date().toISOString().split("T")[0];
  await db.collection("current_affairs").deleteMany({ date: today });
  console.log(
    "[CRON] ✅ Raw news ready — AI will generate on first user request"
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get("/", (req, res) => res.send("✅ Backend running"));
app.get("/health", (req, res) => res.send("Server alive"));

app.get("/admin/refresh-news", async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  await db.collection("raw_news").deleteMany({ date: today });
  await db.collection("current_affairs").deleteMany({ date: today });
  await fetchAndStoreRawNews();
  res.json({ success: true, message: "News refreshed" });
});

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
      {
        $set: { userName, exam, updatedAt: new Date() },
        $inc: { xp },
        $setOnInsert: {
          coins: 0,
          streak: 0,
          lastPlayedDate: null,
          createdAt: new Date(),
        },
      },
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

// ── Quiz Result — now calculates coins + streak ───────────────────────────────
app.post("/quiz/result", async (req, res) => {
  const { userId, topic, exam, score, total, timeTaken, quizId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    // Load current user for streak calculation
    const user = await getUsers().findOne({ userId });
    const today = new Date().toISOString().split("T")[0];
    const lastPlayed = user?.lastPlayedDate;
    const yesterday = new Date(Date.now() - 86400000)
      .toISOString()
      .split("T")[0];

    // Streak logic: same day = keep, yesterday = increment, else reset to 1
    const newStreak =
      lastPlayed === today
        ? user?.streak || 1
        : lastPlayed === yesterday
        ? (user?.streak || 0) + 1
        : 1;

    const coinsEarned = calculateCoins(score, total, timeTaken, newStreak);

    // Update user coins + streak atomically
    await getUsers().updateOne(
      { userId },
      {
        $inc: { coins: coinsEarned },
        $set: {
          streak: newStreak,
          lastPlayedDate: today,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    // Save result record
    await getQuizResults().insertOne({
      userId,
      topic,
      exam,
      score,
      total,
      percentage: Math.round((score / total) * 100),
      timeTaken,
      coinsEarned,
      quizId: quizId ? new ObjectId(quizId) : null,
      createdAt: new Date(),
    });

    // Return updated stats to client
    const updatedUser = await getUsers().findOne({ userId });
    res.json({
      success: true,
      coinsEarned,
      totalCoins: updatedUser?.coins || 0,
      streak: newStreak,
    });
  } catch (err) {
    console.error("❌ Quiz result error:", err.message);
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

// ── Leaderboard — ranked by coins, scoped to exam ─────────────────────────────
app.get("/leaderboard/:exam", async (req, res) => {
  const { exam } = req.params;
  const userId = req.query.userId;
  try {
    // Top 20 players for this exam by coins
    const topUsers = await getUsers()
      .find({ exam, coins: { $gt: 0 } })
      .sort({ coins: -1 })
      .limit(20)
      .project({ userId: 1, userName: 1, coins: 1, streak: 1 })
      .toArray();

    // User's personal rank
    let userRank = null;
    if (userId) {
      const userDoc = await getUsers().findOne({ userId });
      const userCoins = userDoc?.coins || 0;
      const higherCount = await getUsers().countDocuments({
        exam,
        coins: { $gt: userCoins },
      });
      userRank = higherCount + 1;
    }

    res.json({ leaderboard: topUsers, userRank });
  } catch (err) {
    console.error("❌ Leaderboard error:", err.message);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

// ── Current affairs ───────────────────────────────────────────────────────────
app.get("/current-affairs/:exam", async (req, res) => {
  const { exam } = req.params;
  const lang = req.query.lang === "hinglish" ? "hinglish" : "english";
  const today = new Date().toISOString().split("T")[0];

  try {
    const record = await db
      .collection("current_affairs")
      .findOne({ date: today, exam, lang });

    if (record?.status === "done" && record?.affairs?.length >= 10) {
      return res.json({
        date: today,
        exam,
        lang,
        affairs: record.affairs,
        cached: true,
      });
    }

    if (!record || record.status === "failed") generateForExamLang(exam, lang);

    const stale = await db
      .collection("current_affairs")
      .findOne({ exam, lang, status: "done" }, { sort: { date: -1 } });
    if (stale?.affairs?.length) {
      return res.json({
        date: stale.date,
        exam,
        lang,
        affairs: stale.affairs,
        cached: true,
      });
    }

    console.log(
      `[CA] First ever run for ${exam}|${lang} — waiting for generation...`
    );
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const poll = await db
        .collection("current_affairs")
        .findOne({ date: today, exam, lang });
      if (poll?.status === "done" && poll?.affairs?.length >= 10) {
        return res.json({
          date: today,
          exam,
          lang,
          affairs: poll.affairs,
          cached: true,
        });
      }
    }

    return res.json({ date: today, exam, lang, affairs: [], cached: false });
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
    req.file.buffer = null;
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
        const { text } = await extractText(req.file.buffer);
        req.file.buffer = null;
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
    req.file.buffer = null;
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

app.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    const transcription = await groq.audio.transcriptions.create({
      file: new File([req.file.buffer], "audio.webm", { type: "audio/webm" }),
      model: "whisper-large-v3-turbo",
      language: "en",
    });
    req.file.buffer = null;
    res.json({ text: transcription.text });
  } catch {
    res.status(500).json({ error: "Transcription failed" });
  }
});

// ── Chart generation ──────────────────────────────────────────────────────────
app.post("/chart/generate", async (req, res) => {
  const { question, exam = "General" } = req.body;
  if (!question) return res.status(400).json({ error: "Question required" });
  const prompt = `You are a data visualization expert for Indian competitive exams.\nGenerate a chart for this topic: "${question}" for a ${exam} student.\nReturn ONLY a valid JSON object:\n{ "type": "bar"|"line"|"pie"|"doughnut", "title": "...", "labels": [...], "datasets": [{ "label": "...", "data": [...] }], "insight": "..." }\nUse real accurate data. Max 8 data points. Return ONLY the JSON.`;
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
app.use((req, res) => res.status(404).json({ error: "Route not found" }));
app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE")
    return res
      .status(413)
      .json({ error: "File too large. Maximum allowed size is 5MB." });
  console.error("❌ Server error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

// ── Start server ──────────────────────────────────────────────────────────────
connectDB().then(async () => {
  await startJobCron(getJobs, getUsers);

  cron.schedule("30 0 * * *", runDailyPregeneration, { timezone: "UTC" });
  console.log("✅ Raw news cron scheduled — 6:00 AM IST daily");

  setInterval(async () => {
    try {
      const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000);
      const result = await db
        .collection("current_affairs")
        .updateMany(
          { status: "generating", lockedAt: { $lt: tenMinsAgo } },
          { $set: { status: "failed" } }
        );
      if (result.modifiedCount > 0)
        console.log(`🔓 Released ${result.modifiedCount} stale CA locks`);
    } catch {}
  }, 10 * 60 * 1000);

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

  setInterval(() => {
    const mb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(`🧠 Memory: ${mb}MB`);
    if (mb > 400) {
      searchCache.clear();
      userQuizCounts.clear();
      console.log("⚠️ High memory — caches force cleared!");
    }
  }, 5 * 60 * 1000);

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

  cron.schedule("0 1 * * 0", async () => {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const ca = await db
        .collection("current_affairs")
        .deleteMany({ generatedAt: { $lt: sevenDaysAgo } });
      const rn = await db
        .collection("raw_news")
        .deleteMany({ fetchedAt: { $lt: twoDaysAgo } });
      console.log(
        `🧹 Weekly cleanup — CA: ${ca.deletedCount}, raw_news: ${rn.deletedCount}`
      );
    } catch (err) {
      console.warn("⚠️ Weekly cleanup failed:", err.message);
    }
  });
});

app.listen(5050, () =>
  console.log("✅ Backend running on http://localhost:5050")
);
