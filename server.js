// ═══════════════════════════════════════════════════════════════════════════
// server.js — Main Express server
// ═══════════════════════════════════════════════════════════════════════════

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { initializeFlashcards, cleanupOldFlashcardData } from "./flashcards.js";

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
import admin from "firebase-admin";
import cron from "node-cron";
import { initializeBilling } from "./billing/index.js";

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
      data: { type, timestamp: String(Date.now()) },
      android: {
        priority: "high",
        notification: {
          channelId:
            type === "quiz_nudge"
              ? "quiz_alerts"
              : type === "current_affairs_morning" ||
                type === "current_affairs_evening" ||
                type === "current_affairs"
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

const ALLOWED_ORIGINS = [
  "https://examai-in.com",
  "https://www.examai-in.com",
  "https://ai-exam-tutor-ten.vercel.app",
  "http://localhost:5173",
  "http://10.0.2.2:5050",
  "http://localhost:3000",
];
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) callback(null, true);
    else callback(new Error(`CORS blocked: ${origin}`));
  },
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "10kb" }));

const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const infipApiKey = process.env.INFIP_API_KEY || "";
if (!infipApiKey)
  console.warn("⚠️  INFIP_API_KEY not set — image generation will fail.");

// ── MongoDB ───────────────────────────────────────────────────────────────────
let db;
const client = new MongoClient(process.env.MONGODB_URI);

async function connectDB() {
  await client.connect();
  db = client.db("examai");
  await db.collection("quizzes").createIndex({ topic: 1 });
  await db
    .collection("quiz_results")
    .createIndex({ userId: 1, topic: 1, quizId: 1 });
  await db.collection("users").createIndex({ coins: -1 });
  await db.collection("raw_news").createIndex({ date: 1 });
  await db
    .collection("current_affairs_quizzes")
    .createIndex({ date: 1 }, { unique: true });
  console.log("✅ MongoDB connected");
}

const getChats = () => db.collection("chats");
const getQuizResults = () => db.collection("quiz_results");
const getUsers = () => db.collection("users");
const getMemories = () => db.collection("memories");
const getQuizzes = () => db.collection("quizzes");

const searchCache = new Map();
const SEARCH_CACHE_DURATION = 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════════
// RSS — feed sources curated for full-body availability
// ═══════════════════════════════════════════════════════════════════════════
import Parser from "rss-parser";
const rssParser = new Parser({
  timeout: 10000,
  customFields: {
    item: [
      ["content:encoded", "contentEncoded"],
      ["dc:creator", "creator"],
    ],
  },
});

const parseRSSWithFallback = async (url) => {
  if (url.includes("pib.gov.in")) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ExamAI/1.0)",
          Accept: "application/rss+xml, application/xml, text/xml, */*",
        },
      });
      clearTimeout(tid);
      if (!r.ok) return null;
      let xml = await r.text();
      if (!xml.trim().startsWith("<?xml") && !xml.includes("<rss")) return null;
      xml = xml.replace(
        /&(?!(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/g,
        "&amp;"
      );
      return await rssParser.parseString(xml);
    } catch (err) {
      console.warn(`[RAW] PIB fetch failed: ${err.message}`);
      return null;
    }
  }
  return await rssParser.parseURL(url);
};

