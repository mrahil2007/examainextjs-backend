// ═══════════════════════════════════════════════════════════════════════════
// billing/webhookAuth.js
// Verifies that webhook calls actually came from Google Pub/Sub.
//
// Pub/Sub signs each push message with a Google-issued OIDC JWT in the
// Authorization header. We verify the signature and the audience claim.
//
// Setup:
//   1. In Pub/Sub subscription config, set "Authentication" → enable.
//   2. Set the audience to your webhook URL (e.g. https://api.examai-in.com).
//   3. Set BILLING_WEBHOOK_AUDIENCE env var to the same value.
// ═══════════════════════════════════════════════════════════════════════════

import { OAuth2Client } from "google-auth-library";
import { createLogger } from "../lib/logger.js";

const log = createLogger("billing:webhook-auth");

const oauthClient = new OAuth2Client();

/**
 * Express middleware that verifies a Pub/Sub OIDC token.
 *
 * If BILLING_WEBHOOK_AUDIENCE is unset, verification is skipped with a warning
 * — useful for local development. In production you must set it.
 */
export const verifyPubSubWebhook = async (req, res, next) => {
  const audience = process.env.BILLING_WEBHOOK_AUDIENCE;

  if (!audience) {
    log.warn("BILLING_WEBHOOK_AUDIENCE not set — skipping webhook auth");
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    log.warn("Webhook missing Authorization header");
    return res.status(401).json({ error: "unauthorized" });
  }

  const token = authHeader.slice(7);
  try {
    const ticket = await oauthClient.verifyIdToken({
      idToken: token,
      audience,
    });
    const payload = ticket.getPayload();

    // Pub/Sub tokens are issued by accounts.google.com and contain
    // the email of the service account configured in Pub/Sub.
    if (!payload?.email_verified) {
      log.warn("Webhook token email not verified");
      return res.status(401).json({ error: "unauthorized" });
    }

    req.pubsubAuth = {
      email: payload.email,
      sub: payload.sub,
    };
    return next();
  } catch (err) {
    log.warn("Webhook token verification failed", { error: err.message });
    return res.status(401).json({ error: "unauthorized" });
  }
};
