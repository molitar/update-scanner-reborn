import {backgroundActionEnum} from './actions.js';
import {Autoscan} from '/lib/scan/autoscan.js';
import {ScanQueue} from '/lib/scan/scan_queue.js';
import {showNotification} from '/lib/scan/notification.js';
import {PageStore, hasPageStateChanged, isItemChanged}
  from '/lib/page/page_store.js';
import {BookmarkBackup} from '/lib/backup/bookmark_backup.js';
import {isUpToDate, latestVersion} from '/lib/update/update.js';
import {openUpdate} from '/lib/update/update_url.js';
import {log} from '/lib/util/log.js';
import {Config} from '/lib/util/config.js';
import {normaliseParts, HIDE_EXCLUDED_KEY, blockedScriptHost} from '/lib/scan/excluded_parts.js';

const activeIcon = {
  18: '/images/updatescanner_18.png',
  48: '/images/updatescanner_48.png',
  64: '/images/updatescanner_64.png',
};

/**
 * Class representing the Update Scanner background process.
 */
export class Background {
  /**
   * @property {PageStore} pageStore - Object used for saving and loading data
   * from storage.
   */
  constructor() {
    this.pageStore = null;
    this.scanQueue = null;
  }

  /**
   * Start the background processes and listeners.
   */
  async init() {
    this.pageStore = await PageStore.load();
    this.bookmarkBackup = new BookmarkBackup(this.pageStore);
    this.pageStore.bindPageUpdate(this._handlePageUpdate.bind(this));
    // Rules must be ready before scripts are requested. No rules means allow all.
    this.scriptBlockingEnabled = false;
    this.scriptRules = new Map();
    this.frameBlockingSites = new Set();
    await this._refreshScriptRules();
    browser.webRequest.onBeforeRequest.addListener(
      this._blockSelectedScripts.bind(this),
      {urls: ['http://*/*', 'https://*/*'], types: ['script', 'sub_frame']},
      ['blocking']);
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[HIDE_EXCLUDED_KEY]) {
        this._refreshScriptRules().catch((error) => console.warn('[URS1] script rules:', error));
      }
    });
    this.pageStore.bindPageFolderUpdate(
      () => this.bookmarkBackup.schedule());
    browser.runtime.onMessage.addListener(this._handleMessage.bind(this));

    this.scanQueue = new ScanQueue();
    this.scanQueue.bindScanComplete(this._handleScanComplete.bind(this));
    // UPDATESCAN_BUSY_INDICATOR_V1
    this.scanQueue.bindScanState(state => {
      browser.runtime.sendMessage({
        action: 'updatescan-scan-state',
        ...state,
      }).catch(() => {});
    });

    this._refreshIcon();
    this.pageStore.refreshFolderState();
    await this._restoreIfEmpty();
    await this._checkFirstRun();
    await this._checkIfUpdateRequired();

    const autoscan = new Autoscan(this.scanQueue, this.pageStore);
    autoscan.start();

    // Back up the pages to the bookmarks shortly after start-up, then whenever
    // they change.
    this.bookmarkBackup.schedule(10000);
  }

  /**
   * If the extension has no pages at all (for example after being removed and
   * installed again), bring them back from the bookmark backup. This has to run
   * before the first-run page is created, or the store would no longer be empty.
   */
  async _restoreIfEmpty() {
    if (await this.bookmarkBackup.restoreIfEmpty()) {
      const config = await new Config().load();
      config.set('isFirstRun', false);
      config.set('updateVersion', latestVersion);
      await config.save();
      this.pageStore.refreshFolderState();
      this._refreshIcon();
    }
  }

  /**
   * Called when a Page is updated in Storage. Refresh the icon if its state
   * changed.
   *
   * @param {string} pageId - ID of the changed Page.
   * @param {storage.StorageChange} change - Object representing the change.
   */
  _handlePageUpdate(pageId, change) {
    this.bookmarkBackup.schedule();
    this._refreshScriptRules().catch((error) => console.warn('[URS1] script rules:', error));
    if (hasPageStateChanged(change)) {
      this._refreshIcon();
      this.pageStore.refreshFolderState();
    }
  }

  /**
   * Called when a message is sent to the background process.
   *
   * @param {object} message - Message content.
   */
  _handleMessage(message) {
    if (message.action === 'updatescan-get-scan-state') {
      return Promise.resolve({
        pageId: this.scanQueue ? this.scanQueue.currentPageId : null,
        revision: this.scanQueue ? this.scanQueue.scanStateRevision : 0,
      });
    }
    if (message.action === 'live-hide-rules') {
      return this._liveHideRules(message.url);
    }
    if (message.action === 'live-pick-init') {
      return Promise.resolve(this._livePickInit(message.url));
    }
    if (message.action === 'live-pick-save') {
      return this._livePickSave(message.pageId, message.parts);
    }
    if (message.action === backgroundActionEnum.SCAN_ALL) {
      this._scanAll();
    } else if (message.action === backgroundActionEnum.SCAN_ITEM) {
      this._scanItem(message.itemId);
    }
  }

  // Fail-open request filter: only a user-selected third-party script host
  // on a user-selected monitored site can be blocked. No regex or wildcards.
  _blockSelectedScripts(details) {
    if (!this.scriptBlockingEnabled || !(details.originUrl || details.documentUrl)) return {};
    try {
      const pageUrl = new URL(details.originUrl || details.documentUrl);
      const scriptUrl = new URL(details.url);
      if (!/^https?:$/.test(pageUrl.protocol) || !/^https?:$/.test(scriptUrl.protocol)) return {};
      const site = pageUrl.hostname.toLowerCase().replace(/^www\./, '');
      const host = scriptUrl.hostname.toLowerCase();
      // Only requests initiated from the user's monitored site are eligible.
      // Leave same-site frames, browser security challenges, and all other sites alone.
      if (host === pageUrl.hostname.toLowerCase() || host.endsWith('.' + site)) return {};
      if (details.type === 'sub_frame') {
        // A separate, explicitly enabled site-wide rule. OFF by default because
        // some websites need third-party embeds for legitimate video playback.
        return this.frameBlockingSites.has(site) ? {cancel: true} : {};
      }
      const blocked = this.scriptRules.get(site);
      return blocked && blocked.has(host) ? {cancel: true} : {};
    } catch (error) {
      return {};
    }
  }

  async _refreshScriptRules() {
    const setting = await browser.storage.local.get(HIDE_EXCLUDED_KEY);
    const next = new Map();
    const frameSites = new Set();
    if (setting[HIDE_EXCLUDED_KEY] === true) {
      for (const page of this.pageStore.getPageList()) {
        let site;
        try { site = new URL(page.url).hostname.toLowerCase().replace(/^www\./, ''); }
        catch (error) { continue; }
        for (const part of normaliseParts(page.excludedParts)) {
          if (part.kind === 'frames' && part.selector === ':urs1-block-third-party-frames') frameSites.add(site);
          const host = blockedScriptHost(part);
          if (!host || host === site) continue;
          if (!next.has(site)) next.set(site, new Set());
          next.get(site).add(host);
        }
      }
    }
    this.scriptRules = next;
    this.frameBlockingSites = frameSites;
    this.scriptBlockingEnabled = setting[HIDE_EXCLUDED_KEY] === true;
  }

  /**
   * The rules the content script hides on a page: the Exclude parts of the
   * scanned pages on the same site, if the switch in the toolbar Menu is on.
   *
   * @param {string} url - Address of the page being visited.
   *
   * @returns {Promise<{rules: string[]}>} The selectors to hide.
   */
  async _liveHideRules(url) {
    const stored = await browser.storage.local.get(HIDE_EXCLUDED_KEY);
    if (stored[HIDE_EXCLUDED_KEY] !== true) return {rules: [], noClick: [], clickLayers: false, blockPopups: false};
    const siteOf = (address) => {
      try {
        return new URL(address).hostname.toLowerCase().replace(/^www\./, '');
      } catch (error) {
        return '';
      }
    };
    const site = siteOf(url);
    if (!site) return {rules: [], noClick: [], clickLayers: false, blockPopups: false};
    const rules = new Set();
    const noClick = new Set();
    let clickLayers = false;
    let blockPopups = false;
    for (const page of this.pageStore.getPageList()) {
      if (siteOf(page.url) !== site) continue;
      for (const part of normaliseParts(page.excludedParts)) {
        if (part.kind === 'exclude') rules.add(part.selector);
        if (part.kind === 'noclick') noClick.add(part.selector);
        if (part.kind === 'layers') clickLayers = part.hide ? 'hide' : (clickLayers || true);
        if (part.kind === 'popups') blockPopups = true;
      }
    }
    return {rules: [...rules], noClick: [...noClick], clickLayers, blockPopups};
  }

  /**
   * The picker on the live page asks which scanned page it belongs to, and what
   * is already picked for it.
   *
   * @param {string} url - Address of the page in the tab.
   *
   * @returns {object} {ok, pageId, title, parts} or {ok: false}.
   */
  _livePickInit(url) {
    // The live picker configures site-wide protection. A monitored URL on
    // this hostname authorizes picking on any page of the same hostname.
    // Prefer the exact scanned URL when present to preserve prior behavior.
    const clean = (address) => String(address || '').split('#')[0].replace(/\/+$/, '');
    const hostOf = (address) => {
      try {
        const u = new URL(address);
        return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().replace(/^www\./, '') : '';
      } catch (error) { return ''; }
    };
    const site = hostOf(url);
    const pages = this.pageStore.getPageList();
    const page = pages.find((entry) => clean(entry.url) === clean(url)) ||
      (site && pages.find((entry) => hostOf(entry.url) === site));
    if (!page) return {ok: false, reason: 'not-scanned-site'};
    return {
      ok: true,
      pageId: page.id,
      title: page.title,
      parts: normaliseParts(page.excludedParts),
    };
  }

  /**
   * Save the parts picked on the live page to the scanned page.
   *
   * @param {string} pageId - ID of the page.
   * @param {Array} parts - Its ignored and excluded parts.
   */
  async _livePickSave(pageId, parts) {
    const page = this.pageStore.getItem(pageId);
    if (!page || !Array.isArray(parts)) return {ok: false};
    page.excludedParts = normaliseParts(parts);
    await page.save();
    await this._refreshScriptRules();
    return {ok: true};
  }

  /**
   * Refresh the browserAction icon and badge text.
   */
  _refreshIcon() {
    const updateCount = this.pageStore.getPageList()
      .filter(isItemChanged).length;

    const downPages = this.pageStore.getPageList().filter(
      (page) => page.state === 'down');
    browser.browserAction.setIcon({path: activeIcon});
    if (downPages.length) {
      browser.browserAction.setBadgeBackgroundColor({color: '#d93636'});
      browser.browserAction.setBadgeText({text: `${downPages.length}!`});
      browser.browserAction.setTitle({title: `Update Scanner: ${downPages.length} site(s) still down after recheck. ${downPages[0].title}: ${downPages[0].outageError || 'Scan failed'}`});
      return;
    }
    browser.browserAction.setBadgeBackgroundColor({color: '#5555a5'});
    browser.browserAction.setTitle({title: 'Update Scanner'});
    if (updateCount === 0) {
      browser.browserAction.setBadgeText({text: ''});
    } else {
      browser.browserAction.setBadgeText({text: updateCount.toString()});
    }
  }

  /**
   * If this is the first time the addon has been run, create a Page with
   * the Update Scanner website and scan it immediately.
   */
  async _checkFirstRun() {
    const config = await new Config().load();
    if (config.get('isFirstRun')) {
      const page = await this.pageStore.createWebsitePage();
      config.set('isFirstRun', false);
      config.set('updateVersion', latestVersion);
      await config.save();

      this.scanQueue.add([page]);
      this.scanQueue.scan();
    }
  }

  /**
   * If the data structures aren't up to date, open the Update page to perform
   * an update.
   */
  async _checkIfUpdateRequired() {
    if (!(await isUpToDate())) {
      openUpdate();
    }
  }

  /**
   * Manual scan of all Pages in the PageStore.
   */
  _scanAll() {
    this._scanItem(PageStore.ROOT_ID);
  }

  /**
   * Manual scan of a single item. If the item is a PageFolder, scan all items
   * in the folder.
   *
   * @param {string} itemId - ID of the item to scan.
   */
  _scanItem(itemId) {
    const scanList = this.pageStore.getDescendantPages(itemId);

    log(`Pages to manually scan: ${scanList.length}`);
    // Right-click Scan must take priority for both pages and folders.
    // addNext() promotes existing queued entries without duplicating them,
    // while preserving the relative order of previously queued work.
    this.scanQueue.addNext(scanList);
    log(`Manual scan queued next: ${itemId} (${scanList.length} pages)`);
    this.scanQueue.manualScan().catch(error => {
      console.error('Manual scan failed:', error);
    });
  }

  /**
   * Called whenever a scan is complete.
   *
   * @param {ScanResult} result - Object containing the result of the scan.
   */
  _handleScanComplete({majorChanges, scanCount, isManualScan}) {
    // Wait for pageStore to be fully updated before triggering the notification
    window.setTimeout(() => {
      log(`Scan complete, ${majorChanges} new changes.`);
      log(`${scanCount} pages scanned.`);

      // If the user has already viewed some changes, don't include in the count
      const changeCount = this.pageStore.getChangedPageList().length;
      const notifyChangeCount = Math.min(majorChanges, changeCount);

      if (notifyChangeCount > 0 || isManualScan) {
        showNotification(notifyChangeCount);
      }
    }, 1000);
  }
}
