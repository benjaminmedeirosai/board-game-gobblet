// Settings dialog: binds the flags in the <dialog> to the stored profile.

import { getProfile, saveProfile } from '../storage/history.js';
import { requestNotifyPermission, notifyPermissionState, needsHomeScreenInstall } from './notify.js';

export function initSettings(dialog, onChange) {
  const highlight = dialog.querySelector('#set-highlight');
  const notify = dialog.querySelector('#set-notify');
  const note = dialog.querySelector('#settings-note');
  const inputMode = dialog.querySelector('#set-input');

  highlight.addEventListener('change', () => {
    saveProfile({ settings: { highlightMoves: highlight.checked } });
    onChange();
  });
  notify.addEventListener('change', async () => {
    note.textContent = '';
    if (!notify.checked) {
      saveProfile({ settings: { notifyTurns: false } });
      onChange();
      return;
    }
    // Toggling on requires the browser permission — re-prompt if possible.
    const res = await requestNotifyPermission();
    if (res === 'granted') {
      saveProfile({ settings: { notifyTurns: true } });
    } else {
      notify.checked = false;
      saveProfile({ settings: { notifyTurns: false } });
      if (res === 'unsupported') {
        note.textContent = needsHomeScreenInstall()
          ? 'iPhone only allows notifications for installed web apps: open the game in Safari, tap Share → Add to Home Screen, then enable this inside the installed app.'
          : 'This browser doesn’t support web notifications.';
      } else if (res === 'blocked') {
        note.textContent = 'Notifications are blocked for this site in your browser settings — allow them there, then toggle this again.';
      } else {
        note.textContent = 'Notification permission wasn’t granted, so this stays off.';
      }
    }
    onChange();
  });
  inputMode.addEventListener('change', () => {
    saveProfile({ settings: { inputMode: inputMode.value } });
    onChange();
  });
  dialog.querySelector('#btn-settings-close').addEventListener('click', () => dialog.close());

  return {
    open() {
      const s = getProfile().settings;
      highlight.checked = s.highlightMoves;
      // Reflect the EFFECTIVE state: the setting only works with permission.
      notify.checked = s.notifyTurns && notifyPermissionState() === 'granted';
      note.textContent = '';
      inputMode.value = s.inputMode;
      dialog.showModal();
    },
  };
}
