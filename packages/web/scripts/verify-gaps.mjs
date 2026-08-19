// Drives every feature added to close the "what it doesn't do yet" list.
// Usage: node scripts/verify-gaps.mjs <baseUrl> <user> <pass> [outDir]
//
// THIS SCRIPT WRITES TO THE DATABASE IT IS POINTED AT. It creates lots, opens
// and empties containers, and records activities — running it against the workshop's
// real data leaves test rows behind. Point the API at a scratch copy first:
//
//   cp packages/api/data/inventory.db /tmp/scratch.db
//   DATABASE_PATH=/tmp/scratch.db npm run dev
//
import { chromium } from 'playwright';

const baseUrl = process.argv[2] ?? 'http://localhost:5173';
const username = process.argv[3] ?? 'demoadmin';
const password = process.argv[4] ?? 'test-1234-test';
const outDir = process.argv[5] ?? '.';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 1440, height: 950 },
  acceptDownloads: true,
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// Two checks here deliberately provoke a rejection — a delete the API must
// block (409) and a wrong password (400) — and the browser logs every failed
// request as a console error. A 4xx the app HANDLES is the pass condition, not
// a defect, so it is not counted. 5xx and real JS errors still are.
const handled4xx = /Failed to load resource.*status of 4\d\d/;
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (handled4xx.test(m.text())) return;
  errors.push(m.text());
});
const ok = (name) => console.log(`✓ ${name}`);

await page.goto(`${baseUrl}/login`);
await page.fill('#identifier', username);
await page.fill('#password', password);
await page.click('button[type="submit"]');
await page.waitForSelector('text=Active concepts');
ok('signed in');

// 1. A standalone item (no variant, so no concept) now shows on Home --------
await page.goto(`${baseUrl}/items`);
await page.click('button:has-text("Add item")');
await page.waitForSelector('#add-type');
await page.selectOption('#add-type', { label: 'Consumable' });
await page.fill('#add-qty', '2');
await page.fill('#add-unit', 'box');
await page.click('button[type="submit"]:has-text("Save")');
await page.waitForSelector('text=/✓ consumable/');
ok('created a standalone item (no variant)');

await page.goto(`${baseUrl}/`);
await page.waitForSelector('text=Standalone items');
ok('Home shows a card for items with no concept');
await page.screenshot({ path: `${outDir}/gap-home-standalone.png` });

// 2. Status dropdown for a type whose lifecycle isn't in_stock→open→depleted.
// The instrument is `in_service`, so neither Open nor Deplete applies and the
// dropdown is the only way to change its status.
await page.goto(`${baseUrl}/items`);
// Turn EVERY status filter on. Pinning this to 'in service' made the suite
// single-use: the check itself moves the instrument to another status, so a
// second run could never find it again.
for (const status of ['in stock', 'open', 'in service', 'maintenance', 'active', 'retired']) {
  const pill = page.locator(`button:text-is("${status}")`);
  // count() does not auto-wait; check too early and no filter is applied.
  await pill.first().waitFor({ timeout: 10_000 });
  const selected = await pill.first().evaluate((el) => el.className.includes('text-primary'));
  if (!selected) await pill.first().click();
}
// Search for it rather than trusting it to be on the first page: the list is
// paginated, and any run that receives a delivery pushes older rows down.
await page.fill('input[placeholder*="serial"]', 'toolAA001');
await page.waitForSelector('td:has-text("toolAA001")', { timeout: 10_000 });
await page.click('td:has-text("toolAA001")');
await page.waitForSelector('text=Custom fields');
const statusSelect = page.locator('select:has(option:text-is("Set status…"))');
if ((await statusSelect.count()) === 0) throw new Error('status dropdown missing');
const statuses = await statusSelect.locator('option').allTextContents();
// Pick whichever offered status the instrument is not already in.
const target = statuses.slice(1).map((s) => s.trim().replaceAll(' ', '_'))[0];
await statusSelect.selectOption(target);
await page.waitForSelector(`text=/· ${target.replaceAll('_', ' ')}/`);
ok(`instrument status changed via dropdown (offered: ${statuses.slice(1).join(', ')})`);
await page.screenshot({ path: `${outDir}/gap-status.png` });
await page.keyboard.press('Escape');
await page.locator('.fixed >> button').first().click();

