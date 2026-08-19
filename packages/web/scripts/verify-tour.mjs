// Browser check for the interactive manual. Usage:
//   node scripts/verify-tour.mjs <outDir> [username] [password] [baseUrl]
//
// Read-only: it walks the tours and never writes to the database, so the dev
// server's own API is a fine target. Pass a base URL to point it somewhere
// else — the single-port build, for instance.
import { chromium } from 'playwright';

const outDir = process.argv[2] ?? '.';
const username = process.argv[3] ?? 'demoadmin';
const password = process.argv[4] ?? 'test-1234-test';
const baseUrl = process.argv[5] ?? 'http://localhost:5173';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const shot = (name) => page.screenshot({ path: `${outDir}/${name}.png` });
const step = (n) => console.log(`  ${n}`);

await page.goto(`${baseUrl}/login`);
await page.waitForSelector('text=Sign in');
await page.fill('#identifier', username);
await page.fill('#password', password);
await page.click('button[type="submit"]');
await page.waitForSelector('text=Active concepts');
step('signed in');

// A fresh browser has never seen a tour, so the invite must be on Home.
await page.waitForSelector('text=New here?');
await shot('t01-invite');
step('the invite is offered once');

// --- the help menu lists the manual and every tour -----------------------
await page.click('[data-tour="help"]');
await page.waitForSelector('text=Guided tours');
await shot('t02-help-menu');
step('help menu lists the manual and the tours');

// --- walk the basics tour end to end ------------------------------------
await page.click('button:has-text("The basics")');
await page.waitForSelector('[data-ui="tour"]');
await shot('t03-tour-step1');

const total = Number((await page.textContent('[data-ui="tour"] .font-mono')).split('/')[1].trim());
if (total < 5) throw new Error(`the basics tour has only ${total} steps`);

for (let i = 1; i < total; i++) {
  await page.click('[data-ui="tour"] button:has-text("Next")');
  await page.waitForTimeout(500);
  if (i === 1) await shot('t04-tour-spotlight');
}
await shot('t05-tour-last');

// The spotlight has to be over something: a tour that highlights nothing is
// a slideshow with extra steps.
const ring = await page.locator('.ring-primary').count();
if (ring === 0) throw new Error('no spotlight ring rendered');
step(`walked all ${total} steps, spotlight present`);

await page.click('[data-ui="tour"] button:has-text("Done")');
await page.waitForTimeout(400);
step('finished');

// --- finishing marks it off, and the invite never comes back ------------
await page.click('[data-tour="help"]');
await page.waitForSelector('text=Guided tours');
await shot('t06-help-menu-done');
await page.keyboard.press('Escape');
await page.goto(`${baseUrl}/`);
await page.waitForSelector('text=Active concepts');
if (await page.locator('text=New here?').count()) {
  throw new Error('the invite came back after a tour was finished');
}
step('invite gone for good');

// --- a tour that changes page actually navigates ------------------------
await page.click('[data-tour="help"]');
await page.click('button:has-text("Asking, buying")');
await page.waitForSelector('[data-ui="tour"]');
await page.waitForTimeout(900);
if (!page.url().includes('/requests')) throw new Error(`expected /requests, got ${page.url()}`);
await shot('t07-tour-navigates');
await page.click('[data-ui="tour"] button:has-text("Next")');
await page.waitForTimeout(1200);
if (!page.url().includes('/lots')) throw new Error(`expected /lots, got ${page.url()}`);
step('route steps navigate');
await page.keyboard.press('Escape');

if (errors.length > 0) {
  console.error('\nCONSOLE ERRORS:\n' + errors.join('\n'));
  await browser.close();
  process.exit(1);
}

console.log('\ntours verified — no console errors');
await browser.close();
