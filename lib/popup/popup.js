import {loadGlobalDefaults} from '/lib/page/bulk_settings.js';
import * as view from './popup_view.js';
import {openMain, openMainAuto, showAllChanges, paramEnum, actionEnum}
  from '/lib/main/main_url.js';
import {backgroundActionEnum} from '/lib/background/actions.js';
import {PageStore, hasPageStateChanged, isItemChanged}
  from '/lib/page/page_store.js';
import {createBackupJson, loadBackupExtras} from '/lib/backup/backup.js';
import {openRestoreUrl} from '/lib/backup/restore_url.js';
import {waitForMs} from '/lib/util/promise.js';
import {buildUblockFilters} from '/lib/scan/ublock_filters.js';
import {HIDE_EXCLUDED_KEY} from '/lib/scan/excluded_parts.js';

/**
 * Class representing the Update Scanner toolbar popup.
 */
export class Popup {
  /**
   * @property {PageStore} pageStore - Object used for saving and loading data
   * from storage.
   */
  constructor() {
    this.pageStore = null;
  }

  /**
   * Initialises the popup data and event handlers.
   */
  async init() {
    // Small delay to allow popup to render
    await waitForMs(100);

    this.pageStore = await PageStore.load();
    this.pageStore.bindPageUpdate(this._handlePageUpdate.bind(this));

    view.init();
    // URS_TEST_PASS_CAPTURE_V1: explicit opt-in, off by default.
    const captureCheck = document.querySelector('#urs-pass-capture-checkbox');
    if (captureCheck) {
      browser.storage.local.get('ursDiagnosticPassCaptures').then(values => {
        captureCheck.checked = values.ursDiagnosticPassCaptures === true;
      }).catch(error => console.warn('URS test toggle read failed', error));
      captureCheck.addEventListener('change', () => {
        browser.storage.local.set({ursDiagnosticPassCaptures: captureCheck.checked})
          .catch(error => console.warn('URS test toggle save failed', error));
      });
    }
    this._initDebugToolsToggle(captureCheck);
    const viewCaptures = document.querySelector('#urs-view-pass-captures');
    if (viewCaptures) viewCaptures.addEventListener('click', event => {
      event.preventDefault();
      browser.tabs.create({url: browser.runtime.getURL('app/pass_captures/pass_captures.html')});
      window.close();
    });
    view.bindShowAllClick(this._handleShowAllClick.bind(this));
    view.bindNewClick(this._handleNewClick.bind(this));
    view.bindSidebarClick(this._handleSidebarClick.bind(this));
    view.bindScanAllClick(this._handleScanAllClick.bind(this));
    view.bindBackupClick(this._handleBackupClick.bind(this));
    view.bindRestoreClick(this._handleRestoreClick.bind(this));
    view.bindHelpClick(this._handleHelpClick.bind(this));
    document.querySelector('#page-settings-menu')
      .addEventListener('click', () => this._handlePageSettingsClick());
    this._initLiveHide();
    document.querySelector('#live-pick-button')
      .addEventListener('click', () => this._handleLivePickClick());
    document.querySelector('#copy-filters-button')
      .addEventListener('click', () => this._handleUblockClick());
    document.querySelector('#global-settings-menu').addEventListener('click', async () => {
      // Wait for the tab to be created before the popup closes.
      await openMain({[paramEnum.ACTION]: 'global_settings'}, true, true);
      window.close();
    });
    view.bindPageClick(this._handlePageClick.bind(this));

    this._refreshPageList();
  }

