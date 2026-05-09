// ═══════════════════════════════════════════════════════════════════════════
// billing/playApiClient.js
// Wraps the Google Play Android Publisher API.
// Handles: service-account auth, token caching, purchase verification.
// ═══════════════════════════════════════════════════════════════════════════

import { GoogleAuth } from "google-auth-library";
import { PACKAGE_NAME } from "./constants.js";
import { ConfigurationError, PlayApiError } from "./errors.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("billing:play-api");

const PLAY_API_BASE =
  "https://androidpublisher.googleapis.com/androidpublisher/v3";
const PLAY_API_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

// ── Service account loader ────────────────────────────────────────────────────

let cachedAuth = null;

const getAuth = () => {
  if (cachedAuth) return cachedAuth;

  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT;
  if (!raw) {
    throw new ConfigurationError(
      "GOOGLE_PLAY_SERVICE_ACCOUNT environment variable is not set"
    );
  }

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (err) {
    throw new ConfigurationError(
      "GOOGLE_PLAY_SERVICE_ACCOUNT is not valid JSON"
    );
  }

  cachedAuth = new GoogleAuth({ credentials, scopes: [PLAY_API_SCOPE] });
  log.info("Initialized Google Play Auth");
  return cachedAuth;
};

// ── Access token retrieval ────────────────────────────────────────────────────
//
// The GoogleAuth client caches and refreshes tokens internally, so we just
// ask it for a fresh one on each call. This is cheap.

const getAccessToken = async () => {
  try {
    const client = await getAuth().getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("Empty access token returned");
    return token;
  } catch (err) {
    throw new PlayApiError("Failed to obtain Play API access token", {
      cause: err,
    });
  }
};

// ── Subscription purchase verification ────────────────────────────────────────

/**
 * Fetches the current state of a subscription purchase from Google Play.
 *
 * @param {string} productId
 * @param {string} purchaseToken
 * @returns {Promise<object>} Raw subscription resource from Play API
 * @throws {PlayApiError} If the API call fails or returns non-2xx
 */
export const getSubscriptionPurchase = async (productId, purchaseToken) => {
  const accessToken = await getAccessToken();
  const url =
    `${PLAY_API_BASE}/applications/${encodeURIComponent(PACKAGE_NAME)}` +
    `/purchases/subscriptions/${encodeURIComponent(productId)}` +
    `/tokens/${encodeURIComponent(purchaseToken)}`;

  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    throw new PlayApiError("Network error contacting Play API", { cause: err });
  }

  if (!response.ok) {
    let googleResponse = null;
    try {
      googleResponse = await response.json();
    } catch {
      /* ignore — Play sometimes returns text on error */
    }
    log.warn("Play API returned non-2xx", {
      status: response.status,
      productId,
      googleResponse,
    });
    throw new PlayApiError(`Play API returned status ${response.status}`, {
      googleResponse,
    });
  }

  return response.json();
};
