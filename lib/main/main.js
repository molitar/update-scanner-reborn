import {GLOBAL_KEY, creationDefaults, loadGlobalDefaults, applySettingsToPages} from '/lib/page/bulk_settings.js';
import * as view from './main_view.js';
import * as dialog from './dialog_view.js';
import {getMainDiffUrl, paramEnum, actionEnum} from './main_url.js';
import {openDebugInfo} from '/lib/debug_info/debug_info_url.js';
import {PageStore} from '/lib/page/page_store.js';
import {Page} from '/lib/page/page.js';
import {PageFolder} from '/lib/page/page_folder.js';
import {diffWithSummary} from '/lib/diff/diff.js';
import {ContentData, getChangeSize} from '/lib/scan/scan_content.js';
import {matchHtmlWithSelector} from '/lib/scan/selector_matcher.js';
import {describeChange} from '/lib/page/thresholds.js';
import {readStamp, compareCaptures} from '/lib/scan/scan_environment.js';
import {log} from '/lib/util/log.js';

// Allow function mocking
export const __ = {
  diffWithSummary: (...args) => diffWithSummary(...args),
  viewDiff: (...args) => view.viewDiff(...args),
  log: (...args) => log(...args),
};

/**
 * Class representing the main Update Scanner content page.
 */
export class Main {
  /**
   * @property {PageStore} pageStore - Object used for saving and loading data
   * from storage.
   * @property {Page} currentPage - Currently selected page.
   * @property {view.ViewTypes} viewType - Currently selected view type.
   */
  constructor() {
    this.pageStore = null;
    this.currentPage = null;
    this.viewType = view.ViewTypes.DIFF;
    // Measured size of a page's change, by page + scan times + settings, so
    // switching views doesn't measure it again.
    this._changeSummaries = new Map();
    this._measurements = new Map();
    // What the diff highlighted, as hover text, by page and pair of scans.
    this._diffNotes = new Map();
  }

  /**
   * Initialise the main page's content iframe.
   */
  async init() {
    this.pageStore = await PageStore.load();

    view.init();
    view.bindMenu({
      settingsHandler: this._handleMenuSettings.bind(this),
      debugHandler: this._handleMenuDebug.bind(this),
    });
    view.bindViewDropdownChange(this._handleViewDropdownChange.bind(this));

    dialog.init();

    this._handleUrlParams(window.location.search);
  }

  /**
   * Parse and handle URL query parameters.
   *
   * @param {string} searchString - Query portion of the URL, starting with the
   * '?' character.
   */
  _handleUrlParams(searchString) {
    const params = new URLSearchParams(searchString);
    switch (this._getUrlParam(params, paramEnum.ACTION)) {
      case actionEnum.NEW_PAGE: {
        this._createNewPage(
          this._getUrlParam(params, paramEnum.TITLE),
          this._getUrlParam(params, paramEnum.URL),
          this._getUrlParam(params, paramEnum.PARENT_ID),
          parseInt(this._getUrlParam(params, paramEnum.INSERT_AFTER_INDEX)),
        );
        break;
      }
      case actionEnum.NEW_PAGE_FOLDER: {
        this._createNewPageFolder(
          this._getUrlParam(params, paramEnum.TITLE),
          this._getUrlParam(params, paramEnum.PARENT_ID),
          parseInt(this._getUrlParam(params, paramEnum.INSERT_AFTER_INDEX)),
        );
        break;
      }
      case actionEnum.SHOW_DIFF: {
        this._showDiff(
          this.pageStore.getItem(this._getUrlParam(params, paramEnum.ID)),
        );
        break;
      }
      case 'global_settings': {
        this._showGlobalSettings().catch(console.error);
        break;
      }
      case actionEnum.SHOW_SETTINGS: {
        const item = this.pageStore.getItem(
          this._getUrlParam(params, paramEnum.ID),
        );
        if (item instanceof Page) {
          this._showPageSettings(item);
        } else {
          this._showPageFolderSettings(item);
        }
        break;
      }
    }
  }

