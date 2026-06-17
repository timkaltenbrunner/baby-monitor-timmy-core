"use strict";

// Pure decision logic for one-time ("lifetime", non-consumable) purchase
// verification. Kept network-free so it can be unit-tested without touching the
// Play / App Store APIs or any production project.

const ONE_TIME_PRODUCT_TYPES = new Set(["onetime", "one-time", "product"]);

// A missing / "subscription" productType keeps the legacy auto-renewing path.
// Only an explicit one-time marker selects the products / non-consumable path.
function isOneTimeProductType(productType) {
  return ONE_TIME_PRODUCT_TYPES.has(
    String(productType || "subscription").trim().toLowerCase()
  );
}

// Google Play ProductPurchase.purchaseState: 0 = Purchased, 1 = Canceled,
// 2 = Pending. Only a completed purchase entitles the user.
function isPlayProductActive(productPurchase) {
  // Guard explicitly: Number(null) === 0 would otherwise treat a missing
  // purchase as "Purchased".
  if (!productPurchase || productPurchase.purchaseState == null) return false;
  return Number(productPurchase.purchaseState) === 0;
}

// Decide whether a decoded App Store transaction payload entitles the user to a
// non-consumable. Unlike a subscription there is no expiry — it is valid forever
// unless Apple revoked it (refund). Returns { ok, reason }.
function evaluateAppStoreOneTimeTransaction(payload, expectedProductId) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "missing-transaction" };
  }
  if (payload.productId !== expectedProductId) {
    return { ok: false, reason: "product-mismatch" };
  }
  if (payload.type && payload.type !== "Non-Consumable") {
    return { ok: false, reason: "not-non-consumable" };
  }
  if (payload.revocationDate || payload.revocationReason !== undefined) {
    return { ok: false, reason: "revoked" };
  }
  return { ok: true, reason: null };
}

module.exports = {
  isOneTimeProductType,
  isPlayProductActive,
  evaluateAppStoreOneTimeTransaction,
};
