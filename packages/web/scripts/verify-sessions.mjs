// Accounts, sessions, signing in and signing out — with more than one person.
//
// Usage: node scripts/verify-sessions.mjs [baseUrl]
//
// The other suites each drive one account, and everything interesting about
// this half of the app needs two: a claim belongs to ONE person, another
// person's chord switches user, resetting a password throws somebody out of a
// browser that is not the one running the test. So this one opens three
// contexts — an admin, Anna's own desk, and a shared bench machine — and keeps
// them all alive at once.
//
// THIS SCRIPT WRITES TO THE DATABASE IT IS POINTED AT. It creates two accounts,
// changes roles, resets passwords and ends every session on the server. Point
// it at a scratch copy, never at the workshop's real data:
//
//   DATABASE_PATH=/tmp/scratch/inventory.db npm run db:seed
//   DATABASE_PATH=/tmp/scratch/inventory.db SERVE_WEB=1 WEB_DIST=./packages/web/dist \
//     PORT=3007 node packages/api/dist/index.js
//   node packages/web/scripts/verify-sessions.mjs http://localhost:3007
//
// Exits non-zero if anything failed.

import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:3007';

const ADMIN = { user: 'sessadmin', pass: 'sess-admin-1234', name: 'Session Admin' };
const ANNA = { user: 'annaop', pass: 'anna-op-1234', name: 'Anna Operator' };
const BOB = { user: 'bobview', pass: 'bob-view-1234', name: 'Bob Viewer' };
const BOB_NEW_PASS = 'bob-reset-9876';

/** Comfortably longer than the app's 350 ms default, so timing is never the variable. */
const HOLD = 550;

const results = [];
const ok = (name, extra = '') => {
  results.push(true);
  console.log(`  ok  ${name}${extra ? ' — ' + extra : ''}`);
};
const bad = (name, extra = '') => {
  results.push(false);
  console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`);
};
const check = (condition, name, extra = '') => (condition ? ok(name, extra) : bad(name, extra));
const section = (title) => console.log(`\n— ${title} —`);

const browser = await chromium.launch({ args: ['--no-sandbox'] });

/** One browser = one computer. Three of them, all alive at the same time. */
async function computer(label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${label}: ${e}`));
  page.on('console', (m) => {
    // A 4xx the app handles and shows is the pass condition for several checks
    // below (a wrong password, a revoked chord). Only 5xx and real JS faults
    // count as breakage.
    if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(`${label}: ${m.text()}`);
  });
  return { label, context, page, errors };
}

// ---------------------------------------------------------------- helpers

const sessionCookie = async (ctx) =>
  (await ctx.cookies()).find((c) => c.name.includes('session_token')) ?? null;

/**
 * Is a session still alive on the SERVER?
 *
 * Signing out has to delete the row, not merely drop the cookie: a cookie the
 * browser forgot but the server still honours is a session anybody who copied
 * it can keep using. So the check is made from outside the browser, with the
 * cookie value captured beforehand.
 */
async function stillValid(cookieValue) {
  const response = await fetch(`${BASE}/api/v1/items?perPage=1`, {
    headers: { cookie: `better-auth.session_token=${cookieValue}` },
  });
  return response.status === 200;
}

async function signIn({ page }, { user, pass }, { remember = false } = {}) {
  await page.goto(`${BASE}/login`);
  await page.waitForSelector('#identifier');
  await page.fill('#identifier', user);
  await page.fill('#password', pass);
  const box = page.locator('input[type="checkbox"]').first();
  if ((await box.count()) > 0 && (await box.isChecked()) !== remember) await box.click();
  await page.click('button[type="submit"]');
}

async function signedInAs({ page }) {
  const response = await page.request.get(`${BASE}/api/auth/get-session`);
  if (!response.ok()) return null;
  const body = await response.json().catch(() => null);
  return body?.user?.username ?? null;
}

/** Generate a chord for whoever this browser is signed in as. */
async function makeChord({ page }) {
  const response = await page.request.post(`${BASE}/api/v1/users/me/fast-key`);
  return (await response.json()).chord;
}