// 3. CSV export downloads --------------------------------------------------
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('button:has-text("Export")'),
]);
const csvPath = `${outDir}/exported.csv`;
await download.saveAs(csvPath);
ok(`CSV exported as ${download.suggestedFilename()}`);

// 4. Label printing from a selection ---------------------------------------
// Clear the search left over from the instrument check, or there is only one
// row left to tick and the sheet cannot have two labels on it.
await page.fill('input[placeholder*="serial"]', '');
await page.waitForTimeout(600);
await page.locator('tbody input[type="checkbox"]').first().check();
await page.locator('tbody input[type="checkbox"]').nth(1).check();
await page.waitForSelector('text=2 selected');
await page.click('button:has-text("Print labels")');
await page.waitForSelector('.label-sheet img');
const qrCount = await page.locator('.label-sheet img').count();
if (qrCount !== 2) throw new Error(`expected 2 QR codes, got ${qrCount}`);
ok('label sheet rendered 2 QR codes');
await page.screenshot({ path: `${outDir}/gap-labels.png` });
await page.click('button:has-text("Close")');

// 5. History filter by user ------------------------------------------------
await page.goto(`${baseUrl}/history`);
await page.waitForSelector('tbody span:text-is("created")');
const userFilter = page.locator('select:has(option:text-is("All users"))');
if ((await userFilter.count()) === 0) throw new Error('user filter missing');
await userFilter.selectOption({ label: 'Demo Admin' });
await page.waitForTimeout(600);
ok('history filters by user');

// 6. Cascade delete offers itself, then the Bin restores -------------------
await page.goto(`${baseUrl}/concepts`);
await page.fill('input[placeholder="Search…"]', 'isopropyl');
await page.waitForSelector('td:has-text("CON001")');
await page.click('tr:has-text("CON001") button[title="Delete"]');
await page.waitForSelector('text=Delete this?');
await page.click('button:has-text("Delete") >> nth=-1');
await page.waitForSelector('text=Something is in the way');
ok('blocked delete explains itself and offers the cascade');
await page.screenshot({ path: `${outDir}/gap-cascade.png` });
await page.click('button:has-text("Delete all of it")');
await page.waitForSelector('text=Deleted');

await page.goto(`${baseUrl}/trash`);
await page.waitForSelector('td:has-text("CON001")');
const blocked = await page.locator('text=restore its').count();
if (blocked === 0) throw new Error('expected child rows to be blocked');
ok(`Bin lists the deleted rows, ${blocked} blocked until their parent returns`);
await page.screenshot({ path: `${outDir}/gap-trash.png` });

// restore everything, parents first
for (let round = 0; round < 4; round++) {
  const buttons = page.locator('button:has-text("Restore")');
  const n = await buttons.count();
  if (n === 0) break;
  for (let i = 0; i < n; i++) {
    const button = page.locator('button:has-text("Restore")').first();
    if (!(await button.count())) break;
    await button.click();
    await page.waitForTimeout(400);
  }
}
await page.waitForSelector('text=Nothing has been deleted');
ok('everything restored from the Bin');

await page.goto(`${baseUrl}/concepts`);
await page.fill('input[placeholder="Search…"]', 'isopropyl');
await page.waitForSelector('td:has-text("CON001")');
const stock = await page.textContent('tr:has-text("CON001") td:nth-child(4)');
ok(`concept is back with its stock: ${stock?.trim()}`);

// 7. Password change guards -------------------------------------------------
await page.click('button[title="Change password"]');
await page.waitForSelector('#pw-current');
await page.fill('#pw-current', 'wrong-password');
await page.fill('#pw-new', 'brand-new-1234');
await page.fill('#pw-repeat', 'brand-new-1234');
await page.click('button[type="submit"]:has-text("Save")');
await page.waitForSelector('text=/Invalid password/i');
ok('changing the password rejects a wrong current password');
await page.screenshot({ path: `${outDir}/gap-password.png` });

console.log(errors.length ? `\nCONSOLE ERRORS:\n${errors.join('\n')}` : '\nNo console errors.');
await browser.close();
if (errors.length) process.exit(1);
