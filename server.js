import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

import { runDailyScraper, loadExistingEvents } from './daily_scraper.js';
import { isSupabaseReady, fetchEventsFromSupabase, getKnownEvents } from './supabase.js';
import { loadTargets, addTarget, removeTarget } from './targets.js';
import { loadSettings, saveSettings } from './settings.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let isScrapingRunning = false;
let currentScrapingTarget = null;
let lastScrapeResult = null;
let activeCronJob = null;

/**
 * Applies or restarts the cron job dynamically
 */
async function applyCronSchedule() {
  const settings = await loadSettings();

  if (activeCronJob) {
    activeCronJob.stop();
    activeCronJob = null;
    console.log('⏹️ Stopped previous cron schedule.');
  }

  if (settings.auto_scrape_enabled && settings.cron_expression) {
    if (cron.validate(settings.cron_expression)) {
      activeCronJob = cron.schedule(settings.cron_expression, () => {
        console.log(`⏰ [CRON] Triggering scheduled scrape (${settings.cron_expression}) at ${new Date().toISOString()}...`);
        triggerScrapeJob('cron_schedule');
      });
      console.log(`✅ Active Cron Job scheduled: "${settings.cron_expression}" (${settings.schedule_type})`);
    } else {
      console.warn(`⚠️ Invalid cron expression: "${settings.cron_expression}"`);
    }
  } else {
    console.log('⏸️ Automatic scraping is currently DISABLED.');
  }
}

/**
 * Triggers scraper with locking
 */
async function triggerScrapeJob(source = 'manual', specificUrl = null) {
  if (isScrapingRunning) {
    return { status: 'already_running', message: 'A scrape task is currently in progress.' };
  }

  isScrapingRunning = true;
  currentScrapingTarget = specificUrl || 'all';
  console.log(`🚀 Starting scraper job for ${currentScrapingTarget} (triggered by: ${source})...`);

  try {
    const urlsToScrape = specificUrl ? [specificUrl] : null;
    const result = await runDailyScraper(urlsToScrape);
    lastScrapeResult = {
      ...result,
      triggered_by: source,
      target: currentScrapingTarget,
      completed_at: new Date().toISOString()
    };
    return lastScrapeResult;
  } catch (err) {
    console.error('❌ Scraper error:', err.message);
    lastScrapeResult = {
      status: 'error',
      error: err.message,
      triggered_by: source,
      target: currentScrapingTarget,
      failed_at: new Date().toISOString()
    };
    return lastScrapeResult;
  } finally {
    isScrapingRunning = false;
    currentScrapingTarget = null;
  }
}

// Initialize Cron Schedule at startup
applyCronSchedule();

// --- API ENDPOINTS ---

/**
 * System Status API
 */
app.get('/api/status', async (req, res) => {
  const supaOnline = await isSupabaseReady();
  let totalEvents = 0;

  if (supaOnline) {
    const known = await getKnownEvents();
    totalEvents = known.knownIds.size;
  } else {
    const local = await loadExistingEvents();
    totalEvents = local.length;
  }

  const targets = await loadTargets();
  const settings = await loadSettings();

  res.json({
    service: 'AllEvents Scraper Service (Railway + Supabase)',
    status: 'online',
    database: supaOnline ? 'Supabase PostgreSQL' : 'Local JSON Fallback',
    is_supabase_connected: supaOnline,
    is_scraping_now: isScrapingRunning,
    current_scraping_target: currentScrapingTarget,
    settings,
    total_events: totalEvents,
    targets_count: targets.length,
    last_scrape_run: lastScrapeResult
  });
});

/**
 * Get / Update Automation Settings
 */
app.get('/api/settings', async (req, res) => {
  const settings = await loadSettings();
  res.json(settings);
});

app.post('/api/settings', async (req, res) => {
  try {
    const updated = await saveSettings(req.body);
    await applyCronSchedule();
    res.json({ success: true, settings: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Manage Target URLs
 */
app.get('/api/targets', async (req, res) => {
  const targets = await loadTargets();
  res.json({ targets });
});

app.post('/api/targets', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string' || !url.includes('allevents.in')) {
    return res.status(400).json({ error: 'Please enter a valid AllEvents.in URL' });
  }

  const updated = await addTarget(url);
  res.json({ success: true, targets: updated });
});

app.delete('/api/targets', async (req, res) => {
  const url = req.body?.url || req.query?.url;
  if (!url) {
    return res.status(400).json({ error: 'URL required' });
  }

  const updated = await removeTarget(url);
  res.json({ success: true, targets: updated });
});

/**
 * Get events with query filters
 */
app.get('/api/events', async (req, res) => {
  try {
    const supaOnline = await isSupabaseReady();
    const { search, city, tag, hasTicket, limit = 100, offset = 0 } = req.query;

    if (supaOnline) {
      const result = await fetchEventsFromSupabase({
        search,
        city,
        tag,
        hasTicket,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10)
      });

      if (result) {
        return res.json({
          source: 'Supabase',
          total: result.total,
          count: result.events.length,
          offset: parseInt(offset, 10),
          events: result.events
        });
      }
    }

    // Fallback: Local JSON
    let events = await loadExistingEvents();

    if (search) {
      const q = search.toLowerCase();
      events = events.filter((e) =>
        e.name?.toLowerCase().includes(q) ||
        e.venue?.toLowerCase().includes(q) ||
        e.address?.toLowerCase().includes(q)
      );
    }

    if (city) {
      const c = city.toLowerCase();
      events = events.filter((e) => e.city?.toLowerCase().includes(c));
    }

    if (hasTicket === 'true') {
      events = events.filter((e) => Boolean(e.external_ticket_url));
    }

    const start = parseInt(offset, 10);
    const count = parseInt(limit, 10);
    const paginated = events.slice(start, start + count);

    res.json({
      source: 'Local JSON',
      total: events.length,
      count: paginated.length,
      offset: start,
      events: paginated
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Manual Trigger Endpoint
 */
app.all(['/api/scrape', '/api/scrape-now'], (req, res) => {
  if (isScrapingRunning) {
    return res.status(409).json({
      status: 'busy',
      message: 'Scraping is already running in background.'
    });
  }

  const specificUrl = req.body?.url || req.query?.url || null;
  triggerScrapeJob('api_request', specificUrl);

  res.json({
    status: 'started',
    message: specificUrl
      ? `Started scraping for ${specificUrl}`
      : 'Started scraping for all target URLs.'
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.resolve('public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on http://0.0.0.0:${PORT}`);
});
