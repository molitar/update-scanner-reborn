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
  if (newTab && besideCurrent) {
    browser.tabs.query({active: true, currentWindow: true}).then(([active]) => {
      const options = {url: url};
      if (active) {
        options.windowId = active.windowId;
        options.index = active.index + 1;
        options.openerTabId = active.id;
      }
      return browser.tabs.create(options);
    }).catch(() => browser.tabs.create({url: url}));
  } else if (newTab) {
    browser.tabs.create({url: url});
  } else {
    browser.tabs.update({url: url});
  }
}

/**
 * Open the Main page the way a user expects:
 *   - Looking at an Update Scanner page (a change view, settings...): the new
 *     page replaces it in the same tab.
 *   - Looking at any other site: that tab is left alone and the page opens in a
 *     new tab immediately to its right (closing it returns to the site).
 *
 * @param {object} params - Object containing paramEnum key/values.
 */
export async function openMainAuto(params) {
  const url = getMainUrl(params);
  try {
    const [active] = await browser.tabs.query({active: true, currentWindow: true});
    const mainBase = browser.extension.getURL('/app/main/main.html');
    if (active && typeof active.url === 'string' && active.url.startsWith(mainBase)) {
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
