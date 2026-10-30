// Exercise the compiled Rust/Wasm entry point in workerd. Every subrequest is
// intercepted by an in-process service; no detection/provider endpoint is used.
const { Miniflare } = require(process.env.EGRESS_MINIFLARE_MODULE || 'miniflare');
const assert = require('node:assert/strict');
const path = require('node:path');
const secret = 'test-only-diagnostic-secret-000000000000';
const endpoint = 'https://gateway.test/__diagnostics/egress';
let calls = [];
let mode = 'ok';
const options = {
  modules: true,
  scriptPath: path.resolve(__dirname, '../build/index.js'),
  modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'], fallthrough: true }],
  compatibilityDate: '2026-08-01',
  outboundService: async (request) => {
    calls.push(request);
    assert.equal(request.url, 'https://api.ipify.org/');
    assert.equal(request.method, 'GET');
    assert.equal(await request.text(), '');
    for (const name of ['authorization', 'cookie', 'x-api-key', 'cf-connecting-ip',
      'x-forwarded-for', 'x-real-ip', 'forwarded', 'origin', 'referer']) {
      assert.equal(request.headers.get(name), null, name);
    }
    assert.equal(request.headers.get('accept'), 'text/plain');
    assert.equal(request.headers.get('cache-control'), 'no-store');
    if (mode === 'headers-timeout') await new Promise(r => setTimeout(r, 4500));
    if (mode === 'body-timeout') {
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('192.'));
        setTimeout(() => { try { controller.close(); } catch {} }, 4500);
      } }));
    }
    if (mode === 'transport') throw new Error('mock connection failure');
    if (mode === 'failure') return new Response('private upstream detail', {status: 503});
    if (mode === 'redirect') return new Response(null, {status: 302, headers: {location: 'https://forbidden.test/'}});
    if (mode === 'oversize') return new Response('1'.repeat(65));
    if (mode === 'invalid') return new Response('not an IP or secret detail');
    return new Response('192.0.2.42\n');
  },
};
const mf = new Miniflare(options);
let passed = 0;
async function check(label, status, init = {}, suffix = '') {
  const response = await mf.dispatchFetch(endpoint + suffix, init);
  assert.equal(response.status, status, label);
  assert.equal(response.headers.get('cache-control'), 'no-store', label);
  assert.equal(response.headers.get('access-control-allow-origin'), null, label);
  const body = await response.json();
  assert.ok(!JSON.stringify(body).includes(secret));
  console.log(`PASS ${label}`);
  passed++;
  return body;
}
const auth = {headers: {authorization: `Bearer ${secret}`}};
async function run() {
  assert.deepEqual(await check('default disabled', 404, auth), {error: 'not_found'});
  await mf.setOptions({...options, bindings: {EGRESS_DIAGNOSTICS_ENABLED: 'true'}});
  await check('missing secret', 404, auth);
  await mf.setOptions({...options, bindings: {EGRESS_DIAGNOSTICS_ENABLED: 'true', EGRESS_DIAGNOSTICS_SECRET: 'short'}});
  await check('short secret fails closed', 404, auth);
  await mf.setOptions({...options, bindings: {EGRESS_DIAGNOSTICS_ENABLED: 'TRUE', EGRESS_DIAGNOSTICS_SECRET: secret}});
  await check('enable requires exact true', 404, auth);
  await mf.setOptions({...options, bindings: {EGRESS_DIAGNOSTICS_ENABLED: 'true', EGRESS_DIAGNOSTICS_SECRET: secret}});
  await check('missing authorization', 404);
  await check('wrong authorization', 404, {headers: {authorization: 'Bearer wrong'}});
  await check('preflight not exposed', 404, {method: 'OPTIONS'});
  await check('POST rejected', 400, {...auth, method: 'POST', body: 'private content'});
  await check('URL overrides rejected', 400, auth, '?url=https://forbidden.test');
  assert.equal(calls.length, 0, 'denied requests must never fetch');
  const body = await check('fixed target and no sensitive header forwarding', 200, {headers: {
    ...auth.headers, cookie: 'private', 'x-api-key': 'provider-test-key',
    'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.2',
    'x-real-ip': '198.51.100.3', forwarded: 'for=198.51.100.4',
    origin: 'https://private.test', referer: 'https://private.test/content',
  }});
  assert.equal(calls.length, 1);
  assert.equal(body.ip, '192.0.2.42');
  assert.equal(body.target, 'https://api.ipify.org');
  assert.match(body.scope, /not evidence of OpenAI/);
  for (mode of ['transport', 'failure', 'redirect', 'oversize', 'invalid']) {
    const before = calls.length;
    assert.deepEqual(await check(mode, 502, auth), {error: 'diagnostic_failed'});
    assert.equal(calls.length, before + 1, 'no retry or redirect');
  }
  for (mode of ['headers-timeout', 'body-timeout']) {
    const start = Date.now();
    assert.deepEqual(await check(mode, 504, auth), {error: 'diagnostic_timeout'});
    assert.ok(Date.now() - start < 4300, 'whole-operation deadline');
  }
  const health = await mf.dispatchFetch('https://gateway.test/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).runtime, 'cloudflare-worker');
  console.log(`PASS health route unchanged; ${passed + 1} checks passed`);
}
run().finally(() => mf.dispose()).catch(error => {console.error(error); process.exitCode = 1;});