  /**
   * The debug tools (capture each Dynamic pass) are hidden until the Update
   * Scanner arrow in the popup header is clicked 7 times in a row (each click
   * within 2 seconds of the last). Seven more clicks hide them again. The
   * choice is remembered. Hiding the tools also turns capture off, so a hidden
   * option can never keep slowing scans down.
   */
  _initDebugToolsToggle(captureCheck) {
    const panel = document.querySelector('#urs-scan-test-tools');
    const arrow = document.querySelector('.icon-section-header');
    if (!panel || !arrow) return;
    const CLICKS = 7;
    const GAP_MS = 2000;
    const show = visible => { panel.style.display = visible ? '' : 'none'; };
    browser.storage.local.get('ursDebugToolsVisible')
      .then(values => show(values.ursDebugToolsVisible === true))
      .catch(error => console.warn('URS debug tools read failed', error));
    let count = 0;
    let last = 0;
    arrow.addEventListener('click', () => {
      const now = Date.now();
      count = (now - last > GAP_MS) ? 1 : count + 1;
      last = now;
      if (count < CLICKS) return;
      count = 0;
      const visible = panel.style.display === 'none';
      show(visible);
      const save = {ursDebugToolsVisible: visible};
      if (!visible) {
        save.ursDiagnosticPassCaptures = false;
        if (captureCheck) captureCheck.checked = false;
      }
      browser.storage.local.set(save)
        .catch(error => console.warn('URS debug tools save failed', error));
    });
  }

  /**
   * Update the page list to show all pages in the 'changed'' state.
   */
  _refreshPageList() {
    view.clearPageList();
    this.pageStore.getPageList()
      .filter((page) => isItemChanged(page) || page.state === 'down')
      .map(view.addPage);
  }

  /**
   * Called when the New button is clicked, to open the page to create a new
   * scan item.
   */
  async _handleNewClick() {
    const tabs = await browser.tabs.query({currentWindow: true, active: true});
    await openMain({
      [paramEnum.ACTION]: actionEnum.NEW_PAGE,
      [paramEnum.TITLE]: tabs[0].title,
      [paramEnum.URL]: tabs[0].url,
    }, true, true);
    window.close();
  }

  /**
   * Called when the Sidebar button is clicked, to open the sidebar.
   */
  _handleSidebarClick() {
    browser.sidebarAction.open();
    window.close();
  }

  /**
   * Called when the Scan All menu item is clicked, to scan all pages.
   */
  _handleScanAllClick() {
    browser.runtime.sendMessage({action: backgroundActionEnum.SCAN_ALL});
    window.close();
  }

  /**
   * Called when the Backup menu item is clicked, to backup pages to a file.
   */
  async _handleBackupClick() {
    const blob = new Blob(
      [createBackupJson(this.pageStore, await loadGlobalDefaults(), await loadBackupExtras())],
      {type: 'application/json'},
    );
    const url = URL.createObjectURL(blob);

    await view.downloadUrl(url, 'Update Scanner Backup.json');
    URL.revokeObjectURL(url);
  }

  /**
   * Called when the Page Settings menu item is clicked: opens the settings of
   * the scanned page that is open in the current tab.
   */
  async _handlePageSettingsClick() {
    const item = document.querySelector('#page-settings-menu');
    const original = item.textContent;
    const [tab] = await browser.tabs.query({currentWindow: true, active: true});
    // Same address, ignoring a #fragment and a trailing slash.
    const clean = (address) => String(address || '').split('#')[0].replace(/\/+$/, '');
    const page = tab && this.pageStore.getPageList()
      .find((entry) => clean(entry.url) === clean(tab.url));
    if (!page) {
      item.textContent = 'This page is not being scanned';
      setTimeout(() => {
        item.textContent = original;
      }, 3000);
      return;
    }
    await openMain({
      [paramEnum.ACTION]: actionEnum.SHOW_SETTINGS,
      [paramEnum.ID]: page.id,
    }, true, true);
    window.close();
  }

  /**
   * The menu switch "Hide excluded parts on sites": shows On / Off and flips it.
   */
  async _initLiveHide() {
    const item = document.querySelector('#live-hide-menu');
    const base = item.textContent;
    const show = (on) => {
      item.textContent = `${base}: ${on ? 'On' : 'Off'}`;
    };
    const stored = await browser.storage.local.get(HIDE_EXCLUDED_KEY);
    show(stored[HIDE_EXCLUDED_KEY] === true);
    item.addEventListener('click', async () => {
      const now = await browser.storage.local.get(HIDE_EXCLUDED_KEY);
      const next = now[HIDE_EXCLUDED_KEY] !== true;
      await browser.storage.local.set({[HIDE_EXCLUDED_KEY]: next});
      show(next);
    });
  }

