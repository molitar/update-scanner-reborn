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
  $on(form.elements["scan-mode"], "input", ({target}) =>
    updateScanModeDescription(target.value),
  );
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
  form.elements["scan-mode"].value = scanMode;
  updateScanModeDescription(scanMode);

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

          scanMode: form.elements["scan-mode"].value,

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
    'autoscanFieldset': kind !== 'folder',
    'thresholdFieldset': true,
    'change-size-info': page,
    'scanModeFieldset': true,
    'notificationFieldset': true,
    'bulkSettingsFieldset': !page,
    'apply-autoscan-row': kind === 'global',
    'apply-descendants-row': kind === 'folder',
    'global-defaults-notes': kind === 'global',
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
  if (global) {
    const autoscanValue = autoscanMinsToSlider(value.scanRateMinutes);
    form.elements['autoscan'].value = autoscanValue;
    updateAutoscanDescription(autoscanValue);
  }
  form.elements['scan-mode'].value = value.scanMode || 'standard';
  updateScanModeDescription(form.elements['scan-mode'].value);
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
  form.elements['apply-descendants'].checked = false;
  form.elements['apply-scan-mode'].checked = false;
  form.elements['apply-autoscan'].checked = false;
  form.elements['apply-notifications'].checked = !global;
  // A folder's change threshold reaches every link under it when the folder
  // setting is applied, so nobody has to edit the links one by one.
  form.elements['apply-detection'].checked = !global;
  qs('label[for="apply-detection"]').textContent = global ?
    'Override Change Threshold and number handling' :
    'Apply change threshold and number handling';
  qs('#apply-autoscan-row label').textContent = global ?
    'Override Autoscan Settings' :
    'Apply Autoscan interval to existing links';
  qs('label[for="apply-scan-mode"]').textContent = global ?
    'Override Scan Mode' :
    'Apply scan mode (recheck automatic mode selection)';
  qs('label[for="apply-notifications"]').textContent = global ?
    'Override Notifications' :
    'Apply notification and audio settings';
  qs('#apply-descendants-label').textContent = global ?
    'Apply to all existing links' :
    'Apply to all links in this folder, including subfolders';
  qs('#bulk-settings-description').textContent = global ?
    'Select which settings to override on existing websites:' :
    'Saved settings become defaults for new links in this folder. Check below to update existing links too.';
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
            ...(global ? {
              scanRateMinutes:
                AutoscanSliderToMins[form.elements['autoscan'].value],
            } : {}),
            scanMode: form.elements['scan-mode'].value,
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
          applyDescendants: global ? (
            form.elements['apply-autoscan'].checked ||
            form.elements['apply-scan-mode'].checked ||
            form.elements['apply-notifications'].checked ||
            form.elements['apply-detection'].checked
          ) : form.elements['apply-descendants'].checked,
          groups: {
            scan: form.elements['apply-scan-mode'].checked,
            autoscan: global && form.elements['apply-autoscan'].checked,
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

function updateScanModeDescription(modeName) {
  const form = qs("#settings-form");
  form.elements["scan-mode-description"].value =
    modeName === "popup" ?
      "Use an unfocused popup render window for pages that require a real visible paint surface." :
      modeName === "dynamic" ?
        "Always render this page in a background browser tab before comparing changes." :
        "Use the fast standard scan and automatically promote to deeper rendering when needed.";
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