  /**
   * Returns a  value from the URL parameters, or undefined if the specified
   * key doesn't exist. This is useful because URLSearchParams.get() returns
   * null if the key doesn't exist.
   *
   * @param {URLSearchParams} params - URLSearchParams object to use.
   * @param {string} key - Parameter key to use.
   *
   * @returns {string} Value associated with the given key, or undefined if it
   * doesn't exist.
   */
  _getUrlParam(params, key) {
    if (params.has(key)) {
      return params.get(key);
    }
    return undefined;
  }

  /**
   * _Show the Dialog to create a new Page.
   *
   * @param {string} title - Default title field.
   * @param {string} url - Default url field.
   * @param {string} parentId - Parent folder of the new Page.
   * @param {integer} insertAfterIndex - Add the page after this item in the
   * parent folder. If negative, the Page will be added to the end of the parent
   * folder.
   */
  async _createNewPage(
    title,
    url = '',
    parentId = PageStore.ROOT_ID,
    insertAfterIndex = -1,
  ) {
    if (url.startsWith('about') || url.startsWith('moz-extension')) {
      title = undefined;
      url = undefined;
    }

    const temporaryPage = new Page(-1, {
      ...await creationDefaults(this.pageStore, parentId),
      title: title, url: url,
    });
    const newSettings = await dialog.openPageDialog(temporaryPage);

    if (newSettings == null) {
      document.location.replace('about:blank');
    } else {
      this.currentPage = await this.pageStore.createPage(
        parentId,
        insertAfterIndex,
      );
      this._updateCurrentPage(newSettings);
      // @TODO: Scan it immediately
    }
  }

  /**
   * _Show the Dialog to create a new PageFolder.
   *
   * @param {string} title - Default title field.
   * @param {string} parentId - Parent folder of the new PageFolder.
   * @param {integer} insertAfterIndex - Add the PageFolder after this item in
   * the parent folder. If negative, the PageFolder will be added to the end of
   * the parent folder.
   */
  async _createNewPageFolder(
    title,
    parentId = PageStore.ROOT_ID,
    insertAfterIndex = -1,
  ) {
    const temporaryPageFolder = new PageFolder(-1, {title: title});
    const newSettings = await dialog.openPageFolderDialog(
      temporaryPageFolder, await creationDefaults(this.pageStore, parentId));
    if (newSettings !== null) {
      const pageFolder = await this.pageStore.createPageFolder(
        parentId,
        insertAfterIndex,
      );
      pageFolder.title = newSettings.title;
      pageFolder.childSettings = newSettings.settings;
      await pageFolder.save();
    }
    document.location.replace('about:blank');
  }

  /**
   * Called whenever the 'Page Settings' item is chosen from the menu.
   */
  _handleMenuSettings() {
    this._showPageSettings(this.currentPage);
  }

  /**
   * Called whenever the 'Debug Info' item is chosen from the menu.
   */
  _handleMenuDebug() {
    openDebugInfo(this.currentPage.id);
  }

