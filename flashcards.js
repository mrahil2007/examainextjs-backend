// ═══════════════════════════════════════════════════════════════════════════
// flashcards.js — Flashcard generation, review, and deck management
// ═══════════════════════════════════════════════════════════════════════════
//
// Usage in server.js:
//
//   import { initializeFlashcards } from "./flashcards.js";
//
//   // After connectDB().then(...):
//   const flashcards = initializeFlashcards({
//     db,
//     callGeminiOnce,    // your existing helper
//     extractJSONArray,  // your existing helper
//   });
//   app.use("/flashcards", flashcards.router);
//
// Exposes routes:
//   POST   /flashcards/generate
//   POST   /flashcards/from-chat
//   GET    /flashcards/:userId
//   GET    /flashcards/:userId/topic/:topic
//   POST   /flashcards/review
//   DELETE /flashcards/:userId/deck/:batchId
//   GET    /flashcards/:userId/stats
//
// ═══════════════════════════════════════════════════════════════════════════

import express from "express";
import { ObjectId } from "mongodb";

// ── Config ────────────────────────────────────────────────────────────────────
const DAILY_GENERATION_LIMIT_FREE = 3;
const DAILY_GENERATION_LIMIT_PRO = 20;
const MIN_CARDS_PER_DECK = 3;
const MAX_CARDS_PER_DECK = 20;
const DEFAULT_CARDS_PER_DECK = 10;

const Q_MAX_LENGTH = 200;
const A_MAX_LENGTH = 400;

// Spaced repetition intervals (days) by state
const INTERVAL_FORGOT = 1;
const INTERVAL_NEW_KNEW = 1;
const INTERVAL_LEARNING_KNEW = 3;
const INTERVAL_KNOWN_KNEW = 7;

// ── Prompt builder ────────────────────────────────────────────────────────────

const buildFlashcardPrompt = (topic, count) => {
  return `You are a flashcard creator for a student weak on "${topic}".

Generate exactly ${count} question-answer flashcards.

Rules:
- Question: short, direct, factual. 5-15 words max.
- Answer: concise, complete. 5-30 words max. No fluff.
- Test recall, not analysis.
- Cover the most important facts/concepts of "${topic}".
- Order from foundational to advanced.

Avoid:
- "Explain in detail" type questions
- Multiple-choice format
- Examples in answers (unless the example IS the answer)
- Hedging language ("might be", "could be")
- Special characters inside strings (no unescaped quotes, no newlines, no markdown)

OUTPUT FORMAT — strict, no exceptions:
- Return ONE valid JSON array and nothing else
- No commentary before or after
- No markdown code fences
- Use double-quotes (") only, never single quotes
- Escape any internal double-quotes as \\"
- No line breaks inside string values

Example output (exact format):
[{"q":"What is X?","a":"X is Y."},{"q":"Define Z.","a":"Z means W."}]`;
};