  /**
   * Called when the Pick on this page menu item is clicked: starts the picker in
   * the page of the current tab.
   */
  async _handleLivePickClick() {
    const [tab] = await browser.tabs.query({currentWindow: true, active: true});
    if (!tab || !/^https?:/.test(tab.url || '')) {
      this._note('Open a web page first, then press the picker.', 4000);
      return;
    }
    try {
      await browser.tabs.executeScript(tab.id, {file: '/lib/live_picker/selector_core.js'});
      await browser.tabs.executeScript(tab.id, {file: '/lib/live_picker/live_picker.js'});
      window.close();
    } catch (error) {
      this._note('Cannot pick on this page.', 4000);
    }
  }

  /**
   * Called when the Copy uBlock Filters menu item is clicked: copies the ignored
   * parts of every link as one block of uBlock Origin filters.
   */
  /**
   * Show a short message under the header of the popup.
   *
   * @param {string} text - The message.
   * @param {number} ms - How long to show it.
   */
  _note(text, ms = 7000) {
    const note = document.querySelector('#popup-note');
    note.textContent = text;
    note.classList.remove('hidden');
    clearTimeout(this._noteTimer);
    this._noteTimer = setTimeout(() => note.classList.add('hidden'), ms);
  }

  async _handleUblockClick() {
    const entries = [];
    const walk = (folderId) => {
      for (const id of this.pageStore.getItem(folderId).children) {
        const item = this.pageStore.getItem(id);
        if (item.children) walk(id);
        else entries.push({url: item.url, title: item.title, parts: item.excludedParts});
      }
    };
    walk(PageStore.ROOT_ID);
    const result = buildUblockFilters(entries, new Date().toISOString().slice(0, 10));
    try {
      if (!result.filters) throw new Error('none');
      await navigator.clipboard.writeText(result.text);
      this._note(`Copied ${result.filters} filter${result.filters === 1 ? '' : 's'} from ` +
        `${result.sites} site${result.sites === 1 ? '' : 's'} (${result.siteNames.join(', ')})` +
        (result.notExcluded ? `; ${result.notExcluded} Ignore part${result.notExcluded === 1 ? '' : 's'} not copied` : '') +
        '. They are on the clipboard: paste them into uBlock Origin, Dashboard, My filters.', 9000);
    } catch (error) {
      this._note(result.filters ? 'Could not copy to the clipboard.' : (result.notExcluded ?
        `Nothing to copy: the ${result.notExcluded} saved parts are Ignore, not Exclude.` :
        `Nothing to copy yet: no excluded parts (${result.linkCount} links read).`));
    }
  }

  /**
   * Called when the Restore menu item is clicked, to restore pages from a file.
   */
  async _handleRestoreClick() {
    openRestoreUrl();
    window.close();
  }

  /**
   * Called when the Help menu item is clicked, to open the Update Scanner
   * Reborn issues page on GitHub (questions, bugs and requests go there).
   */
  _handleHelpClick() {
    browser.tabs.create({url:
      'https://github.com/molitar/update-scanner-reborn/issues'});
    window.close();
  }

  /**
   * Called when the "Show All Updates" button is clicked, to open all changes
   * in new tabs.
   */
  async _handleShowAllClick() {
    await showAllChanges();
    window.close();
  }

  /**
   * Called when an item in the page list is clicked, to view that page.
   *
   * @param {string} pageId - ID of the clicked page.
   */
  _handlePageClick(pageId) {
    if (pageId !== undefined) {
      const params = {
        [paramEnum.ACTION]: actionEnum.SHOW_DIFF,
        [paramEnum.ID]: pageId,
      };
      const item = this.pageStore && this.pageStore.getItem(pageId);
      openMainAuto(params, item ? item.url : '');
    }
  }

  /**
   * Called when a Page is updated in Storage. Refresh the page list if its
   * state changed.
   *
   * @param {string} pageId - ID of the changed Page.
   * @param {storage.StorageChange} change - Object representing the change.
   */
  _handlePageUpdate(pageId, change) {
    if (hasPageStateChanged(change)) {
      this._refreshPageList();
    }
  }
}
