// ═══════════════════════════════════════════════════════════════════════════
// billing/repository.js
// All MongoDB reads/writes for billing live here.
// Consumers never see the database driver — they call typed methods.
// ═══════════════════════════════════════════════════════════════════════════

import { BILLING_EVENT_TYPE } from "./constants.js";

const USERS_COLLECTION = "users";
const EVENTS_COLLECTION = "billing_events";

/**
 * Creates a billing repository bound to a specific Mongo db instance.
 * @param {import("mongodb").Db} db
 */
export const createBillingRepository = (db) => {
  const users = () => db.collection(USERS_COLLECTION);
  const events = () => db.collection(EVENTS_COLLECTION);

  return {
    /** Ensure all required indexes exist. Call once at startup. */
    async ensureIndexes() {
      await Promise.all([
        users().createIndex(
          { proPurchaseToken: 1 },
          { sparse: true, name: "billing_purchaseToken" }
        ),
        users().createIndex(
          { isPro: 1, proExpiryDate: 1 },
          { name: "billing_proExpiry" }
        ),
        events().createIndex(
          { userId: 1, createdAt: -1 },
          { name: "events_userId_createdAt" }
        ),
        events().createIndex(
          { purchaseToken: 1 },
          { name: "events_purchaseToken" }
        ),
      ]);
    },

    async findUserById(userId) {
      return users().findOne({ userId });
    },

    async findUserByPurchaseToken(purchaseToken) {
      return users().findOne({ proPurchaseToken: purchaseToken });
    },

    /**
     * Grant Pro to a user. Idempotent — safe to call multiple times.
     */
    async grantPro({ userId, productId, purchaseToken, expiryDate }) {
      await users().updateOne(
        { userId },
        {
          $set: {
            isPro: true,
            proProductId: productId,
            proPurchaseToken: purchaseToken,
            proExpiryDate: expiryDate,
            proGrantedAt: new Date(),
            updatedAt: new Date(),
          },
          $unset: {
            proPendingPurchaseToken: "",
            proPendingProductId: "",
            proRevokedAt: "",
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      );
    },

    /**
     * Mark a purchase as pending verification (e.g. UPI awaiting confirmation).
     */
    async markPendingPurchase({ userId, productId, purchaseToken }) {
      await users().updateOne(
        { userId },
        {
          $set: {
            proPendingProductId: productId,
            proPendingPurchaseToken: purchaseToken,
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      );
    },

    /**
     * Revoke Pro for a user.
     */
    async revokePro(userId, reason) {
      await users().updateOne(
        { userId },
        {
          $set: {
            isPro: false,
            proRevokedAt: new Date(),
            proRevokeReason: reason,
            updatedAt: new Date(),
          },
        }
      );
    },

    /**
     * Update only the expiry date — used when a subscription renews.
     */
    async extendProExpiry(userId, newExpiryDate) {
      await users().updateOne(
        { userId },
        { $set: { proExpiryDate: newExpiryDate, updatedAt: new Date() } }
      );
    },

    /**
     * Bulk-revoke users whose subscriptions expired. Returns affected count.
     */
    async revokeExpiredSubscriptions() {
      const result = await users().updateMany(
        { isPro: true, proExpiryDate: { $lt: new Date() } },
        {
          $set: {
            isPro: false,
            proRevokedAt: new Date(),
            proRevokeReason: "auto_expired",
            updatedAt: new Date(),
          },
        }
      );
      return result.modifiedCount;
    },

    /**
     * Append an audit-trail entry. Never throws — billing must keep working
     * even if the audit log is unavailable.
     */
    async logEvent({
      userId = null,
      eventType,
      productId = null,
      purchaseToken = null,
      expiryDate = null,
      paymentState = null,
      countryCode = null,
      priceMicros = null,
      currency = null,
      rtdnType = null,
      metadata = null,
    }) {
      try {
        await events().insertOne({
          userId,
          eventType,
          productId,
          purchaseToken,
          expiryDate,
          paymentState,
          countryCode,
          priceMicros: priceMicros !== null ? String(priceMicros) : null,
          currency,
          rtdnType,
          metadata,
          createdAt: new Date(),
        });
      } catch {
        /* swallow — never let audit-log failures break billing */
      }
    },
  };
};

export const BillingEventTypes = BILLING_EVENT_TYPE;