const RSS_NEWS_SOURCES = [
  "https://feeds.bbci.co.uk/news/world/rss.xml",
  "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
  "https://www.aljazeera.com/xml/rss/all.xml",
  "https://www.reutersagency.com/feed/?best-topics=world&post_type=best",
  "https://feeds.skynews.com/feeds/rss/world.xml",
  "https://www.theguardian.com/world/rss",
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
        if (!feed) continue;
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

// ── AI helpers ────────────────────────────────────────────────────────────────
const GROQ_MODELS = [
  { id: "llama-3.3-70b-versatile", MaxCompletionTokens: 8000 },
  { id: "openai/gpt-oss-20b", MaxCompletionTokens: 8000 },
  { id: "openai/gpt-oss-120b", MaxCompletionTokens: 8000 },
  { id: "llama-3.1-8b-instant", MaxCompletionTokens: 8000 },
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
        max_completion_tokens: 8000 + (hasContext ? CONTEXT_EXTRA_TOKENS : 0),
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
            max_tokens: 8000,
          }),
        }
      );
      if (!response.ok) {
        console.warn(
          `⚠️ Groq model ${model.id} failed with status: ${response.status}`
        );
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
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
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

// ═══════════════════════════════════════════════════════════════════════════
// INFIP IMAGE HELPERS
// ═══════════════════════════════════════════════════════════════════════════
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

const saveMemory = async (userId, conversation) => {
  if (!userId || !conversation?.length) return;
  try {
    const existing = await loadMemory(userId);
    const extractPrompt = `
You are a memory extraction system for a study app.
Analyze this conversation and extract key facts about the user.

EXISTING MEMORY:
${existing.length ? existing.map((f) => `- ${f}`).join("\n") : "None yet"}

NEW CONVERSATION:
${conversation.map((m) => `${m.role}: ${m.content}`).join("\n")}

Extract a JSON array of short fact strings: name, interests, weak topics, strong topics, language preference, study goals.

Rules:
- Merge with existing, don't duplicate
- Max 10 facts, each max 15 words
- Return ONLY a JSON array of strings
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

const askAIAgentGroq = async (question) => {
  try {
    const prompt = `You are a routing agent.\nDecide the best source: "${question}"\nReply with ONLY one word: "web_search" or "direct"`;
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
    minVersion: 20,
    currentVersion: 20,
    maintenanceMode: false,
    features: { aiChat: true, voiceMode: true },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COINS HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const calculateCoins = (score, total, timeTaken, streak) => {
  const baseCoins = score * 10;
  const wrongDeduction = (total - score) * 3;
  const speedBonus = timeTaken < 60 ? 20 : timeTaken < 120 ? 10 : 0;
  const streakBonus = streak >= 7 ? 30 : streak >= 3 ? 15 : 0;
  const perfectBonus = score === total ? 50 : 0;
  return Math.max(
    0,
    baseCoins - wrongDeduction + speedBonus + streakBonus + perfectBonus
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// PRIVACY HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\+?[\d\s\-()]{7,}$/;

const isPiiUserName = (name) => {
  if (!name || typeof name !== "string") return true;
  const trimmed = name.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (lower === "null" || lower === "undefined" || lower === "user")
    return true;
  if (EMAIL_REGEX.test(trimmed)) return true;
  if (PHONE_REGEX.test(trimmed)) return true;
  return false;
};

const buildAnonHandle = (userId) => {
  const idStr = (userId || "").toString();
  const slice = idStr
    .slice(-6)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const padded = (slice + "XXXXXX").slice(0, 6);
  return `Student${padded}`;
};

const getSafeUserName = (user) => {
  if (!user) return "Student";
  if (isPiiUserName(user.userName)) {
    return buildAnonHandle(user.userId || user._id);
  }
  return user.userName.trim();
};

// ═══════════════════════════════════════════════════════════════════════════
// CURRENT AFFAIRS — RSS ingestion with full-body extraction
// ═══════════════════════════════════════════════════════════════════════════

const fetchAndStoreRawNews = async () => {
  const today = new Date().toISOString().split("T")[0];

  const existing = await db.collection("raw_news").findOne({ date: today });
  if (existing?.items?.length >= 10) {
    const fetchedAt = existing.fetchedAt ? new Date(existing.fetchedAt) : null;
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
    if (fetchedAt && fetchedAt > sixHoursAgo) {
      console.log(
        `[RAW] Already have fresh news (${existing.items.length} items)`
      );
      return;
    }
  }

  console.log("[RAW] Fetching fresh news from RSS feeds...");
  const allItems = [];
  const seen = new Set();

  const sources = [
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    "https://www.aljazeera.com/xml/rss/all.xml",
    "https://ir.thomsonreuters.com/rss/news-releases.xml?items=15",
    "https://feeds.skynews.com/feeds/rss/world.xml",
    "https://www.theguardian.com/world/rss",
    "https://www.moneycontrol.com/rss/latestnews.xml",
    "https://www.livemint.com/rss/news",
  ];

  for (const url of sources) {
    if (allItems.length >= 200) break;
    try {
      const feed = await parseRSSWithFallback(url);
      if (!feed) {
        console.warn(`[RAW] Skipping ${url}`);
        continue;
      }
      let count = 0;
      for (const item of feed.items || []) {
        if (count >= 40) break;
        if (allItems.length >= 200) break;
        if (!item.title || seen.has(item.title)) continue;
        const pubDate = item.pubDate ? new Date(item.pubDate) : null;
        const isToday =
          pubDate && pubDate.toISOString().split("T")[0] === today;
        const isRecent =
          pubDate && Date.now() - pubDate.getTime() < 48 * 60 * 60 * 1000;
        if (!pubDate || isToday || isRecent) {
          seen.add(item.title);

          const rawBody =
            item.contentEncoded ||
            item["content:encoded"] ||
            item.content ||
            item.contentSnippet ||
            item.summary ||
            "";

          const cleanBody = rawBody
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]*>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/[\r\n\t]+/g, " ")
            .replace(/\s{2,}/g, " ")
            .trim();

          const snippet = cleanBody.slice(0, 300);
          const fullBody =
            cleanBody.length > 300 ? cleanBody.slice(0, 3000) : "";

          allItems.push({
            title: item.title.replace(/[\r\n\t]+/g, " ").trim(),
            snippet,
            fullBody,
            link: item.link || null,
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

  if (allItems.length < 5 && process.env.SERPER_API_KEY) {
    console.warn("[RAW] ⚠️ Too few RSS items — trying Serper fallback");
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
            fullBody: "",
            link: n.link || null,
            source: n.source,
          });
        }
      });
    } catch {}
  }

  const capped = allItems.slice(0, 100);
  await db
    .collection("raw_news")
    .updateOne(
      { date: today },
      { $set: { date: today, items: capped, fetchedAt: new Date() } },
      { upsert: true }
    );
  console.log(`[RAW] ✅ Stored ${capped.length} items — 0 API cost`);
};

// ═══════════════════════════════════════════════════════════════════════════
// DAILY CURRENT AFFAIRS QUIZ — single hard quiz
// ═══════════════════════════════════════════════════════════════════════════

const generateCurrentAffairsQuiz = async (newsItems) => {
  const ranked = [...newsItems]
    .filter((i) => i.fullBody || (i.snippet && i.snippet.length > 50))
    .sort((a, b) => {
      const scoreA = (a.fullBody?.length || 0) + (a.snippet?.length || 0);
      const scoreB = (b.fullBody?.length || 0) + (b.snippet?.length || 0);
      return scoreB - scoreA;
    })
    .slice(0, 20);

  if (ranked.length < 5) return null;

  const contextBlock = ranked
    .map((item, i) => {
      const body = item.fullBody?.slice(0, 800) || item.snippet || "";
      return `[${i + 1}] ${item.title}\nSource: ${item.source}\n${body}\n`;
    })
    .join("\n---\n");

  const prompt = `You are a senior question setter for competitive exams.

Generate exactly 10 HARD MCQs from these current affairs items.

DIFFICULTY: HARD — competitive exam level (UPSC Prelims style).

STYLE:
- Use "Consider the following statements" format for at least 4 questions
- Use "Which of the following is/are correct?" for at least 2 questions
- Distractors must be highly plausible
- Test conceptual understanding, not just headlines
- Include subtle traps: dates, ministry names, sequence of events, exact figures
- Avoid trivial recall

NEWS ITEMS:
${contextBlock}

Rules:
- Each MCQ answerable from the items above — don't invent facts
- 4 options each, exactly one correct
- 1-2 sentence explanation
- Cover diverse topics

Return ONLY a valid JSON array:
[
  {
    "question": "Consider the following statements:\\n1. Statement A\\n2. Statement B\\n3. Statement C\\nWhich of the statements above is/are correct?",
    "options": ["1 and 2 only", "2 and 3 only", "1 and 3 only", "1, 2 and 3"],
    "correct": 0,
    "explanation": "...",
    "topic": "Polity | Economy | Governance | IR | Environment | Schemes | Science | Defence | Social | International"
  }
]

correct = index (0-3) of right option.`;

  try {
    const raw = await callGeminiOnce(prompt, 4000);
    if (!raw) return null;
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const questions = extractJSONArray(cleaned);
    if (!Array.isArray(questions) || questions.length < 5) return null;

    const validated = questions
      .filter(
        (q) =>
          q.question &&
          Array.isArray(q.options) &&
          q.options.length === 4 &&
          typeof q.correct === "number" &&
          q.correct >= 0 &&
          q.correct <= 3
      )
      .map((q) => ({
        question: q.question.trim(),
        options: q.options.map((o) => String(o).trim()),
        correct: q.correct,
        explanation: (q.explanation || "").trim(),
        topic: q.topic || "General",
      }));

    return validated.length >= 5 ? validated : null;
  } catch (err) {
    console.warn(`[CA Quiz] Generation failed:`, err.message);
    return null;
  }
};

const generateDailyQuiz = async () => {
  const today = new Date().toISOString().split("T")[0];
  const existing = await db
    .collection("current_affairs_quizzes")
    .findOne({ date: today });
  if (existing) return;

  const rawDoc = await db.collection("raw_news").findOne({ date: today });
  if (!rawDoc?.items?.length) return;

  console.log("[CA Quiz] Generating today's quiz...");
  const questions = await generateCurrentAffairsQuiz(rawDoc.items);
  if (!questions) return;

  await db.collection("current_affairs_quizzes").updateOne(
    { date: today },
    {
      $set: {
        date: today,
        questions,
        generatedAt: new Date(),
        totalQuestions: questions.length,
      },
    },
    { upsert: true }
  );
  console.log(`[CA Quiz] ✅ ${questions.length} hard questions stored`);
};

const runDailyPregeneration = async () => {
  console.log("[CRON] 🌅 Daily refresh —", new Date().toISOString());
  const today = new Date().toISOString().split("T")[0];
  await db.collection("raw_news").deleteMany({ date: { $ne: today } });
  await db
    .collection("current_affairs_quizzes")
    .deleteMany({ date: { $ne: today } });
  await fetchAndStoreRawNews();
  await generateDailyQuiz();
  console.log("[CRON] ✅ Done");
};

// ═══════════════════════════════════════════════════════════════════════════
// PUSH NOTIFICATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const IST_TZ_OFFSET_MINUTES = 5 * 60 + 30;

const getISTHour = () => {
  const now = new Date();
  const istMs = now.getTime() + IST_TZ_OFFSET_MINUTES * 60 * 1000;
  return new Date(istMs).getUTCHours();
};

const isQuietHours = () => {
  const hour = getISTHour();
  return hour >= 23 || hour < 6;
};

const PUSH_DELAY_MS = 30;

const sendPushToAllUsers = async ({ title, body, type }) => {
  if (isQuietHours()) {
    console.log(`[Push:${type}] Skipped — quiet hours`);
    return { sent: 0, failed: 0, skipped: 0 };
  }
  try {
    const query = {
      fcmToken: { $exists: true, $ne: null },
      $or: [
        { "notificationPrefs.enabled": { $exists: false } },
        { "notificationPrefs.enabled": true },
      ],
    };

    const users = await getUsers()
      .find(query)
      .project({ userId: 1, fcmToken: 1, notificationPrefs: 1 })
      .toArray();

    let sent = 0,
      failed = 0,
      skipped = 0;
    const invalidTokens = [];

    for (const user of users) {
      if (user.notificationPrefs?.[type] === false) {
        skipped++;
        continue;
      }
      try {
        await admin.messaging().send({
          token: user.fcmToken,
          notification: { title, body },
          data: { type, timestamp: String(Date.now()) },
          android: {
            priority: "high",
            notification: {
              channelId:
                type === "quiz_nudge"
                  ? "quiz_alerts"
                  : type === "current_affairs_morning" ||
                    type === "current_affairs_evening"
                  ? "current_affairs"
                  : "general",
            },
          },
        });
        sent++;
      } catch (err) {
        failed++;
        const code = err?.errorInfo?.code || err?.code || "";
        if (
          code.includes("registration-token-not-registered") ||
          code.includes("invalid-argument") ||
          code.includes("invalid-registration-token")
        ) {
          invalidTokens.push(user.userId);
        }
      }
      await new Promise((r) => setTimeout(r, PUSH_DELAY_MS));
    }

    if (invalidTokens.length) {
      getUsers()
        .updateMany(
          { userId: { $in: invalidTokens } },
          { $unset: { fcmToken: "" } }
        )
        .catch(() => {});
    }

    console.log(
      `[Push:${type}] sent=${sent} failed=${failed} skipped=${skipped}`
    );
    return { sent, failed, skipped };
  } catch (err) {
    console.error(`[Push:${type}] Fatal:`, err.message);
    return { sent: 0, failed: 0, skipped: 0 };
  }
};

const getMorningPushContent = async () => {
  const today = new Date().toISOString().split("T")[0];
  const rawDoc = await db.collection("raw_news").findOne({ date: today });
  if (!rawDoc?.items?.length) return null;
  return {
    title: `📰 Today's brief is ready`,
    body: `${rawDoc.items.length} current affairs waiting — start your prep`,
  };
};

const getEveningPushContent = async () => {
  const today = new Date().toISOString().split("T")[0];
  const rawDoc = await db.collection("raw_news").findOne({ date: today });
  if (!rawDoc?.items?.length) return null;
  return {
    title: `🌆 Evening update`,
    body: `Fresh stories since morning — open the digest`,
  };
};

const getQuizPushContent = async () => {
  const today = new Date().toISOString().split("T")[0];
  const quiz = await db
    .collection("current_affairs_quizzes")
    .findOne({ date: today });
  if (!quiz) {
    return { title: "🎯 Quiz time", body: "Test what you learned today" };
  }
  const variants = [
    {
      title: "🎯 Today's CA Quiz — 10 Qs",
      body: "Test your knowledge. 5 min, earn coins.",
    },
    {
      title: "🧠 Did you absorb today's CA?",
      body: "Find out in 10 questions",
    },
    {
      title: "🏆 Maintain your streak",
      body: "Today's current affairs quiz is live",
    },
  ];
  return variants[new Date().getDate() % variants.length];
};

// ═══════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get("/", (req, res) => res.send("✅ Backend running"));
app.get("/health", (req, res) => res.send("Server alive"));

app.get("/admin/refresh-news", async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  await db.collection("raw_news").deleteMany({ date: today });
  await fetchAndStoreRawNews();
  res.json({ success: true });
});

