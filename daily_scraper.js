import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs/promises';
import path from 'path';
import { isSupabaseReady, getKnownEvents, upsertEvent } from './supabase.js';

// Enable stealth evasion
chromium.use(stealthPlugin());

// --- CONFIGURATION ---
const TARGET_CITY_URL = process.env.SCRAPE_URL || 'https://allevents.in/new-delhi/all';
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve('./data');
const DATA_FILE = path.join(DATA_DIR, 'events.json');
const USER_DATA_DIR = path.join(DATA_DIR, 'user_data');
const MAX_LISTING_PAGES = parseInt(process.env.MAX_PAGES || '1', 10);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function loadExistingEvents() {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return [];
  }
}

function extractClevertapDetails(html) {
  const result = {
    event_id: null,
    organizer_id: null,
    external_ticket_url: null,
    currency: null,
    event_status: null,
    city: null,
    region: null,
    country: null,
    categories: [],
    tags: []
  };

  const baseMatch = html.match(/var\s+clevertap_obj\s*=\s*(\{[\s\S]*?\});/);
  if (baseMatch) {
    try {
      const sanitized = baseMatch[1]
        .replace(/,\s*}/g, '}')
        .replace(/clevertap_eventname/g, '""');
      const baseObj = JSON.parse(sanitized);
      Object.assign(result, baseObj);
    } catch (e) {}
  }

  const ticketMatch = html.match(/clevertap_obj\['external_ticket_url'\]\s*=\s*"([^"]+)";/);
  if (ticketMatch) {
    result.external_ticket_url = ticketMatch[1].replace(/\\/g, '');
  }

  const tagsMatches = [...html.matchAll(/clevertap_obj\['category_tag_combined'\]\s*=\s*"([^"]+)";/g)];
  if (tagsMatches.length > 0) {
    result.categories = tagsMatches[tagsMatches.length - 1][1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const lookupMatch = html.match(/act_track_event\['merged_lookup'\]\s*=\s*(\[[^\]]*\]);/);
  if (lookupMatch) {
    try {
      result.tags = JSON.parse(lookupMatch[1]);
    } catch (e) {}
  }

  return result;
}

function extractSchemaEvent(html) {
  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const s of scripts) {
    try {
      const data = JSON.parse(s[1].trim());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] === 'Event') {
          const offers = Array.isArray(item.offers)
            ? item.offers
                .filter((o) => o['@type'] === 'Offer')
                .map((o) => ({
                  name: o.name || null,
                  price: o.price || null,
                  currency: o.priceCurrency || null,
                  availability: o.availability ? o.availability.replace('http://schema.org/', '') : null
                }))
            : [];

          return {
            name: item.name || null,
            startDate: item.startDate || null,
            endDate: item.endDate || null,
            description: item.description || null,
            image: item.image || null,
            venue: item.location?.name || null,
            address: item.location?.address?.streetAddress || null,
            city: item.location?.address?.addressLocality || null,
            coordinates: item.location?.geo
              ? {
                  latitude: item.location.geo.latitude,
                  longitude: item.location.geo.longitude
                }
              : null,
            offers
          };
        }
      }
    } catch (e) {}
  }
  return {};
}

async function waitForCloudflare(page) {
  for (let i = 0; i < 15; i++) {
    const title = await page.title();
    if (title && !title.includes('Just a moment')) {
      return true;
    }
    await sleep(1000);
  }
  return false;
}