// Prompt builder for chat-derived flashcards
const buildChatFlashcardPrompt = (conversationText, count) => {
  return `You are a flashcard creator. The user just had this conversation with an AI tutor:

${conversationText}

Generate exactly ${count} question-answer flashcards capturing the KEY FACTS and CONCEPTS the user learned from this conversation.

Rules:
- Question: short, direct, factual. 5-15 words max.
- Answer: concise, complete. 5-30 words max. No fluff.
- Test recall, not analysis.
- Only cover content actually discussed in the conversation.
- If the conversation has no learnable content (small talk, jokes, vague questions), return an empty array [].

Avoid:
- Questions about the conversation itself ("what did the AI say...")
- "Explain in detail" type questions
- Multiple-choice format
- Hedging language ("might be", "could be")
- Special characters inside strings (no unescaped quotes, no newlines, no markdown)

OUTPUT FORMAT — strict, no exceptions:
- Return ONE valid JSON array and nothing else
- No commentary before or after
- No markdown code fences
- Use double-quotes (") only
- Escape any internal double-quotes as \\"
- No line breaks inside string values

Example output (exact format):
[{"q":"What is X?","a":"X is Y."},{"q":"Define Z.","a":"Z means W."}]`;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const todayISO = () => new Date().toISOString().split("T")[0];

const sanitizeCard = (raw) => {
  const q = (raw?.q || "").toString().trim().slice(0, Q_MAX_LENGTH);
  const a = (raw?.a || "").toString().trim().slice(0, A_MAX_LENGTH);
  return { q, a };
};

// Robust JSON parser for AI-generated flashcards.
// Handles: ```json fences, leading/trailing text, single quotes,
// trailing commas, and falls back to regex extraction of {q, a} pairs.
const parseFlashcardsJSON = (raw) => {
  if (!raw || typeof raw !== "string") throw new Error("Empty AI response");

  // Strip code fences and language hints
  let text = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  // Try strict JSON.parse on the whole thing
  try {
    const direct = JSON.parse(text);
    if (Array.isArray(direct)) return direct;
  } catch {
    /* fall through */
  }

  // Find the first `[` and the matching last `]`
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    let slice = text.slice(start, end + 1);

    // Try as-is
    try {
      const parsed = JSON.parse(slice);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* try cleanup */
    }

    // Cleanup pass: remove trailing commas before } or ]
    const cleaned = slice
      .replace(/,(\s*[}\]])/g, "$1")
      // Replace smart quotes with regular quotes
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");

    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through to regex */
    }
  }

  // Last resort: regex-extract { "q": "...", "a": "..." } pairs
  // Matches q and a in either order, accepts \" escapes
  const cards = [];
  const objRegex =
    /\{[^{}]*?"q"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*?"a"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*?\}/g;
  let m;
  while ((m = objRegex.exec(text)) !== null) {
    cards.push({
      q: m[1].replace(/\\"/g, '"').replace(/\\n/g, " "),
      a: m[2].replace(/\\"/g, '"').replace(/\\n/g, " "),
    });
  }
  if (cards.length > 0) return cards;

  // Try reverse order: a before q
  const objRegex2 =
    /\{[^{}]*?"a"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*?"q"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*?\}/g;
  while ((m = objRegex2.exec(text)) !== null) {
    cards.push({
      q: m[2].replace(/\\"/g, '"').replace(/\\n/g, " "),
      a: m[1].replace(/\\"/g, '"').replace(/\\n/g, " "),
    });
  }
  if (cards.length > 0) return cards;

  throw new Error("Could not extract cards from AI response");
};

const nextState = (currentState, currentStreak, knewIt) => {
  let newState = currentState;
  let newStreak = currentStreak;

  if (knewIt) {
    newStreak += 1;
    if (currentState === "NEW") newState = "LEARNING";
    else if (currentState === "LEARNING" && newStreak >= 2) newState = "KNOWN";
    else if (currentState === "FORGOTTEN" && newStreak >= 2)
      newState = "LEARNING";
  } else {
    newStreak = 0;
    if (currentState === "KNOWN") newState = "FORGOTTEN";
    else if (currentState === "LEARNING") newState = "NEW";
  }

  return { newState, newStreak };
};

const computeNextDueAt = (newState, knewIt) => {
  let intervalDays = INTERVAL_NEW_KNEW;
  if (!knewIt) intervalDays = INTERVAL_FORGOT;
  else if (newState === "KNOWN") intervalDays = INTERVAL_KNOWN_KNEW;
  else if (newState === "LEARNING") intervalDays = INTERVAL_LEARNING_KNEW;
  else intervalDays = INTERVAL_NEW_KNEW;

  return new Date(Date.now() + intervalDays * 86400000)
    .toISOString()
    .split("T")[0];
};

// ── Core generation logic ─────────────────────────────────────────────────────

const generateFlashcardsImpl = async ({
  db,
  callGeminiOnce,
  extractJSONArray,
  userId,
  topic,
  count,
  isPro,
}) => {
  // Rate limit
  const today = todayISO();
  const todayStart = new Date(today + "T00:00:00.000Z");
  const todayGens = await db.collection("card_generations").countDocuments({
    userId,
    createdAt: { $gte: todayStart },
  });

  const limit = isPro
    ? DAILY_GENERATION_LIMIT_PRO
    : DAILY_GENERATION_LIMIT_FREE;
  if (todayGens >= limit) {
    const err = new Error(
      isPro
        ? `Daily limit reached (${limit} decks/day).`
        : `Daily limit reached (${limit} decks/day). Upgrade to Pro for more.`
    );
    err.status = 429;
    throw err;
  }

  const safeCount = Math.min(
    Math.max(Number(count) || DEFAULT_CARDS_PER_DECK, MIN_CARDS_PER_DECK),
    MAX_CARDS_PER_DECK
  );

  const prompt = buildFlashcardPrompt(topic, safeCount);

  const raw = await callGeminiOnce(prompt, 2000);
  if (!raw) {
    const err = new Error("AI generation failed. Please try again.");
    err.status = 502;
    throw err;
  }

  let items;
  try {
    items = parseFlashcardsJSON(raw);
  } catch (e) {
    console.warn("[Cards] Parse failed. Raw output:", raw.slice(0, 800));
    console.warn("[Cards] Parse error:", e.message);
    const err = new Error("Failed to parse generated cards. Please try again.");
    err.status = 502;
    throw err;
  }

  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error("No valid cards generated.");
    err.status = 502;
    throw err;
  }

  const batchId = `batch_${Date.now()}_${userId.slice(-6)}`;
  const now = new Date();

  const docs = items
    .slice(0, safeCount)
    .map((c, i) => {
      const { q, a } = sanitizeCard(c);
      return {
        userId,
        q,
        a,
        topic,
        batchId,
        orderInBatch: i,
        state: "NEW",
        correctStreak: 0,
        totalAttempts: 0,
        totalCorrect: 0,
        createdAt: now,
        lastReviewedAt: null,
        nextDueAt: today,
        archived: false,
      };
    })
    .filter((d) => d.q && d.a);

  if (docs.length < MIN_CARDS_PER_DECK) {
    const err = new Error(
      "Not enough valid cards generated. Please try again."
    );
    err.status = 502;
    throw err;
  }

  const insertResult = await db.collection("flashcards").insertMany(docs);

  await db.collection("card_generations").insertOne({
    userId,
    topic,
    batchId,
    cardCount: docs.length,
    createdAt: now,
  });

  console.log(
    `[Cards] Generated ${docs.length} cards for ${userId} on "${topic}"`
  );

  // Attach inserted IDs as `id` for client convenience
  const cards = docs.map((doc, i) => ({
    ...doc,
    id: insertResult.insertedIds[i].toString(),
  }));

  return { cards, batchId };
};

// ── Chat-based generation ─────────────────────────────────────────────────────

const generateFromChatImpl = async ({
  db,
  callGeminiOnce,
  userId,
  messages,
  count,
  isPro,
}) => {
  if (!Array.isArray(messages) || messages.length < 2) {
    const err = new Error("Not enough conversation to make cards");
    err.status = 400;
    throw err;
  }

  // Rate limit shares the bucket with topic-based generation
  const today = todayISO();
  const todayStart = new Date(today + "T00:00:00.000Z");
  const todayGens = await db
    .collection("card_generations")
    .countDocuments({ userId, createdAt: { $gte: todayStart } });

  const limit = isPro
    ? DAILY_GENERATION_LIMIT_PRO
    : DAILY_GENERATION_LIMIT_FREE;
  if (todayGens >= limit) {
    const err = new Error(
      isPro
        ? `Daily limit reached (${limit} decks/day).`
        : `Daily limit reached (${limit} decks/day). Upgrade to Pro for more.`
    );
    err.status = 429;
    throw err;
  }

  const safeCount = Math.min(
    Math.max(Number(count) || 5, MIN_CARDS_PER_DECK),
    MAX_CARDS_PER_DECK
  );

  // Format last ~12 turns of the conversation, cap at ~6000 chars
  const recent = messages.slice(-12);
  let conversationText = recent
    .map((m) => {
      const role = m.role === "assistant" ? "AI" : "User";
      const content = (m.content || "").toString().replace(/\s+/g, " ").trim();
      return `${role}: ${content}`;
    })
    .join("\n");
  if (conversationText.length > 6000) {
    conversationText = conversationText.slice(-6000);
  }

  const prompt = buildChatFlashcardPrompt(conversationText, safeCount);

  const raw = await callGeminiOnce(prompt, 2000);
  if (!raw) {
    const err = new Error("AI generation failed. Please try again.");
    err.status = 502;
    throw err;
  }

  let items;
  try {
    items = parseFlashcardsJSON(raw);
  } catch (e) {
    console.warn("[Cards] Chat parse failed. Raw:", raw.slice(0, 600));
    const err = new Error(
      "Couldn't extract cards from this chat. Try a more focused conversation."
    );
    err.status = 502;
    throw err;
  }

  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error("No learnable content found in this chat.");
    err.status = 422;
    throw err;
  }

  // Derive a topic from the first user message (best-effort)
  const firstUserMsg =
    messages.find((m) => m.role === "user")?.content || "Chat";
  const topic =
    firstUserMsg.toString().trim().slice(0, 60).replace(/\?+$/, "").trim() ||
    "Chat";

  const batchId = `chat_${Date.now()}_${userId.slice(-6)}`;
  const now = new Date();

  const docs = items
    .slice(0, safeCount)
    .map((c, i) => {
      const { q, a } = sanitizeCard(c);
      return {
        userId,
        q,
        a,
        topic,
        batchId,
        orderInBatch: i,
        source: "chat",
        state: "NEW",
        correctStreak: 0,
        totalAttempts: 0,
        totalCorrect: 0,
        createdAt: now,
        lastReviewedAt: null,
        nextDueAt: today,
        archived: false,
      };
    })
    .filter((d) => d.q && d.a);

  if (docs.length < MIN_CARDS_PER_DECK) {
    const err = new Error("Not enough learnable content in this chat.");
    err.status = 422;
    throw err;
  }

  const insertResult = await db.collection("flashcards").insertMany(docs);

  await db.collection("card_generations").insertOne({
    userId,
    topic,
    batchId,
    cardCount: docs.length,
    source: "chat",
    createdAt: now,
  });

  console.log(
    `[Cards] Generated ${docs.length} chat cards for ${userId} (topic="${topic}")`
  );

  const cards = docs.map((doc, i) => ({
    ...doc,
    id: insertResult.insertedIds[i].toString(),
  }));

  return { cards, batchId, topic };
};

// ── Initialize: creates indexes and returns Express router ────────────────────

export const initializeFlashcards = ({
  db,
  callGeminiOnce,
  extractJSONArray,
}) => {
  if (!db) throw new Error("flashcards: db is required");
  if (!callGeminiOnce)
    throw new Error("flashcards: callGeminiOnce is required");
  if (!extractJSONArray)
    throw new Error("flashcards: extractJSONArray is required");

  // Create indexes (idempotent)
  Promise.all([
    db
      .collection("flashcards")
      .createIndex({ userId: 1, state: 1, nextDueAt: 1 }),
    db.collection("flashcards").createIndex({ userId: 1, topic: 1 }),
    db.collection("flashcards").createIndex({ userId: 1, archived: 1 }),
    db.collection("flashcards").createIndex({ batchId: 1 }),
    db.collection("card_generations").createIndex({ userId: 1, createdAt: -1 }),
  ])
    .then(() => console.log("✅ Flashcards indexes ready"))
    .catch((err) =>
      console.warn("⚠️ Flashcards index setup failed:", err.message)
    );

  const router = express.Router();

  // ── POST /generate ──────────────────────────────────────────────────────────
  router.post("/generate", async (req, res) => {
    const {
      userId,
      topic,
      count = DEFAULT_CARDS_PER_DECK,
      isPro = false,
    } = req.body || {};

    if (!userId || !topic) {
      return res.status(400).json({ error: "userId and topic required" });
    }
    if (typeof topic !== "string" || topic.trim().length < 2) {
      return res.status(400).json({ error: "Invalid topic" });
    }

    try {
      const result = await generateFlashcardsImpl({
        db,
        callGeminiOnce,
        extractJSONArray,
        userId,
        topic: topic.trim(),
        count,
        isPro: Boolean(isPro),
      });
      res.json(result);
    } catch (err) {
      console.error("[Cards] Generate error:", err.message);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // ── POST /from-chat — generate cards from a chat conversation ───────────────
  router.post("/from-chat", async (req, res) => {
    const { userId, messages, count = 5, isPro = false } = req.body || {};

    if (!userId) {
      return res.status(400).json({ error: "userId required" });
    }
    if (!Array.isArray(messages) || messages.length < 2) {
      return res
        .status(400)
        .json({ error: "messages array required (at least 2 turns)" });
    }

    try {
      const result = await generateFromChatImpl({
        db,
        callGeminiOnce,
        userId,
        messages,
        count,
        isPro: Boolean(isPro),
      });
      res.json(result);
    } catch (err) {
      console.error("[Cards] From-chat error:", err.message);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // ── GET /:userId — list decks grouped by topic ──────────────────────────────
  router.get("/:userId", async (req, res) => {
    try {
      const cards = await db
        .collection("flashcards")
        .find({ userId: req.params.userId, archived: false })
        .sort({ createdAt: -1 })
        .toArray();

      const today = todayISO();
      const byTopic = {};

      for (const c of cards) {
        if (!byTopic[c.topic]) {
          byTopic[c.topic] = {
            topic: c.topic,
            totalCards: 0,
            knownCount: 0,
            learningCount: 0,
            newCount: 0,
            forgottenCount: 0,
            dueCount: 0,
            lastReviewedAt: null,
          };
        }
        const d = byTopic[c.topic];
        d.totalCards++;
        if (c.state === "KNOWN") d.knownCount++;
        else if (c.state === "LEARNING") d.learningCount++;
        else if (c.state === "NEW") d.newCount++;
        else if (c.state === "FORGOTTEN") d.forgottenCount++;
        if ((c.nextDueAt || today) <= today) d.dueCount++;
        if (c.lastReviewedAt) {
          const t = new Date(c.lastReviewedAt).toISOString();
          if (!d.lastReviewedAt || t > d.lastReviewedAt) {
            d.lastReviewedAt = t;
          }
        }
      }

      const decks = Object.values(byTopic).sort((a, b) => {
        if (b.dueCount !== a.dueCount) return b.dueCount - a.dueCount;
        return (b.lastReviewedAt || "").localeCompare(a.lastReviewedAt || "");
      });

      res.json({ decks });
    } catch (err) {
      console.error("[Cards] Decks fetch error:", err.message);
      res.status(500).json({ error: "Failed to fetch decks" });
    }
  });

  // ── GET /:userId/topic/:topic — fetch a deck for review ─────────────────────
  router.get("/:userId/topic/:topic", async (req, res) => {
    try {
      const cards = await db
        .collection("flashcards")
        .find({
          userId: req.params.userId,
          topic: req.params.topic,
          archived: false,
        })
        .toArray();

      // Sort priority: FORGOTTEN → LEARNING → NEW → KNOWN, then by orderInBatch
      const priority = { FORGOTTEN: 1, LEARNING: 2, NEW: 3, KNOWN: 4 };
      cards.sort((a, b) => {
        const p = (priority[a.state] || 5) - (priority[b.state] || 5);
        if (p !== 0) return p;
        return (a.orderInBatch || 0) - (b.orderInBatch || 0);
      });

      const out = cards.map((c) => ({
        id: c._id.toString(),
        q: c.q,
        a: c.a,
        topic: c.topic,
        state: c.state,
        correctStreak: c.correctStreak,
      }));

      res.json({ cards: out, total: out.length });
    } catch (err) {
      console.error("[Cards] Deck fetch error:", err.message);
      res.status(500).json({ error: "Failed to fetch deck" });
    }
  });

  // ── POST /review — submit a review for a single card ────────────────────────
  router.post("/review", async (req, res) => {
    const { cardId, userId, knewIt } = req.body || {};

    if (!cardId || !userId || typeof knewIt !== "boolean") {
      return res.status(400).json({ error: "cardId, userId, knewIt required" });
    }

    let cardObjectId;
    try {
      cardObjectId = new ObjectId(cardId);
    } catch (e) {
      return res.status(400).json({ error: "Invalid cardId" });
    }

    try {
      const card = await db
        .collection("flashcards")
        .findOne({ _id: cardObjectId, userId });

      if (!card) return res.status(404).json({ error: "Card not found" });

      const { newState, newStreak } = nextState(
        card.state,
        card.correctStreak || 0,
        knewIt
      );
      const nextDueAt = computeNextDueAt(newState, knewIt);

      await db.collection("flashcards").updateOne(
        { _id: cardObjectId },
        {
          $set: {
            state: newState,
            correctStreak: newStreak,
            lastReviewedAt: new Date(),
            nextDueAt,
          },
          $inc: {
            totalAttempts: 1,
            ...(knewIt ? { totalCorrect: 1 } : {}),
          },
        }
      );

      res.json({ state: newState, nextDueAt, correctStreak: newStreak });
    } catch (err) {
      console.error("[Cards] Review error:", err.message);
      res.status(500).json({ error: "Review failed" });
    }
  });

  // ── DELETE /:userId/deck/:batchId — delete an entire generated deck ─────────
  router.delete("/:userId/deck/:batchId", async (req, res) => {
    try {
      const result = await db.collection("flashcards").deleteMany({
        userId: req.params.userId,
        batchId: req.params.batchId,
      });
      res.json({ success: true, deletedCount: result.deletedCount });
    } catch (err) {
      console.error("[Cards] Delete error:", err.message);
      res.status(500).json({ error: "Delete failed" });
    }
  });

  // ── GET /:userId/stats — quick stats for HomeScreen ─────────────────────────
  router.get("/:userId/stats", async (req, res) => {
    try {
      const userId = req.params.userId;
      const today = todayISO();

      const [byState, dueToday, totalDecks] = await Promise.all([
        db
          .collection("flashcards")
          .aggregate([
            { $match: { userId, archived: false } },
            { $group: { _id: "$state", count: { $sum: 1 } } },
          ])
          .toArray(),
        db.collection("flashcards").countDocuments({
          userId,
          archived: false,
          nextDueAt: { $lte: today },
        }),
        db.collection("flashcards").distinct("topic", {
          userId,
          archived: false,
        }),
      ]);

      const states = { NEW: 0, LEARNING: 0, KNOWN: 0, FORGOTTEN: 0 };
      for (const s of byState) states[s._id] = s.count;

      res.json({
        states,
        dueToday,
        totalDecks: totalDecks.length,
        totalCards:
          states.NEW + states.LEARNING + states.KNOWN + states.FORGOTTEN,
      });
    } catch (err) {
      console.error("[Cards] Stats error:", err.message);
      res.status(500).json({ error: "Stats fetch failed" });
    }
  });

  return { router };
};

// ── Daily cleanup helper — call from your existing 2 AM cron ──────────────────
//
// Usage in server.js inside the existing daily cleanup cron:
//   import { cleanupOldFlashcardData } from "./flashcards.js";
//   await cleanupOldFlashcardData(db);

export const cleanupOldFlashcardData = async (db) => {
  try {
    // Drop generation logs older than 30 days (only used for rate limiting)
    const cutoff = new Date(Date.now() - 30 * 86400000);
    const result = await db
      .collection("card_generations")
      .deleteMany({ createdAt: { $lt: cutoff } });
    if (result.deletedCount > 0) {
      console.log(
        `[Cards] Cleaned up ${result.deletedCount} old generation logs`
      );
    }
  } catch (err) {
    console.warn("[Cards] Cleanup failed:", err.message);
  }
};
