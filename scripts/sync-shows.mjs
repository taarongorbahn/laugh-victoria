// Sync shows from Airtable into data/shows.json, keeping the API call count low
// enough for Airtable's free plan (1,000 calls per workspace per month).
//
// How it saves calls:
//   - A normal run only asks Airtable for Active shows plus records changed in the
//     last few days. That is one API call as long as there are fewer than 100.
//   - Archived shows are kept in the repo, so the archive isn't re-read every run.
//     The Status field in Airtable decides what is current and what is archived;
//     this script never archives anything on its own.
//   - Show graphics are downloaded into assets/shows/ once, because Airtable image
//     links expire after a few hours.
//
// A "full" run (FULL_SYNC=true, or the first run after this script ships) reads
// every record once to download graphics for the archive. It costs about one call
// per 100 records.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE = 'app3CJU1iVnaJcQZL';
const TABLE = 'Shows';
const DATA_FILE = 'data/shows.json';
const IMAGE_DIR = 'assets/shows';
const IMAGE_URL_PREFIX = '/assets/shows';
const RECENT_DAYS = 3; // covers a missed run or two
const SYNC_VERSION = 2;

if (!TOKEN) {
  console.error('AIRTABLE_TOKEN is not set');
  process.exit(1);
}

let apiCalls = 0;

// ---------- Airtable ----------

async function airtableGet(params) {
  const url = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(TABLE)}?${params}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    apiCalls++;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (res.status === 429 && attempt === 1) {
      console.warn('Airtable rate limit hit, waiting 30s before one retry');
      await new Promise(r => setTimeout(r, 30_000));
      continue;
    }
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(`Airtable ${res.status}: ${JSON.stringify(body.error || body)}`);
    return body;
  }
}

// Normal runs ask for Active shows plus anything changed in the last RECENT_DAYS days.
// "Changed recently" is how the script sees a show you just flipped to Archived, or an
// archived show you just edited, without re-reading the whole archive.
const RECENT_FORMULA =
  `OR({Status}='Active', {Status}=BLANK(), ` +
  `IS_AFTER(LAST_MODIFIED_TIME(), DATEADD(NOW(), -${RECENT_DAYS}, 'days')))`;

async function fetchRecords({ recentOnly }) {
  let records = [];
  let offset = '';
  do {
    const params = new URLSearchParams({ 'sort[0][field]': 'Date', 'sort[0][direction]': 'asc' });
    if (recentOnly) params.set('filterByFormula', RECENT_FORMULA);
    if (offset) params.set('offset', offset);
    const page = await airtableGet(params);
    records = records.concat(page.records || []);
    offset = page.offset || '';
  } while (offset);
  return records;
}

// ---------- Helpers ----------

const statusOf = r => (r.fields?.Status || '').toLowerCase();
const dateOf = r => (r.fields?.Date ? new Date(r.fields.Date) : null);
const byDateAsc = (a, b) => (dateOf(a)?.getTime() ?? 0) - (dateOf(b)?.getTime() ?? 0);

function loadPrevious() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { current: [], archived: [] };
  }
}

// ---------- Images ----------

function localImageName(att) {
  return `${att.id}.jpg`;
}

async function localizeGraphics(record) {
  const graphics = record.fields?.['Show Graphic'];
  if (!Array.isArray(graphics)) return record;

  const localized = [];
  for (const att of graphics) {
    const file = path.join(IMAGE_DIR, localImageName(att));
    const localUrl = `${IMAGE_URL_PREFIX}/${localImageName(att)}`;

    if (!fs.existsSync(file)) {
      if (!att.url || att.url.startsWith('/')) {
        localized.push(att);
        continue;
      }
      try {
        const res = await fetch(att.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const input = Buffer.from(await res.arrayBuffer());
        await sharp(input)
          .rotate()
          .resize({ width: 1080, withoutEnlargement: true })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: 78, mozjpeg: true })
          .toFile(file);
      } catch (e) {
        console.warn(`Could not save graphic for "${record.fields?.Show}" (${att.id}): ${e.message}`);
        localized.push(att); // keep the Airtable link rather than dropping the graphic
        continue;
      }
    }

    const { thumbnails, ...rest } = att;
    localized.push({
      ...rest,
      url: localUrl,
      type: 'image/jpeg',
      thumbnails: {
        small: { url: localUrl },
        large: { url: localUrl },
        full: { url: localUrl },
      },
    });
  }
  return { ...record, fields: { ...record.fields, 'Show Graphic': localized } };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- Main ----------

async function main() {
  const prev = loadPrevious();
  const full = process.env.FULL_SYNC === 'true' || prev.syncVersion !== SYNC_VERSION;
  console.log(full ? 'Full sync: reading every record once' : 'Normal sync: reading active and recently changed shows');

  const fetched = await fetchRecords({ recentOnly: !full });

  // The Status field in Airtable decides everything. The script never archives a show itself.
  // Archived shows already in the repo stay there, so deleting old records from Airtable
  // doesn't remove them from the site.
  const archived = new Map((prev.archived || []).map(r => [r.id, r]));
  const current = new Map();

  for (const r of fetched) {
    const status = statusOf(r);
    if (status === 'active' || status === '') {
      current.set(r.id, r);
      archived.delete(r.id); // flipped back from Archived to Active
    } else if (status === 'archived') {
      archived.set(r.id, r);
    }
    // Pending and any other status stay off the site.
  }
  // A show that was Active last run and didn't come back at all was deleted, or set to
  // Pending, more than RECENT_DAYS ago. It simply isn't in `current` any more.

  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  const currentList = await mapLimit([...current.values()].sort(byDateAsc), 6, localizeGraphics);
  const archivedList = await mapLimit([...archived.values()].sort(byDateAsc), 6, localizeGraphics);

  const output = {
    fetchedAt: new Date().toISOString(),
    syncVersion: SYNC_VERSION,
    current: currentList,
    archived: archivedList,
  };

  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
  console.log(`Wrote ${currentList.length} current and ${archivedList.length} archived shows using ${apiCalls} Airtable API call(s).`);
  if (!full && fetched.length >= 100) {
    console.warn('100+ active shows: each run now costs more than one call. Consider archiving or a longer sync interval.');
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
