// ═══════════════════════════════════════════════════════════════════════════
// billing/constants.js
// Single source of truth for all billing-related constants.
// ═══════════════════════════════════════════════════════════════════════════

export const PRODUCT_IDS = Object.freeze({
  INR: process.env.PRODUCT_ID_INR || "examai_pro_monthly_inr",
  USD: process.env.PRODUCT_ID_USD || "examai_pro_monthly_usd",
});

export const VALID_PRODUCT_IDS = Object.freeze(Object.values(PRODUCT_IDS));

export const PACKAGE_NAME =
  process.env.GOOGLE_PLAY_PACKAGE_NAME || "com.examai.app";

/**
 * Google Play subscription paymentState values.
 * @see https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptions
 */
export const PAYMENT_STATE = Object.freeze({
  PENDING: 0, // Payment pending (e.g. UPI awaiting confirmation)
  RECEIVED: 1, // Payment received successfully
  FREE_TRIAL: 2, // User is on free trial
  DEFERRED_UPGRADE: 3, // Pending deferred upgrade/downgrade
});

/**
 * Real-time developer notification types from Pub/Sub.
 * @see https://developer.android.com/google/play/billing/rtdn-reference
 */
export const RTDN_TYPE = Object.freeze({
  RECOVERED: 1,
  RENEWED: 2,
  CANCELED: 3,
  PURCHASED: 4,
  ON_HOLD: 5,
  IN_GRACE_PERIOD: 6,
  RESTARTED: 7,
  PRICE_CHANGE_CONFIRMED: 8,
  DEFERRED: 9,
  PAUSED: 10,
  PAUSE_SCHEDULE_CHANGED: 11,
  REVOKED: 12,
  EXPIRED: 13,
});

/**
 * RTDN types that indicate the user should currently have Pro access.
 */
export const ACTIVE_RTDN_TYPES = Object.freeze(
  new Set([
    RTDN_TYPE.RECOVERED,
    RTDN_TYPE.RENEWED,
    RTDN_TYPE.PURCHASED,
    RTDN_TYPE.IN_GRACE_PERIOD,
    RTDN_TYPE.RESTARTED,
  ])
);

/**
 * RTDN types that indicate the user should lose Pro access.
 */
export const INACTIVE_RTDN_TYPES = Object.freeze(
  new Set([
    RTDN_TYPE.CANCELED,
    RTDN_TYPE.ON_HOLD,
    RTDN_TYPE.PAUSED,
    RTDN_TYPE.REVOKED,
    RTDN_TYPE.EXPIRED,
  ])
);

export const BILLING_EVENT_TYPE = Object.freeze({
  VERIFIED: "verified",
  PENDING: "pending",
  WEBHOOK_RECEIVED: "webhook_received",
  AUTO_EXPIRED: "auto_expired",
  RE_VERIFIED: "re_verified",
});
