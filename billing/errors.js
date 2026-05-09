// ═══════════════════════════════════════════════════════════════════════════
// billing/errors.js
// Typed error classes for the billing domain.
// Each carries a default HTTP status code so route handlers can rethrow.
// ═══════════════════════════════════════════════════════════════════════════

export class BillingError extends Error {
  constructor(
    message,
    { statusCode = 500, code = "BILLING_ERROR", cause } = {}
  ) {
    super(message);
    this.name = "BillingError";
    this.statusCode = statusCode;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

export class ValidationError extends BillingError {
  constructor(message, details) {
    super(message, { statusCode: 400, code: "VALIDATION_ERROR" });
    this.details = details;
  }
}

export class PlayApiError extends BillingError {
  constructor(message, { cause, googleResponse } = {}) {
    super(message, { statusCode: 502, code: "PLAY_API_ERROR", cause });
    this.googleResponse = googleResponse;
  }
}

export class PurchaseNotActiveError extends BillingError {
  constructor(message = "Purchase is not currently active", details) {
    super(message, { statusCode: 400, code: "PURCHASE_NOT_ACTIVE" });
    this.details = details;
  }
}

export class ConfigurationError extends BillingError {
  constructor(message) {
    super(message, { statusCode: 500, code: "CONFIGURATION_ERROR" });
  }
}
