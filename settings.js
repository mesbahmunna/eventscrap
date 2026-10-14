import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve('./data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  auto_scrape_enabled: true,
  schedule_type: 'daily', // 'daily', 'every_6h', 'every_12h', 'custom'
  schedule_time: '04:00', // UTC 04:00
  cron_expression: '0 4 * * *'
};

export async function loadSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8');
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(newSettings) {
  const current = await loadSettings();
  const updated = { ...current, ...newSettings };

  // Calculate cron_expression from schedule_type if not custom
  if (updated.schedule_type === 'every_6h') {
    updated.cron_expression = '0 */6 * * *';
  } else if (updated.schedule_type === 'every_12h') {
    updated.cron_expression = '0 */12 * * *';
  } else if (updated.schedule_type === 'daily') {
    const [hh, mm] = (updated.schedule_time || '04:00').split(':');
    updated.cron_expression = `${parseInt(mm || '0', 10)} ${parseInt(hh || '4', 10)} * * *`;
  }

  await fs.writeFile(SETTINGS_FILE, JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}
