// The rules and guards, straight against the API — no browser. Checks the
// invariants that must never bend: what stock is allowed to do, what equipment
// refuses, what a pool may not invent, and what the app says when you feed it
// nonsense.
//
// Usage: node scripts/verify-rules.mjs [apiBaseUrl] [user] [pass]
//
// THIS SCRIPT WRITES TO THE DATABASE IT IS POINTED AT. It creates maintenance
// plans, links items, records activities and empties containers. Point it at a
// scratch copy, never at the workshop's real data:
//
//   cp packages/api/data/inventory.db /tmp/scratch.db
//   PORT=3002 DATABASE_PATH=/tmp/scratch.db npx tsx src/index.ts   # in packages/api
//   node scripts/verify-rules.mjs http://localhost:3002
//
// Exits non-zero if anything failed.

const BASE = process.argv[2] ?? 'http://localhost:3001';
const USER = process.argv[3] ?? 'demoadmin';
const PASS = process.argv[4] ?? 'test-1234-test';
console.log(`\n→ ${BASE} — this writes to that database\n`);
let cookie = '';
const findings = [];

const note = (level, area, text) => {
  findings.push({ level, area, text });
  const tag = { PASS: '  ok ', FAIL: 'FAIL ', NOTE: 'NOTE ', WARN: 'WARN ' }[level];
  console.log(`${tag} [${area}] ${text}`);
};

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let body = null;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: res.status, body };
}

