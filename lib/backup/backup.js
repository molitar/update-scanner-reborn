import {PageStore} from '/lib/page/page_store.js';
import {PageFolder} from '/lib/page/page_folder.js';
import {HIDE_EXCLUDED_KEY} from '/lib/scan/excluded_parts.js';

export const JSON_BACKUP_ID = 'https://github.com/sneakypete81/updatescanner/@JSON_BACKUP_ID';
export const JSON_BACKUP_VERSION = 1;

/**
 * Returns a JSON string to use for backing up the PageStore.
 * Doesn't include downloaded HTML.
 *
 * @param  {PageStore} pageStore - PageStore object to backup.
 * @returns {string} JSON string of the PageStore contents.
 */
/**
 * @returns {Promise<{hideExcludedLive: boolean}>} Settings kept beside the
 * pages and global defaults.
 */
export async function loadBackupExtras() {
  const stored = await browser.storage.local.get(HIDE_EXCLUDED_KEY);
  return {hideExcludedLive: stored[HIDE_EXCLUDED_KEY] === true};
}

export function createBackupJson(pageStore, globalSettings, extras = {}) {
  const tree = {
    id: JSON_BACKUP_ID,
    version: JSON_BACKUP_VERSION,
    data: generateTree(pageStore),
    globalSettings: globalSettings,
    ...(typeof extras.hideExcludedLive === 'boolean' ?
      {hideExcludedLive: extras.hideExcludedLive} : {}),
    settingsVersion: 1,
  };
  return JSON.stringify(tree, null, 2);
}

/**
 * Recursively create a nested tree of objects to allow JSON backup of
 * the PageStore.
 *
 * @param  {PageStore} pageStore - PageStore object to backup.
 * @param  {string} rootId - ID of the root element.
 * @returns {object} Nested tree of objects representing the PageStore.
 */
function generateTree(pageStore, rootId=PageStore.ROOT_ID) {
  const pageFolder = pageStore.getItem(rootId);
  const result = pageFolder.backup();
  result.children = [];

  for (const childId of pageFolder.children) {
    const child = pageStore.getItem(childId);
    if (child == null) {
      continue;
    }
    if (child instanceof PageFolder) {
      result.children.push(generateTree(pageStore, childId));
    } else {
      result.children.push(child.backup());
    }
  }
  return result;
}
