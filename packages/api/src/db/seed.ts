import { fileURLToPath } from 'node:url';
import { count, eq } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { TranslatedText } from '@inventory/shared';
import { db } from './client';
import {
  actionLines,
  actions,
  analogous,
  concepts,
  itemLinks,
  items,
  locations,
  logEventDefs,
  logEventVersions,
  lotLines,
  lots,
  maintenancePlans,
  occupancies,
  poolRecounts,
  poolUnits,
  pools,
  suppliers,
  types,
  variants,
} from './schema';
import { generateHumanId } from '../services/ids';
import { logEvent } from '../services/history';
import { computeNextDue } from '../services/maintenance';

// Demo data: the app must be demoable in 30 seconds —
// a believable location tree, isopropyl alcohol with two variants and three
// items (one open), one low-stock concept, one zero-stock concept, so Home
// shows every alert state. Runs ONLY on an empty DB.
//
// The demo is a home workshop rather than anything specialised, on purpose:
// glue, sandpaper, screws and a caliper are things almost everybody can
// picture, and somebody deciding whether this app suits them should be
// reading their own shelves, not somebody else's trade.

const uuid = () => crypto.randomUUID();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const daysAhead = (n: number) => new Date(Date.now() + n * 86_400_000);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function tt(en: string, de: string, ca: string): TranslatedText {
  return { en, de, ca };
}