  /**
   * Update the current Page with new settings from the Settings dialog.
   *
   * @param {object} newSettings - Settings to apply to the current page.
   */
  _updateCurrentPage(newSettings) {
    const standardNeedsVerification =
      newSettings.scanMode === "standard" &&
      (this.currentPage.scanMode !== "standard" ||
       this.currentPage.url !== newSettings.url);

    this.currentPage.title = newSettings.title;
    this.currentPage.url = newSettings.url;
    this.currentPage.scanRateMinutes = newSettings.scanRateMinutes;
    this.currentPage.changeThreshold = newSettings.changeThreshold;
    this.currentPage.ignoreNumbers = newSettings.ignoreNumbers;
    this.currentPage.selectors = newSettings.selectors;
    this.currentPage.contentMode = newSettings.contentMode;
    this.currentPage.requireExactMatchCount =
      newSettings.requireExactMatchCount;
    this.currentPage.partialScan = newSettings.partialScan;
    this.currentPage.scanMode = newSettings.scanMode;

    // An explicit scan-mode save retrains the selected tier on the next scan.
    // Standard is checked against Dynamic; Dynamic is checked against Popup.
    // Popup is the deepest tier and requires no further verification.
    this.currentPage.standardModeVerified = false;
    this.currentPage.dynamicModeVerified = false;
    this.currentPage.showNotification = newSettings.showNotification;
    this.currentPage.notificationDurationSeconds = newSettings.notificationDurationSeconds;
    this.currentPage.notificationUntilClicked = newSettings.notificationUntilClicked;
    this.currentPage.playNotificationSound = newSettings.playNotificationSound;
    this.currentPage.notificationSoundType = newSettings.notificationSoundType;
    this.currentPage.notificationSoundData = newSettings.notificationSoundData;
    this.currentPage.notificationSoundName = newSettings.notificationSoundName;
    this.currentPage.save();

    document.location.replace(getMainDiffUrl(this.currentPage.id));
  }

  /**
   * Called whenever the view dropdown selection changes.
   *
   * @param {view.ViewTypes} viewType - New value of the dropdown.
   */
  _handleViewDropdownChange(viewType) {
    this.viewType = viewType;
    this._refreshView();
  }

  /**
   * Show the diff view of the Page, and update the page state to NO_CHANGE.
   *
   * @param {Page} page - Page to view.
   *
   * @returns {Promise} A Promise that fulfils once the view has been updated.
   */
  _showDiff(page) {
    if (page.isChanged()) {
      page.state = Page.stateEnum.NO_CHANGE;
      page.save();
    }
    this.currentPage = page;
    this.viewType = view.ViewTypes.DIFF;
    return this._refreshView();
  }

  /**
   * Show the Page settings dialog.
   *
   * @param {Page} page - Page to edit.
   */
  async _showPageSettings(page) {
    this.currentPage = page;
    const newSettings = await dialog.openPageDialog(page);
    if (newSettings !== null) {
      this._updateCurrentPage(newSettings);
    }
    document.location.replace(getMainDiffUrl(this.currentPage.id));
  }

  /**
   * Show the PageFolder settings dialog.
   *
   * @param {PageFolder} pageFolder - PageFolder to edit.
   */
  async _showGlobalSettings() {
    const result = await dialog.openGlobalSettingsDialog(await loadGlobalDefaults());
    if (result) {
      await browser.storage.local.set({[GLOBAL_KEY]: result.settings});
      if (result.applyDescendants) {
        const count = await applySettingsToPages(
          this.pageStore.getPageList(), result.settings, result.groups);
        console.info(`Global settings applied to ${count} links.`);
      }
    }
    await this._closeTemporarySettingsTab();
  }

  async _showPageFolderSettings(pageFolder) {
    const newSettings = await dialog.openPageFolderDialog(
      pageFolder, await creationDefaults(this.pageStore, pageFolder.id));
    if (newSettings !== null) {
      pageFolder.title = newSettings.title;
      pageFolder.childSettings = newSettings.settings;
      await pageFolder.save();
      if (newSettings.applyDescendants) {
        const count = await applySettingsToPages(
          this.pageStore.getDescendantPages(pageFolder.id),
          newSettings.settings, newSettings.groups);
        console.info(`Folder settings applied to ${count} links.`);
      }
    }
    await this._closeTemporarySettingsTab();
  }

  /**
   * Close only the current extension settings tab.
   * Called after settings are saved or the dialog is cancelled.
   */
  async _closeTemporarySettingsTab() {
    try {
      const currentTab = await browser.tabs.getCurrent();
      const mainUrl = browser.runtime.getURL('app/main/main.html');

      if (!window.location.href.startsWith(mainUrl) ||
          !currentTab || !Number.isInteger(currentTab.id)) {
        console.warn('Temporary settings tab could not be identified.');
        return;
      }

      await browser.tabs.remove(currentTab.id);
    } catch (error) {
      console.error('Unable to close settings tab:', error);
    }
  }


