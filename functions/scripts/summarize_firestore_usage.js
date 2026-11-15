#!/usr/bin/env node
"use strict";

const { createInterface } = require("node:readline");
const { summarizeSamples } = require("../lib/firestore_usage_sample");

async function main() {
  const rows = [];
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    rows.push(entry.jsonPayload || entry);
  }
  console.log(JSON.stringify(summarizeSamples(rows), null, 2));
}

main().catch((error) => {
  console.error(`Could not summarize Firestore usage: ${error.name}`);
  process.exitCode = 1;
});
