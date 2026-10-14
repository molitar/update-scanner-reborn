import {pickSettings} from '/lib/page/bulk_settings.js';
import {THRESHOLD_STEPS, typicalChange, MIN_SCANS_FOR_TYPICAL}
  from '/lib/page/thresholds.js';
import {qs, $on, hideElement, showElement} from '/lib/util/view_helpers.js';

// See https://bugzilla.mozilla.org/show_bug.cgi?id=840640
import dialogPolyfill
  from '/dependencies/module/dialog-polyfill/dist/dialog-polyfill.esm.js';
import {Page} from '../page/page.js';

/**
 * Initialise the dialog box.
 */
export function init() {
  const dialog = qs("#settings-dialog");
  dialogPolyfill.registerDialog(dialog);

  const form = qs("#settings-form");
  form.elements["autoscan"].max = AutoscanSliderToMins.length - 1;
  form.elements["threshold"].max = ThresholdSliderToChars.length - 1;
  form.elements["notification-duration"].min = 1;
  form.elements["notification-duration"].max = NotificationDurationUntilClicked;

  $on(form.elements["autoscan"], "input", ({target}) =>
    updateAutoscanDescription(target.value),
  );
  $on(form.elements["threshold"], "input", ({target}) => {
    updateThresholdDescription(target.value);
    renderChangeSizeInfo();
  });
  $on(qs("#use-suggested-threshold"), "click", () => {
    form.elements["threshold"].value = suggestedThresholdIndex;
    updateThresholdDescription(suggestedThresholdIndex);
    renderChangeSizeInfo();
  });
  // The lock is the user's own choice. Picking a fixed mode never turns it on;
  // picking Automatic turns it off (Automatic cannot be locked), and turning
  // the lock off switches the dropdown to Automatic so the change is visible.
  $on(form.elements["scan-mode"], "input", () => {
    if (form.elements["scan-mode"].value === "auto") {
      form.elements["scan-mode-locked"].checked = false;
    }
    updateScanModeDescription();
  });
  $on(form.elements["scan-mode-locked"], "input", () => {
    const select = form.elements["scan-mode"];
    if (form.elements["scan-mode-locked"].checked) {
      // Locking keeps the mode the link is using now (Standard if unknown).
      if (select.value === "auto") select.value = lockableScanMode;
    } else {
      // Unlocking goes back to Automatic, so the change is visible.
      select.value = "auto";
    }
    updateScanModeDescription();
  });
  $on(form.elements["notification-duration"], "input", ({target}) =>
    updateNotificationDurationDescription(target.value),
  );
  $on(form.elements["show-notification"], "input", () =>
    updateNotificationUI(),
  );
  $on(form.elements["play-notification-sound"], "input", () =>
    updateNotificationSoundUI(),
  );
  $on(form.elements["notification-sound-type"], "input", () =>
    updateNotificationSoundUI(),
  );
  $on(form.elements["notification-sound-file"], "change", ({target}) => {
    const file = target.files && target.files[0];
    form.elements["notification-sound-name"].value =
      file ? file.name : "No custom sound selected";
  });

  $on(form, "reset", () => dialog.close());
}

/**
 * Show the settings dialog for the specified Page.
 *
 * @param {Page} page - Page object to view.
 *
 * @returns {Promise} Promise that resolves with an object containing the
 * updated page settings.
 */
