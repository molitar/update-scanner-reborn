import {Page} from './page.js';

// UPDATESCAN_BULK_SETTINGS_V1
export const GLOBAL_KEY = 'updatescan:global-defaults';
export const SETTING_KEYS = [
  'scanMode', 'showNotification', 'notificationDurationSeconds',
  'notificationUntilClicked', 'playNotificationSound',
  'notificationSoundType', 'notificationSoundData', 'notificationSoundName',
];

export function pickSettings(value) {
  const result = {};
  for (const key of SETTING_KEYS) {
    if (value && value[key] !== undefined) result[key] = value[key];
  }
  return result;
}

export async function loadGlobalDefaults() {
  const stored = await browser.storage.local.get(GLOBAL_KEY);
  return {...pickSettings(Page.DEFAULTS), ...pickSettings(stored[GLOBAL_KEY])};
}

export async function creationDefaults(store, parentId) {
  let result = await loadGlobalDefaults();
  const ancestors = [];
  const seen = new Set();
  let folder = store.getItem(parentId);
  while (folder && !seen.has(folder.id)) {
    seen.add(folder.id);
    ancestors.unshift(folder);
    folder = store.findParent(folder.id);
  }
  for (const ancestor of ancestors) {
    result = {...result, ...pickSettings(ancestor.childSettings)};
  }
  return result;
}

export async function applySettingsToPages(pages, settings, groups) {
  const selected = pickSettings(settings);
  const keys = SETTING_KEYS.filter(key =>
    key === 'scanMode' ? groups.scan : groups.notifications);
  let updated = 0;
  for (const page of pages) {
    if (!page || page.id === undefined) continue;
    const key = Page._KEY(page.id);
    // Reload immediately before writing to retain current scan state.
    const stored = await browser.storage.local.get(key);
    if (!stored[key]) continue;
    const data = {...stored[key]};
    for (const name of keys) {
      if (selected[name] !== undefined) data[name] = selected[name];
    }
    if (groups.scan) {
      data.standardModeVerified = false;
      data.dynamicModeVerified = false;
    }
    await browser.storage.local.set({[key]: data});
    updated++;
  }
  return updated;
}
