"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { sampleCreation, summarizeSamples } = require("../lib/firestore_usage_sample");

const secret = "a".repeat(32);
const time = "2026-11-15T10:00:00Z";
const event = {
  authType: "unknown",
  authId: "test-firebase-uid",
  time,
  params: { sessionId: "raw-session-id" },
  data: { exists: true, data: () => ({ candidate: "encrypted", sdpMid: "é" }) },
};

test("sampling is stable within a session and emits only digests and sizes", () => {
  const first = sampleCreation({ ...event, id: "event-a" }, "candidates_baby", 100, secret);
  const second = sampleCreation({ ...event, id: "event-b" }, "candidates_parent", 100, secret);
  assert.equal(first.session, second.session);
  assert.notEqual(first.eventKey, second.eventKey);
  assert.equal(first.sdpMidBytes, 2);
  assert.doesNotMatch(JSON.stringify(first), /raw-session-id|test-firebase-uid|encrypted|event-a/);
  assert.equal(sampleCreation({ ...event, id: "event-a" }, "candidates_baby", 0, secret), null);
  assert.equal(sampleCreation({ ...event, id: "event-a", authType: "service_account" },
    "candidates_baby", 100, secret), null);
  for (let sampleRate = 1; sampleRate < 100; sampleRate += 10) {
    const a = sampleCreation({ ...event, id: "event-a" }, "candidates_baby", sampleRate, secret);
    const b = sampleCreation({ ...event, id: "event-b" }, "candidates_parent", sampleRate, secret);
    assert.equal(Boolean(a), Boolean(b));
  }
});

test("summaries deduplicate delivery and report device days and unattributed events", () => {
  const first = sampleCreation({ ...event, id: "event-a" }, "sessions", 100, secret);
  const second = sampleCreation({ ...event, id: "event-b" }, "sessions", 100, secret);
  const tomorrow = sampleCreation({ ...event, id: "event-c", time: "2026-11-16T10:00:00Z" },
    "sessions", 100, secret);
  const unknown = sampleCreation({ ...event, id: "event-d", authId: undefined },
    "pairing_codes", 100, secret);
  const candidate = sampleCreation({ ...event, id: "event-e" }, "candidates_parent", 100, secret);
  assert.equal(first.deviceDay, second.deviceDay);
  assert.notEqual(first.deviceDay, tomorrow.deviceDay);
  const summary = summarizeSamples([first, first, second, tomorrow, unknown, candidate]);
  assert.equal(summary.createsPerDeviceDay.sessions.samples, 2);
  assert.equal(summary.createsPerDeviceDay.sessions.max, 2);
  assert.equal(summary.unattributed.pairing_codes, 1);
  assert.equal(summary.candidates.candidates_parent.perSession.max, 1);
  assert.equal(summary.candidates.candidates_parent.sdpMidBytes.max, 2);
});