async function pressChord(page, chord) {
  const press = async (keys) => {
    for (const key of keys) await page.keyboard.down(`Key${key.toUpperCase()}`);
    await page.waitForTimeout(HOLD + 200);
    for (const key of keys) await page.keyboard.up(`Key${key.toUpperCase()}`);
  };
  const [first, second] = chord.split(' ');
  await press(first.split('+'));
  await page.waitForTimeout(150);
  await press(second.split('+'));
  await page.waitForTimeout(1600);
}

const admin = await computer('admin');
const anna = await computer('anna');
const bench = await computer('bench');

// ========================================================= 1. the first admin
section('the first account');

await signIn(admin, ADMIN);
let landed = await admin.page
  .waitForSelector('text=Active concepts', { timeout: 6000 })
  .then(() => true)
  .catch(() => false);

if (!landed) {
  await admin.page.click('text=/First run|Erstmalige|primer/i');
  await admin.page.waitForSelector('#name');
  await admin.page.fill('#name', ADMIN.name);
  await admin.page.fill('#identifier', ADMIN.user);
  await admin.page.fill('#password', ADMIN.pass);
  await admin.page.click('button[type="submit"]');
  await admin.page.waitForSelector('text=Active concepts', { timeout: 15_000 });
  ok('the first account registered, and became the admin');
} else {
  ok('the admin signed in');
}

// Registration closes after the first account, whichever way we got here.
const secondSignUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'gatecrash@workshop.invalid', username: 'gatecrash',
    password: 'gate-crash-1234', name: 'Gate Crash',
  }),
});
check(secondSignUp.status === 403, 'public registration is closed afterwards', `${secondSignUp.status}`);

// ============================================================== 2. two people
section('the admin makes two accounts');

for (const [person, role] of [[ANNA, 'operator'], [BOB, 'viewer']]) {
  const made = await admin.page.request.post(`${BASE}/api/v1/users`, {
    data: { name: person.name, username: person.user, password: person.pass, role, email: null },
  });
  // 409 means a previous run already made them — fine, the point is that they exist.
  check([201, 409].includes(made.status()), `${person.user} exists as a ${role}`, `${made.status()}`);
}

await signIn(anna, ANNA);
await anna.page.waitForSelector('[data-tour="nav"]', { timeout: 10_000 });
check((await signedInAs(anna)) === ANNA.user, 'Anna signed in on her own computer');

await signIn(bench, BOB);
await bench.page.waitForSelector('[data-tour="nav"]', { timeout: 10_000 });
check((await signedInAs(bench)) === BOB.user, 'Bob signed in on the bench computer');

// ================================================================= 3. roles
section('what a role is allowed to do');

const bobUsers = await bench.page.request.get(`${BASE}/api/v1/users`);
check(bobUsers.status() === 403, 'a viewer cannot read the user list (403)', `${bobUsers.status()}`);

const bobNav = await bench.page.locator('[data-tour="nav"]').innerText();
check(!/Lots|Bestellungen/i.test(bobNav), 'and is not offered the pages they could not use');

const users = await admin.page.request.get(`${BASE}/api/v1/users`).then((r) => r.json());
const bobId = users.find((u) => u.username === BOB.user)?.id;
const annaId = users.find((u) => u.username === ANNA.user)?.id;
const adminId = users.find((u) => u.username === ADMIN.user)?.id;
check(Boolean(bobId && annaId && adminId), 'the admin can read the user list');

const ownRole = await admin.page.request.patch(`${BASE}/api/v1/users/${adminId}/role`, {
  data: { role: 'viewer' },
});
check(ownRole.status() === 409, 'an admin cannot demote themselves out of the admin area (409)', `${ownRole.status()}`);

await admin.page.request.patch(`${BASE}/api/v1/users/${bobId}/role`, { data: { role: 'manager' } });
await bench.page.reload();
await bench.page.waitForSelector('[data-tour="nav"]');
const bobNavAfter = await bench.page.locator('[data-tour="nav"]').innerText();
check(/Lots|Bestellungen/i.test(bobNavAfter), 'promoting him to manager opens the pages, on reload');

// ==================================================== 4. signing out for real
section('signing out');

const bobCookieBefore = (await sessionCookie(bench.context))?.value ?? '';
check(await stillValid(bobCookieBefore), "Bob's session is live on the server");

