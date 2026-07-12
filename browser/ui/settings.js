// Settings dialog: binds the flags in the <dialog> to the stored profile.

import { getProfile, saveProfile } from '../storage/history.js';
import { requestNotifyPermission, notifyPermissionState, needsHomeScreenInstall } from './notify.js';
import { THEME_LIST } from '../../assets/themes.js';

export function initSettings(dialog, onChange) {
  const highlight = dialog.querySelector('#set-highlight');
  const animate = dialog.querySelector('#set-animate');
  const sound = dialog.querySelector('#set-sound');
  const notify = dialog.querySelector('#set-notify');
  const note = dialog.querySelector('#settings-note');
  const inputMode = dialog.querySelector('#set-input');
  const themeSel = dialog.querySelector('#set-theme');
  const limitStrip = dialog.querySelector('#set-limit');
  const limitMode = dialog.querySelector('#set-limitmode');

  themeSel.innerHTML = THEME_LIST
    .map((t) => `<option value="${t.id}">${t.name}</option>`)
    .join('');

  // Reflect the stored limit as the highlighted strip button; grey out the
  // "when time's up" choice when there's no limit.
  function paintLimit(limit) {
    limitStrip.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.v) === limit);
    });
    limitMode.disabled = limit === 0;
  }

  limitStrip.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const limit = Number(btn.dataset.v);
    saveProfile({ settings: { turnLimit: limit } });
    paintLimit(limit);
    onChange();
  });
  limitMode.addEventListener('change', () => {
    saveProfile({ settings: { limitMode: limitMode.value } });
    onChange();
  });

  highlight.addEventListener('change', () => {
    saveProfile({ settings: { highlightMoves: highlight.checked } });
    onChange();
  });
  animate.addEventListener('change', () => {
    saveProfile({ settings: { animateMoves: animate.checked } });
    onChange();
  });
  sound.addEventListener('change', () => {
    saveProfile({ settings: { soundOnMove: sound.checked } });
    onChange();
  });
  themeSel.addEventListener('change', () => {
    saveProfile({ settings: { theme: themeSel.value } });
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
      animate.checked = s.animateMoves;
      sound.checked = s.soundOnMove;
      // Reflect the EFFECTIVE state: the setting only works with permission.
      notify.checked = s.notifyTurns && notifyPermissionState() === 'granted';
      note.textContent = '';
      inputMode.value = s.inputMode;
      themeSel.value = s.theme;
      limitMode.value = s.limitMode;
      paintLimit(s.turnLimit);
      dialog.showModal();
    },
  };
}
