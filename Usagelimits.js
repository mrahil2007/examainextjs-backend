// ═══════════════════════════════════════════════════════════════════════════
// usageLimits.js — Daily free-tier usage caps (Pro users bypass).
//
// Rolling 24-hour window, tracked per user, per feature, in MongoDB so it
// survives restarts and can't be reset by reinstalling the app.
//
//   FREE_DAILY_LIMITS = { quiz: 3, chat: 10 }
//
// Pro detection defaults to reading users.isPro / users.proExpiryDate, which
// your billing webhooks + daily expiry cron keep up to date. If you'd rather
// use the authoritative billing service (handles renewals via Play re-verify),
// pass it in: initUsageLimits(db, { isPro: (uid) => billing.service.getProStatus(uid).isPro })
// ═══════════════════════════════════════════════════════════════════════════

export const FREE_DAILY_LIMITS = { quiz: 3, chat: 10 };

const WINDOW_MS = 24 * 60 * 60 * 1000; // rolling 24h
const CLEANUP_MS = 48 * 60 * 60 * 1000; // TTL margin — never deletes an active window

let usageColl = null;
let usersColl = null;
let isProResolver = null;

// Default Pro check — fast local read of the users collection.
const defaultIsPro = async (key) => {
  const user = await usersColl.findOne(
    { userId: key },
    { projection: { isPro: 1, proExpiryDate: 1 } }
  );
  if (!user?.isPro) return false;
  if (!user.proExpiryDate) return true; // Pro with no expiry recorded → treat as active
  return Date.now() < new Date(user.proExpiryDate).getTime();
};

export const initUsageLimits = async (db, options = {}) => {
  usageColl = db.collection("usage_limits");
  usersColl = db.collection("users");
  await usageColl.createIndex({ userId: 1, feature: 1 }, { unique: true });
  await usageColl.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }); // TTL auto-cleanup
  isProResolver =
    typeof options.isPro === "function" ? options.isPro : defaultIsPro;
  console.log(
    `✅ Usage limits ready (quiz: ${FREE_DAILY_LIMITS.quiz}/day, chat: ${FREE_DAILY_LIMITS.chat}/day)`
  );
};

/**
 * Consume one unit of a user's daily quota for `feature`.
 * Call this at the top of the route. `key` is userId (or anonId for guests).
 *
 * @returns {Promise<{
 *   allowed: boolean,
 *   unlimited: boolean,      // true for Pro / untracked
 *   used?: number,
 *   limit?: number,
 *   resetInMinutes?: number  // present when blocked
 * }>}
 */
export const consumeDailyQuota = async (key, feature) => {
  const limit = FREE_DAILY_LIMITS[feature];
  if (!limit) return { allowed: true, unlimited: true }; // unknown feature → don't block
  if (!key) return { allowed: true, unlimited: true }; // no identifier → can't track

  if (await isProResolver(key)) return { allowed: true, unlimited: true }; // Pro bypass

  const now = Date.now();
  const doc = await usageColl.findOne({ userId: key, feature });

  let windowStart = doc?.windowStart ? new Date(doc.windowStart).getTime() : 0;
  let count = doc?.count || 0;

  const needsReset = !doc || now - windowStart >= WINDOW_MS;
  if (needsReset) {
    windowStart = now;
    count = 0;
  }

  if (count >= limit) {
    const resetInMinutes = Math.max(
      1,
      Math.ceil((windowStart + WINDOW_MS - now) / 60000)
    );
    return {
      allowed: false,
      unlimited: false,
      used: count,
      limit,
      resetInMinutes,
    };
  }

  try {
    if (needsReset) {
      await usageColl.updateOne(
        { userId: key, feature },
        {
          $set: {
            windowStart: new Date(windowStart),
            count: 1,
            expireAt: new Date(windowStart + CLEANUP_MS),
          },
        },
        { upsert: true }
      );
    } else {
      await usageColl.updateOne(
        { userId: key, feature },
        {
          $set: { expireAt: new Date(windowStart + CLEANUP_MS) },
          $inc: { count: 1 },
        }
      );
    }
  } catch (err) {
    // Rare upsert race on the unique index — fail open rather than wrongly block.
    console.warn("⚠️ usage quota write race:", err.message);
  }

  return { allowed: true, unlimited: false, used: count + 1, limit };
};

/**
 * Give back one unit. Call in a route's catch block so a FAILED request
 * (e.g. the AI call errored) doesn't cost the user one of their free credits.
 */
export const refundDailyQuota = async (key, feature) => {
  if (!key || !FREE_DAILY_LIMITS[feature]) return;
  try {
    await usageColl.updateOne(
      { userId: key, feature, count: { $gt: 0 } },
      { $inc: { count: -1 } }
    );
  } catch {
    /* best-effort */
  }
};
