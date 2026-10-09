import {scanPage} from './scan.js';
import {waitForMs} from '/lib/util/promise.js';

// Allow function mocking
export const __ = {
  scanPage: (...args) => scanPage(...args),
  waitForMs: (...args) => waitForMs(...args),
};

// Wait between scanning pages
const SCAN_IDLE_MS = 2000;

/**
 * @typedef {object} ScanResult
 * @property {integer} majorChanges Number of pages that had major changes
 * when scanned.
 * @property {integer} scanCount Number of pages that were scanned.
 */

/**
 * @callback ScanCompleteHandler
 * @param {ScanResult} scanResult - Object containing the result of the scan.
 */

/**
 * Class to maintain a queue of pages to scan.
 */
export class ScanQueue {
  /**
   * Create a new empty queue.
   */
  constructor() {
    // UPDATESCAN_BUSY_INDICATOR_V1
    this.currentPageId = null;
    this.scanStateRevision = 0;
    this._scanStateHandler = null;
    this.queue = [];
    this._priorityPageIds = new Set();
    this._scanCompleteHandler = null;
    this._isScanning = false;
    this._isManualScan = false;
  }

  /**
   * Bind a handler to call whenever a scan is completed.
   *
   * @param {ScanCompleteHandler} handler - Called when a scan completes.
   */
  bindScanState(handler) {
    this._scanStateHandler = handler;
  }

  _setCurrentPage(pageId) {
    this.currentPageId = pageId == null ? null : String(pageId);
    this.scanStateRevision++;
    if (this._scanStateHandler) {
      this._scanStateHandler({
        pageId: this.currentPageId,
        revision: this.scanStateRevision,
      });
    }
  }

  bindScanComplete(handler) {
    this._scanCompleteHandler = handler;
  }

  /**
   * Add a list of pages to the queue. Ignore pages that are already queued.
   *
   * @param {Array.<Page>} pageList - List of pages to add to the queue.
   */
  // UPDATESCAN_MANUAL_QUEUE_PRIORITY_V1
  add(pageList) {
    for (const page of pageList) {
      if (!page || page.id == null) continue;
      const id = String(page.id);
      if (id === this.currentPageId ||
          this.queue.some(item => String(item.id) === id)) continue;
      this.queue.push(page);
    }
  }

  addNext(pageList) {
    for (const page of pageList) {
      if (!page || page.id == null) continue;
      const id = String(page.id);
      // An already-running page finishes normally without a duplicate scan.
      if (id === this.currentPageId) continue;
      if (this._priorityPageIds.has(id)) continue;
      // Move an existing folder-queue entry rather than adding a second copy.
      this.queue = this.queue.filter(item => String(item.id) !== id);
      const insertionIndex = this.queue.filter(
        item => this._priorityPageIds.has(String(item.id))).length;
      this.queue.splice(insertionIndex, 0, page);
      this._priorityPageIds.add(id);
    }
  }

  /**
   * Start scanning the pages in the queue. When the scan is complete, call
   * the scanComplete handler. Does nothing if a scan is already in progress.
   */
  async scan() {
    if (this._isScanning) {
      return;
    }

    this._isScanning = true;
    let result;
    try {
      result = await this._processScanQueue();
    } catch (error) {
      this._isManualScan = false;
      throw error;
    } finally {
      this._isScanning = false;
      if (this.currentPageId !== null) this._setCurrentPage(null);
    }
    const {majorChanges, scanCount} = result;

    if (this._scanCompleteHandler !== null) {
      this._scanCompleteHandler({
        majorChanges: majorChanges,
        scanCount: scanCount,
        isManualScan: this._isManualScan,
      });
    }
    this._isManualScan = false;
  }

  /**
   * Identical to the scan function, but when the scanComplete handler is called
   * the isManualScan property is set.
   */
  async manualScan() {
    this._isManualScan = true;
    await this.scan();
  }

  /**
   * Scan all pages in the queue. Pages added during the scan are scanned too.
   *
   * @returns {ScanResult} Result of the scan.
   */
  async _processScanQueue() {
    let majorChanges = 0;
    let scanCount = 0;

    while (this.queue.length > 0) {
      const page = this.queue.shift();
      this._priorityPageIds.delete(String(page.id));
      this._setCurrentPage(page.id);
      let majorChange;
      try {
        majorChange = await __.scanPage(page);
      } finally {
        this._setCurrentPage(null);
      }
      if (majorChange) {
        majorChanges++;
      }
      scanCount++;

      if (this.queue.length > 0) {
        await __.waitForMs(SCAN_IDLE_MS);
      }
    }
    return {majorChanges: majorChanges, scanCount: scanCount};
  }
}
