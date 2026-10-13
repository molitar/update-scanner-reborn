import {createBackupJson, JSON_BACKUP_ID} from './backup.js';
import {loadGlobalDefaults} from '/lib/page/bulk_settings.js';
import {PageFolder} from '/lib/page/page_folder.js';
import {PageStore} from '/lib/page/page_store.js';
import {log} from '/lib/util/log.js';

// Automatic backup of the page list into the browser's bookmarks.
//
// The pages live in the extension's own storage, which the browser deletes if the
// extension is ever removed and installed again. Bookmarks survive that, and the
// browser also keeps its own daily backups of them, so a copy kept there is
// protected twice.
//
// Layout, under "Update Scanner Reborn" (in Other Bookmarks unless the folder
// already exists somewhere else):
//
//   Update Scanner Reborn
//     <your folders and pages as ordinary, clickable bookmarks>
//     Backup data (do not edit)
//       daily 2026-10-12 · 71 pages            one per day, the last 14 days
//       before restore 2026-10-12 19:08 · 71 pages   taken before every restore
//       smaller 2026-10-12 19:08 · 3 pages     taken if the page list suddenly
//                                              shrinks, so the bigger one is kept
//
// Each snapshot folder holds the normal JSON backup (the same content as the Backup
// menu item), split into a few bookmarks so each stays far below the browser's URL
// length limit.

export const BACKUP_FOLDER_TITLE = 'Update Scanner Reborn';
export const DATA_FOLDER_TITLE = 'Backup data (do not edit)';

const STATE_KEY = 'updatescan:bookmark-backup';
const UNFILED_FOLDER_ID = 'unfiled_____';
const CHUNK_SIZE = 30000; // Base64 characters per bookmark; a multiple of 4.
const DATA_URL_PREFIX = 'data:text/plain;base64,';
const FALLBACK_URL_PREFIX = 'https://sneakypete81.github.io/updatescanner/#backup=';
const DAILY_KEEP = 14;
const OTHER_KEEP = 10;
const SYNC_DELAY_MS = 30000;
const SHRINK_RATIO = 0.5;
const SHRINK_MIN_PAGES = 10;

const KIND_DAILY = 'daily';
const KIND_RESTORE = 'before restore';
const KIND_SMALLER = 'smaller';
const TITLE_PATTERN = new RegExp(
  `^(${KIND_DAILY}|${KIND_RESTORE}|${KIND_SMALLER}) ` +
  '(\\d{4}-\\d{2}-\\d{2})(?: (\\d{2}:\\d{2}))?(?: · (\\d+) pages?)?');

// Allow function mocking
export const __ = {
  log: (...args) => log(...args),
  now: () => new Date(),
};

// ---------------------------------------------------------------- formatting

/**
 * @param {Date} date - Date to format.
 *
 * @returns {string} Local date as YYYY-MM-DD.
 */
