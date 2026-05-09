// ═══════════════════════════════════════════════════════════════════════════
// billing/index.js
// Public entry point for the billing module.
// Wires up: repository → service → router, plus background jobs.
// ═══════════════════════════════════════════════════════════════════════════

import cron from "node-cron";
import { createBillingRepository } from "./repository.js";
import { createBillingService } from "./service.js";
import { createBillingRouter } from "./router.js";
import * as playApi from "./playApiClient.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("billing:index");

/**
 * Initializes the billing module.
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.db
 * @returns {Promise<{ router: import("express").Router, service }>}
 */
export const initializeBilling = async ({ db }) => {
  const repository = createBillingRepository(db);
  await repository.ensureIndexes();
  log.info("Billing indexes ensured");

  const service = createBillingService({ repository, playApi });
  const router = createBillingRouter({ service });

  // ── Daily expiry cron — runs at 03:00 UTC ─────────────────────────────────
  cron.schedule(
    "0 3 * * *",
    async () => {
      try {
        await service.revokeExpiredSubscriptions();
      } catch (err) {
        log.error("Expiry cron failed", { error: err.message });
      }
    },
    { timezone: "UTC" }
  );
  log.info("Billing module initialized");

  return { router, service };
};
