import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve('./data');
const TARGETS_FILE = path.join(DATA_DIR, 'targets.json');

const DEFAULT_TARGETS = [
  'https://allevents.in/new-delhi/all'
];

export async function loadTargets() {
  try {
    const raw = await fs.readFile(TARGETS_FILE, 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) && list.length > 0 ? list : DEFAULT_TARGETS;
  } catch (e) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(TARGETS_FILE, JSON.stringify(DEFAULT_TARGETS, null, 2), 'utf8');
    return DEFAULT_TARGETS;
  }
}

export async function addTarget(url) {
  const cleanUrl = url.trim();
  const list = await loadTargets();
  if (!list.includes(cleanUrl)) {
    list.push(cleanUrl);
    await fs.writeFile(TARGETS_FILE, JSON.stringify(list, null, 2), 'utf8');
  }
  return list;
}

export async function removeTarget(url) {
  const cleanUrl = url.trim();
  let list = await loadTargets();
  list = list.filter((item) => item !== cleanUrl);
  await fs.writeFile(TARGETS_FILE, JSON.stringify(list, null, 2), 'utf8');
  return list;
}