export function dateString(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * @param {Date} date - Date to format.
 *
 * @returns {string} Local time as HH:MM.
 */
function timeString(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * @param {number} count - Number of pages.
 *
 * @returns {string} " · 71 pages" style suffix for snapshot titles.
 */
function pagesSuffix(count) {
  return ` · ${count} ${count === 1 ? 'page' : 'pages'}`;
}

/**
 * Splits JSON text into base64 chunks that are small enough for a bookmark URL.
 *
 * @param {string} text - Text to encode.
 *
 * @returns {Array.<string>} Base64 chunks, in order.
 */
export function toChunks(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const base64 = btoa(binary);
  const chunks = [];
  for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
    chunks.push(base64.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

/**
 * @param {Array.<string>} chunks - Base64 chunks from toChunks(), in order.
 *
 * @returns {string} The original text.
 */
export function fromChunks(chunks) {
  const binary = atob(chunks.join(''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * @param {string} url - Bookmark URL written by chunkUrl().
 *
 * @returns {?string} The base64 chunk it carries, or null if it is not one.
 */
function chunkFromUrl(url) {
  if (url.startsWith(DATA_URL_PREFIX)) return url.slice(DATA_URL_PREFIX.length);
  if (url.startsWith(FALLBACK_URL_PREFIX)) {
    return url.slice(FALLBACK_URL_PREFIX.length);
  }
  return null;
}

/**
 * @param {string} text - Text to hash.
 *
 * @returns {Promise<string>} SHA-256 of the text, as hex.
 */
async function digest(text) {
  const hash = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------ bookmarks

/**
 * @param {string} parentId - Folder to look in.
 * @param {string} title - Folder title to find.
 *
 * @returns {Promise<?object>} The folder, or null.
 */
async function findChildFolder(parentId, title) {
  const children = await browser.bookmarks.getChildren(parentId);
  return children.find(
    (child) => child.url === undefined && child.title === title) || null;
}

/**
 * Finds the "Update Scanner Reborn" folder wherever the user keeps it, creating it
 * in Other Bookmarks the first time.
 *
 * @returns {Promise<object>} The bookmark folder.
 */
async function ensureBackupFolder() {
  const matches = await browser.bookmarks.search({title: BACKUP_FOLDER_TITLE});
  const folder = matches.find(
    (item) => item.url === undefined && item.title === BACKUP_FOLDER_TITLE);
  if (folder) return folder;
  return browser.bookmarks.create({
    parentId: UNFILED_FOLDER_ID, title: BACKUP_FOLDER_TITLE,
  });
}

/**
 * @param {string} parentId - Folder that should contain the data folder.
 *
 * @returns {Promise<object>} The "Backup data" folder.
 */
async function ensureDataFolder(parentId) {
  return (await findChildFolder(parentId, DATA_FOLDER_TITLE)) ||
    browser.bookmarks.create({parentId, title: DATA_FOLDER_TITLE});
}

/**
 * @returns {Promise<?object>} The "Backup data" folder, or null if there is none.
 */
async function findDataFolder() {
  const matches = await browser.bookmarks.search({title: BACKUP_FOLDER_TITLE});
  for (const base of matches) {
    if (base.url === undefined && base.title === BACKUP_FOLDER_TITLE) {
      const data = await findChildFolder(base.id, DATA_FOLDER_TITLE);
      if (data) return data;
    }
  }
  return null;
}

/**
 * @param {string} chunk - Base64 chunk.
 *
 * @returns {string} Bookmark URL carrying the chunk.
 */
function chunkUrl(chunk) {
  return DATA_URL_PREFIX + chunk;
}

/**
 * Writes one snapshot folder holding the JSON text.
 *
 * @param {string} dataFolderId - The "Backup data" folder.
 * @param {string} title - Title for the snapshot folder.
 * @param {string} json - Backup JSON text.
 *
 * @returns {Promise<object>} The new snapshot folder.
 */
async function writeSnapshot(dataFolderId, title, json) {
  const folder = await browser.bookmarks.create({
    parentId: dataFolderId, title,
  });
  const chunks = toChunks(json);
  try {
    for (let i = 0; i < chunks.length; i++) {
      const partTitle = `part ${i + 1}/${chunks.length}`;
      try {
        await browser.bookmarks.create({
          parentId: folder.id, title: partTitle, url: chunkUrl(chunks[i]),
        });
      } catch (error) {
        // Some browsers refuse data: bookmarks. A plain https URL works anywhere.
        __.log(`Bookmark backup: data URL refused (${error}), using fallback`);
        await browser.bookmarks.create({
          parentId: folder.id, title: partTitle,
          url: FALLBACK_URL_PREFIX + chunks[i],
        });
      }
    }
  } catch (error) {
    // Do not leave a half written snapshot behind.
    await browser.bookmarks.removeTree(folder.id).catch(() => {});
    throw error;
  }
  return folder;
}

/**
 * @param {Array.<object>} items - Bookmark nodes in the "Backup data" folder.
 *
 * @returns {Array.<object>} Snapshots, newest first.
 */
function parseSnapshots(items) {
  const snapshots = [];
  for (const item of items) {
    if (item.url !== undefined) continue;
    const match = TITLE_PATTERN.exec(item.title || '');
    if (!match) continue;
    snapshots.push({
      id: item.id,
      title: item.title,
      kind: match[1],
      date: match[2],
      time: match[3] || '',
      pages: match[4] === undefined ? null : Number(match[4]),
      added: item.dateAdded || 0,
    });
  }
  return snapshots.sort((a, b) => b.added - a.added);
}

/**
 * Keeps only the newest snapshots of each kind.
 *
 * @param {string} dataFolderId - The "Backup data" folder.
 */
async function pruneSnapshots(dataFolderId) {
  const snapshots = parseSnapshots(
    await browser.bookmarks.getChildren(dataFolderId));
  const keep = {
    [KIND_DAILY]: DAILY_KEEP, [KIND_RESTORE]: OTHER_KEEP, [KIND_SMALLER]: OTHER_KEEP,
  };
  const seen = {};
  for (const snapshot of snapshots) {
    seen[snapshot.kind] = (seen[snapshot.kind] || 0) + 1;
    if (seen[snapshot.kind] > keep[snapshot.kind]) {
      await browser.bookmarks.removeTree(snapshot.id);
    }
  }
}

// -------------------------------------------------------------- reading back

/**
 * @returns {Promise<Array.<object>>} Available snapshots, newest first. Each has
 * id, title, kind ('daily', 'before restore' or 'smaller'), date, time and pages.
 */
export async function listSnapshots() {
  const data = await findDataFolder();
  if (!data) return [];
  return parseSnapshots(await browser.bookmarks.getChildren(data.id));
}

/**
 * @param {string} snapshotId - Bookmark folder ID of a snapshot.
 *
 * @returns {Promise<string>} The backup JSON text stored in the snapshot.
 */
export async function readSnapshotJson(snapshotId) {
  const parts = (await browser.bookmarks.getChildren(snapshotId))
    .filter((item) => item.url !== undefined)
    .map((item) => {
      const match = /^part (\d+)\/(\d+)$/.exec(item.title || '');
      return {index: match ? Number(match[1]) : 0,
        total: match ? Number(match[2]) : 0, chunk: chunkFromUrl(item.url)};
    })
    .filter((part) => part.chunk !== null && part.index > 0)
    .sort((a, b) => a.index - b.index);

  if (parts.length === 0 || parts.length !== parts[0].total ||
      parts.some((part, i) => part.index !== i + 1)) {
    throw new Error('The bookmark backup is incomplete.');
  }
  const text = fromChunks(parts.map((part) => part.chunk));
  const json = JSON.parse(text);
  if (!json || json.id !== JSON_BACKUP_ID) {
    throw new Error('The bookmark backup is not an Update Scanner backup.');
  }
  return text;
}

/**
 * Replaces all pages with the ones in a snapshot. Callers are expected to have
 * saved a safety snapshot first (saveSafetySnapshot()).
 *
 * @param {PageStore} pageStore - Page store to restore into.
 * @param {string} snapshotId - Bookmark folder ID of the snapshot to restore.
 */
export async function restoreFromSnapshot(pageStore, snapshotId) {
  const json = JSON.parse(await readSnapshotJson(snapshotId));
  // Loaded on demand: restore.js depends on this module.
  const {validateBackup, restoreParsedBackup} = await import('./restore.js');
  validateBackup(json);
  await pageStore.deleteItem(PageStore.ROOT_ID);
  await restoreParsedBackup(pageStore, json);
}

// ---------------------------------------------------------------- snapshots

/**
 * Saves a copy of the current pages, to be called right before anything that
 * replaces them. Does nothing if there are no pages.
 *
 * @param {PageStore} pageStore - Page store to copy.
 *
 * @returns {Promise<boolean>} True if a snapshot was saved.
 */
export async function saveSafetySnapshot(pageStore) {
  const count = pageStore.getPageList().length;
  if (count === 0) return false;

  const now = __.now();
  const json = createBackupJson(pageStore, await loadGlobalDefaults());
  const base = await ensureBackupFolder();
  const data = await ensureDataFolder(base.id);
  await writeSnapshot(data.id,
    `${KIND_RESTORE} ${dateString(now)} ${timeString(now)}${pagesSuffix(count)}`,
    json);
  await pruneSnapshots(data.id);
  __.log(`Bookmark backup: saved a safety snapshot of ${count} pages`);
  return true;
}

// ------------------------------------------------------------ the sync itself

/**
 * @param {PageStore} pageStore - Page store to describe.
 * @param {string} [folderId] - Folder to describe (default: the root).
 *
 * @returns {Array.<object>} Folders and pages as plain objects, in order.
 */
function mirrorTree(pageStore, folderId = PageStore.ROOT_ID) {
  const result = [];
  for (const childId of pageStore.getItem(folderId).children) {
    const child = pageStore.getItem(childId);
    if (child === undefined) continue;
    if (child instanceof PageFolder) {
      result.push({folder: child.title, children: mirrorTree(pageStore, childId)});
    } else {
      result.push({title: child.title, url: child.url});
    }
  }
  return result;
}

/**
 * @param {string} parentId - Folder to fill.
 * @param {Array.<object>} tree - Output of mirrorTree().
 */
async function writeMirror(parentId, tree) {
  for (const node of tree) {
    if (node.folder !== undefined) {
      const folder = await browser.bookmarks.create({
        parentId, title: node.folder || 'Folder',
      });
      await writeMirror(folder.id, node.children);
    } else {
      try {
        await browser.bookmarks.create({
          parentId, title: node.title || node.url, url: node.url,
        });
      } catch (error) {
        __.log(`Bookmark backup: skipped ${node.url}: ${error}`);
      }
    }
  }
}

/**
 * Rebuilds the readable copy of the page list next to the data folder.
 *
 * @param {string} baseId - The "Update Scanner Reborn" folder.
 * @param {string} dataFolderId - The "Backup data" folder, left alone.
 * @param {Array.<object>} tree - Output of mirrorTree().
 */
async function rebuildMirror(baseId, dataFolderId, tree) {
  for (const child of await browser.bookmarks.getChildren(baseId)) {
    if (child.id === dataFolderId) continue;
    if (child.url === undefined) {
      await browser.bookmarks.removeTree(child.id);
    } else {
      await browser.bookmarks.remove(child.id);
    }
  }
  await writeMirror(baseId, tree);
}

/**
 * @returns {Promise<object>} Remembered state from the last sync.
 */
async function loadState() {
  const stored = await browser.storage.local.get(STATE_KEY);
  return stored[STATE_KEY] || {};
}

/**
 * Keeps the bookmark copy of the page list up to date.
 */
export class BookmarkBackup {
  /**
   * @param {PageStore} pageStore - Page store to back up.
   */
  constructor(pageStore) {
    this.pageStore = pageStore;
    this._timer = null;
    this._running = false;
    this._again = false;
  }

  /**
   * Ask for a sync soon. Many calls in a row (a scan updating many pages) result
   * in a single sync.
   *
   * @param {number} [delayMs] - How long to wait before syncing.
   */
  schedule(delayMs = SYNC_DELAY_MS) {
    if (this._timer !== null) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.sync().catch((error) => {
        __.log(`Bookmark backup failed: ${error}`);
      });
    }, delayMs);
  }

  /**
   * Bring the bookmark copy up to date with the current pages.
   *
   * @returns {Promise<string>} What happened: 'saved', 'unchanged', 'empty' or
   * 'busy'.
   */
  async sync() {
    if (this._running) {
      this._again = true;
      return 'busy';
    }
    this._running = true;
    try {
      return await this._sync();
    } finally {
      this._running = false;
      if (this._again) {
        this._again = false;
        this.schedule();
      }
    }
  }

  /**
   * @returns {Promise<string>} See sync().
   */
  async _sync() {
    const count = this.pageStore.getPageList().length;
    // Never replace a backup with an empty page list: that is what a freshly
    // reinstalled extension looks like.
    if (count === 0) return 'empty';

    const now = __.now();
    const today = dateString(now);
    const json = createBackupJson(this.pageStore, await loadGlobalDefaults());
    const hash = await digest(json);
    const state = await loadState();

    const base = await ensureBackupFolder();
    const data = await ensureDataFolder(base.id);
    const snapshots = parseSnapshots(await browser.bookmarks.getChildren(data.id));
    const dailies = snapshots.filter((s) => s.kind === KIND_DAILY);
    const todays = dailies.find((s) => s.date === today);
    const previousCount = dailies.length ? dailies[0].pages : null;
    const shrunk = previousCount !== null && previousCount >= SHRINK_MIN_PAGES &&
      count < previousCount * SHRINK_RATIO;

    const changed = hash !== state.hash;
    let result = 'unchanged';
    if (changed || (!todays && !shrunk)) {
      if (shrunk) {
        // Keep the bigger backup untouched and put this one next to it.
        await writeSnapshot(data.id,
          `${KIND_SMALLER} ${today} ${timeString(now)}${pagesSuffix(count)}`, json);
        __.log(`Bookmark backup: the page list shrank from ${previousCount} to ` +
          `${count}; kept the earlier backup`);
      } else {
        const fresh = await writeSnapshot(data.id,
          `${KIND_DAILY} ${today} (new)${pagesSuffix(count)}`, json);
        if (todays) await browser.bookmarks.removeTree(todays.id);
        await browser.bookmarks.update(fresh.id, {
          title: `${KIND_DAILY} ${today}${pagesSuffix(count)}`,
        });
      }
      await pruneSnapshots(data.id);
      result = 'saved';
    }

    const tree = mirrorTree(this.pageStore);
    const mirror = JSON.stringify(tree);
    if (mirror !== state.mirror) {
      await rebuildMirror(base.id, data.id, tree);
      result = 'saved';
    }

    await browser.storage.local.set({
      [STATE_KEY]: {hash, mirror, pages: count, at: now.getTime()},
    });
    return result;
  }

  /**
   * If the extension has no pages at all, as after being removed and installed
   * again, bring them back from the newest bookmark backup.
   *
   * @returns {Promise<boolean>} True if pages were restored.
   */
  async restoreIfEmpty() {
    if (this.pageStore.getPageList().length > 0) return false;
    // Storage still lists pages: loading them failed, which is not the same as
    // having none, and restoring now would duplicate them.
    if (this.pageStore.storageInfo.pageIds.length > 0) return false;

    try {
      const snapshots = (await listSnapshots()).filter(
        (snapshot) => snapshot.pages === null || snapshot.pages > 0);
      const choice = snapshots.find((s) => s.kind === KIND_DAILY) || snapshots[0];
      if (!choice) return false;

      await restoreFromSnapshot(this.pageStore, choice.id);
      __.log(`Bookmark backup: storage was empty, restored '${choice.title}'`);
      return true;
    } catch (error) {
      __.log(`Bookmark backup: automatic restore failed: ${error}`);
      return false;
    }
  }
}
