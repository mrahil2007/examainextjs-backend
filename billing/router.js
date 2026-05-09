// ═══════════════════════════════════════════════════════════════════════════
// billing/router.js
// Express router for billing endpoints.
// Routes are thin — they validate input, call the service, format the response.
// All business logic lives in service.js.
// ═══════════════════════════════════════════════════════════════════════════

import express from "express";
import { VALID_PRODUCT_IDS } from "./constants.js";
import { BillingError, ValidationError } from "./errors.js";
import { verifyPubSubWebhook } from "./webhookAuth.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("billing:router");

// ── Validators ────────────────────────────────────────────────────────────────

const validateVerifyPurchaseInput = (body) => {
  const { userId, purchaseToken, productId } = body || {};
  const missing = [];
  if (!userId) missing.push("userId");
  if (!purchaseToken) missing.push("purchaseToken");
  if (!productId) missing.push("productId");
  if (missing.length) {
    throw new ValidationError(`Missing required fields: ${missing.join(", ")}`);
  }
  if (!VALID_PRODUCT_IDS.includes(productId)) {
    throw new ValidationError(`Invalid productId: ${productId}`);
  }
  return { userId, purchaseToken, productId };
};

// ── Async handler wrapper — catches errors and forwards to error middleware ──

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ── Error handler — translates BillingError into HTTP responses ──────────────

const billingErrorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof BillingError) {
    return res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      details: err.details,
    });
  }

  log.error("Unhandled billing error", {
    error: err.message,
    stack: err.stack,
  });
  return res.status(500).json({ error: "Internal server error" });
};

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {ReturnType<import("./service.js").createBillingService>} deps.service
 */
export const createBillingRouter = ({ service }) => {
  const router = express.Router();

  // ── POST /verify-purchase ───────────────────────────────────────────────────
  router.post(
    "/verify-purchase",
    asyncHandler(async (req, res) => {
      const input = validateVerifyPurchaseInput(req.body);
      const result = await service.verifyAndGrant(input);
      res.json({ success: true, ...result });
    })
  );

  // ── GET /pro-status/:userId ─────────────────────────────────────────────────
  router.get(
    "/pro-status/:userId",
    asyncHandler(async (req, res) => {
      const { userId } = req.params;
      if (!userId) throw new ValidationError("userId is required");
      const result = await service.getProStatus(userId);
      res.json(result);
    })
  );

  // ── POST /webhook ───────────────────────────────────────────────────────────
  // Always returns 200 — Pub/Sub treats non-2xx as a delivery failure and retries.
  router.post(
    "/webhook",
    verifyPubSubWebhook,
    asyncHandler(async (req, res) => {
      try {
        const message = req.body?.message;
        if (!message?.data) {
          log.warn("Webhook missing message.data");
          return res.status(200).send("ok");
        }

        let notification;
        try {
          const decoded = Buffer.from(message.data, "base64").toString("utf-8");
          notification = JSON.parse(decoded);
        } catch (err) {
          log.warn("Webhook payload not valid JSON", { error: err.message });
          return res.status(200).send("ok");
        }

        const subNotification = notification?.subscriptionNotification;
        if (!subNotification) {
          log.debug("Webhook is not a subscription notification — skipping");
          return res.status(200).send("ok");
        }

        await service.processWebhookNotification({
          notificationType: subNotification.notificationType,
          purchaseToken: subNotification.purchaseToken,
          subscriptionId: subNotification.subscriptionId,
        });

        return res.status(200).send("ok");
      } catch (err) {
        // Webhooks must never return non-200 — log and absorb.
        log.error("Webhook handler error", { error: err.message });
        return res.status(200).send("ok");
      }
    })
  );

  router.use(billingErrorHandler);
  return router;
};