await bench.page.click('button[title*="Sign out"], button[title*="Surt"], button[title*="Abmelden"]');
await bench.page.waitForURL('**/login', { timeout: 10_000 }).catch(() => {});
check(bench.page.url().includes('/login'), 'signing out lands on the sign-in screen');
check(
  !(await stillValid(bobCookieBefore)),
  'and the session is deleted on the server, not just forgotten by the browser',
);

await bench.page.goto(`${BASE}/items`);
await bench.page.waitForTimeout(600);
check(bench.page.url().includes('/login'), 'a protected page is closed again afterwards');

// A wrong password must not produce a session of any kind.
await signIn(bench, { user: BOB.user, pass: 'not-the-password' });
await bench.page.waitForTimeout(1200);
check((await sessionCookie(bench.context)) === null, 'a wrong password leaves no session behind');
check(
  (await bench.page.locator('.text-danger, p.text-sm.text-danger').count()) > 0,
  'and says so on screen',
);

await signIn(bench, BOB);
await bench.page.waitForSelector('[data-tour="nav"]', { timeout: 10_000 });

// ======================================================= 5. chords, with two
section('the key chord, with two people');

const annaChord = await makeChord(anna);
const bobChord = await makeChord(bench);
check(
  Boolean(annaChord && bobChord) && annaChord !== bobChord,
  'each person gets their own chord',
  `${annaChord} / ${bobChord}`,
);

// Anna's own chord, pressed while she is working, signs her out.
await anna.page.goto(`${BASE}/items`);
await anna.page.waitForSelector('[data-tour="items-table"]');
await anna.page.locator('h1').click();
await pressChord(anna.page, annaChord);
check((await signedInAs(anna)) === null, 'your own chord signs you out — from any page, not just the sign-in screen');

// And signs her back in from wherever she is.
await pressChord(anna.page, annaChord);
check((await signedInAs(anna)) === ANNA.user, 'and the same chord signs you back in');

// The handover: Bob walks up to Anna's machine and presses his own.
const annaCookieBefore = (await sessionCookie(anna.context))?.value ?? '';
await anna.page.goto(`${BASE}/items`);
await anna.page.waitForSelector('[data-tour="items-table"]');
await anna.page.locator('h1').click();
await pressChord(anna.page, bobChord);
check((await signedInAs(anna)) === BOB.user, "somebody else's chord hands the machine over");
check(
  !(await stillValid(annaCookieBefore)),
  'and the previous session is deleted, not left open behind it',
);

// Giving it back is ONE press, not two: a chord that is not the current user's
// switches straight over. Pressing it twice would sign Anna back out again.
await pressChord(anna.page, annaChord);
check((await signedInAs(anna)) === ANNA.user, 'and one press hands it straight back — no signing out in between');

// The signed-out board tells people to press their chord, so it has to read one
// even when the cursor is sitting in its search box.
const guest = await computer('guest');
await guest.page.goto(`${BASE}/`);
await guest.page.waitForSelector('h1');
await guest.page.locator('input[placeholder]').first().click();
await pressChord(guest.page, bobChord);
check((await signedInAs(guest)) === BOB.user, 'the chord works from the public board, cursor in the search box and all');
await guest.context.close();

// Inside the app, a text field must still swallow it — that guard is what stops
// the shortcut eating what somebody typed into a search box.
await anna.page.goto(`${BASE}/items`);
await anna.page.waitForSelector('[data-tour="items-table"]');
await anna.page.locator('input[placeholder]').last().click();
await pressChord(anna.page, annaChord);
check((await signedInAs(anna)) === ANNA.user, 'but a chord typed into a search box inside the app is ignored');

// An admin taking a chord away.
await admin.page.request.delete(`${BASE}/api/v1/users/${annaId}/fast-key`);
const revoked = await fetch(`${BASE}/api/auth/sign-in/fast-key`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chord: annaChord }),
});
check(revoked.status === 401, 'a chord an admin revoked stops working', `${revoked.status}`);
const annaChord2 = await makeChord(anna); // she gives herself a new one

// ======================================================== 6. claiming a desk
section('remembering a computer');

