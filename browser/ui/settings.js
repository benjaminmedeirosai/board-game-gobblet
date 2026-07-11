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
          : 'This browser doesn’t support web notifications. If you opened the game from a link in another app, open it in your real browser instead.';
      } else if (res === 'blocked') {
        note.textContent = 'Notifications are blocked for this site in your browser settings — allow them there, then toggle this again.';
      } else if (res === 'default') {
        // The prompt never appeared (or was swiped away) — usually the browser
        // suppressing prompts, or its own notifications being off at OS level.
        note.textContent = 'The permission prompt didn’t appear or was dismissed. The reliable fix: install the game (Chrome menu → Add to Home screen / Install app), then enable this inside the installed app — the permission applies everywhere. Also check that notifications are enabled for your browser in your phone’s settings.';
      } else {
        note.textContent = 'Notification permission was declined, so this stays off.';
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
