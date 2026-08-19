// Headless browser smoke test: drives the real app end to end and writes
// screenshots. Usage:  node scripts/smoke.mjs <outDir> [username] [password]
//
// THIS SCRIPT WRITES TO THE DATABASE IT IS POINTED AT. It creates lots, opens
// and empties containers, and records activities — running it against the workshop's
// real data leaves test rows behind. Point the API at a scratch copy first:
//
//   cp packages/api/data/inventory.db /tmp/scratch.db
//   DATABASE_PATH=/tmp/scratch.db npm run dev
//
import { chromium } from 'playwright';

const outDir = process.argv[2] ?? '.';
const username = process.argv[3] ?? 'demoadmin';
const password = process.argv[4] ?? 'test-1234-test';
// A base URL, like every other suite takes. Without one this script silently
// drove whatever was on :5173 — which on a developer's machine is the dev
// server, pointed at real data.
const baseUrl = process.argv[5] ?? 'http://localhost:5173';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const shot = (name) => page.screenshot({ path: `${outDir}/${name}.png` });

// 1. Sign in with a USERNAME (not an email)
await page.goto(`${baseUrl}/login`);
await page.waitForSelector('text=Sign in');
await shot('01-login');
await page.fill('#identifier', username);
await page.fill('#password', password);
await page.click('button[type="submit"]');

// 2. Home: metrics, concept cards, location filter
await page.waitForSelector('text=Active concepts');
await page.waitForSelector('text=CON001');
await shot('02-home');

// 3. Location filter
await page.click('aside >> text=Store room');
await page.waitForTimeout(700);
await shot('03-home-location-filter');
await page.click('aside >> text=Store room');
await page.waitForTimeout(400);

// 4. Quick Add via the `q` keyboard shortcut
await page.keyboard.press('q');
await page.waitForSelector('#qa-name');
await page.fill('#qa-name', 'IPA');
await page.waitForSelector('text=Northline IPA');
await shot('04-quickadd-typeahead');
await page.click('button:has-text("Close")');
await page.waitForTimeout(300);

// 5. Items browser + detail drawer
await page.goto(`${baseUrl}/items`);
await page.waitForSelector('text=supplyAA001');
await shot('05-items');
await page.click('td:has-text("supplyAA001")');
await page.waitForSelector('text=Custom fields');
await shot('06-item-drawer');
await page.click('button:has-text("Details")'); // keep drawer, close via X
await page.click('.fixed >> button >> nth=0');
await page.waitForTimeout(300);

// 6. Types editor with the live preview pane
await page.goto(`${baseUrl}/types`);
await page.waitForSelector('text=supply');
await page.click('tr:has-text("supply") >> button[title="Edit"] >> nth=0');
await page.waitForSelector('text=Add-item form preview');
await shot('07-type-editor');
await page.click('button:has-text("Cancel")');

// 7. Locations tree
await page.goto(`${baseUrl}/locations`);
await page.waitForSelector('text=L01R01Z01');
await shot('08-locations');

// 8. Theme menu — switch to a preset, confirm the whole UI reskins
await page.click('button[title="Theme colours"]');
await page.waitForSelector('text=Presets');
await shot('09-theme-menu');
await page.click('button:has-text("Ember")');
await page.waitForTimeout(500);
await shot('10-theme-ember');
await page.click('button:has-text("Restore defaults")');
await page.waitForTimeout(300);
await page.click('button:has-text("Close")');

// 9. History with filters
await page.goto(`${baseUrl}/history`);
await page.waitForSelector('tbody span:text-is("created")');
await shot('11-history');

// 10. Users admin
await page.goto(`${baseUrl}/users`);
await page.waitForSelector('text=Member since');
await shot('12-users');

console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'No console errors.');
await browser.close();
