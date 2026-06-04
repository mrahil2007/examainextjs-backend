// ═══════════════════════════════════════════════════════════════════════════
// usageLimits.js — daily free-tier quota enforcement
//
// Rolling 24-hour window per (key, feature). Pro users bypass entirely.
// Backed by a MongoDB `usage_limits` collection with a TTL index so old
// counters self-expire — no cron needed.
//
// server.js expects:
//   await initUsageLimits(db)
//   const q = await consumeDailyQuota(key, feature)   // { allowed, limit, resetInMinutes }
//   await refundDailyQuota(key, feature)
// ═══════════════════════════════════════════════════════════════════════════

const DAY_MS = 24 * 60 * 60 * 1000;

// Per-feature daily limits for free users.
const LIMITS = {
  chat: 10,
  quiz: 3,
};

let _db = null;
let _coll = null;
let _users = null;

export async function initUsageLimits(db) {
  _db = db;
  _coll = db.collection("usage_limits");
  _users = db.collection("users");

  // Fast lookups by key+feature.
  await _coll.createIndex({ key: 1, feature: 1 });

  // TTL index: documents auto-delete 24h after windowStart, so counters
  // never accumulate stale data. (Mongo's TTL monitor runs ~every 60s.)
  try {
    await _coll.createIndex({ windowStart: 1 }, { expireAfterSeconds: 86400 });
  } catch (e) {
    // Index may already exist with different options — safe to ignore.
    console.warn("⚠️ usage_limits TTL index:", e.message);
  }

  console.log("✅ Usage limits initialized (chat=10/day, quiz=3/day)");
}

// Returns true if the user has Pro (so they bypass all limits).
async function isProUser(key) {
  if (!key || !_users) return false;
  try {
    // `key` is userId for logged-in users, anonId/guest for the rest.
    const user = await _users.findOne(
      { userId: key },
      { projection: { isPro: 1, proExpiry: 1, _id: 0 } }
    );
    if (!user) return false;
    if (user.isPro === true) {
      // Optional expiry check if you store one.
      if (user.proExpiry && new Date(user.proExpiry) < new Date()) return false;
      return true;
    }
    return false;
  } catch (e) {
    console.warn("⚠️ isProUser check failed:", e.message);
    return false; // fail closed (treat as free) so limits still apply
  }
}

/**
 * Atomically consume one unit of the daily quota for (key, feature).
 * Returns { allowed, limit, resetInMinutes, remaining }.
 *
 * Pro users and unknown features are always allowed.
 */
export async function consumeDailyQuota(key, feature) {
  const limit = LIMITS[feature];

  // Unknown feature or no key → don't block.
  if (!limit || !key || !_coll) {
    return {
      allowed: true,
      limit: limit || 0,
      resetInMinutes: 0,
      remaining: 0,
    };
  }

  // Pro users bypass.
  if (await isProUser(key)) {
    return {
      allowed: true,
      limit,
      resetInMinutes: 0,
      remaining: limit,
      pro: true,
    };
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - DAY_MS);

  const existing = await _coll.findOne({ key, feature });

  // No record, or the window has fully expired → start a fresh window at 1.
  if (!existing || !existing.windowStart || existing.windowStart < cutoff) {
    await _coll.updateOne(
      { key, feature },
      { $set: { key, feature, count: 1, windowStart: now } },
      { upsert: true }
    );
    return {
      allowed: true,
      limit,
      resetInMinutes: Math.ceil(DAY_MS / 60000),
      remaining: limit - 1,
    };
  }

  // Within the active window.
  const resetInMinutes = Math.max(
    1,
    Math.ceil((existing.windowStart.getTime() + DAY_MS - now.getTime()) / 60000)
  );

  if ((existing.count || 0) >= limit) {
    return { allowed: false, limit, resetInMinutes, remaining: 0 };
  }

  // Increment within the same window.
  await _coll.updateOne({ key, feature }, { $inc: { count: 1 } });
  return {
    allowed: true,
    limit,
    resetInMinutes,
    remaining: limit - (existing.count + 1),
  };
}

/**
 * Refund one unit (used when the downstream AI call fails, so a failed
 * request doesn't burn the user's quota). Never goes below 0, and only
 * touches the current active window.
 */
export async function refundDailyQuota(key, feature) {
  const limit = LIMITS[feature];
  if (!limit || !key || !_coll) return;
  try {
    const now = new Date();
    const cutoff = new Date(now.getTime() - DAY_MS);
    await _coll.updateOne(
      { key, feature, windowStart: { $gte: cutoff }, count: { $gt: 0 } },
      { $inc: { count: -1 } }
    );
  } catch (e) {
    console.warn("⚠️ refundDailyQuota failed:", e.message);
  }
}
