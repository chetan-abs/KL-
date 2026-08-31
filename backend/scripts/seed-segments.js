#!/usr/bin/env node
/**
 * The twenty incentive segments, and the mapping from items to them.
 *
 *   npm run seed-segments               # create/update segments, map items
 *   npm run seed-segments -- --report   # show the mapping, change nothing
 *
 * Section 9 of the requirements lists twenty segments with a monthly target
 * and a base incentive. It does not say which items belong to which — that is
 * knowledge the business has and the document assumes. The matchers below are
 * built from the 141 brand names actually present in the rate sheet, and every
 * item that matches nothing falls to "Others", which is a real segment with
 * its own target rather than a hole.
 *
 * The mapping is a business judgement, not a fact in the file. Run with
 * --report and check the counts against what the segment is meant to cover
 * before the first incentive month is approved.
 */

const pool = require('../config/db');

/**
 * A matcher is a brand name, or `brand::substring` to narrow within a brand.
 *
 * Matching is case-insensitive. Segments are applied in `seq` order and the
 * first match wins, so a narrowed segment must sit before the broad one it
 * carves out of — "Legrand MCB / Box" before "Legrand Modular", or every
 * Legrand MCB would land in the modular segment.
 */
const SEGMENTS = [
  // --- narrowed segments first ------------------------------------------
  { name: 'KEI Wire 90 meter',   target: 300000, base: 1000, brands: ['KEI::90'] },
  { name: 'KEI Wire 300 meter',  target: 500000, base: 1500, brands: ['KEI::300'] },
  { name: 'Legrand MCB / Box',   target: 200000, base: 1500, brands: ['Legrand::MCB', 'Legrand::Box', 'Legrand Black::MCB', 'Legrand Black::Box'] },
  { name: 'Anchor MCB',          target: 200000, base: 1200, brands: ['ANCHOR UNO Mcb & Switchgear'] },
  { name: 'Polycab MCB / Box',   target: 200000, base: 1000, brands: ['Polycab MCBS & BOXES', 'Polycab Metal & Pvc Boxes'] },
  { name: 'Polycab LED',         target: 150000, base:  600, brands: ['POLYCAB LED'] },
  { name: 'Polycab Etira Wire',  target: 300000, base: 2200, brands: ['Polycab Wire', 'Polycab::Etira'] },

  // --- wires --------------------------------------------------------------
  { name: 'Orient Wire',         target: 300000, base: 2500, brands: ['Orient Wire'] },
  { name: 'Maru Wire',           target: 150000, base: 2000, brands: ['Maru Wire'] },

  // --- modular ------------------------------------------------------------
  {
    name: 'Anchor Modular', target: 500000, base: 3500,
    brands: [
      'Anchor Penta Modular', 'Anchor Penta Modular BLACK', 'Anchor Penta Ivory/white',
      'Anchor Pc Penta Accessories', 'Anchor Roma', 'Anchor Roma Allure',
      'Anchor Roma Urban White', 'Anchor Roma Urban BLACK', 'Anchor Ziva',
      'Anchor Smart', 'Anchor Rider',
    ],
  },
  { name: 'Wendorflex / ATC',    target: 300000, base: 4500, brands: ['Wendor', 'ATC Wires&Cebals', 'Atc Led'] },
  { name: 'Legrand Modular',     target: 300000, base: 3000, brands: ['Legrand', 'Legrand Black'] },

  // --- fans ---------------------------------------------------------------
  {
    name: 'Crompton Fans', target: 300000, base: 1500,
    brands: ['Crompton Fan', 'Crompton Greaves', 'Crompton Local', 'Crompton Appliances',
      'Crompton Greaves - Unmapped Items'],
  },
  { name: 'CG Power Fans',       target: 300000, base: 2250, brands: ['CG Power Fans'] },
  { name: 'Ezzair / Blu Fans',   target: 150000, base:  500, brands: ['Blu Fan'] },

  // --- the rest -----------------------------------------------------------
  { name: 'Precision Casing',    target: 4000,   base: 1000, brands: ['Precision'], kind: 'qty' },
  { name: 'Havells MCB / SP',    target: 200000, base: 1200, brands: ['Havells'] },
  { name: 'Berlia Pipes',        target: 200000, base:  800, brands: ['Berlia'] },
  {
    name: 'Maru Accessories', target: 200000, base: 800,
    brands: ['Maru', 'Maru Ancilaries', 'Maru Miracle', 'Maru Magnum', 'Maru Montero',
      'Maru Neo Rainbow Plus', 'Maru Neo Speed', 'Maru Snow', 'Maru Fancy/Cherry', 'Maru Led'],
  },
  { name: 'Others', target: 200000, base: 700, brands: [], catchAll: true },
];