export async function runDailyScraper() {
  console.log('='.repeat(65));
  console.log(` DAILY INCREMENTAL SCRAPER - ${new Date().toISOString()}`);
  console.log(` Target: ${TARGET_CITY_URL}`);
  console.log('='.repeat(65));

  await ensureDataDir();
  const localEvents = await loadExistingEvents();

  // Check Supabase connection
  const supabaseOnline = await isSupabaseReady();
  let knownUrls = new Set(localEvents.map((e) => e.url).filter(Boolean));
  let knownIds = new Set(localEvents.map((e) => e.event_id).filter(Boolean));

  if (supabaseOnline) {
    console.log('🟢 Supabase connected! Fetching known events from PostgreSQL...');
    const supaEvents = await getKnownEvents();
    supaEvents.knownIds.forEach((id) => knownIds.add(id));
    supaEvents.knownUrls.forEach((u) => knownUrls.add(u));
    console.log(`   Supabase has ${supaEvents.knownIds.size} existing events stored.`);
  } else {
    console.log('🟡 Supabase table not detected yet. Falling back to local data file.');
    console.log(`   Local storage has ${localEvents.length} events stored.`);
  }

  const isHeadless = process.env.HEADLESS !== 'false';
  console.log(`🌐 Launching browser (headless: ${isHeadless})...`);

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: isHeadless,
    viewport: { width: 1280, height: 720 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const page = context.pages()[0] || (await context.newPage());

  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    const url = route.request().url();
    if (
      ['image', 'media', 'font'].includes(type) ||
      url.includes('google-analytics') ||
      url.includes('doubleclick') ||
      url.includes('facebook')
    ) {
      return route.abort();
    }
    return route.continue();
  });

  const discoveredEvents = [];

  // --- STEP 1: Check listing pages ---
  for (let pageNum = 1; pageNum <= MAX_LISTING_PAGES; pageNum++) {
    const url = pageNum === 1 ? TARGET_CITY_URL : `${TARGET_CITY_URL}?page=${pageNum}`;
    console.log(`\n🔍 Checking listing [Page ${pageNum}]: ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    const passed = await waitForCloudflare(page);
    if (!passed) {
      console.warn('⚠️ Cloudflare verification took longer than expected.');
    }

    await sleep(2000);

    const eventsOnPage = await page.evaluate(() => {
      const results = [];
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        try {
          const data = JSON.parse(s.textContent || '{}');
          const list = Array.isArray(data) ? data : [data];
          for (const item of list) {
            if (item['@type'] === 'Event' && item.url) {
              results.push({
                name: item.name || '',
                url: item.url,
                startDate: item.startDate || ''
              });
            }
          }
        } catch (e) {}
      }
      return results;
    });

    console.log(`   Found ${eventsOnPage.length} events listed on page ${pageNum}.`);
    discoveredEvents.push(...eventsOnPage);
  }

  // --- STEP 2: Filter for NEW events only ---
  const newEventsToScrape = [];
  const seenInRun = new Set();

  for (const ev of discoveredEvents) {
    if (!ev.url || seenInRun.has(ev.url)) continue;
    seenInRun.add(ev.url);

    const urlIdMatch = ev.url.match(/\/(\d{10,20})$/);
    const potentialId = urlIdMatch ? urlIdMatch[1] : null;

    const isAlreadyKnown =
      knownUrls.has(ev.url) ||
      (potentialId && knownIds.has(potentialId));

    if (isAlreadyKnown) {
      continue;
    }

    newEventsToScrape.push(ev);
  }

  // --- STEP 3: Handle results ---
  if (newEventsToScrape.length === 0) {
    console.log('\n✅ NO NEW EVENTS FOUND TODAY!');
    console.log('⚡ All listed events are already in database.');
    console.log('⏭️  Skipped all detail page requests. Done in seconds!\n');
    await context.close();
    return {
      status: 'up_to_date',
      new_events_added: 0,
      total_events: knownIds.size,
      timestamp: new Date().toISOString()
    };
  }

  console.log(`\n✨ Found ${newEventsToScrape.length} BRAND NEW event(s)!`);
  console.log('🚀 Visiting only new events to extract ticket links & categories...\n');

  let addedCount = 0;
  for (const item of newEventsToScrape) {
    addedCount++;
    console.log(`[${addedCount}/${newEventsToScrape.length}] Fetching: "${item.name}"`);

    try {
      await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await sleep(1500);

      const html = await page.content();
      const schemaData = extractSchemaEvent(html);
      const clevertapData = extractClevertapDetails(html);

      const fullRecord = {
        name: schemaData.name || item.name,
        url: item.url,
        event_id: clevertapData.event_id || (item.url.match(/\/(\d{10,20})$/)?.[1] || null),
        organizer_id: clevertapData.organizer_id,
        external_ticket_url: clevertapData.external_ticket_url, // direct booking link
        startDate: schemaData.startDate || item.startDate,
        endDate: schemaData.endDate,
        currency: clevertapData.currency,
        event_status: clevertapData.event_status,
        city: clevertapData.city || schemaData.city,
        region: clevertapData.region,
        country: clevertapData.country,
        categories: clevertapData.categories,
        tags: clevertapData.tags,
        venue: schemaData.venue,
        address: schemaData.address,
        coordinates: schemaData.coordinates,
        ticket_offers: schemaData.offers,
        first_discovered_at: new Date().toISOString()
      };

      // 1. Save to Supabase (if ready)
      if (supabaseOnline) {
        await upsertEvent(fullRecord);
      }

      // 2. Save to local data backup
      localEvents.push(fullRecord);
      await fs.writeFile(DATA_FILE, JSON.stringify(localEvents, null, 2), 'utf8');

      knownUrls.add(item.url);
      if (fullRecord.event_id) knownIds.add(fullRecord.event_id);

      console.log(`   ✔️ Saved! External ticket: ${fullRecord.external_ticket_url || 'None (In-app ticket)'}`);

      const delay = Math.floor(Math.random() * 1500) + 2000;
      await sleep(delay);
    } catch (err) {
      console.warn(`   ⚠️ Warning: Failed for ${item.url}: ${err.message}`);
    }
  }

  await context.close();
  console.log(`\n🎉 Completed! Added ${addedCount} new event(s). Total in database: ${knownIds.size}\n`);

  return {
    status: 'success',
    new_events_added: addedCount,
    total_events: knownIds.size,
    timestamp: new Date().toISOString()
  };
}

if (process.argv[1] && process.argv[1].endsWith('daily_scraper.js')) {
  runDailyScraper().catch((err) => {
    console.error('Scraper fatal error:', err);
    process.exit(1);
  });
}