const beforeClaim = await sessionCookie(anna.context);
check(
  beforeClaim !== null && beforeClaim.expires === -1,
  'an unclaimed computer gets a cookie that dies with the browser',
  beforeClaim ? String(beforeClaim.expires) : 'none',
);

await anna.page.goto(`${BASE}/`);
await anna.page.waitForSelector('[data-tour="nav"]');
await anna.page.click('button[title*="Remember"], button[title*="Recorda"], button[title*="merken"]');
await anna.page.waitForSelector('#claim-password');
await anna.page.fill('#claim-password', ANNA.pass);
await anna.page.click('[role="dialog"] button:has-text("Remember this computer")');
await anna.page.waitForTimeout(1500);

const afterClaim = await sessionCookie(anna.context);
check(afterClaim !== null && afterClaim.expires > 0, 'claiming it makes the cookie outlive the browser');
const claim = JSON.parse(await anna.page.evaluate(() => localStorage.getItem('remembered-device')));
check(claim?.username === ANNA.user, 'and the desk is recorded as hers', claim?.username ?? 'none');

// THE rule luctuous asked for: the claim belongs to one person, not to the machine.
await signIn(anna, BOB);
await anna.page.waitForSelector('[data-tour="nav"]', { timeout: 10_000 });
const bobOnAnnasDesk = await sessionCookie(anna.context);
check(
  bobOnAnnasDesk !== null && bobOnAnnasDesk.expires === -1,
  'a colleague signing in on her desk gets an ordinary session that times out',
  bobOnAnnasDesk ? String(bobOnAnnasDesk.expires) : 'none',
);
const claimAfterBob = await anna.page.evaluate(() => localStorage.getItem('remembered-device'));
check(
  claimAfterBob !== null && JSON.parse(claimAfterBob).username === ANNA.user,
  'and borrowing it does not take the desk away from her',
);

// She comes back: the box is already ticked for her, and she gets it back.
await anna.page.goto(`${BASE}/login`);
await anna.page.fill('#identifier', ANNA.user);
await anna.page.waitForTimeout(300);
const preTicked = await anna.page.locator('input[type="checkbox"]').first().isChecked();
check(preTicked, 'when she signs in again the box is already ticked for her');
await anna.page.fill('#password', ANNA.pass);
await anna.page.click('button[type="submit"]');
await anna.page.waitForSelector('[data-tour="nav"]', { timeout: 10_000 });
const backAgain = await sessionCookie(anna.context);
check(backAgain !== null && backAgain.expires > 0, 'and her lasting session comes back');

// Her chord at her own desk must not quietly downgrade it.
await pressChord(anna.page, annaChord2); // out
await pressChord(anna.page, annaChord2); // in
const afterChord = await sessionCookie(anna.context);
check((await signedInAs(anna)) === ANNA.user, 'her chord still signs her in at her own desk');
check(
  afterChord !== null && afterChord.expires > 0,
  'and it stays a lasting session, not downgraded to a temporary one',
  afterChord ? String(afterChord.expires) : 'none',
);

// ======================================================== 7. idle, with two
section('twenty minutes of silence, on two computers');

// Anna's desk is claimed: nothing should happen to it at all.
const annaIdle = await anna.context.newPage();
await annaIdle.clock.install();
await annaIdle.goto(`${BASE}/`);
await annaIdle.waitForSelector('[data-tour="nav"]');
await annaIdle.clock.fastForward('25:00');
await annaIdle.waitForTimeout(500);
check(!annaIdle.url().includes('/login'), "Anna's claimed desk is never signed out for idling");
await annaIdle.close();

// The bench is not claimed by anybody.
const benchIdle = await bench.context.newPage();
await benchIdle.clock.install();
await benchIdle.goto(`${BASE}/`);
await benchIdle.waitForSelector('[data-tour="nav"]');
await benchIdle.clock.fastForward('20:30');
await benchIdle.waitForURL('**/login**', { timeout: 10_000 }).catch(() => {});
check(benchIdle.url().includes('idle=1'), 'the shared bench signs itself out and says why', benchIdle.url());
await benchIdle.close();

await signIn(bench, BOB);
await bench.page.waitForSelector('[data-tour="nav"]', { timeout: 10_000 });