/**
 * "Their wire-related targets are set at double those of field salesmen."
 * The showroom pool's target on these five doubles; everything else is shared
 * at the same figure.
 */
const SHOWROOM_DOUBLED = new Set([
  'KEI Wire 90 meter', 'KEI Wire 300 meter', 'Polycab Etira Wire',
  'Orient Wire', 'Maru Wire',
]);

function parseMatcher(m) {
  const [brand, name] = m.split('::');
  return { brand: brand.toLowerCase(), name: name ? name.toLowerCase() : null };
}

async function main() {
  const report = process.argv.includes('--report');
  const conn = await pool.getConnection();

  try {
    if (!report) {
      await conn.beginTransaction();
      for (const [i, s] of SEGMENTS.entries()) {
        await conn.query(
          `INSERT INTO incentive_segments
             (name, seq, target_kind, monthly_target, base_incentive,
              showroom_multiplier, match_brands, is_catch_all)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             seq = VALUES(seq), target_kind = VALUES(target_kind),
             monthly_target = VALUES(monthly_target), base_incentive = VALUES(base_incentive),
             showroom_multiplier = VALUES(showroom_multiplier),
             match_brands = VALUES(match_brands), is_catch_all = VALUES(is_catch_all)`,
          [s.name, i + 1, s.kind === 'qty' ? 'qty' : 'value', s.target, s.base,
            SHOWROOM_DOUBLED.has(s.name) ? 2 : 1,
            JSON.stringify(s.brands), s.catchAll ? 1 : 0],
        );
      }
      await conn.commit();
      console.log(`[SEGMENTS] ${SEGMENTS.length} segments written.`);
    }

    // ---- map items ------------------------------------------------------
    const [segRows] = await conn.query(
      'SELECT id, name, seq, match_brands, is_catch_all FROM incentive_segments ORDER BY seq',
    );
    const catchAll = segRows.find((s) => s.is_catch_all);
    const matchers = segRows
      .filter((s) => !s.is_catch_all)
      .map((s) => ({
        id: s.id,
        name: s.name,
        rules: (typeof s.match_brands === 'string' ? JSON.parse(s.match_brands) : s.match_brands || [])
          .map(parseMatcher),
      }));

    const [items] = await conn.query('SELECT masterid, name, brand FROM items');
    const counts = new Map(segRows.map((s) => [s.id, 0]));
    const updates = new Map();

    for (const item of items) {
      const brand = (item.brand || '').toLowerCase();
      const name = (item.name || '').toLowerCase();
      let hit = null;
      for (const seg of matchers) {
        if (seg.rules.some((r) => r.brand === brand && (!r.name || name.includes(r.name)))) {
          hit = seg.id;
          break;
        }
      }
      const target = hit || catchAll?.id || null;
      counts.set(target, (counts.get(target) || 0) + 1);
      if (target) updates.set(item.masterid, target);
    }

    if (!report) {
      await conn.beginTransaction();
      // Grouped by segment so the whole map is a handful of statements rather
      // than one per item across 8,900 rows.
      const bySeg = new Map();
      for (const [itemId, segId] of updates) {
        if (!bySeg.has(segId)) bySeg.set(segId, []);
        bySeg.get(segId).push(itemId);
      }
      for (const [segId, ids] of bySeg) {
        for (let i = 0; i < ids.length; i += 500) {
          const chunk = ids.slice(i, i + 500);
          await conn.query(
            `UPDATE items SET incentive_segment_id = ? WHERE masterid IN (${chunk.map(() => '?').join(',')})`,
            [segId, ...chunk],
          );
        }
      }
      await conn.commit();
    }

    console.log(`\n[SEGMENTS] item mapping over ${items.length} items:\n`);
    for (const s of segRows) {
      const n = counts.get(s.id) || 0;
      console.log(`  ${String(s.seq).padStart(2)}. ${s.name.padEnd(22)} ${String(n).padStart(5)} items${s.is_catch_all ? '   (catch-all)' : ''}`);
    }
    if (report) console.log('\n  (report only — nothing written)');
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[SEGMENTS] failed:', err.message);
  process.exit(1);
});
