import {PageStore} from '/lib/page/page_store.js';

/**
 * Parameter names for the Main page URL parameters.
 *
 * @readonly
 * @enum {string}
 */
export const paramEnum = {
  ACTION: 'action',
  ID: 'id',
  TITLE: 'title',
  URL: 'url',
  PARENT_ID: 'parentId',
  INSERT_AFTER_INDEX: 'insertAfterIndex',
};

/**
 * Values for the Main page action URL parameter.
 *
 * @readonly
 * @enum {string}
 */
export const actionEnum = {
  NEW_PAGE: 'new_page',
  NEW_PAGE_FOLDER: 'new_page_folder',
  SHOW_DIFF: 'show_diff',
  SHOW_SETTINGS: 'show_settings',
};


/**
 * Open the Main page URL, passing the specified parameters.
 *
 * @param {object} params - Object containing paramEnum key/values.
 * @param {boolean} newTab - Open the page in a new tab.
 * @param {boolean} besideCurrent - With newTab: put the new tab immediately to
 * the right of the tab being looked at, and return to that tab when it is
 * closed. Used for settings, so closing them never drops the user onto some
 * other tab (for example one that is busy scanning).
 */
export function openMain(params, newTab, besideCurrent = false) {
  const url = getMainUrl(params);
  // The promise is returned so a caller that is about to close the toolbar
  // popup can wait for the tab to exist: closing the popup first ended the
  // pending lookup and the tab was never created (Global Settings and New
  // would not open).
  if (newTab && besideCurrent) {
    return browser.tabs.query({active: true, currentWindow: true}).then(([active]) => {
      const options = {url: url};
      if (active) {
        options.windowId = active.windowId;
        options.index = active.index + 1;
        options.openerTabId = active.id;
      }
      return browser.tabs.create(options);
    }).catch(() => browser.tabs.create({url: url}));
  } else if (newTab) {
    return browser.tabs.create({url: url});
  }
  return browser.tabs.update({url: url});
}

/**
 * @param {string} address - A web address.
 *
 * @returns {string} Its host name in lower case, without a leading "www.".
 */
function siteOf(address) {
  try {
    return new URL(address).hostname.toLowerCase().replace(/^www\./, '');
  } catch (error) {
    return '';
  }
}

/**
 * @param {string} a - A web address.
 * @param {string} b - Another web address.
 *
 * @returns {boolean} True if both are on the same site: the same host name
 * (ignoring "www."), or one a sub-domain of the other.
 */
export function sameSite(a, b) {
  const first = siteOf(a);
  const second = siteOf(b);
  if (!first || !second) return false;
  return first === second || first.endsWith('.' + second) ||
    second.endsWith('.' + first);
}

/**
 * Open the Main page the way a user expects:
 *   - Looking at an Update Scanner page (a change view, settings...): the new
 *     page replaces it in the same tab.
 *   - Looking at the very site the page monitors (siteUrl): the Changes view
 *     replaces it in the same tab, so no extra tab piles up.
 *   - Looking at any other site: that tab is left alone and the page opens in a
 *     new tab immediately to its right (closing it returns to the site).
 *
 * @param {object} params - Object containing paramEnum key/values.
 * @param {string} [siteUrl] - Address of the page being opened, when it is a
 * monitored page (not for New Page, settings...).
 */
export async function openMainAuto(params, siteUrl = '') {
  const url = getMainUrl(params);
  try {
    const [active] = await browser.tabs.query({active: true, currentWindow: true});
    const mainBase = browser.extension.getURL('/app/main/main.html');
    if (active && typeof active.url === 'string' && active.url.startsWith(mainBase)) {
      await browser.tabs.update(active.id, {url: url});
      return;
    }
    if (active && siteUrl && typeof active.url === 'string' &&
        sameSite(active.url, siteUrl)) {
      await browser.tabs.update(active.id, {url: url});
      return;
    }
    const options = {url: url};
    if (active) {
      options.windowId = active.windowId;
      options.index = active.index + 1;
      options.openerTabId = active.id;
    }
    await browser.tabs.create(options);
  } catch (error) {
    await browser.tabs.create({url: url});
  }
}

/**
 * Returns the URL to open the Main page, passing the specified parameters.
 *
 * @param {object} params - Object containing paramEnum key/values.
 *
 * @returns {string} URL of the Main page.
 */
function getMainUrl(params) {
  const url = new URL(browser.extension.getURL('/app/main/main.html'));
  for (const [param, value] of Object.entries(params)) {
    url.searchParams.set(param, value);
  }
  return url.href;
}

/**
 * Returns the URL to open the Main page showing a diff.
 *
 * @param {string} pageId - ID of the Page to diff.
 *
 * @returns {string} URL of the Main page.
 */
export function getMainDiffUrl(pageId) {
  const params = {
    [paramEnum.ACTION]: actionEnum.SHOW_DIFF,
    [paramEnum.ID]: pageId,
  };
  return getMainUrl(params);
}

/**
 * Open all changed pages in new tabs.
 */
export async function showAllChanges() {
  const pageStore = await PageStore.load();
  for (const page of pageStore.getChangedPageList()) {
    openMain(
      {[paramEnum.ACTION]: actionEnum.SHOW_DIFF, [paramEnum.ID]: page.id},
      true);
  }
}