app.get("/admin/regenerate-ca-quiz", async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  await db.collection("current_affairs_quizzes").deleteMany({ date: today });
  await generateDailyQuiz();
  res.json({ success: true });
});

app.get("/admin/test-push/:type", async (req, res) => {
  const { type } = req.params;
  let content;
  if (type === "morning") content = await getMorningPushContent();
  else if (type === "evening") content = await getEveningPushContent();
  else if (type === "quiz") content = await getQuizPushContent();
  else return res.status(400).json({ error: "Invalid type" });
  if (!content) return res.json({ error: "No content available" });

  const pushType =
    type === "quiz"
      ? "quiz_nudge"
      : type === "morning"
      ? "current_affairs_morning"
      : "current_affairs_evening";

  const result = await sendPushToAllUsers({
    title: content.title,
    body: content.body,
    type: pushType,
  });
  res.json({ content, result });
});

// ── Chat history ──────────────────────────────────────────────────────────────
app.get("/chats/:userId", async (req, res) => {
  try {
    const chats = await getChats()
      .find({ userId: req.params.userId })
      .sort({ updatedAt: -1 })
      .project({ title: 1, updatedAt: 1 })
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
    const newChat = {
      userId: req.params.userId,
      title: "New Chat",
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
  const { question, history = [], userId, chatId, anonId } = req.body;
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
    if (!isSimple) decision = await askAIAgentGroq(question);
    if (decision.action === "web_search") {
      const ctx = await fetchLiveSearchContext(decision.query);
      if (ctx) finalPrompt = `${ctx}\n\nQuestion: ${question}`;
    }
    const answer = await askAI(finalPrompt, history, false, memory);
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
      saveMemory(resolvedUserId, updatedHistory).catch((err) =>
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
  const { userId, userName, xp = 0 } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    const safeName = isPiiUserName(userName)
      ? buildAnonHandle(userId)
      : userName.trim();
    await getUsers().updateOne(
      { userId },
      {
        $set: { userName: safeName, updatedAt: new Date() },
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
    const { email, phone, phoneNumber, fcmToken, _id, ...rest } = user;
    res.json({ ...rest, userName: getSafeUserName(user) });
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
  } catch {
    res.status(500).json({ error: "Memory merge failed" });
  }
});

app.patch("/user/:userId/notification-prefs", async (req, res) => {
  const { userId } = req.params;
  const {
    enabled,
    current_affairs_morning,
    current_affairs_evening,
    quiz_nudge,
  } = req.body;
  try {
    const update = {};
    if (typeof enabled === "boolean")
      update["notificationPrefs.enabled"] = enabled;
    if (typeof current_affairs_morning === "boolean")
      update["notificationPrefs.current_affairs_morning"] =
        current_affairs_morning;
    if (typeof current_affairs_evening === "boolean")
      update["notificationPrefs.current_affairs_evening"] =
        current_affairs_evening;
    if (typeof quiz_nudge === "boolean")
      update["notificationPrefs.quiz_nudge"] = quiz_nudge;
    await getUsers().updateOne(
      { userId },
      { $set: { ...update, updatedAt: new Date() } }
    );
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Failed to update prefs" });
  }
});

app.get("/user/:userId/notification-prefs", async (req, res) => {
  try {
    const user = await getUsers().findOne(
      { userId: req.params.userId },
      { projection: { notificationPrefs: 1, _id: 0 } }
    );
    res.json({
      enabled: user?.notificationPrefs?.enabled !== false,
      current_affairs_morning:
        user?.notificationPrefs?.current_affairs_morning !== false,
      current_affairs_evening:
        user?.notificationPrefs?.current_affairs_evening !== false,
      quiz_nudge: user?.notificationPrefs?.quiz_nudge !== false,
    });
  } catch {
    res.status(500).json({ error: "Failed to load prefs" });
  }
});

// ── Quiz generation (with difficulty) ─────────────────────────────────────────
app.post("/quiz/generate", async (req, res) => {
  const { topic, count = 10, userId, difficulty = "hard" } = req.body;
  if (!checkUserRateLimit(userId))
    return res.status(429).json({ error: "Limit reached" });
  if (!topic) return res.status(400).json({ error: "Topic required" });
  const safeCount = Math.min(Math.max(Number(count) || 10, 1), 40);
  const safeDifficulty = ["easy", "medium", "hard"].includes(difficulty)
    ? difficulty
    : "hard";

  if (userId) {
    const solvedResults = await getQuizResults()
      .find({ userId, topic, quizId: { $ne: null } })
      .project({ quizId: 1 })
      .toArray();
    const solvedIds = solvedResults.map((r) => r.quizId).filter(Boolean);
    const existingQuiz = await getQuizzes().findOne({
      topic,
      difficulty: safeDifficulty,
      ...(solvedIds.length ? { _id: { $nin: solvedIds } } : {}),
      createdAt: { $exists: true },
      "questions.10": { $exists: safeCount > 10 ? true : false },
    });
    if (existingQuiz) {
      console.log(`♻️ Serving pooled quiz ${existingQuiz._id}`);
      return res.json({
        quizId: existingQuiz._id,
        questions: existingQuiz.questions,
        reused: true,
      });
    }
  }

  const prompt = getQuizPrompt("General", topic, safeCount, "", safeDifficulty);
  try {
    const content = await generateAIContent(prompt, false);
    const questions = extractJSONArray(
      content.replace(/```json|```/gi, "").trim()
    );
    const quizDoc = {
      topic,
      difficulty: safeDifficulty,
      questions,
      createdAt: new Date(),
    };
    const result = await getQuizzes().insertOne(quizDoc);
    res.json({
      quizId: result.insertedId,
      questions,
      reused: false,
    });
  } catch (err) {
    console.error("❌ Quiz generation error:", err.message);
    res.status(500).json({ error: "Quiz failed" });
  }
});

// ── Daily Current Affairs Quiz ────────────────────────────────────────────────
app.get("/current-affairs-quiz", async (req, res) => {
  const userId = req.query.userId;
  const today = new Date().toISOString().split("T")[0];
  try {
    const quizDoc = await db
      .collection("current_affairs_quizzes")
      .findOne({ date: today });
    if (!quizDoc) {
      return res.json({
        date: today,
        questions: [],
        available: false,
        message: "Today's quiz is being prepared.",
      });
    }
    let alreadyAttempted = false;
    let previousScore = null;
    if (userId) {
      const result = await getQuizResults().findOne({
        userId,
        topic: `Current Affairs ${today}`,
      });
      if (result) {
        alreadyAttempted = true;
        previousScore = {
          score: result.score,
          total: result.total,
          percentage: result.percentage,
          coinsEarned: result.coinsEarned,
        };
      }
    }
    res.json({
      date: today,
      quizId: quizDoc._id,
      questions: quizDoc.questions,
      totalQuestions: quizDoc.totalQuestions,
      available: true,
      alreadyAttempted,
      previousScore,
    });
  } catch (err) {
    console.error("[CA Quiz] Fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch quiz" });
  }
});

// ── Quiz Result ───────────────────────────────────────────────────────────────
app.post("/quiz/result", async (req, res) => {
  const { userId, topic, score, total, timeTaken, quizId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    const user = await getUsers().findOne({ userId });
    const today = new Date().toISOString().split("T")[0];
    const lastPlayed = user?.lastPlayedDate;
    const yesterday = new Date(Date.now() - 86400000)
      .toISOString()
      .split("T")[0];
    const newStreak =
      lastPlayed === today
        ? user?.streak || 1
        : lastPlayed === yesterday
        ? (user?.streak || 0) + 1
        : 1;
    const coinsEarned = calculateCoins(score, total, timeTaken, newStreak);
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
    await getQuizResults().insertOne({
      userId,
      topic,
      score,
      total,
      percentage: Math.round((score / total) * 100),
      timeTaken,
      coinsEarned,
      quizId: quizId ? new ObjectId(quizId) : null,
      createdAt: new Date(),
    });
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

// ── Leaderboard ───────────────────────────────────────────────────────────────
app.get("/leaderboard", async (req, res) => {
  const userId = req.query.userId;
  try {
    const topUsers = await getUsers()
      .find({ coins: { $gt: 0 } })
      .sort({ coins: -1 })
      .limit(20)
      .project({ userId: 1, userName: 1, coins: 1, streak: 1, _id: 0 })
      .toArray();
    const sanitizedLeaderboard = topUsers.map((user) => ({
      userId: user.userId,
      userName: getSafeUserName(user),
      coins: user.coins || 0,
      streak: user.streak || 0,
    }));
    let userRank = null;
    if (userId) {
      const userDoc = await getUsers().findOne(
        { userId },
        { projection: { coins: 1, _id: 0 } }
      );
      const userCoins = userDoc?.coins || 0;
      const higherCount = await getUsers().countDocuments({
        coins: { $gt: userCoins },
      });
      userRank = higherCount + 1;
    }
    res.json({ leaderboard: sanitizedLeaderboard, userRank });
  } catch (err) {
    console.error("❌ Leaderboard error:", err.message);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

// ── Current Affairs ───────────────────────────────────────────────────────────
app.get("/current-affairs", async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  try {
    let rawDoc = await db.collection("raw_news").findOne({ date: today });
    if (!rawDoc?.items?.length) {
      await fetchAndStoreRawNews();
      rawDoc = await db.collection("raw_news").findOne({ date: today });
    }
    if (!rawDoc?.items?.length) {
      return res.json({ date: today, affairs: [], total: 0 });
    }
    const affairs = rawDoc.items.map((item, i) => ({
      id: `ca_${i + 1}`,
      headline: item.title,
      summary: item.snippet && item.snippet !== item.title ? item.snippet : "",
      fullBody: item.fullBody || null,
      link: item.link || null,
      source: item.source,
      pubDate: item.pubDate,
    }));
    res.json({
      date: rawDoc.date,
      affairs,
      total: affairs.length,
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
      mode: result.mode,
    });
  } catch (err) {
    console.error("❌ /image/edit:", err.message);
    return res.status(502).json({ error: err.message || "Image edit failed" });
  }
});

// ── Image / PDF upload — vision analysis or PDF text extraction ──────────────
app.post("/image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "File required" });

    const userId = req.body.userId || req.body.anonId || null;
    const userPrompt =
      typeof req.body.prompt === "string" ? req.body.prompt.trim() : "";
    const memory = userId ? await loadMemory(userId) : [];

    // PDF flow — extract text first, then ask AI tutor
    if (req.file.mimetype === "application/pdf") {
      try {
        const { text } = await extractText(req.file.buffer);
        if (text && text.trim().length > 50) {
          const combined = userPrompt
            ? `${userPrompt}\n\n[Uploaded document content]\n${text.slice(
                0,
                12000
              )}`
            : `Analyze and explain this uploaded document. Extract key concepts, formulas, and likely exam questions.\n\n[Document content]\n${text.slice(
                0,
                12000
              )}`;
          const answer = await askAI(combined, [], false, memory);
          req.file.buffer = null;
          return res.json({ answer });
        }
      } catch (err) {
        console.warn("⚠️ PDF text extraction failed:", err.message);
        // fall through to vision
      }
    }

    // Image flow — pass user prompt to vision model
    const answer = await askAIWithImage(
      req.file.buffer,
      req.file.mimetype,
      userPrompt
    );
    req.file.buffer = null;
    res.json({ answer });
  } catch (err) {
    console.error("❌ /image error:", err.message);
    res.status(500).json({ error: "Image processing failed" });
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
// ── Bonus coins (rewarded ad rewards, daily login, etc.) ─────────────────────
app.post("/user/bonus-coins", async (req, res) => {
  const { userId, amount, reason } = req.body;
  if (!userId || !amount || amount < 0 || amount > 500) {
    return res.status(400).json({ error: "Invalid request" });
  }
  try {
    await getUsers().updateOne(
      { userId },
      {
        $inc: { coins: amount },
        $push: {
          bonusLog: {
            $each: [{ amount, reason: reason || "bonus", at: new Date() }],
            $slice: -50, // keep last 50 bonus events only
          },
        },
        $set: { updatedAt: new Date() },
      },
      { upsert: false }
    );
    const updated = await getUsers().findOne({ userId });
    res.json({ success: true, totalCoins: updated?.coins || 0 });
  } catch (err) {
    console.error("❌ Bonus coins error:", err.message);
    res.status(500).json({ error: "Failed to credit coins" });
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
      getMemories().deleteMany({ userId }),
    ]);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Failed to delete user data" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// BACKWARD-COMPAT SHIMS for released app (v19 and below)
// ═══════════════════════════════════════════════════════════════════════════

// Old leaderboard — redirect to new endpoint (same shape)
app.get("/leaderboard/:exam", (req, res, next) => {
  req.url = `/leaderboard${
    req.url.includes("?") ? req.url.substring(req.url.indexOf("?")) : ""
  }`;
  app._router.handle(req, res, next);
});

// Old current-affairs — legacy field shape with category/importance/content
app.get("/current-affairs/:exam", async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  try {
    let rawDoc = await db.collection("raw_news").findOne({ date: today });
    if (!rawDoc?.items?.length) {
      await fetchAndStoreRawNews();
      rawDoc = await db.collection("raw_news").findOne({ date: today });
    }
    const affairs = (rawDoc?.items || [])
      .filter(
        (item) =>
          (item.fullBody && item.fullBody.length > 100) ||
          (item.snippet && item.snippet.length > 80)
      )
      .map((item, i) => ({
        id: `ca_${i + 1}`,
        category: "National",
        headline: item.title,
        summary:
          item.snippet && item.snippet !== item.title ? item.snippet : "",
        content: item.fullBody || item.snippet || item.title,
        importance: "high",
        examRelevance: req.params.exam || "General",
        tags: [],
      }));
    res.json({
      date: rawDoc?.date || today,
      exam: req.params.exam || "General",
      lang: req.query.lang || "english",
      affairs,
      cached: false,
    });
  } catch (err) {
    console.error("[CA compat] ❌", err.message);
    res.status(500).json({ error: "Failed to fetch current affairs" });
  }
});

// Jobs — return object shape, not array (old Gson model expects object)
app.get("/jobs", (req, res) => res.json({ jobs: [], total: 0, page: 1 }));
app.get("/jobs/*", (req, res) => res.json({ jobs: [], total: 0, page: 1 }));
app.post("/jobs/*", (req, res) => res.json({ success: true }));

// Resume — return [] shape for old app's List<ResumeResponse>
app.get("/resume/:userId", (req, res) => res.json([]));
app.get("/resume/:userId/:id", (req, res) =>
  res.json({ _id: "", title: "Update required", updatedAt: "" })
);
app.post("/resume/generate", (req, res) =>
  res.status(410).json({ error: "Please update the app to continue" })
);
app.post("/resume/:userId", (req, res) => res.json({ success: true }));
app.delete("/resume/:userId", (req, res) => res.json({ success: true }));
app.delete("/resume/:userId/:id", (req, res) => res.json({ success: true }));

// Chart removed — graceful error
app.post("/chart/generate", (req, res) =>
  res.status(410).json({ error: "Feature no longer available. Please update." })
);

// ═══════════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════════

connectDB().then(async () => {
  const billing = await initializeBilling({ db });
  app.use("/billing", billing.router);

  // Flashcards module
  const flashcards = initializeFlashcards({
    db,
    callGeminiOnce,
    extractJSONArray,
  });
  app.use("/flashcards", flashcards.router);
  console.log("✅ Flashcards module mounted at /flashcards");

  cron.schedule("30 0 * * *", runDailyPregeneration, { timezone: "UTC" });
  console.log("✅ Daily news + quiz cron — 6:00 AM IST");

  cron.schedule(
    "30 1 * * *",
    async () => {
      const content = await getMorningPushContent();
      if (!content) return;
      await sendPushToAllUsers({
        title: content.title,
        body: content.body,
        type: "current_affairs_morning",
      });
    },
    { timezone: "UTC" }
  );
  console.log("✅ Morning push — 7:00 AM IST");

  cron.schedule(
    "0 13 * * *",
    async () => {
      try {
        await fetchAndStoreRawNews();
      } catch {}
      const content = await getEveningPushContent();
      if (!content) return;
      await sendPushToAllUsers({
        title: content.title,
        body: content.body,
        type: "current_affairs_evening",
      });
    },
    { timezone: "UTC" }
  );
  console.log("✅ Evening push — 6:30 PM IST");

  cron.schedule(
    "0 16 * * *",
    async () => {
      const content = await getQuizPushContent();
      await sendPushToAllUsers({
        title: content.title,
        body: content.body,
        type: "quiz_nudge",
      });
    },
    { timezone: "UTC" }
  );
  console.log("✅ Quiz push — 9:30 PM IST");

  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of searchCache.entries()) {
      if (now - val.timestamp > SEARCH_CACHE_DURATION) searchCache.delete(key);
    }
    for (const [key, val] of userQuizCounts.entries()) {
      if (now - val.windowStart > 60 * 60 * 1000) userQuizCounts.delete(key);
    }
  }, 60 * 60 * 1000);

  setInterval(() => {
    const mb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(`🧠 Memory: ${mb}MB`);
    if (mb > 400) {
      searchCache.clear();
      userQuizCounts.clear();
    }
  }, 5 * 60 * 1000);

  // Daily cleanup — empty chats + old flashcard generation logs
  cron.schedule("0 2 * * *", async () => {
    try {
      await getChats().deleteMany({
        messages: { $size: 0 },
        createdAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      });
      await cleanupOldFlashcardData(db);
    } catch (err) {
      console.warn("⚠️ Daily cleanup failed:", err.message);
    }
  });

  // 404 handler MUST be registered LAST
  app.use((req, res) => res.status(404).json({ error: "Route not found" }));
  app.use((err, req, res, next) => {
    if (err.code === "LIMIT_FILE_SIZE")
      return res.status(413).json({ error: "File too large. Max 5MB." });
    console.error("❌ Server error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  });

  app.listen(5050, () =>
    console.log("✅ Backend running on http://localhost:5050")
  );
});
