import * as view from './restore_view.js';
import {JSON_BACKUP_ID, JSON_BACKUP_VERSION} from './backup.js';
import {restoreBookmarksFromJson} from './restore_bookmarks.js';
import {
  listSnapshots, restoreFromSnapshot, saveSafetySnapshot,
} from './bookmark_backup.js';
import {readAsText} from '/lib/util/promise.js';
import {fileDialog} from '/lib/util/file_dialog.js';
import {PageStore} from '/lib/page/page_store.js';
import {Page} from '/lib/page/page.js';
import {GLOBAL_KEY, pickSettings} from '/lib/page/bulk_settings.js';
import {HIDE_EXCLUDED_KEY} from '/lib/scan/excluded_parts.js';

// UPDATESCAN_COMPLETE_SETTINGS_RESTORE_V1
export function init() {
  view.showUploadButton(restore);
  showBookmarkBackups();
}

/**
 * Restoring deletes every existing page first, so a copy of them is saved in the
 * bookmark backup before that happens.
 *
 * @param {PageStore} store - Page store that is about to be replaced.
 *
 * @returns {Promise<boolean>} False if the user chose to stop.
 */
async function saveSafetyCopy(store) {
  try {
    await saveSafetySnapshot(store);
    return true;
  } catch (error) {
    console.error(error);
    return window.confirm(
      'A safety copy of your current pages could not be saved in your ' +
      'bookmarks. Restore anyway? Your current pages will be lost.');
  }
}

async function restore() {
  try {
    const files = await fileDialog({accept: '.json'});
    if (!files || !files[0]) return;
    // Parse and validate before confirmation or deleting existing links.
    const json = await parseFile(files[0]);
    validateBackup(json);
    if (!view.confirmRestore()) return;
    view.showRestoring();
    const store = await PageStore.load();
    if (!await saveSafetyCopy(store)) {
      view.showUploadAgain();
      return;
    }
    await store.deleteItem(PageStore.ROOT_ID);
    await restoreParsedBackup(store, json);
    view.showComplete();
  } catch (error) {
    console.error(error);
    view.showFailed();
  }
}

/**
 * List the automatic backups kept in the bookmarks, if there are any.
 */
async function showBookmarkBackups() {
  try {
    const snapshots = await listSnapshots();
    if (snapshots.length > 0) {
      view.showBookmarkBackups(snapshots, restoreFromBookmarks);
    }
  } catch (error) {
    // No bookmark access: the file restore above still works.
    console.error(error);
  }
}

async function restoreFromBookmarks(snapshotId) {
  try {
    if (!view.confirmRestore()) return;
    view.showRestoring();
    const store = await PageStore.load();
    if (!await saveSafetyCopy(store)) {
      view.showUploadAgain();
      return;
    }
    await restoreFromSnapshot(store, snapshotId);
    view.showComplete();
  } catch (error) {
    console.error(error);
    view.showFailed();
  }
}

async function parseFile(file) {
  return JSON.parse(await readAsText(file));
}

export function validateBackup(json) {
  if (!json || typeof json !== 'object') {
    throw new Error('Invalid backup file.');
  }
  if (json.id === JSON_BACKUP_ID) {
    if (json.version !== JSON_BACKUP_VERSION) {
      throw new Error('Unsupported backup version: ' + json.version);
    }
    validateTree(json.data);
    if (json.globalSettings !== undefined) validateSettings(json.globalSettings);
    if (json.hideExcludedLive !== undefined && typeof json.hideExcludedLive !== 'boolean') {
      throw new Error('Invalid hide excluded parts setting.');
    }
    return;
  }
  // Accept the original v3 bookmark format only when its root is present.
  function hasRoot(node) {
    return node && Array.isArray(node.children) &&
      ((Array.isArray(node.annos) &&
        node.annos.some(anno => anno.name === 'updatescan/root')) ||
       node.children.some(hasRoot));
  }
  if (!hasRoot(json)) throw new Error('Not an Update Scanner backup.');
}

function validateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Invalid saved settings.');
  }
  if (settings.scanMode !== undefined &&
      !['standard', 'dynamic', 'popup'].includes(settings.scanMode)) {
    throw new Error('Invalid saved scan mode.');
  }
  for (const key of [
    'showNotification', 'notificationUntilClicked', 'playNotificationSound',
    'scanModeLocked', 'scanModeAuto',
    // Block counting, dates and times, translated pages, the tuning bar.
    'countBlocks', 'ignoreDates', 'translatedPage', 'blockTuneBar',
  ]) {
    if (settings[key] !== undefined && typeof settings[key] !== 'boolean') {
      throw new Error('Invalid setting: ' + key);
    }
  }
  if (settings.blockMatch !== undefined &&
      (!Number.isFinite(settings.blockMatch) || settings.blockMatch < 0.01 ||
       settings.blockMatch > 1)) {
    throw new Error('Invalid block match setting.');
  }
  if (settings.excludedParts !== undefined &&
      (!Array.isArray(settings.excludedParts) ||
       !settings.excludedParts.every(part => part &&
         typeof part.selector === 'string'))) {
    throw new Error('Invalid ignored parts.');
  }
  if (settings.notificationDurationSeconds !== undefined &&
      (!Number.isFinite(settings.notificationDurationSeconds) ||
       settings.notificationDurationSeconds < 1)) {
    throw new Error('Invalid notification duration.');
  }
  if (settings.notificationSoundType !== undefined &&
      !['default', 'custom'].includes(settings.notificationSoundType)) {
    throw new Error('Invalid notification sound type.');
  }
  for (const key of ['notificationSoundData', 'notificationSoundName']) {
    if (settings[key] !== undefined && settings[key] !== null &&
        typeof settings[key] !== 'string') {
      throw new Error('Invalid setting: ' + key);
    }
  }
}

function validateTree(node) {
  if (!node || node.type !== 'PageFolder' ||
      typeof node.title !== 'string' || !Array.isArray(node.children)) {
    throw new Error('Invalid folder in backup.');
  }
  if (node.childSettings != null) validateSettings(node.childSettings);
  for (const child of node.children) {
    if (child && child.type === 'PageFolder') {
      validateTree(child);
    } else if (child && child.type === 'Page' &&
               typeof child.title === 'string' &&
               typeof child.url === 'string') {
      validateSettings(child);
      if (child.scanRateMinutes !== undefined &&
          (!Number.isFinite(child.scanRateMinutes) || child.scanRateMinutes < 0)) {
        throw new Error('Invalid scan interval.');
      }
    } else {
      throw new Error('Invalid link in backup.');
    }
  }
}

export async function restoreBackupFromFile(store, file) {
  const json = await parseFile(file);
  validateBackup(json);
  await restoreParsedBackup(store, json);
}

export async function restoreParsedBackup(store, json) {
  const root = store.getItem(PageStore.ROOT_ID);
  root.childSettings = null;
  if (json.id === JSON_BACKUP_ID) {
    await browser.storage.local.set({
      [GLOBAL_KEY]: pickSettings(json.globalSettings || Page.DEFAULTS),
    });
    if (typeof json.hideExcludedLive === 'boolean') {
      await browser.storage.local.set({[HIDE_EXCLUDED_KEY]: json.hideExcludedLive});
    }
    root.title = json.data.title;
    root.childSettings = json.data.childSettings == null ? null :
      pickSettings(json.data.childSettings);
    await root.save();
    await restoreBackupFromJson(store, json.data);
  } else {
    await browser.storage.local.set({[GLOBAL_KEY]: pickSettings(Page.DEFAULTS)});
    await root.save();
    await restoreBookmarksFromJson(store, json);
  }
}

async function restoreBackupFromJson(
  store, json, parentId = PageStore.ROOT_ID,
) {
  for (const child of json.children) {
    if (child.type === 'PageFolder') {
      const folder = await store.createPageFolder(parentId, -1);
      folder.title = child.title;
      folder.childSettings = child.childSettings == null ? null :
        pickSettings(child.childSettings);
      await folder.save();
      await restoreBackupFromJson(store, child, folder.id);
    } else {
      // Explicit factory defaults keep older backups independent of
      // the defaults configured on the computer performing the restore.
      const page = await store.createPage(parentId, -1, {
        ...Page.DEFAULTS, ...child,
        standardModeVerified: false,
        dynamicModeVerified: false,
        scanModeDetected: false,
      });
      await page.save();
    }
  }
}
