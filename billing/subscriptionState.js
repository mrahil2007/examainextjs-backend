// ═══════════════════════════════════════════════════════════════════════════
// billing/subscriptionState.js
// Pure functions that interpret a Play API subscription response.
// No side effects, no I/O — easy to unit test.
// ═══════════════════════════════════════════════════════════════════════════

import { PAYMENT_STATE } from "./constants.js";

/**
 * @typedef {object} SubscriptionState
 * @property {boolean} isActive       Should the user have Pro right now?
 * @property {boolean} isPending      Payment pending (e.g. UPI awaiting confirmation)?
 * @property {boolean} isCancelled    Has the user cancelled (may still have time left)?
 * @property {Date|null} expiryDate   When does access expire?
 * @property {number|null} paymentState  Raw paymentState from Play
 * @property {string|null} cancelReason  Set if cancelled
 * @property {string|null} countryCode   ISO country code where purchase was made
 * @property {bigint|null} priceMicros   Price in micro-units of currency
 * @property {string|null} currency      ISO currency code
 */

/**
 * Interprets a raw subscription resource from the Play API.
 *
 * @param {object} purchase Raw response from playApiClient.getSubscriptionPurchase()
 * @returns {SubscriptionState}
 */
export const interpretSubscription = (purchase) => {
  if (!purchase || typeof purchase !== "object") {
    return {
      isActive: false,
      isPending: false,
      isCancelled: false,
      expiryDate: null,
      paymentState: null,
      cancelReason: null,
      countryCode: null,
      priceMicros: null,
      currency: null,
    };
  }

  const paymentState =
    typeof purchase.paymentState === "number" ? purchase.paymentState : null;

  const isPending = paymentState === PAYMENT_STATE.PENDING;
  const isPaid =
    paymentState === PAYMENT_STATE.RECEIVED ||
    paymentState === PAYMENT_STATE.FREE_TRIAL;

  const isCancelled = purchase.cancelReason !== undefined;

  const expiryDate = purchase.expiryTimeMillis
    ? new Date(parseInt(purchase.expiryTimeMillis, 10))
    : null;

  // A purchase is "active" if Play received payment AND it hasn't expired.
  // Cancelled subscriptions remain active until expiry — that's intentional.
  const hasNotExpired = expiryDate ? expiryDate.getTime() > Date.now() : false;
  const isActive = isPaid && hasNotExpired;

  return {
    isActive,
    isPending,
    isCancelled,
    expiryDate,
    paymentState,
    cancelReason: purchase.cancelReason ?? null,
    countryCode: purchase.countryCode ?? null,
    priceMicros: purchase.priceAmountMicros
      ? BigInt(purchase.priceAmountMicros)
      : null,
    currency: purchase.priceCurrencyCode ?? null,
  };
};
