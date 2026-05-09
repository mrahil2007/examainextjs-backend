// ═══════════════════════════════════════════════════════════════════════════
// billing/service.js
// Business logic for billing operations.
// Consumes the repository + Play API client; exposes high-level methods.
// ═══════════════════════════════════════════════════════════════════════════

import {
  ACTIVE_RTDN_TYPES,
  BILLING_EVENT_TYPE,
  INACTIVE_RTDN_TYPES,
} from "./constants.js";
import { PurchaseNotActiveError, ValidationError } from "./errors.js";
import { interpretSubscription } from "./subscriptionState.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("billing:service");

/**
 * @param {object} deps
 * @param {ReturnType<import("./repository.js").createBillingRepository>} deps.repository
 * @param {import("./playApiClient.js")} deps.playApi
 */
export const createBillingService = ({ repository, playApi }) => ({
  /**
   * Verifies a Play purchase token and grants Pro on success.
   * Handles three outcomes:
   *   - Active   → grant Pro, return isPro: true
   *   - Pending  → mark pending, return isPro: false, pending: true
   *   - Inactive → throw PurchaseNotActiveError
   */
  async verifyAndGrant({ userId, purchaseToken, productId }) {
    const purchase = await playApi.getSubscriptionPurchase(
      productId,
      purchaseToken
    );
    const state = interpretSubscription(purchase);

    // Pending — UPI etc. Don't grant yet, let webhook complete it.
    if (state.isPending) {
      await repository.markPendingPurchase({
        userId,
        productId,
        purchaseToken,
      });
      await repository.logEvent({
        userId,
        eventType: BILLING_EVENT_TYPE.PENDING,
        productId,
        purchaseToken,
        paymentState: state.paymentState,
        countryCode: state.countryCode,
        priceMicros: state.priceMicros,
        currency: state.currency,
      });
      log.info("Purchase pending — awaiting webhook", { userId, productId });
      return {
        isPro: false,
        pending: true,
        expiryDate: null,
      };
    }

    // Inactive — payment failed, expired, or revoked.
    if (!state.isActive) {
      log.warn("Verification rejected — purchase not active", {
        userId,
        productId,
        paymentState: state.paymentState,
        isCancelled: state.isCancelled,
        expiryDate: state.expiryDate,
      });
      throw new PurchaseNotActiveError("Purchase is not currently active", {
        paymentState: state.paymentState,
        cancelReason: state.cancelReason,
        expiryDate: state.expiryDate,
      });
    }

    // Active — grant Pro.
    await repository.grantPro({
      userId,
      productId,
      purchaseToken,
      expiryDate: state.expiryDate,
    });
    await repository.logEvent({
      userId,
      eventType: BILLING_EVENT_TYPE.VERIFIED,
      productId,
      purchaseToken,
      expiryDate: state.expiryDate,
      paymentState: state.paymentState,
      countryCode: state.countryCode,
      priceMicros: state.priceMicros,
      currency: state.currency,
    });
    log.info("Pro granted", {
      userId,
      productId,
      expiryDate: state.expiryDate,
    });

    return {
      isPro: true,
      pending: false,
      expiryDate: state.expiryDate,
      productId,
    };
  },

  /**
   * Returns the current Pro status for a user.
   * If the local record shows expired, re-verifies with Play (in case of renewal).
   */
  async getProStatus(userId) {
    if (!userId) throw new ValidationError("userId is required");

    const user = await repository.findUserById(userId);
    if (!user?.isPro) {
      return { isPro: false };
    }

    const expiryDate = user.proExpiryDate ? new Date(user.proExpiryDate) : null;
    const hasExpired = expiryDate && Date.now() > expiryDate.getTime();

    if (!hasExpired) {
      return {
        isPro: true,
        expiryDate,
        productId: user.proProductId,
      };
    }

    // Local record says expired — re-verify with Play in case of renewal.
    if (!user.proPurchaseToken || !user.proProductId) {
      await repository.revokePro(userId, "missing_purchase_token");
      log.info("Revoked Pro — no purchase token to re-verify", { userId });
      return { isPro: false, reason: "subscription_expired" };
    }

    let renewedState;
    try {
      const purchase = await playApi.getSubscriptionPurchase(
        user.proProductId,
        user.proPurchaseToken
      );
      renewedState = interpretSubscription(purchase);
    } catch (err) {
      log.warn("Re-verification with Play failed — keeping local state", {
        userId,
        error: err.message,
      });
      // Don't revoke on transient API errors — wait for webhook or next launch.
      return {
        isPro: true,
        expiryDate,
        productId: user.proProductId,
        stale: true,
      };
    }

    if (renewedState.isActive) {
      await repository.extendProExpiry(userId, renewedState.expiryDate);
      await repository.logEvent({
        userId,
        eventType: BILLING_EVENT_TYPE.RE_VERIFIED,
        productId: user.proProductId,
        purchaseToken: user.proPurchaseToken,
        expiryDate: renewedState.expiryDate,
        paymentState: renewedState.paymentState,
      });
      log.info("Pro re-verified and extended", {
        userId,
        newExpiry: renewedState.expiryDate,
      });
      return {
        isPro: true,
        expiryDate: renewedState.expiryDate,
        productId: user.proProductId,
      };
    }

    // Truly expired.
    await repository.revokePro(userId, "subscription_expired");
    await repository.logEvent({
      userId,
      eventType: BILLING_EVENT_TYPE.AUTO_EXPIRED,
      productId: user.proProductId,
      purchaseToken: user.proPurchaseToken,
    });
    log.info("Pro expired and revoked", { userId });
    return { isPro: false, reason: "subscription_expired" };
  },

  /**
   * Processes a real-time developer notification from Play.
   * Always idempotent — the same notification can be delivered multiple times.
   */
  async processWebhookNotification({
    notificationType,
    purchaseToken,
    subscriptionId,
  }) {
    const isActive = ACTIVE_RTDN_TYPES.has(notificationType);
    const isInactive = INACTIVE_RTDN_TYPES.has(notificationType);

    // Always log the event, even if we can't find the user yet.
    await repository.logEvent({
      eventType: BILLING_EVENT_TYPE.WEBHOOK_RECEIVED,
      productId: subscriptionId,
      purchaseToken,
      rtdnType: notificationType,
    });

    if (!isActive && !isInactive) {
      log.debug("Webhook event has no Pro state effect — skipping", {
        notificationType,
      });
      return { handled: false, reason: "no_state_change" };
    }

    const user = await repository.findUserByPurchaseToken(purchaseToken);
    if (!user) {
      // Race condition: webhook arrived before client called /verify-purchase.
      // The verify-purchase call will reconcile state, so this is expected.
      log.debug(
        "Webhook for unverified token — will reconcile on client verify",
        { notificationType, tokenPrefix: purchaseToken?.slice(0, 12) }
      );
      return { handled: false, reason: "user_not_found" };
    }

    if (isActive) {
      // Re-fetch latest state from Play to get current expiry.
      try {
        const purchase = await playApi.getSubscriptionPurchase(
          subscriptionId,
          purchaseToken
        );
        const state = interpretSubscription(purchase);
        if (state.isActive) {
          await repository.grantPro({
            userId: user.userId,
            productId: subscriptionId,
            purchaseToken,
            expiryDate: state.expiryDate,
          });
          log.info("Webhook activated Pro", {
            userId: user.userId,
            rtdnType: notificationType,
            expiry: state.expiryDate,
          });
        }
      } catch (err) {
        log.warn("Webhook active-event but re-verify failed", {
          userId: user.userId,
          error: err.message,
        });
      }
    } else {
      await repository.revokePro(user.userId, `webhook_${notificationType}`);
      log.info("Webhook revoked Pro", {
        userId: user.userId,
        rtdnType: notificationType,
      });
    }

    return { handled: true, userId: user.userId };
  },

  /**
   * Daily cron job target — revoke users whose subscriptions silently expired.
   */
  async revokeExpiredSubscriptions() {
    const count = await repository.revokeExpiredSubscriptions();
    if (count > 0) log.info("Auto-revoked expired subscriptions", { count });
    return count;
  },
});