function main() {
  migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
  });

  const existing = db.select({ n: count() }).from(concepts).get();
  if ((existing?.n ?? 0) > 0) {
    console.log('Database is not empty — seed skipped.');
    return;
  }

  db.transaction(() => {
    // ------------------------------------------------------------------ Types
    const supplyType = {
      id: uuid(),
      key: 'supply',
      name: tt('Supply', 'Verbrauchsstoff', 'Producte'),
      humanIdPrefix: 'supply',
      validStatuses: ['in_stock', 'open', 'depleted', 'expired', 'discarded', 'quarantine'],
      tracksQuantity: true,
      fieldDefinitions: [
        { key: 'articleCode', label: tt('Article code', 'Artikelnummer', "Codi d'article"), kind: 'text', required: false, order: 0 },
        { key: 'expiryDate', label: tt('Expiry date', 'Verfallsdatum', 'Data de caducitat'), kind: 'date', required: false, order: 1 },
        { key: 'hazardClass', label: tt('Hazard class', 'Gefahrenklasse', 'Classe de perill'), kind: 'select', required: false, options: ['none', 'flammable', 'corrosive', 'toxic', 'oxidizing'], order: 2 },
      ],
    } as const;

    const consumableType = {
      id: uuid(),
      key: 'consumable',
      name: tt('Consumable', 'Verbrauchsmaterial', 'Consumible'),
      humanIdPrefix: 'consumable',
      validStatuses: ['in_stock', 'open', 'depleted', 'discarded', 'lost'],
      tracksQuantity: true,
      fieldDefinitions: [
        { key: 'material', label: tt('Material', 'Material', 'Material'), kind: 'text', required: false, order: 0 },
      ],
    } as const;

    const toolType = {
      id: uuid(),
      key: 'tool',
      name: tt('Tool', 'Werkzeug', 'Eina'),
      humanIdPrefix: 'tool',
      validStatuses: ['in_service', 'maintenance', 'out_of_service', 'retired'],
      tracksQuantity: false,
      // Not stock: "0 pillar drills" is not a warning.
      countsAsStock: false,
      fieldDefinitions: [
        { key: 'manufacturer', label: tt('Manufacturer', 'Hersteller', 'Fabricant'), kind: 'text', required: false, order: 0 },
        { key: 'nextService', label: tt('Next service', 'Nächste Wartung', 'Propera revisió'), kind: 'date', required: false, order: 1 },
      ],
    } as const;

    const documentType = {
      id: uuid(),
      key: 'document',
      name: tt('Document', 'Dokument', 'Document'),
      humanIdPrefix: 'document',
      validStatuses: ['active', 'superseded', 'archived'],
      tracksQuantity: false,
      countsAsStock: false,
      fieldDefinitions: [
        { key: 'docCode', label: tt('Document code', 'Dokumentcode', 'Codi de document'), kind: 'text', required: true, order: 0 },
        { key: 'revision', label: tt('Revision', 'Revision', 'Revisió'), kind: 'text', required: false, order: 1 },
      ],
    } as const;

    const sparePartType = {
      id: uuid(),
      key: 'sparepart',
      name: tt('Spare part', 'Ersatzteil', 'Recanvi'),
      humanIdPrefix: 'sparepart',
      validStatuses: ['in_stock', 'installed', 'used', 'discarded'],
      tracksQuantity: true,
      fieldDefinitions: [
        { key: 'compatibleWith', label: tt('Compatible with', 'Kompatibel mit', 'Compatible amb'), kind: 'text', required: false, order: 0 },
      ],
    } as const;

    const allTypes = [supplyType, consumableType, toolType, documentType, sparePartType];
    for (const type of allTypes) {
      db.insert(types).values({ ...type, validStatuses: [...type.validStatuses], fieldDefinitions: type.fieldDefinitions.map((f) => ({ ...f, options: 'options' in f && f.options ? [...f.options] : undefined })) }).run();
      logEvent({ entityType: 'type', entityId: type.id, entityHumanId: type.key, action: 'created' });
    }

    // -------------------------------------------------------------- Locations
    function seedLocation(code: string, level: 'site' | 'room' | 'zone' | 'surface', name: TranslatedText | null, parentId: string | null): string {
      const id = uuid();
      db.insert(locations).values({ id, code, level, name, parentId }).run();
      logEvent({ entityType: 'location', entityId: id, entityHumanId: code, action: 'created' });
      return id;
    }

    const workshop = seedLocation('L01', 'site', tt('Workshop', 'Werkstatt', 'Taller'), null);
    const storeroom = seedLocation('L01R01', 'room', tt('Store room', 'Lagerraum', 'Magatzem'), workshop);
    const flammablesCab = seedLocation('L01R01Z01', 'zone', tt('Flammables cupboard', 'Schrank für Brennbares', "Armari d'inflamables"), storeroom);
    const shelfA1 = seedLocation('L01R01Z01S01', 'surface', tt('Shelf A1', 'Regal A1', 'Prestatge A1'), flammablesCab);
    const shelfA2 = seedLocation('L01R01Z01S02', 'surface', tt('Shelf A2', 'Regal A2', 'Prestatge A2'), flammablesCab);
    const generalZone = seedLocation('L01R01Z02', 'zone', tt('General shelving', 'Allgemeine Regale', 'Prestatgeria general'), storeroom);
    const assemblyArea = seedLocation('L01R02', 'room', tt('Assembly area', 'Montagebereich', 'Zona de muntatge'), workshop);
    const bench = seedLocation('L01R02Z01', 'zone', tt('Workbench', 'Werkbank', 'Banc de treball'), assemblyArea);

    // --------------------------------------- Concept → Analogous → Variant(s)
    function seedConcept(name: TranslatedText, unit: string, minStock: number | null): string {
      const id = uuid();
      const humanId = generateHumanId('CON', 'simple');
      db.insert(concepts).values({ id, humanId, name, unit, minStockThreshold: minStock }).run();
      logEvent({ entityType: 'concept', entityId: id, entityHumanId: humanId, action: 'created' });
      return id;
    }

    function seedAnalogous(conceptId: string, name: TranslatedText): string {
      const id = uuid();
      const humanId = generateHumanId('ANA', 'simple');
      db.insert(analogous).values({ id, humanId, conceptId, name }).run();
      logEvent({ entityType: 'analogous', entityId: id, entityHumanId: humanId, action: 'created' });
      return id;
    }

    function seedVariant(input: {
      analogousId: string;
      conceptId: string;
      typeId: string;
      name: TranslatedText;
      brand?: string;
      supplier?: string;
      packSize?: number;
      packUnit?: string;
      purity?: string;
    }): string {
      const id = uuid();
      const humanId = generateHumanId('VAR', 'simple');
      db.insert(variants).values({
        id,
        humanId,
        analogousId: input.analogousId,
        conceptId: input.conceptId,
        typeId: input.typeId,
        name: input.name,
        brand: input.brand ?? null,
        supplier: input.supplier ?? null,
        packSize: input.packSize ?? null,
        packUnit: input.packUnit ?? null,
        purity: input.purity ?? null,
      }).run();
      logEvent({ entityType: 'variant', entityId: id, entityHumanId: humanId, action: 'created' });
      return id;
    }

    function seedItem(input: {
      typeId: string;
      prefix: string;
      variantId: string;
      analogousId: string;
      conceptId: string;
      locationId: string;
      status: 'in_stock' | 'open' | 'depleted';
      quantityInitial: number;
      quantityRemaining: number;
      unit: string;
      priceAmount: number; // minor units!
      receivedDaysAgo: number;
      customFields?: Record<string, unknown>;
      openedDaysAgo?: number;
      depletedDaysAgo?: number;
    }): void {
      const id = uuid();
      const humanId = generateHumanId(input.prefix, 'lettered');
      db.insert(items).values({
        id,
        humanId,
        typeId: input.typeId,
        variantId: input.variantId,
        analogousId: input.analogousId,
        conceptId: input.conceptId,
        locationId: input.locationId,
        status: input.status,
        quantityInitial: input.quantityInitial,
        quantityRemaining: input.quantityRemaining,
        unit: input.unit,
        priceAmount: input.priceAmount,
        priceCurrency: 'EUR',
        priceLocked: true,
        customFields: input.customFields ?? {},
        receivedAt: daysAgo(input.receivedDaysAgo),
        openedAt: input.openedDaysAgo !== undefined ? daysAgo(input.openedDaysAgo) : null,
        depletedAt: input.depletedDaysAgo !== undefined ? daysAgo(input.depletedDaysAgo) : null,
      }).run();
      logEvent({ entityType: 'item', entityId: id, entityHumanId: humanId, action: 'created' });
    }

    // 1) Isopropyl alcohol — healthy stock, two variants, one item open
    const ipa = seedConcept(tt('Isopropyl alcohol 99%', 'Isopropylalkohol 99%', 'Alcohol isopropílic 99%'), 'L', 2);
    const ipaAna = seedAnalogous(ipa, tt('Isopropyl alcohol 99%', 'Isopropylalkohol 99%', 'Alcohol isopropílic 99%'));
    const northlineIpa = seedVariant({
      analogousId: ipaAna, conceptId: ipa, typeId: supplyType.id,
      name: tt('Northline IPA 99%, 1 L', 'Northline IPA 99%, 1 L', 'Northline IPA 99%, 1 L'),
      brand: 'Northline', supplier: 'Northside Hardware', packSize: 1, packUnit: 'L', purity: '99%',
    });
    const corvidIpa = seedVariant({
      analogousId: ipaAna, conceptId: ipa, typeId: supplyType.id,
      name: tt('Corvid IPA 99%, 2.5 L', 'Corvid IPA 99%, 2,5 L', 'Corvid IPA 99%, 2,5 L'),
      brand: 'Corvid', supplier: 'Northside Hardware', packSize: 2.5, packUnit: 'L', purity: '99%',
    });

    const ipaFields = { articleCode: 'IPA-1000', hazardClass: 'flammable' };
    seedItem({
      typeId: supplyType.id, prefix: 'supply', variantId: northlineIpa, analogousId: ipaAna,
      conceptId: ipa, locationId: shelfA1, status: 'in_stock',
      quantityInitial: 1, quantityRemaining: 1, unit: 'L', priceAmount: 890, receivedDaysAgo: 20,
      customFields: { ...ipaFields, expiryDate: isoDate(daysAhead(400)) },
    });
    seedItem({
      typeId: supplyType.id, prefix: 'supply', variantId: northlineIpa, analogousId: ipaAna,
      conceptId: ipa, locationId: shelfA1, status: 'open',
      quantityInitial: 1, quantityRemaining: 0.65, unit: 'L', priceAmount: 890, receivedDaysAgo: 60, openedDaysAgo: 12,
      customFields: { ...ipaFields, expiryDate: isoDate(daysAhead(34)) }, // ⚠ exp badge on Home
    });
    seedItem({
      typeId: supplyType.id, prefix: 'supply', variantId: corvidIpa, analogousId: ipaAna,
      conceptId: ipa, locationId: shelfA2, status: 'in_stock',
      quantityInitial: 2.5, quantityRemaining: 2.5, unit: 'L', priceAmount: 1750, receivedDaysAgo: 10,
      customFields: { ...ipaFields, expiryDate: isoDate(daysAhead(700)) },
    });

    // 2) Sanding discs — LOW stock (2 boxes < min 5)
    const discs = seedConcept(tt('Sanding discs 120 grit', 'Schleifscheiben Korn 120', 'Discs de lija gra 120'), 'box', 5);
    const discsAna = seedAnalogous(discs, tt('Sanding discs 120 grit', 'Schleifscheiben Korn 120', 'Discs de lija gra 120'));
    const discsVar = seedVariant({
      analogousId: discsAna, conceptId: discs, typeId: consumableType.id,
      name: tt('GritPro 125 mm, 120 grit, 50 pcs', 'GritPro 125 mm, Korn 120, 50 Stk', 'GritPro 125 mm, gra 120, 50 u'),
      brand: 'GritPro', packSize: 50, packUnit: 'pcs',
    });
    for (let i = 0; i < 2; i++) {
      seedItem({
        typeId: consumableType.id, prefix: 'consumable', variantId: discsVar, analogousId: discsAna,
        conceptId: discs, locationId: generalZone, status: 'in_stock',
        quantityInitial: 1, quantityRemaining: 1, unit: 'box', priceAmount: 1290, receivedDaysAgo: 30,
        customFields: { material: 'aluminium oxide' },
      });
    }

    // 3) Wood glue — ZERO stock (only a depleted item remains)
    const glue = seedConcept(tt('Wood glue D3', 'Holzleim D3', 'Cola de fusta D3'), 'L', 1);
    const glueAna = seedAnalogous(glue, tt('Wood glue D3', 'Holzleim D3', 'Cola de fusta D3'));
    const glueVar = seedVariant({
      analogousId: glueAna, conceptId: glue, typeId: supplyType.id,
      name: tt('Bondwell D3, 750 mL', 'Bondwell D3, 750 mL', 'Bondwell D3, 750 mL'),
      brand: 'Bondwell', supplier: 'Northside Hardware', packSize: 0.75, packUnit: 'L',
    });
    seedItem({
      typeId: supplyType.id, prefix: 'supply', variantId: glueVar, analogousId: glueAna,
      conceptId: glue, locationId: shelfA2, status: 'depleted',
      quantityInitial: 0.75, quantityRemaining: 0, unit: 'L', priceAmount: 640, receivedDaysAgo: 90,
      openedDaysAgo: 45, depletedDaysAgo: 3,
      customFields: { articleCode: 'GLU-750', hazardClass: 'none' },
    });

    // 4) An instrument and a document: types whose lifecycle is nothing like
    //    in_stock → open → depleted, so the status dropdown has something to
    //    show and the demo covers non-consumable inventory.
    const caliper = seedConcept(tt('Digital caliper', 'Digitaler Messschieber', 'Peu de rei digital'), 'unit', null);
    const caliperAna = seedAnalogous(caliper, tt('Digital caliper', 'Digitaler Messschieber', 'Peu de rei digital'));
    const caliperVar = seedVariant({
      analogousId: caliperAna, conceptId: caliper, typeId: toolType.id,
      name: tt('Precisio DC-150', 'Precisio DC-150', 'Precisio DC-150'),
      brand: 'Precisio', supplier: 'Northside Hardware',
    });
    const caliperId = uuid();
    const caliperHumanId = generateHumanId('tool', 'lettered');
    db.insert(items).values({
      id: caliperId, humanId: caliperHumanId, typeId: toolType.id, variantId: caliperVar,
      analogousId: caliperAna, conceptId: caliper, locationId: bench,
      status: 'in_service', priceAmount: 3990, priceCurrency: 'EUR', priceLocked: true,
      serialNumber: 'DC150-0293471',
      customFields: { manufacturer: 'Precisio', nextService: isoDate(daysAhead(60)) },
      receivedAt: daysAgo(400),
    }).run();
    logEvent({ entityType: 'item', entityId: caliperId, entityHumanId: caliperHumanId, action: 'created' });

    const manual = seedConcept(tt('Caliper instructions', 'Messschieber-Anleitung', 'Instruccions del peu de rei'), 'unit', null);
    const manualAna = seedAnalogous(manual, tt('Caliper instructions', 'Messschieber-Anleitung', 'Instruccions del peu de rei'));
    const manualVar = seedVariant({
      analogousId: manualAna, conceptId: manual, typeId: documentType.id,
      name: tt('DC-150 manual rev. 3', 'DC-150 Anleitung Rev. 3', 'DC-150 manual rev. 3'),
    });
    const manualId = uuid();
    const manualHumanId = generateHumanId('document', 'lettered');
    db.insert(items).values({
      id: manualId, humanId: manualHumanId, typeId: documentType.id, variantId: manualVar,
      analogousId: manualAna, conceptId: manual, locationId: assemblyArea,
      status: 'active', customFields: { docCode: 'DC150-MAN', revision: '3' },
      receivedAt: daysAgo(120),
    }).run();
    logEvent({ entityType: 'item', entityId: manualId, entityHumanId: manualHumanId, action: 'created' });

    // The manual belongs WITH the caliper. Filed by the bench,
    // findable from the tool it describes — which is where anybody actually
    // looks for it, rather than in a drawer of loose paper.
    db.insert(itemLinks).values({
      id: uuid(), parentItemId: caliperId, childItemId: manualId,
      relation: 'document', notes: 'Measuring and zeroing',
    }).run();

    // Two plans on one tool, on purpose: a caliper ages by the calendar for
    // its yearly check against gauge blocks and by use for the quick zero
    // check, and "whichever comes first" is only visible when both are
    // running.
    const calibrationDone = daysAgo(300);
    db.insert(maintenancePlans).values({
      id: uuid(), itemId: caliperId,
      name: tt('Check against gauge blocks', 'Prüfung mit Endmaßen', 'Comprovació amb galgues'),
      kind: 'calibration', everyDays: 365, everyUses: null,
      lastDoneAt: calibrationDone,
      nextDueAt: computeNextDue({ everyDays: 365, lastDoneAt: calibrationDone }),
      notes: 'Result noted on the back of the manual',
    }).run();
    db.insert(maintenancePlans).values({
      id: uuid(), itemId: caliperId,
      name: tt('Zero check', 'Nullpunktprüfung', 'Comprovació del zero'),
      kind: 'inspection', everyDays: null, everyUses: 500,
      usesSinceLast: 460, lastDoneAt: null, nextDueAt: null,
    }).run();

    // 5) Machine oil — healthy, no threshold
    const oil = seedConcept(tt('Machine oil', 'Maschinenöl', "Oli de màquina"), 'L', null);
    const oilAna = seedAnalogous(oil, tt('Machine oil', 'Maschinenöl', "Oli de màquina"));
    const oilVar = seedVariant({
      analogousId: oilAna, conceptId: oil, typeId: supplyType.id,
      name: tt('Ferro light oil, 500 mL', 'Ferro Feinöl, 500 mL', 'Ferro oli fi, 500 mL'),
      brand: 'Ferro', packSize: 0.5, packUnit: 'L',
    });
    seedItem({
      typeId: supplyType.id, prefix: 'supply', variantId: oilVar, analogousId: oilAna,
      conceptId: oil, locationId: bench, status: 'in_stock',
      quantityInitial: 0.5, quantityRemaining: 0.5, unit: 'L', priceAmount: 550, receivedDaysAgo: 5,
      customFields: { expiryDate: isoDate(daysAhead(365)) },
    });

    // ==================================================================
    // demo data. Enough of each feature that the whole operational
    // half is visible without anyone having to invent data first.
    // ==================================================================

    // -- Tracking levels. One workshop runs all three at once:
    //    alcohol on the estimated rate, sanding discs on activities,
    //    everything else counted by hand.
    db.update(concepts)
      .set({ trackingLevel: 2, seededMonthlyRate: 1.5 })
      .where(eq(concepts.id, ipa))
      .run();
    db.update(concepts)
      .set({ trackingLevel: 3, seededMonthlyRate: 800 })
      .where(eq(concepts.id, discs))
      .run();

    // -- An activity with a consumption map, in force from three months back
    //    so the dated versioning has something to sit on.
    const prepId = uuid();
    const prepHumanId = generateHumanId('ACT', 'simple');
    db.insert(actions)
      .values({
        id: prepId,
        humanId: prepHumanId,
        name: tt('Sand and degrease a panel', 'Platte schleifen und entfetten', "Polir i desgreixar un plafó"),
      })
      .run();
    db.insert(actionLines)
      .values([
        {
          id: uuid(), actionId: prepId, conceptId: discs,
          quantity: 0.01, validFrom: daysAgo(90),
        },
        {
          id: uuid(), actionId: prepId, conceptId: ipa,
          quantity: 0.02, validFrom: daysAgo(90),
        },
      ])
      .run();
    logEvent({ entityType: 'action', entityId: prepId, entityHumanId: prepHumanId, action: 'created' });

    // -- Reusable pools. The mixing cups are the case that made this a
    //    distinct kind of object: pooled, because nobody numbers a cup.
    //
    //    The pool is linked to a Concept, and that Concept has unopened boxes
    //    in the cupboard: cups are bought and forecast like anything else,
    //    and commissioning is the move from stock into rotation.
    const cups = seedConcept(
      tt('Mixing cups 200 mL', 'Mischbecher 200 mL', 'Gots de barreja 200 mL'),
      'unit',
      100,
    );
    const cupsAna = seedAnalogous(cups, tt('200 mL cup', '200-mL-Becher', 'Got de 200 mL'));
    const cupVariant = seedVariant({
      analogousId: cupsAna, conceptId: cups, typeId: consumableType.id,
      name: tt('ClearMix 200 mL, box of 250', 'ClearMix 200 mL, 250er', 'ClearMix 200 mL, caixa de 250'),
      brand: 'ClearMix', supplier: 'Northside Hardware', packSize: 250, packUnit: 'unit',
    });
    // Two unopened boxes: the cupboard the pool refills from.
    for (const days of [45, 12]) {
      seedItem({
        typeId: consumableType.id, prefix: consumableType.humanIdPrefix,
        variantId: cupVariant, analogousId: cupsAna,
        conceptId: cups, locationId: generalZone, status: 'in_stock',
        quantityInitial: 250, quantityRemaining: 250, unit: 'unit',
        priceAmount: 18_900, receivedDaysAgo: days,
      });
    }

    const cupPoolId = uuid();
    const cupHumanId = generateHumanId('POO', 'simple');
    db.insert(pools)
      .values({
        id: cupPoolId,
        humanId: cupHumanId,
        name: tt('Mixing cups', 'Mischbecher', 'Gots de barreja'),
        granularity: 'pooled',
        conceptId: cups,
        available: 248,
        inUse: 36,
        dirty: 16,
        addressable: false,
      })
      .run();
    logEvent({ entityType: 'pool', entityId: cupPoolId, entityHumanId: cupHumanId, action: 'created' });

    // Two recounts, so attrition is already measurable rather than "come back
    // in a month" — the difference IS the breakage rate.
    db.insert(poolRecounts)
      .values([
        { id: uuid(), poolId: cupPoolId, expected: 300, counted: 300, attrition: 0, note: 'baseline', createdAt: daysAgo(60) },
        { id: uuid(), poolId: cupPoolId, expected: 260, counted: 248, attrition: 12, createdAt: daysAgo(2) },
      ])
      .run();

    // Trays: the same kind of thing, but identified, because a tray has a number.
    const trayPoolId = uuid();
    const trayHumanId = generateHumanId('POO', 'simple');
    db.insert(pools)
      .values({
        id: trayPoolId,
        humanId: trayHumanId,
        name: tt('Sorting trays', 'Sortierschalen', "Safates de classificació"),
        granularity: 'identified',
        addressable: true,
        slotsPerUnit: 40,
      })
      .run();
    const trayIds = ['1', '2', '3'].map((code) => {
      const id = uuid();
      db.insert(poolUnits)
        .values({ id, poolId: trayPoolId, code, state: code === '3' ? 'in_use' : 'available', locationId: shelfA2 })
        .run();
      return { id, code };
    });
    logEvent({ entityType: 'pool', entityId: trayPoolId, entityHumanId: trayHumanId, action: 'created' });

    // A batch of parts sitting in tray 3, compartment 1. The batch has no
    // location of its own — this row IS its whereabouts.
    db.insert(occupancies)
      .values({
        id: uuid(),
        unitId: trayIds[2]!.id,
        position: '1',
        sampleTag: 'KIT-21099-2621703602',
        openedAt: daysAgo(1),
      })
      .run();

    // -- One received lot, so price history and supplier lead time exist from
    //    the first minute instead of after the first purchase.
    const lotId = uuid();
    const lotHumanId = generateHumanId('LOT', 'simple');
    const supplierId = uuid();
    db.insert(suppliers)
      .values({ id: supplierId, humanId: generateHumanId('SUP', 'simple'), name: 'Northside Hardware' })
      .run();
    db.insert(lots)
      .values({
        id: lotId,
        humanId: lotHumanId,
        supplierId,
        reference: 'PO-2026-0114',
        status: 'received',
        orderedAt: daysAgo(38),
        receivedAt: daysAgo(27),
      })
      .run();
    db.insert(lotLines)
      .values({
        id: uuid(),
        lotId,
        conceptId: ipa,
        orderedVariantId: northlineIpa,
        orderedQuantity: 2,
        unitPriceAmount: 830,
        priceCurrency: 'EUR',
        receivedVariantId: northlineIpa,
        receivedQuantity: 2,
        status: 'received',
        locationId: shelfA1,
      })
      .run();
    logEvent({ entityType: 'lot', entityId: lotId, entityHumanId: lotHumanId, action: 'received' });

    // -- The log dictionary, pre-loaded with the event from PLAN so
    //    the feature can be tried by pasting one line. It starts in SHADOW:
    //    a new rule records what it would do, and a human enables it.
    const eventId = uuid();
    db.insert(logEventDefs)
      .values({
        id: eventId,
        name: 'RegistreFeinaK',
        description: 'A job was logged: one mixing cup goes into circulation',
        shadow: true,
      })
      .run();
    db.insert(logEventVersions)
      .values({
        id: uuid(),
        eventId,
        validFrom: new Date(0), // covers historical replay from the beginning
        effects: [{ kind: 'pool_take', poolId: cupPoolId, quantity: 1 }],
      })
      .run();
  });

  // Counted, not typed: a hand-written summary drifts the first time anyone
  // adds a row above it, and then reports numbers that were never true.
  const tally = (table: SQLiteTable) => db.select({ n: count() }).from(table).get()?.n ?? 0;
  console.log(
    `Seed complete: ${tally(types)} types, ${tally(locations)} locations, ` +
      `${tally(concepts)} concepts, ${tally(analogous)} analogous, ${tally(variants)} variants, ` +
      `${tally(items)} items, ${tally(actions)} activities, ` +
      `${tally(pools)} pools (${tally(poolUnits)} units), ${tally(lots)} lot, ` +
      `${tally(logEventDefs)} log event.`,
  );
}

main();
