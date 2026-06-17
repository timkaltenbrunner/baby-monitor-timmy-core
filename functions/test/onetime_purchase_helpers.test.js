const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isOneTimeProductType,
  isPlayProductActive,
  evaluateAppStoreOneTimeTransaction,
} = require("../lib/onetime_purchase_helpers");

const LIFETIME = "timmy_support_onetime";

test("productType discriminator: subscription path stays the default", () => {
  // Missing / subscription markers must NOT select the one-time path — this is
  // what keeps every existing subscriber on the unchanged code path.
  assert.equal(isOneTimeProductType(undefined), false);
  assert.equal(isOneTimeProductType(""), false);
  assert.equal(isOneTimeProductType("subscription"), false);
  assert.equal(isOneTimeProductType("SUBSCRIPTION"), false);
});

test("productType discriminator: one-time markers select the products path", () => {
  assert.equal(isOneTimeProductType("onetime"), true);
  assert.equal(isOneTimeProductType("one-time"), true);
  assert.equal(isOneTimeProductType("ONETIME"), true);
  assert.equal(isOneTimeProductType(" product "), true);
});

test("Play product is active only when purchaseState is Purchased (0)", () => {
  assert.equal(isPlayProductActive({ purchaseState: 0 }), true);
  assert.equal(isPlayProductActive({ purchaseState: 1 }), false); // canceled
  assert.equal(isPlayProductActive({ purchaseState: 2 }), false); // pending
  assert.equal(isPlayProductActive({}), false);
  assert.equal(isPlayProductActive(null), false);
});

test("App Store non-consumable entitles when not revoked and product matches", () => {
  const r = evaluateAppStoreOneTimeTransaction(
    { productId: LIFETIME, type: "Non-Consumable" },
    LIFETIME
  );
  assert.deepEqual(r, { ok: true, reason: null });
});

test("App Store non-consumable rejects a different product", () => {
  const r = evaluateAppStoreOneTimeTransaction(
    { productId: "timmy_support_monthly", type: "Non-Consumable" },
    LIFETIME
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "product-mismatch");
});

test("App Store non-consumable rejects a non-NonConsumable type", () => {
  const r = evaluateAppStoreOneTimeTransaction(
    { productId: LIFETIME, type: "Auto-Renewable Subscription" },
    LIFETIME
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not-non-consumable");
});

test("App Store non-consumable rejects a revoked (refunded) transaction", () => {
  const revokedByDate = evaluateAppStoreOneTimeTransaction(
    { productId: LIFETIME, type: "Non-Consumable", revocationDate: 1735689600000 },
    LIFETIME
  );
  assert.equal(revokedByDate.ok, false);
  assert.equal(revokedByDate.reason, "revoked");

  const revokedByReason = evaluateAppStoreOneTimeTransaction(
    { productId: LIFETIME, type: "Non-Consumable", revocationReason: 0 },
    LIFETIME
  );
  assert.equal(revokedByReason.ok, false);
  assert.equal(revokedByReason.reason, "revoked");
});

test("App Store non-consumable rejects a missing payload", () => {
  assert.equal(evaluateAppStoreOneTimeTransaction(null, LIFETIME).ok, false);
});