// ================================================= 8. passwords end sessions
section('passwords');

const bobLive = (await sessionCookie(bench.context))?.value ?? '';
await admin.page.request.post(`${BASE}/api/v1/users/${bobId}/password`, {
  data: { newPassword: BOB_NEW_PASS },
});
check(
  !(await stillValid(bobLive)),
  "resetting somebody's password throws them out of the browser they left open",
);

const oldPassword = await fetch(`${BASE}/api/auth/sign-in/username`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: BOB.user, password: BOB.pass }),
});
check(oldPassword.status >= 400, 'and the old password stops working', `${oldPassword.status}`);
BOB.pass = BOB_NEW_PASS;

await signIn(bench, BOB);
await bench.page.waitForSelector('[data-tour="nav"]', { timeout: 10_000 });
check((await signedInAs(bench)) === BOB.user, 'the new one works');

// ================================================= 9. signing everyone out
section('signing everyone out, everywhere');

const annaBefore = (await sessionCookie(anna.context))?.value ?? '';
const benchBefore = (await sessionCookie(bench.context))?.value ?? '';
const adminBefore = (await sessionCookie(admin.context))?.value ?? '';

const revokeAll = await admin.page.request.post(`${BASE}/api/v1/users/sessions/revoke-all`);
const revoked3 = await revokeAll.json();
check(revokeAll.ok(), `every session ended`, `${revoked3.sessions} session(s)`);

check(!(await stillValid(annaBefore)), "it reaches Anna's claimed desk too");
check(!(await stillValid(benchBefore)), 'and the shared bench');
check(!(await stillValid(adminBefore)), "and the admin's own session");

// The desk is still hers afterwards: "everybody signs in again" is not the same
// as "everybody loses their computer".
const claimSurvives = await anna.page.evaluate(() => localStorage.getItem('remembered-device'));
check(
  claimSurvives !== null && JSON.parse(claimSurvives).username === ANNA.user,
  'her desk is still hers — she signs in again, she does not re-claim it',
);

await signIn(anna, ANNA, { remember: true });
await anna.page.waitForSelector('[data-tour="nav"]', { timeout: 10_000 });
const afterRevoke = await sessionCookie(anna.context);
check(afterRevoke !== null && afterRevoke.expires > 0, 'and signing in gives it straight back');

// ============================================== 10. giving the desk up
section('giving the desk up');

await anna.page.click('button[title*="Remember"], button[title*="Recorda"], button[title*="merken"]');
await anna.page.waitForSelector('[role="dialog"]');
await anna.page.click('[role="dialog"] button:has-text("Forget this computer")');
await anna.page.waitForURL('**/login', { timeout: 10_000 }).catch(() => {});
check(anna.page.url().includes('/login'), 'forgetting the computer signs you out on the spot');
check(
  (await anna.page.evaluate(() => localStorage.getItem('remembered-device'))) === null,
  'and the desk is nobody\'s again',
);

await signIn(anna, ANNA);
await anna.page.waitForSelector('[data-tour="nav"]', { timeout: 10_000 });
const afterForget = await sessionCookie(anna.context);
check(
  afterForget !== null && afterForget.expires === -1,
  'so her next session is an ordinary one again',
  afterForget ? String(afterForget.expires) : 'none',
);

// ================================================== 11. guessing at chords
// LAST, on purpose: the throttle counts every attempt from this address, so
// anything after it would be answered with 429 whether it deserved it or not.
section('guessing at chords');

let firstRefusal = 0;
for (let attempt = 1; attempt <= 14; attempt++) {
  const response = await fetch(`${BASE}/api/auth/sign-in/fast-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chord: 'q+w+e a+s+d' }),
  });
  if (response.status === 429 && firstRefusal === 0) firstRefusal = attempt;
}
check(
  firstRefusal > 0 && firstRefusal <= 14,
  'a machine guessing chords is cut off within a minute',
  `refused from attempt ${firstRefusal}`,
);

// ================================================================== results
const errors = [...admin.errors, ...anna.errors, ...bench.errors];
check(errors.length === 0, 'no console errors on any of the three computers', errors.slice(0, 3).join(' | '));

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