async function signIn(username, password) {
  const res = await fetch(`${BASE}/api/auth/sign-in/username`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return res.status;
}

// =========================================================== 1. auth
console.log('\n──────── 1. authentication and roles ────────');

{
  const anon = await fetch(`${BASE}/api/v1/items`).then((r) => r.status);
  anon === 401
    ? note('PASS', 'auth', 'unauthenticated read is refused (401)')
    : note('FAIL', 'auth', `unauthenticated GET /items returned ${anon}, expected 401`);

  const bad = await signIn(USER, 'definitely-wrong');
  bad >= 400
    ? note('PASS', 'auth', `wrong password refused (${bad})`)
    : note('FAIL', 'auth', `wrong password accepted (${bad})`);
  cookie = '';

  const ghost = await signIn('nobody-here', 'whatever-1234');
  ghost >= 400
    ? note('PASS', 'auth', `unknown username refused (${ghost})`)
    : note('FAIL', 'auth', `unknown username accepted (${ghost})`);
  cookie = '';

  const good = await signIn(USER, PASS);
  good === 200
    ? note('PASS', 'auth', 'valid sign-in works')
    : note('FAIL', 'auth', `valid sign-in returned ${good}`);
}

// ================================================= 2. input validation
console.log('\n──────── 2. input validation ────────');

{
  const r = await api('/api/v1/items/not-a-uuid');
  [400, 404].includes(r.status)
    ? note('PASS', 'validation', `malformed uuid rejected (${r.status} ${r.body?.error?.code})`)
    : note('FAIL', 'validation', `malformed uuid returned ${r.status}`);

  const missing = await api('/api/v1/items/00000000-0000-4000-8000-000000000000');
  missing.status === 404
    ? note('PASS', 'validation', 'well-formed but unknown id is 404')
    : note('FAIL', 'validation', `unknown id returned ${missing.status}`);

  const big = await api('/api/v1/items?perPage=100000');
  big.status === 400
    ? note('PASS', 'validation', 'oversized perPage rejected (400)')
    : note(
        'WARN',
        'validation',
        `perPage=100000 returned ${big.status}, ${big.body?.data?.length ?? '?'} rows`,
      );

  const neg = await api('/api/v1/items?page=-5');
  neg.status === 400
    ? note('PASS', 'validation', 'negative page rejected')
    : note('WARN', 'validation', `page=-5 returned ${neg.status}`);

  const junkStatus = await api('/api/v1/items?status=banana');
  junkStatus.status === 200
    ? note(
        'PASS',
        'validation',
        `unknown status filter ignored rather than erroring (${junkStatus.body?.meta?.total} rows)`,
      )
    : note('NOTE', 'validation', `status=banana returned ${junkStatus.status}`);
}

// ============================================== 3. equipment: links
console.log('\n──────── 3. equipment — links ────────');

const items = (await api('/api/v1/items?perPage=100')).body.data;
const byId = (h) => items.find((i) => i.humanId === h);
const instrument = byId('toolAA001');
const doc = byId('documentAA001');
const supply = byId('supplyAA001');

{
  const self = await api(`/api/v1/items/${instrument.id}/links`, {
    method: 'POST',
    body: { childItemId: instrument.id, relation: 'spare' },
  });
  self.status === 400
    ? note('PASS', 'links', 'self-link refused')
    : note('FAIL', 'links', `self-link returned ${self.status}`);

  const existing = (await api(`/api/v1/items/${instrument.id}/links`)).body;
  const already = existing.children.length > 0;
  const dup = await api(`/api/v1/items/${instrument.id}/links`, {
    method: 'POST',
    body: { childItemId: doc.id, relation: 'document' },
  });
  if (already) {
    dup.status === 400
      ? note('PASS', 'links', 'duplicate link refused')
      : note('FAIL', 'links', `duplicate link returned ${dup.status}`);
  } else {
    note('NOTE', 'links', `no seed link present; create returned ${dup.status}`);
  }

  // A → B exists; B → A must be refused as a loop.
  const loop = await api(`/api/v1/items/${doc.id}/links`, {
    method: 'POST',
    body: { childItemId: instrument.id, relation: 'accessory' },
  });
  loop.status === 400
    ? note('PASS', 'links', `direct loop refused: "${loop.body.error.message}"`)
    : note('FAIL', 'links', `direct loop returned ${loop.status}`);

  // Three-deep loop: tool → doc → supply → tool
  const chain = await api(`/api/v1/items/${doc.id}/links`, {
    method: 'POST',
    body: { childItemId: supply.id, relation: 'consumable' },
  });
  if (chain.status === 201) {
    const deep = await api(`/api/v1/items/${supply.id}/links`, {
      method: 'POST',
      body: { childItemId: instrument.id, relation: 'accessory' },
    });
    deep.status === 400
      ? note('PASS', 'links', 'three-deep loop refused (ancestor walk works)')
      : note('FAIL', 'links', `three-deep loop returned ${deep.status} — CYCLE CREATED`);
    await api(`/api/v1/links/${chain.body.id}`, { method: 'DELETE' });
  } else {
    note('NOTE', 'links', `could not build the chain (${chain.status})`);
  }

  const badRelation = await api(`/api/v1/items/${instrument.id}/links`, {
    method: 'POST',
    body: { childItemId: supply.id, relation: 'soulmate' },
  });
  badRelation.status === 400
    ? note('PASS', 'links', 'unknown relation rejected by the schema')
    : note('FAIL', 'links', `relation "soulmate" accepted (${badRelation.status})`);

  const ghostChild = await api(`/api/v1/items/${instrument.id}/links`, {
    method: 'POST',
    body: { childItemId: '00000000-0000-4000-8000-000000000000', relation: 'spare' },
  });
  ghostChild.status === 404
    ? note('PASS', 'links', 'linking a non-existent item is 404')
    : note('FAIL', 'links', `non-existent child returned ${ghostChild.status}`);
}

// ========================================= 4. equipment: maintenance
console.log('\n──────── 4. equipment — maintenance ────────');

{
  const noInterval = await api(`/api/v1/items/${instrument.id}/maintenance`, {
    method: 'POST',
    body: { name: { en: 'Nothing' }, kind: 'service' },
  });
  noInterval.status === 400
    ? note('PASS', 'maintenance', 'a plan with neither days nor uses is refused')
    : note('FAIL', 'maintenance', `interval-less plan accepted (${noInterval.status})`);

  const zero = await api(`/api/v1/items/${instrument.id}/maintenance`, {
    method: 'POST',
    body: { name: { en: 'Zero' }, everyDays: 0 },
  });
  zero.status === 400
    ? note('PASS', 'maintenance', 'everyDays=0 refused')
    : note('FAIL', 'maintenance', `everyDays=0 accepted (${zero.status})`);

  const negative = await api(`/api/v1/items/${instrument.id}/maintenance`, {
    method: 'POST',
    body: { name: { en: 'Negative' }, everyUses: -10 },
  });
  negative.status === 400
    ? note('PASS', 'maintenance', 'negative interval refused')
    : note('FAIL', 'maintenance', `everyUses=-10 accepted (${negative.status})`);

  const fractional = await api(`/api/v1/items/${instrument.id}/maintenance`, {
    method: 'POST',
    body: { name: { en: 'Fractional' }, everyDays: 3.7 },
  });
  fractional.status === 400
    ? note('PASS', 'maintenance', 'fractional interval refused')
    : note('WARN', 'maintenance', `everyDays=3.7 accepted (${fractional.status})`);

  // A real plan, then the full lifecycle.
  const created = await api(`/api/v1/items/${instrument.id}/maintenance`, {
    method: 'POST',
    body: { name: { en: 'Probe plan' }, kind: 'service', everyDays: 30, everyUses: 10 },
  });
  if (created.status !== 201) {
    note('FAIL', 'maintenance', `could not create a plan (${created.status})`);
  } else {
    const plan = created.body;
    plan.daysUntilDue === 30
      ? note('PASS', 'maintenance', 'a never-serviced plan starts its clock today')
      : note('NOTE', 'maintenance', `new plan daysUntilDue=${plan.daysUntilDue}`);

    // Count uses past the limit and check "whichever comes first".
    await api(`/api/v1/items/${instrument.id}/uses`, { method: 'POST', body: { uses: 12 } });
    const after = (await api(`/api/v1/items/${instrument.id}/maintenance`)).body.find(
      (p) => p.id === plan.id,
    );
    after.overdue === true && after.daysUntilDue > 0
      ? note('PASS', 'maintenance', `overdue by uses while days remain (${after.usesUntilDue} uses, ${after.daysUntilDue} days)`)
      : note('FAIL', 'maintenance', `whichever-comes-first wrong: overdue=${after.overdue} uses=${after.usesUntilDue} days=${after.daysUntilDue}`);

    const done = await api(`/api/v1/maintenance/${plan.id}/done`, {
      method: 'POST',
      body: { notes: 'probe' },
    });
    done.body.usesSinceLast === 0 && done.body.overdue === false
      ? note('PASS', 'maintenance', 'marking done resets both counters')
      : note('FAIL', 'maintenance', `after done: uses=${done.body.usesSinceLast} overdue=${done.body.overdue}`);

    const records = (await api(`/api/v1/maintenance/${plan.id}/records`)).body;
    records.length === 1 && records[0].usesAtService === 12
      ? note('PASS', 'maintenance', 'the record keeps the use counter as it stood (12)')
      : note('FAIL', 'maintenance', `record: ${JSON.stringify(records)}`);

    const zeroUses = await api(`/api/v1/items/${instrument.id}/uses`, {
      method: 'POST',
      body: { uses: 0 },
    });
    zeroUses.status === 400
      ? note('PASS', 'maintenance', 'counting zero uses is refused')
      : note('WARN', 'maintenance', `uses=0 returned ${zeroUses.status}`);

    const negUses = await api(`/api/v1/items/${instrument.id}/uses`, {
      method: 'POST',
      body: { uses: -5 },
    });
    negUses.status === 400
      ? note('PASS', 'maintenance', 'counting negative uses is refused')
      : note('FAIL', 'maintenance', `uses=-5 returned ${negUses.status} — counter can go backwards`);

    // Update to nothing: must not leave a plan that counts nothing.
    const blank = await api(`/api/v1/maintenance/${plan.id}`, {
      method: 'PATCH',
      body: { everyDays: null, everyUses: null },
    });
    blank.status === 400
      ? note('PASS', 'maintenance', 'editing a plan down to no interval is refused')
      : note('FAIL', 'maintenance', `plan edited to count nothing (${blank.status})`);

    const del = await api(`/api/v1/maintenance/${plan.id}`, { method: 'DELETE' });
    const stillListed = (await api(`/api/v1/items/${instrument.id}/maintenance`)).body.some(
      (p) => p.id === plan.id,
    );
    del.status === 200 && !stillListed
      ? note('PASS', 'maintenance', 'a deleted plan disappears from the item')
      : note('FAIL', 'maintenance', `delete=${del.status} stillListed=${stillListed}`);

    const doneAfterDelete = await api(`/api/v1/maintenance/${plan.id}/done`, {
      method: 'POST',
      body: {},
    });
    doneAfterDelete.status === 404
      ? note('PASS', 'maintenance', 'a deleted plan cannot be marked done')
      : note('FAIL', 'maintenance', `done on deleted plan returned ${doneAfterDelete.status}`);
  }

  const dueList = (await api('/api/v1/maintenance/due')).body;
  Array.isArray(dueList)
    ? note('PASS', 'maintenance', `due list returns ${dueList.length} plan(s), overdue first: ${dueList[0]?.overdue}`)
    : note('FAIL', 'maintenance', 'due list is not an array');
}

// =================================================== 5. stock rules
console.log('\n──────── 5. stock: the rules that must never bend ────────');

{
  const action = (await api('/api/v1/actions')).body[0];
  if (!action) {
    note('NOTE', 'stock', 'no activity defined, skipping the level-3 checks');
  } else {
    // Provision what the check needs instead of assuming it. Repeated runs
    // drain the open container, and a charge against an empty one legitimately
    // moves no stock — which would read as a broken rule 13 when the rule is
    // working exactly as written.
    let charged = null;
    for (const line of action.lineDetails ?? []) {
      const forConcept = (await api(`/api/v1/items?conceptId=${line.conceptId}&perPage=100`)).body.data;
      const usable = forConcept.find(
        (i) => i.status === 'open' && (i.quantityRemaining ?? 0) > line.quantity,
      );
      if (usable) { charged = line; break; }
      const spare = forConcept.find(
        (i) => i.status === 'in_stock' && (i.quantityRemaining ?? 0) > line.quantity,
      );
      if (spare) {
        await api(`/api/v1/items/${spare.id}/open`, { method: 'POST', body: {} });
        charged = line;
        break;
      }
    }

    if (!charged) {
      note('NOTE', 'stock', 'nothing left in stock to open, skipping the rule-13 check');
    } else {
    const before = (await api('/api/v1/concepts/stock')).body[charged.conceptId];
    const rec = await api('/api/v1/action-records', {
      method: 'POST',
      body: { actionId: action.id, count: 1 },
    });
    const after = (await api('/api/v1/concepts/stock')).body[charged.conceptId];
    Math.abs((before - after) - charged.quantity) < 0.0015
      ? note('PASS', 'stock', `recording an activity moved stock by exactly the map (${before} → ${after}) — rule 13 as rewritten`)
      : note('FAIL', 'stock', `stock went ${before} → ${after}, the map says ${charged.quantity} — rule 13 broken`);
    }

  }

  // Stock itself must never be reported negative, whatever was charged.
  const anyNegative = Object.entries((await api('/api/v1/concepts/stock')).body)
    .filter(([, value]) => value < 0);
  anyNegative.length === 0
    ? note('PASS', 'stock', 'no concept reports negative stock')
    : note('FAIL', 'stock', `negative stock on ${anyNegative.length} concept(s)`);

  // Adjusting to a negative quantity must be refused.
  const openItem = items.find((i) => i.status === 'open' && i.quantityRemaining !== null);
  if (openItem) {
    const neg = await api(`/api/v1/items/${openItem.id}/adjust`, {
      method: 'POST',
      body: { quantityRemaining: -50, note: 'probe' },
    });
    neg.status === 400
      ? note('PASS', 'stock', 'adjusting to a negative quantity is refused')
      : note('FAIL', 'stock', `negative adjust accepted (${neg.status}) — stock can go negative`);
  }

  // Depleting twice must not double-count.
  const spare = items.find((i) => i.status === 'in_stock');
  if (spare) {
    await api(`/api/v1/items/${spare.id}/deplete`, { method: 'POST', body: {} });
    const second = await api(`/api/v1/items/${spare.id}/deplete`, { method: 'POST', body: {} });
    const s = (await api('/api/v1/concepts/stock')).body;
    second.status >= 400
      ? note('PASS', 'stock', `depleting an already-empty item is refused (${second.status})`)
      : note('NOTE', 'stock', `depleting twice returned ${second.status} (idempotent, stock=${s[spare.conceptId]})`);
  }
}

// ================================================ 6. pool commission
console.log('\n──────── 6. pools — commissioning from the cupboard ────────');

{
  const pools = (await api('/api/v1/pools')).body;
  const pool = pools.find((p) => p.humanId === 'POO001');
  const cupboard = (await api(`/api/v1/pools/${pool.id}/stock`)).body;
  note('NOTE', 'pools', `cupboard holds ${cupboard.available ?? JSON.stringify(cupboard).slice(0, 120)}`);

  const tooMany = await api(`/api/v1/pools/${pool.id}/commission`, {
    method: 'POST',
    body: { quantity: 999999 },
  });
  tooMany.status >= 400
    ? note('PASS', 'pools', `commissioning more than the cupboard holds is refused (${tooMany.status})`)
    : note('FAIL', 'pools', `commissioned 999999 with ${tooMany.status} — stock invented from nothing`);

  const zero = await api(`/api/v1/pools/${pool.id}/commission`, {
    method: 'POST',
    body: { quantity: 0 },
  });
  zero.status === 400
    ? note('PASS', 'pools', 'commissioning zero is refused')
    : note('WARN', 'pools', `quantity=0 returned ${zero.status}`);

  const negative = await api(`/api/v1/pools/${pool.id}/commission`, {
    method: 'POST',
    body: { quantity: -100 },
  });
  negative.status === 400
    ? note('PASS', 'pools', 'commissioning a negative quantity is refused')
    : note('FAIL', 'pools', `quantity=-100 returned ${negative.status} — pool could be drained into stock`);

  // Take more than are available.
  const over = await api(`/api/v1/pools/${pool.id}/events`, {
    method: 'POST',
    body: { kind: 'take', quantity: 999999 },
  });
  over.status >= 400
    ? note('PASS', 'pools', `taking more than are available is refused (${over.status})`)
    : note('FAIL', 'pools', `took 999999 cups with ${over.status}`);
}

// ================================================== 7. locations
console.log('\n──────── 7. locations — browsing ────────');

{
  const locations = (await api('/api/v1/locations')).body;
  const room = locations.find((l) => l.level === 'room');
  const subtree = (await api(`/api/v1/items?locationId=${room.id}&perPage=100`)).body;
  const exact = (await api(`/api/v1/items?locationId=${room.id}&locationExact=true&perPage=100`)).body;
  subtree.meta.total >= exact.meta.total
    ? note('PASS', 'locations', `subtree ${subtree.meta.total} ≥ exact ${exact.meta.total} for ${room.code}`)
    : note('FAIL', 'locations', `exact (${exact.meta.total}) exceeded subtree (${subtree.meta.total})`);

  const allExact = exact.data.every((i) => i.locationId === room.id);
  allExact
    ? note('PASS', 'locations', 'locationExact really returns only that node')
    : note('FAIL', 'locations', 'locationExact leaked items from sub-locations');

  const junk = await api('/api/v1/items?locationId=not-a-uuid');
  junk.status === 400
    ? note('PASS', 'locations', 'malformed locationId rejected')
    : note('WARN', 'locations', `bad locationId returned ${junk.status}`);

  const withItems = locations.find((l) => l.itemCount > 0);
  if (withItems) {
    const del = await api(`/api/v1/locations/${withItems.id}`, { method: 'DELETE' });
    del.status === 409
      ? note('PASS', 'locations', `deleting an occupied location is blocked (${del.body.error.code})`)
      : note('FAIL', 'locations', `occupied location delete returned ${del.status}`);
  }
}

// ================================================ 8. trash and purge
console.log('\n──────── 8. bin and permanent delete ────────');

{
  const trash = (await api('/api/v1/trash')).body;
  const rows = trash.data ?? trash;
  note('NOTE', 'trash', `bin holds ${Array.isArray(rows) ? rows.length : '?'} row(s)`);

  const referenced = items.find((i) => i.conceptId);
  if (referenced) {
    const purgeLive = await api(`/api/v1/trash/item/${referenced.id}/purge`, { method: 'DELETE' });
    purgeLive.status >= 400
      ? note('PASS', 'trash', `purging a live (undeleted) row is refused (${purgeLive.status})`)
      : note('FAIL', 'trash', `purged a live row (${purgeLive.status})`);
  }
}

// ============================================ 9. history readability
console.log('\n──────── 9. history ────────');

{
  const h = (await api('/api/v1/history?perPage=25')).body;
  const rows = h.data;
  const opaque = rows.filter((r) => !r.entityName && !r.entityHumanId);
  opaque.length === 0
    ? note('PASS', 'history', `all ${rows.length} recent rows carry a name or an id`)
    : note('WARN', 'history', `${opaque.length}/${rows.length} rows show neither name nor id: ${opaque.map((r) => r.entityType + '/' + r.action).join(', ')}`);

  const serviced = rows.find((r) => r.action === 'serviced');
  serviced
    ? note('PASS', 'history', `a service reads as: ${serviced.entityHumanId} · ${JSON.stringify(serviced.valueAfter)}`)
    : note('NOTE', 'history', 'no serviced row in the last 25');

  const badFilter = await api('/api/v1/history?entityType=banana');
  badFilter.status === 400
    ? note('PASS', 'history', 'unknown entityType filter rejected')
    : note('WARN', 'history', `entityType=banana returned ${badFilter.status}`);
}

// ================================================= 10. manual routes
console.log('\n──────── 10. the manual endpoint ────────');

{
  for (const locale of ['en', 'ca', 'de']) {
    const r = await fetch(`${BASE}/api/v1/manual/${locale}`);
    const body = await r.text();
    r.status === 200 && body.includes('<title>')
      ? note('PASS', 'manual', `${locale} serves ${(body.length / 1024).toFixed(0)} KB of HTML`)
      : note('FAIL', 'manual', `${locale} returned ${r.status}`);
  }
  const bad = await fetch(`${BASE}/api/v1/manual/../../etc/passwd`);
  bad.status === 404
    ? note('PASS', 'manual', 'path traversal on the locale is refused')
    : note('FAIL', 'manual', `traversal returned ${bad.status} — POSSIBLE FILE DISCLOSURE`);

  const fr = await fetch(`${BASE}/api/v1/manual/fr`);
  fr.status === 404
    ? note('PASS', 'manual', 'an unknown locale is a clean 404')
    : note('FAIL', 'manual', `fr returned ${fr.status}`);
}

// ===================================================== summary
console.log('\n════════ summary ════════');
const counts = findings.reduce((acc, f) => ({ ...acc, [f.level]: (acc[f.level] ?? 0) + 1 }), {});
console.log(JSON.stringify(counts));
const bad = findings.filter((f) => f.level === 'FAIL' || f.level === 'WARN');
if (bad.length) {
  console.log('\nNeeds a look:');
  for (const f of bad) console.log(`  ${f.level} [${f.area}] ${f.text}`);
}

const failed = findings.filter((f) => f.level === 'FAIL');
if (failed.length > 0) process.exit(1);