  /**
   * Refresh the view, reloading any necessary HTML from storage.
   */
  async _refreshView() {
    const page = this.currentPage;

    switch (this.viewType) {
      case view.ViewTypes.OLD: {
        const html = _updateHeader(
          page,
          (await loadHtml(page, PageStore.htmlTypes.OLD)) || '',
        );
        view.viewOld(page, html);
        break;
      }

      case view.ViewTypes.NEW: {
        const html = _updateHeader(
          page,
          (await loadHtml(page, PageStore.htmlTypes.NEW)) || '',
        );
        view.viewNew(page, html);
        break;
      }

      case view.ViewTypes.DIFF:
      default: {
        // If the page text did not change (only markup, hidden ids or styles
        // differ), highlighting would mark words that did not change, so show
        // the new page as it is and say so.
        const measured = await this._getMeasurement(page);
        if (measured.size === 0 &&
            page.contentMode !== Page.contentModeEnum.HTML) {
          const html = _updateHeader(
            page,
            (await loadHtml(page, PageStore.htmlTypes.NEW)) || '',
          );
          __.viewDiff(page, html, false);
        } else {
          const result = await loadDiff(page);
          this._diffNotes.set(diffKey(page), result.summary);
          __.viewDiff(page, _updateHeader(page, result.html), true);
        }
      }
    }

    // Not awaited: the page is already showing, the size appears when ready.
    this._showChangeSize(page);
  }

  /**
   * Measure the change between the old and the new version of the page (once
   * per pair of scans).
   *
   * @param {Page} page - Page being viewed.
   *
   * @returns {Promise<{size: ?number, environment: ?object}>} See
   * measurePageChange(); size is null if it could not be measured.
   */
  async _getMeasurement(page) {
    const key = [page.id, page.oldScanTime, page.newScanTime,
      page.ignoreNumbers, page.contentMode, page.selectors].join('|');
    let measured = this._measurements.get(key);
    if (measured === undefined) {
      try {
        measured = await measurePageChange(page);
      } catch (error) {
        __.log(`Could not measure the change on '${page.title}': ${error}`);
        measured = {size: null, environment: null};
      }
      this._measurements.set(key, measured);
    }
    return measured;
  }

  /**
   * Measure the biggest change between the old and the new version of the page
   * and show it in the "View Changes" dropdown option and under the title.
   *
   * @param {Page} page - Page being viewed.
   */
  async _showChangeSize(page) {
    const history = page.changeSizes || [];
    const key = [page.id, page.oldScanTime, page.newScanTime,
      page.changeThreshold, page.ignoreNumbers, page.contentMode,
      page.selectors, history.length,
      history.length ? history[history.length - 1].time : ''].join('|');
    // The Changes view knows exactly which visible text was highlighted; that
    // character count is the change size shown, since it is what the user sees.
    const diffSummary = this._diffNotes.get(diffKey(page));
    const shownSize = diffSummary ? diffSummary.characters : null;
    let summary = this._changeSummaries.get(key + '|' + shownSize);
    if (summary === undefined) {
      try {
        // What is normal for this page comes from its recorded scans, so the
        // size of this change can be judged against it.
        const measured = await this._getMeasurement(page);
        summary = describeChange(
          shownSize == null ? measured.size : shownSize,
          page.changeThreshold, history);
        // If the two versions were captured at a different zoom or window
        // width, say so: pages can lay out differently and show different
        // content at different sizes.
        if (summary && measured.environment) {
          summary = {
            ...summary,
            short: `${summary.short}, ${measured.environment.short}`,
            note: `${summary.note}\n${measured.environment.note}`,
          };
        }
      } catch (error) {
        __.log(`Could not measure the change on '${page.title}': ${error}`);
        summary = null;
      }
      this._changeSummaries.set(key + '|' + shownSize, summary);
    }
    // Say what the diff highlighted (known once the Changes view has loaded).
    const highlighted = describeHighlights(diffSummary) +
      (page.lastScanNote ? `
${page.lastScanNote}` : '');
    if (summary && highlighted) {
      summary = {...summary, note: `${summary.note}
${highlighted}`};
    }
    // The user may have moved to another page while this was measured.
    if (this.currentPage && this.currentPage.id === page.id) {
      view.showChangeSize(page.id, summary);
    }
  }
}

