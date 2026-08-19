// The shipping story, tested for real: an empty directory, one `docker run`,
// and a working inventory ( and the README quickstart).
//
// Usage: node scripts/verify-docker.mjs [baseUrl]
//
// It expects a container already running against an EMPTY volume, because the
// first thing it checks is that registration is open for the first account:
//
//   docker build -t inventoryspace .
//   mkdir /tmp/inventory-data
//   docker run -d --name inventory-smoke -p 3010:3000 -v /tmp/inventory-data:/data inventoryspace
//   node packages/web/scripts/verify-docker.mjs http://localhost:3010
//
// Safe by construction — it only ever touches the container's own volume.
//
// Exits non-zero if anything failed.

import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:3010';
const USER = 'dockeradmin';
const PASS = 'docker-smoke-1234';

const results = [];
const ok = (name, extra = '') => {
  results.push('PASS');
  console.log(`  ok  ${name}${extra ? ' — ' + extra : ''}`);
};
const bad = (name, extra = '') => {
  results.push('FAIL');
  console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`);
};

console.log(`\n→ ${BASE} — expects a container on an empty volume\n`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

try {
  // 1 — one port serves the SPA, the API and the docs.
  // /health is not a route — an unknown path falls through to the SPA, which
  // is correct and is exactly why the check has to name the real one.
  const health = await fetch(`${BASE}/api/v1/health`).then((r) => r.json());
  health?.ok ? ok('the API answers', JSON.stringify(health)) : bad('health', JSON.stringify(health));

  const spa = await fetch(`${BASE}/`).then((r) => r.status);
  spa === 200 ? ok('the frontend is served on the same port') : bad('frontend', String(spa));

  const deep = await fetch(`${BASE}/items`).then((r) => r.status);
  deep === 200 ? ok('deep links fall back to the SPA') : bad('deep link', String(deep));

  const docs = await fetch(`${BASE}/api/openapi.json`).then((r) => r.status);
  docs === 200 ? ok('the OpenAPI spec is served') : bad('openapi', String(docs));

  // 2 — the manual travels in the image, self-contained.
  const manual = await fetch(`${BASE}/api/v1/manual/ca`);
  const manualText = await manual.text();
  manual.status === 200 && manualText.length > 100_000 && !/https?:\/\/fonts\./.test(manualText)
    ? ok('the manual is in the image and needs no network', `${Math.round(manualText.length / 1024)} KB`)
    : bad('manual', `${manual.status}, ${manualText.length} bytes`);

  // 3 — first run: registration is open, and the first account is the admin.
  await page.goto(`${BASE}/login`);
  await page.waitForSelector('form');
  await page.click('text=/First run|Primer cop|Erster Start/');
  await page.waitForTimeout(400);
  await page.fill('#name', 'Docker Admin');
  await page.fill('#identifier', USER);
  await page.fill('#password', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/`, { timeout: 15_000 });
  ok('the first account registers and lands on Home');

  // Asked of the API, not read off a badge: the badge is styled uppercase by
  // CSS while the DOM says "Admin", so scraping it tests the stylesheet.
  const me = await page.evaluate(async () => {
    const response = await fetch('/api/v1/users', { credentials: 'include' });
    return response.ok ? await response.json() : { error: response.status };
  });
  Array.isArray(me) && me.length === 1 && me[0].role === 'admin'
    ? ok('the first account is the administrator', `${me[0].username} · ${me[0].role}`)
    : bad('first account is not admin', JSON.stringify(me));

  // 4 — and then registration is closed, which is the whole security model.
  const second = await page.evaluate(async () => {
    const response = await fetch('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'intruder@no-mail.invalid',
        username: 'intruder',
        password: 'intruder-1234',
        name: 'Intruder',
      }),
    });
    return response.status;
  });
  second === 403 ? ok('registration closed behind the first account') : bad('registration still open', String(second));

  // 5 — a fresh volume is genuinely empty: no demo data smuggled into the image.
  await page.goto(`${BASE}/concepts`);
  await page.waitForSelector('h1');
  const stock = await page.evaluate(async () => {
    const response = await fetch('/api/v1/concepts?perPage=5', { credentials: 'include' });
    return (await response.json()).meta?.total ?? -1;
  });
  stock === 0 ? ok('a fresh volume starts genuinely empty') : bad('fresh volume is not empty', String(stock));

  // 6 — the schema really was migrated at boot, fast_keys included.
  const chord = await page.evaluate(async () => {
    const response = await fetch('/api/v1/users/me/fast-key', {
      method: 'POST',
      credentials: 'include',
    });
    return { status: response.status, body: await response.json() };
  });
  chord.status === 200 && /^[a-z](\+[a-z])* [a-z](\+[a-z])*$/.test(chord.body.chord ?? '')
    ? ok('migrations ran at boot: a chord was issued', chord.body.chord)
    : bad('fast_keys missing after boot', JSON.stringify(chord));
  // 7 — the session cookie must be storable over plain http, or everybody on
  // the workshop network is signed out by their first reload. This is the check
  // that would have caught it: `Secure` is fatal on a LAN address.
  const setCookie = await fetch(`${BASE}/api/auth/sign-in/username`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ username: USER, password: PASS }),
  }).then((r) => r.headers.get('set-cookie') ?? '');
  /secure/i.test(setCookie)
    ? bad('the session cookie is Secure — no browser will keep it over http', setCookie.slice(0, 60))
    : ok('the session cookie survives plain http (a LAN address)');
} finally {
  await browser.close();
}

const noise = errors.filter((e) => !/status of 4\d\d/.test(e));
if (noise.length) console.log('\nconsole errors:\n' + noise.join('\n'));
const failed = results.filter((r) => r === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed || noise.length ? 1 : 0);
