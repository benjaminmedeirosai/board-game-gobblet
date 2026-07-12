// Settings dialog. Two groups: Game settings (the host's copy governs the whole
// game) and Preferences (per device). Everything writes to the local profile;
// app.js decides which keys travel into the game.

import { getProfile, saveProfile } from '../storage/history.js';
import { requestNotifyPermission, notifyPermissionState, needsHomeScreenInstall } from './notify.js';
import { THEME_LIST } from '../../assets/themes.js';
import { SOUND_OPTIONS } from './sound.js';

export function initSettings(dialog, onChange) {
  const q = (sel) => dialog.querySelector(sel);
  const highlight = q('#set-highlight');
  const replay = q('#set-replay');
  const timerMode = q('#set-timermode');
  const thresholdStrip = q('#set-threshold');
  const thresholdRow = q('#set-threshold-row');
  const thresholdLabel = q('#set-threshold-label');
  const penalty = q('#set-penalty');
  const penaltyRow = q('#set-penalty-row');
  const inputMode = q('#set-input');
  const themeSel = q('#set-theme');
  const animate = q('#set-animate');
  const sound = q('#set-sound');
  const notify = q('#set-notify');
  const note = q('#settings-note');

  themeSel.innerHTML = THEME_LIST.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
  sound.innerHTML = SOUND_OPTIONS.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');

  // Show the threshold/penalty rows only when they apply, and word the
  // threshold to match the mode.
  function paintTimer() {
    const mode = timerMode.value;
    thresholdRow.classList.toggle('hidden', mode === 'off');
    penaltyRow.classList.toggle('hidden', mode !== 'perturn');
    thresholdLabel.textContent = mode === 'tug' ? 'Lose when behind by' : 'Seconds per turn';
    const thr = getProfile().settings.timerThreshold;
    thresholdStrip.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.v) === thr);
    });
  }

  const bindCheck = (el, key) => el.addEventListener('change', () => {
    saveProfile({ settings: { [key]: el.checked } });
    onChange();
  });
  const bindSelect = (el, key, after) => el.addEventListener('change', () => {
    saveProfile({ settings: { [key]: el.value } });
    if (after) after();
    onChange();
  });

  bindCheck(highlight, 'highlightMoves');
  bindCheck(replay, 'allowReplay');
  bindCheck(animate, 'animateMoves');
  bindSelect(inputMode, 'inputMode');
  bindSelect(themeSel, 'theme');
  bindSelect(sound, 'moveSound');
  bindSelect(penalty, 'penaltyMode');
  bindSelect(timerMode, 'timerMode', paintTimer);

  thresholdStrip.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    saveProfile({ settings: { timerThreshold: Number(btn.dataset.v) } });
    paintTimer();
    onChange();
  });

  notify.addEventListener('change', async () => {
    note.textContent = '';
    if (!notify.checked) {
      saveProfile({ settings: { notifyTurns: false } });
      onChange();
      return;
    }
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
        note.textContent = 'The permission prompt didn’t appear or was dismissed. The reliable fix: install the game (Chrome menu → Add to Home screen / Install app), then enable this inside the installed app — the permission applies everywhere. Also check that notifications are enabled for your browser in your phone’s settings.';
      } else {
        note.textContent = 'Notification permission was declined, so this stays off.';
      }
    }
    onChange();
  });

  q('#btn-settings-close').addEventListener('click', () => dialog.close());

  return {
    open() {
      const s = getProfile().settings;
      highlight.checked = s.highlightMoves;
      replay.checked = s.allowReplay;
      timerMode.value = s.timerMode;
      penalty.value = s.penaltyMode;
      inputMode.value = s.inputMode;
      themeSel.value = s.theme;
      animate.checked = s.animateMoves;
      sound.value = s.moveSound;
      // Reflect the EFFECTIVE state: the setting only works with permission.
      notify.checked = s.notifyTurns && notifyPermissionState() === 'granted';
      note.textContent = '';
      paintTimer();
      dialog.showModal();
    },
  };
}