/**
 * Measure the biggest change between the stored old and new HTML of a page,
 * the same way a scan does, in the units of the Change Threshold setting.
 *
 * @param {Page} page - Page to measure.
 *
 * @returns {Promise<{size: ?number, environment: ?object}>} size in characters
 * (null if either version is missing) and, when the two versions were captured
 * at a different zoom or window width, a description of that.
 */
async function measurePageChange(page) {
  const oldHtml = await PageStore.loadHtml(page.id, PageStore.htmlTypes.OLD);
  const newHtml = await PageStore.loadHtml(page.id, PageStore.htmlTypes.NEW);
  if (!oldHtml || !newHtml) {
    return {size: null, environment: null};
  }
  const environment = compareCaptures(readStamp(oldHtml), readStamp(newHtml));
  let prev = new ContentData(oldHtml, null);
  let next = new ContentData(newHtml, null);
  if (page.selectors) {
    try {
      prev = new ContentData(
        oldHtml, await matchHtmlWithSelector(oldHtml, page.selectors));
      next = new ContentData(
        newHtml, await matchHtmlWithSelector(newHtml, page.selectors));
    } catch (error) {
      __.log(`Selectors could not be applied when measuring: ${error}`);
    }
  }
  return {size: getChangeSize(prev, next, page), environment};
}

/**
 * Load the HTMLs of the specified page, perform a diff and return the
 * highlighted HTML.
 *
 * @param {Page} page - Page object to load.
 *
 * @returns {Promise} A promise that fulfils with the highlighted HTML string.
 */
async function loadDiff(page) {
  const oldHtml = await loadHtml(page, PageStore.htmlTypes.OLD);
  const newHtml = await loadHtml(page, PageStore.htmlTypes.NEW);
  return await __.diffWithSummary(page, oldHtml, newHtml);
}

/**
 * @param {Page} page - Page being viewed.
 *
 * @returns {string} Key for the page and its current pair of scans.
 */
function diffKey(page) {
  return [page.id, page.oldScanTime, page.newScanTime].join('|');
}

/**
 * @param {?{count: number, characters: number, top: string[]}} summary - From
 * the diff.
 *
 * @returns {string} A line for the hover text saying what was highlighted, or
 * '' if nothing was.
 */
function describeHighlights(summary) {
  if (!summary || !summary.count) return '';
  const places = summary.count === 1 ? '1 place' : `${summary.count} places`;
  return `Highlighted text (${places}, ${summary.characters} characters): ` +
    summary.top.map((text) => `“${text}”`).join(', ') +
    (summary.count > summary.top.length ? ', ...' : '');
}

/**
 * Load the specified Page HTML from the PageStore.
 *
 * @param {Page} page - Page to load.
 * @param {string} htmlType - PageStore.htmlTypes string identifying the HTML
 * type.
 * @returns {Promise} A Promise to be fulfilled with the requested HTML, or
 * null if the HTML does not exist in storage.
 */
async function loadHtml(page, htmlType) {
  const html = await PageStore.loadHtml(page.id, htmlType);

  if (html == null) {
    __.log(`Could not load '${page.title}' ${htmlType} HTML from storage`);
  }
  return html;
}

/**
 * Update the HTML header with a <base href> for the page.
 *
 * @param {Page} page - Page to update.
 * @param {string} html - HTML page content type.
 * @returns {string} Updated HTML page content.
 */
function _updateHeader(page, html) {
  // @TODO: Only add if there's no existing <base href> tag
  return `<base href="${page.url}" target="_top">` + html;
}
