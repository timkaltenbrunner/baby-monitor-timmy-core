const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function harness() {
  const index = path.resolve(__dirname, '../index.js');
  const realRequire = createRequire(index);
  const reads = [];
  let bound = [];
  const values = {
    ADMIN_UID: 'test-admin',
    LOCAL_TURN_API_BASE_URL: '',
    LOCAL_TURN_PUBLIC_URLS: 'turn:example.test:3478',
    LOCAL_TURN_CREDENTIALS: JSON.stringify({ apiKey: 'fixture-api', hmacSecret: 'fixture-hmac' }),
  };
  const firestore = { collection: () => ({ doc: () => ({
    get: async () => ({ exists: false }), set: async () => {},
  }) }) };
  const exports = {};
  const context = vm.createContext({
    exports, process, console, Buffer, URL, setTimeout, clearTimeout,
    require(name) {
      if (name === 'firebase-functions/params') return {
        defineString: name => ({ value: () => values[name] || '' }),
        defineSecret: name => ({ name, value: () => {
          reads.push({ name, bound: bound.includes(name) });
          if (!bound.includes(name)) throw new Error(`Unbound secret: ${name}`);
          return values[name] || '';
        } }),
      };
      if (name === 'firebase-functions/v2/https') return {
        HttpsError: class extends Error {},
        onCall: (options, handler) => async request => {
          bound = (options.secrets || []).map(secret => secret.name);
          try { return await handler(request); } finally { bound = []; }
        },
      };
      if (name === 'firebase-functions/v2/firestore') return { onDocumentWritten: () => {} };
      if (name === 'firebase-functions/v2/scheduler') return { onSchedule: () => {} };
      if (name === 'firebase-admin/app') return { initializeApp() {} };
      if (name === 'firebase-admin/auth') return { getAuth() {} };
      if (name === 'firebase-admin/firestore') return {
        getFirestore: () => firestore, FieldValue: { serverTimestamp: () => 0 },
      };
      return realRequire(name);
    },
  });
  vm.runInContext(fs.readFileSync(index, 'utf8'), context, { filename: index });
  return { exports, reads };
}

for (const name of ['getTurnConfigAdmin', 'setTurnConfigAdmin']) {
  test(`${name} binds credentials used to discover the HMAC-only local provider`, async () => {
    const { exports, reads } = harness();
    const result = await exports[name]({ auth: { uid: 'test-admin' }, data: { providers: [] } });
    assert.ok(reads.length > 0);
    assert.ok(reads.every(read => read.bound), 'all secret reads must have a function binding');
    assert.ok(result.providers.some(provider => provider.id === 'local-turn-builtin'));
    assert.ok(!JSON.stringify(result).includes('fixture-hmac'));
    assert.ok(!JSON.stringify(result).includes('fixture-api'));
  });
}