export function openPageDialog(page) {
  const dialog = qs("#settings-dialog");
  const form = qs("#settings-form");

  prepareSettingsDialog('page');
  dialog.returnValue = '';
  form.elements["title"].value = page.title;
  form.elements["url"].value = page.url;

  const scanMode = ["standard", "dynamic", "popup"].includes(page.scanMode) ?
    page.scanMode : "standard";
  const scanAuto = page.scanModeAuto !== false && page.scanModeLocked !== true;
  const scanLocked = page.scanModeLocked === true;
  const scanChoice = scanAuto ? "auto" : scanMode;
  form.elements["scan-mode"].value = scanChoice;
  form.elements["scan-mode-locked"].checked = scanLocked;
  form.elements["scan-mode-recheck"].checked = false;
  lockableScanMode = scanMode;
  currentScanMode = scanMode;
  detectedScanMode = page.scanModeDetected === true ? scanMode : null;
  autoOptionText = page.scanModeDetected === true ?
    `Automatic (using ${ScanModeNames[scanMode]})` :
    "Automatic (checks on the next scan)";
  updateScanModeDescription();

  const autoscanSliderValue = autoscanMinsToSlider(page.scanRateMinutes);
  form.elements["autoscan"].value = autoscanSliderValue;
  updateAutoscanDescription(autoscanSliderValue);

  const thresholdSliderValue = thresholdCharsToSlider(page.changeThreshold);
  form.elements["threshold"].value = thresholdSliderValue;
  updateThresholdDescription(thresholdSliderValue);

  changeSizes = (page.changeSizes || [])
    .map((entry) => Number(entry && entry.size))
    .filter((size) => Number.isFinite(size) && size > 0);
  renderChangeSizeInfo();

  form.elements["ignore-numbers"].checked = page.ignoreNumbers;

  form.elements["show-notification"].checked =
    page.showNotification !== false;

  const notificationDuration =
    page.notificationUntilClicked === true ?
      NotificationDurationUntilClicked :
      Math.min(15, Math.max(1, Number(page.notificationDurationSeconds) || 5));

  form.elements["notification-duration"].value = notificationDuration;
  updateNotificationDurationDescription(notificationDuration);

  form.elements["play-notification-sound"].checked =
    page.playNotificationSound === true;

  form.elements["notification-sound-type"].value =
    page.notificationSoundType === "custom" ? "custom" : "default";

  form.elements["notification-sound-file"].value = "";
  form.elements["notification-sound-name"].value =
    page.notificationSoundName || "No custom sound selected";

  updateNotificationUI();
  updateNotificationSoundUI();

  hideElement(qs("#folder-heading"));

  dialog.showModal();

  return new Promise((resolve, reject) => {
    $on(dialog, "close", async () => {
      if (dialog.returnValue === "ok") {
        const durationValue =
          Number(form.elements["notification-duration"].value);

        let soundData = page.notificationSoundData || null;
        let soundName = page.notificationSoundName || null;
        const selectedFile =
          form.elements["notification-sound-file"].files[0];

        if (form.elements["notification-sound-type"].value === "custom" &&
            selectedFile) {
          soundData = await readFileAsDataUrl(selectedFile);
          soundName = selectedFile.name;
        }

        resolve({
          title: form.elements["title"].value,
          url: form.elements["url"].value,
          scanRateMinutes:
            AutoscanSliderToMins[form.elements["autoscan"].value],
          changeThreshold:
            ThresholdSliderToChars[form.elements["threshold"].value],
          ignoreNumbers: form.elements["ignore-numbers"].checked,

          ...pageScanModeResult(
            form.elements["scan-mode"].value,
            form.elements["scan-mode-locked"].checked,
            {auto: scanAuto, locked: scanLocked, mode: scanMode},
            form.elements["scan-mode-recheck"].checked),

          showNotification:
            form.elements["show-notification"].checked,
          notificationUntilClicked:
            durationValue === NotificationDurationUntilClicked,
          notificationDurationSeconds:
            durationValue === NotificationDurationUntilClicked ?
              (Number(page.notificationDurationSeconds) || 5) :
              durationValue,

          playNotificationSound:
            form.elements["play-notification-sound"].checked,
          notificationSoundType:
            form.elements["notification-sound-type"].value,
          notificationSoundData: soundData,
          notificationSoundName: soundName,

          selectors: null,
          contentMode: Page.contentModeEnum.TEXT,
          requireExactMatchCount: false,
          partialScan: false,
        });
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Show the settings dialog for the specified PageFolder.
 *
 * @param {PageFolder} pageFolder - PageFolder object to view.
 *
 * @returns {Promise} Promise that resolves with an object containing the
 * updated pageFolder settings.
 */
// UPDATESCAN_BULK_SETTINGS_DIALOG_V1
export function openPageFolderDialog(pageFolder, defaults = {}) {
  return openBulkSettingsDialog(
    {...defaults, ...pageFolder.childSettings}, pageFolder.title, false);
}

export function openGlobalSettingsDialog(defaults) {
  return openBulkSettingsDialog(defaults, '', true);
}

function prepareSettingsDialog(kind) {
  const page = kind === 'page';
  const visibility = {
    'page-heading': page,
    'folder-heading': kind === 'folder',
    'global-heading': kind === 'global',
    'titleFieldset': kind !== 'global',
    'urlFieldset': page,
    'autoscanFieldset': true,
    'thresholdFieldset': true,
    'change-size-info': page,
    'scanModeFieldset': true,
    'notificationFieldset': true,
    'bulk-intro': !page,
    'apply-autoscan-row': !page,
    'apply-detection-row': !page,
    'apply-scan-mode-row': !page,
    'apply-notifications-row': !page,
    'sortFieldset': !page,
  };
  for (const [id, visible] of Object.entries(visibility)) {
    const element = qs('#' + id);
    if (element) (visible ? showElement : hideElement)(element);
  }
}

function openBulkSettingsDialog(settings, title, global) {
  const dialog = qs('#settings-dialog');
  const form = qs('#settings-form');
  const value = {...Page.DEFAULTS, ...pickSettings(settings)};
  prepareSettingsDialog(global ? 'global' : 'folder');
  form.elements['title'].value = title;
  const autoscanValue = autoscanMinsToSlider(value.scanRateMinutes);
  form.elements['autoscan'].value = autoscanValue;
  updateAutoscanDescription(autoscanValue);
  const bulkFixed = value.scanModeLocked === true || value.scanModeAuto === false;
  form.elements['scan-mode'].value = bulkFixed ? (value.scanMode || 'standard') : 'auto';
  form.elements['scan-mode-locked'].checked = value.scanModeLocked === true;
  form.elements['scan-mode-recheck'].checked = false;
  lockableScanMode = 'standard';
  currentScanMode = null;
  detectedScanMode = null;
  autoOptionText = 'Automatic (recommended)';
  updateScanModeDescription();
  const thresholdValue = thresholdCharsToSlider(value.changeThreshold);
  form.elements['threshold'].value = thresholdValue;
  updateThresholdDescription(thresholdValue);
  form.elements['ignore-numbers'].checked = value.ignoreNumbers === true;
  form.elements['show-notification'].checked = value.showNotification !== false;
  const duration = value.notificationUntilClicked ? 16 :
    Math.min(15, Math.max(1, Number(value.notificationDurationSeconds) || 5));
  form.elements['notification-duration'].value = duration;
  updateNotificationDurationDescription(duration);
  form.elements['play-notification-sound'].checked =
    value.playNotificationSound === true;
  form.elements['notification-sound-type'].value =
    value.notificationSoundType === 'custom' ? 'custom' : 'default';
  form.elements['notification-sound-file'].value = '';
  form.elements['notification-sound-name'].value =
    value.notificationSoundName || 'No custom sound selected';
  form.elements['sort-now'].checked = false;
  form.elements['sort-folders-first'].checked = false;
  form.elements['sort-folders-first'].disabled = true;
  form.elements['sort-now'].onchange = () => {
    form.elements['sort-folders-first'].disabled = !form.elements['sort-now'].checked;
  };
  qs('#sort-now-label').textContent = global ?
    'Sort all folders and links alphabetically (A to Z)' :
    'Sort this folder and the folders inside it alphabetically (A to Z)';
  // Every "apply to existing links" box starts unchecked, so nothing existing
  // is changed unless the user ticks the box right under that setting.
  const where = global ? 'all existing links' : 'all existing links in this folder';
  for (const [id, what] of [
    ['autoscan', 'this Autoscan interval'],
    ['detection', 'this change threshold and number setting'],
    ['scan-mode', 'this scan mode and lock'],
    ['notifications', 'these notification and audio settings'],
  ]) {
    form.elements['apply-' + id].checked = false;
    qs(`label[for="apply-${id}"]`).textContent = `Apply ${what} to ${where}`;
  }
  applyScopeText = where;
  updateScanModeDescription();
  qs('#bulk-intro').textContent = global ?
    'These settings are the defaults for new links. A box under a setting also changes that setting on all of your existing links; leave it unchecked to leave them alone.' :
    'These settings are the defaults for new links in this folder. A box under a setting also changes that setting on the links already in this folder (and its subfolders); leave it unchecked to leave them alone.';
  updateNotificationUI();
  updateNotificationSoundUI();
  dialog.returnValue = '';
  return new Promise((resolve, reject) => {
    dialog.addEventListener('close', async () => {
      if (dialog.returnValue !== 'ok') {
        resolve(null);
        return;
      }
      try {
        const durationValue = Number(form.elements['notification-duration'].value);
        let soundData = value.notificationSoundData || null;
        let soundName = value.notificationSoundName || null;
        const file = form.elements['notification-sound-file'].files[0];
        if (form.elements['notification-sound-type'].value === 'custom' && file) {
          soundData = await readFileAsDataUrl(file);
          soundName = file.name;
        }
        resolve({
          title: form.elements['title'].value,
          settings: {
            scanRateMinutes:
              AutoscanSliderToMins[form.elements['autoscan'].value],
            ...bulkScanModeSettings(
              form.elements['scan-mode'].value,
              form.elements['scan-mode-locked'].checked),
            changeThreshold:
              ThresholdSliderToChars[form.elements['threshold'].value],
            ignoreNumbers: form.elements['ignore-numbers'].checked,
            showNotification: form.elements['show-notification'].checked,
            notificationDurationSeconds: durationValue === 16 ?
              (Number(value.notificationDurationSeconds) || 5) : durationValue,
            notificationUntilClicked: durationValue === 16,
            playNotificationSound: form.elements['play-notification-sound'].checked,
            notificationSoundType: form.elements['notification-sound-type'].value,
            notificationSoundData: soundData,
            notificationSoundName: soundName,
          },
          applyDescendants: (
            form.elements['apply-autoscan'].checked ||
            form.elements['apply-scan-mode'].checked ||
            form.elements['apply-notifications'].checked ||
            form.elements['apply-detection'].checked
          ),
          sort: {
            enabled: form.elements['sort-now'].checked,
            foldersFirst: form.elements['sort-folders-first'].checked,
          },
          groups: {
            scan: form.elements['apply-scan-mode'].checked,
            autoscan: form.elements['apply-autoscan'].checked,
            notifications: form.elements['apply-notifications'].checked,
            detection: form.elements['apply-detection'].checked,
          },
        });
      } catch (error) {
        reject(error);
      }
    }, {once: true});
    dialog.showModal();
  });
}

const AutoscanSliderMap = new Map([
  [5, 'Scan every 5 minutes'],
  [15, 'Scan every 15 minutes'],
  [30, 'Scan every 30 minutes'],
  [60, 'Scan every hour'],
  [6 * 60, 'Scan every 6 hours'],
  [24 * 60, 'Scan every day'],
  [7 * 24 * 60, 'Scan every week'],
  [0, 'Manual scan only'],
]);
const AutoscanSliderToMins = [...AutoscanSliderMap.keys()];
const AutoscanSliderDescriptions = [...AutoscanSliderMap.values()];
const AutoscanSliderNever = AutoscanSliderToMins.indexOf(0);

/**
 * @param {number} minutes - Number of minutes between scans.
 *
 * @returns {number} Slider value representing the given number of minutes.
 */
function autoscanMinsToSlider(minutes) {
  if (minutes === 0) {
    return AutoscanSliderNever;
  }

  // Walk through the options, returning the first one that matches
  for (let i = 0; i < AutoscanSliderToMins.length; i++) {
    if (AutoscanSliderToMins[i] >= minutes) {
      return i;
    }
  }

  // Round down to 7 weeks
  return AutoscanSliderNever - 1;
}

/**
 * Update the Autoscan description text based on the current slider value.
 *
 * @param {number} sliderValue - Autoscan slider value.
 */
function updateAutoscanDescription(sliderValue) {
  qs('#settings-form').elements['autoscan-description'].value =
    AutoscanSliderDescriptions[sliderValue];
}

const NotificationDurationUntilClicked = 16;

// Scan mode. The dropdown offers Automatic or a fixed mode (Standard, Dynamic,
// Popup); the Lock switch is a separate choice that only the user makes.
//   Automatic  works out the best mode on the first scan (Standard, then
//              Dynamic, then Popup if page text is missing), then KEEPS it.
//              Only choosing Automatic again, or turning the lock off, makes
//              it check again. It cannot be locked.
//   Fixed      the chosen mode is used for every scan and never checked.
//   Locked     a fixed mode that is never changed for any reason, and no other
//              kind of scan is tried even when scans fail.
// Stored as scanMode + scanModeAuto + scanModeLocked.
let applyScopeText = 'all existing links';
let currentScanMode = null; // the mode a link is using right now (link dialog only)
let detectedScanMode = null; // set once Automatic has settled on a mode (link dialog only)
let lockableScanMode = 'standard'; // what switching the lock ON locks to
let autoOptionText = 'Automatic (recommended)';

const ScanModeNames = {standard: 'Standard', dynamic: 'Dynamic', popup: 'Popup'};

function bulkScanModeSettings(choice, locked) {
  return choice === 'auto' ?
    {scanMode: 'standard', scanModeAuto: true, scanModeLocked: false} :
    {scanMode: choice, scanModeAuto: false, scanModeLocked: locked === true};
}

/**
 * Work out the scan-mode fields to save from a single link's settings dialog.
 * Choosing Automatic again keeps the mode the link has settled on, unless the
 * link was fixed before or "check again" is ticked: then it starts over from
 * Standard and is checked once on its next scan.
 */
function pageScanModeResult(choice, locked, previous, recheck) {
  const previousChoice = previous.auto ? 'auto' : previous.mode;
  if (choice !== 'auto') {
    return {
      scanMode: choice, scanModeAuto: false, scanModeLocked: locked,
      scanModeChanged: choice !== previousChoice || locked !== previous.locked,
      scanModeReset: false,
    };
  }
  const reset = recheck || !previous.auto;
  return {
    scanMode: reset ? 'standard' : previous.mode,
    scanModeAuto: true, scanModeLocked: false,
    scanModeChanged: !previous.auto, scanModeReset: reset,
  };
}

function updateScanModeDescription() {
  const form = qs("#settings-form");
  const choice = form.elements['scan-mode'].value;
  const auto = choice === 'auto';
  const locked = form.elements['scan-mode-locked'].checked;
  const isPage = !qs('#apply-scan-mode-row') ||
    qs('#apply-scan-mode-row').classList.contains('hidden');

  // The first dropdown entry says which mode Automatic is using, once known.
  form.elements['scan-mode'].options[0].textContent = autoOptionText;

  let text;
  if (auto) {
    text = 'Works out the best scan mode on the first scan: Standard, and if the page ' +
      'is not fully captured, Dynamic, then Popup. Once found it keeps that mode until ' +
      'you choose Automatic again to check again.';
    if (isPage) {
      text += detectedScanMode ?
        ` Detected: ${ScanModeNames[detectedScanMode]}.` :
        ' Not checked yet: it will be checked on the next scan.';
    }
  } else {
    text = `Every scan uses ${ScanModeNames[choice]} mode and it is never changed automatically.` +
      (choice === 'standard' ? ' The first scan takes a few seconds longer: it checks the page once and notes in the log if Standard misses anything.' : '');
  }
  form.elements['scan-mode-description'].value = text;

  const help = qs('#scan-mode-lock-help');
  if (help) {
    help.textContent = locked ?
      'Locked: this mode never changes for any reason, and no other kind of scan is tried even if scans keep failing.' :
      auto ?
        'Not locked. Turn the lock on to fix a scan mode permanently.' :
        'Not locked: if a scan fails, a different kind of scan may be tried for that scan only. Turn the lock on to prevent even that.';
  }

  // "Check again" is for a single link that is on Automatic.
  const recheckRow = qs('#scan-mode-recheck-row');
  if (recheckRow) {
    (isPage && auto ? showElement : hideElement)(recheckRow);
  }
  // The folder/global box says exactly what it does for the chosen setting.
  const applyLabel = qs('label[for="apply-scan-mode"]');
  if (applyLabel && !isPage) {
    applyLabel.textContent = auto ?
      `Reset ${applyScopeText} to Automatic (each one checks for its best scan mode once, on its next scan)` :
      locked ?
        `Lock ${applyScopeText} to ${ScanModeNames[choice]} mode (it will never be changed)` :
        `Set ${applyScopeText} to ${ScanModeNames[choice]} mode (not locked)`;
  }
}

function updateNotificationDurationDescription(sliderValue) {
  const value = Number(sliderValue);
  const form = qs("#settings-form");
  form.elements["notification-duration-description"].value =
    value === NotificationDurationUntilClicked ?
      "Until clicked" :
      `${value} second${value === 1 ? "" : "s"}`;
}

function updateNotificationUI() {
  const form = qs("#settings-form");
  form.elements["notification-duration"].disabled =
    !form.elements["show-notification"].checked;
}

function updateNotificationSoundUI() {
  const form = qs("#settings-form");
  const enabled = form.elements["play-notification-sound"].checked;
  const custom =
    form.elements["notification-sound-type"].value === "custom";

  form.elements["notification-sound-type"].disabled = !enabled;
  form.elements["notification-sound-file"].disabled =
    !enabled || !custom;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// The slider steps live in thresholds.js so the Changes view and the sidebar
// describe changes with the same numbers.
const ThresholdSliderMap = new Map([
  [0, ['All changes are detected', '']],
  ...THRESHOLD_STEPS.map(([chars, label]) => [
    chars,
    [`${label} changes are ignored`, `(less than about ${chars} characters)`],
  ]),
]);
const ThresholdSliderToChars = [...ThresholdSliderMap.keys()];
const ThresholdSliderDescriptions = [...ThresholdSliderMap.values()];

/**
 * @param {number} changeThreshold - Change threshold measured in characters.
 *
 * @returns {number} Slider value representing the given number of characters.
 */
function thresholdCharsToSlider(changeThreshold) {
  // Walk through the options, returning the first one that matches
  for (let i = 0; i < ThresholdSliderToChars.length; i++) {
    if (ThresholdSliderToChars[i] >= changeThreshold) {
      return i;
    }
  }
  // Larger than every option: show the highest one (the old code returned 0,
  // "All changes are detected", here).
  return ThresholdSliderToChars.length - 1;
}

// Sizes (characters) of the changes recently seen on the page being edited,
// oldest first, and the slider position that would have ignored all of them.
let changeSizes = [];
let suggestedThresholdIndex = 0;

/**
 * Show how big the changes seen on this page were next to the Change Threshold
 * slider, and offer the threshold that would have ignored all of them.
 */
function renderChangeSizeInfo() {
  const text = qs('#change-size-text');
  const button = qs('#use-suggested-threshold');
  if (!text || !button) return;

  if (changeSizes.length === 0) {
    text.textContent = 'No changes recorded yet. After a few scans this ' +
      'shows how big the changes on this page are, so you can choose a ' +
      'threshold.';
    hideElement(button);
    return;
  }

  const recent = changeSizes.slice(-10);
  const label = (size) => size > 1000 ? '1000+' : String(size);
  const current = ThresholdSliderToChars[
    qs('#settings-form').elements['threshold'].value];
  const ignored = recent.filter((size) => size <= current).length;
  const typical = typicalChange(changeSizes);
  const enough = typical.count >= MIN_SCANS_FOR_TYPICAL;

  let message =
    `Recent changes on this page (characters): ${recent.map(label).join(', ')}.`;
  if (enough) {
    message += ` Typical: ${label(typical.median)}; normally up to ` +
      `${label(typical.normalMax)}.`;
  }
  message += ` With the current setting, ${ignored} of ${recent.length} are ` +
    'ignored.';
  text.textContent = message;

  // Suggest the smallest threshold that ignores the page's normal changes (not
  // its biggest one, which may be a real change worth hearing about). With too
  // few scans to tell what is normal, fall back to ignoring all of them.
  const target = enough ? typical.normalMax : typical.largest;
  const index = ThresholdSliderToChars.findIndex((chars) => chars >= target);
  suggestedThresholdIndex =
    index === -1 ? ThresholdSliderToChars.length - 1 : index;
  const suggested = ThresholdSliderToChars[suggestedThresholdIndex];
  if (suggested !== current) {
    button.textContent = enough ?
      `Ignore normal changes (${suggested})` :
      `Ignore all of these (${suggested})`;
    showElement(button);
  } else {
    hideElement(button);
  }
}

/**
 * Update the Threshold description text based on the current slider value.
 *
 * @param {number} sliderValue - Threshold slider value.
 */
function updateThresholdDescription(sliderValue) {
  qs('#settings-form').elements['threshold-description'].value =
    ThresholdSliderDescriptions[sliderValue][0];
  qs('#settings-form').elements['threshold-subdescription'].value =
    ThresholdSliderDescriptions[sliderValue][1];
}
