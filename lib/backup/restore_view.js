import {$on, qs, showElement, hideElement} from '/lib/util/view_helpers.js';

/**
 * @param {Function} clickHandler - Called when the Upload button is clicked.
 */
export function showUploadButton(clickHandler) {
  showElement(qs('#uploading'));

  $on(qs('#upload-button'), 'click', clickHandler);
}

/**
 * Show the automatic backups kept in the bookmarks, so one can be restored.
 *
 * @param {Array.<object>} snapshots - From listSnapshots(), newest first.
 * @param {Function} restoreHandler - Called with the chosen snapshot's ID.
 */
export function showBookmarkBackups(snapshots, restoreHandler) {
  const list = qs('#bookmark-backup-list');
  list.textContent = '';
  for (const snapshot of snapshots) {
    const option = document.createElement('option');
    option.value = snapshot.id;
    option.textContent = snapshot.title;
    list.appendChild(option);
  }
  showElement(qs('#bookmark-backups'));

  $on(qs('#bookmark-restore-button'), 'click',
    () => restoreHandler(list.value));
}

/**
 * Go back to the choice of what to restore, after a restore was cancelled.
 */
export function showUploadAgain() {
  hideElement(qs('#restoring'));
  showElement(qs('#uploading'));
}

/**
 * Show a dialog asking for confirmation before restoring pages.
 *
 * @returns {boolean} True if the user confirmed the restore.
 */
export function confirmRestore() {
  return window.confirm(
    'Restoring will replace your existing pages - are you sure?\n\n' +
    'A copy of your current pages is saved in your bookmarks first, so ' +
    'you can come back to them.');
}

/**
 * Display the "Restoring" progress message.
 */
export function showRestoring() {
  showElement(qs('#restoring'));
  hideElement(qs('#uploading'));
  hideElement(qs('#restore-complete'));
  hideElement(qs('#restore-failed'));
}

/**
 * Display the "Restore Complete" message.
 */
export function showComplete() {
  hideElement(qs('#restoring'));
  hideElement(qs('#uploading'));
  showElement(qs('#restore-complete'));
  hideElement(qs('#restore-failed'));
}

/**
 * Display the "Restore Failed" message.
 */
export function showFailed() {
  hideElement(qs('#restoring'));
  hideElement(qs('#uploading'));
  hideElement(qs('#restore-complete'));
  showElement(qs('#restore-failed'));
}
