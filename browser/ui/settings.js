// Two settings surfaces:
//  • Preferences  — per device, apply live (input, theme, animation, sound, alerts)
//  • Game settings — the host's, apply to the whole game and only on a restart
//
// Both read/write the one stored profile; app.js decides which keys travel.

import { getProfile, saveProfile, gameSettingsFrom } from '../storage/history.js';
import { requestNotifyPermission, notifyPermissionState, needsHomeScreenInstall, showSampleNotification } from './notify.js';
import { THEME_LIST } from '../../assets/themes.js';
import { SOUND_OPTIONS, playSound, primeAudio } from './sound.js';
import { AI_TYPES } from '../game/ai.js';

// ---- Preferences (device-local, live) ----

export function initPreferences(dialog, onChange) {
  const q = (s) => dialog.querySelector(s);
  const inputMode = q('#set-input');
  const themeSel = q('#set-theme');
  const boardScale = q('#set-boardscale');
  const animate = q('#set-animate');
  const sound = q('#set-sound');
  const notify = q('#set-notify');
  const note = q('#settings-note');

  themeSel.innerHTML = THEME_LIST.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
  sound.innerHTML = SOUND_OPTIONS.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');

  const bindSelect = (el, key) => el.addEventListener('change', () => {
    saveProfile({ settings: { [key]: el.value } });
    onChange();
  });
  bindSelect(inputMode, 'inputMode');
  bindSelect(themeSel, 'theme');
  bindSelect(boardScale, 'boardScale');
  // Sound is a select too, but preview the chosen tone so picking is audible.
  sound.addEventListener('change', () => {
    saveProfile({ settings: { moveSound: sound.value } });
    primeAudio(); // this change is a user gesture — unlock audio, then preview
    playSound(sound.value);
    onChange();
  });
  animate.addEventListener('change', () => {
    saveProfile({ settings: { animateMoves: animate.checked } });
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
      showSampleNotification(); // preview: "this is what a turn alert looks like"
      note.textContent = 'Enabled — here’s a sample of how your turn alerts will look.';
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
        note.textContent = 'The permission prompt didn’t appear or was dismissed. The reliable fix: install the game (Chrome menu → Add to Home screen / Install app), then enable this inside the installed app. Also check notifications are enabled for your browser in your phone’s settings.';
      } else {
        note.textContent = 'Notification permission was declined, so this stays off.';
      }
    }
    onChange();
  });

  q('#btn-prefs-close').addEventListener('click', () => dialog.close());

  return {
    open() {
      const s = getProfile().settings;
      inputMode.value = s.inputMode;
      themeSel.value = s.theme;
      boardScale.value = String(s.boardScale);
      animate.checked = s.animateMoves;
      sound.value = s.moveSound;
      notify.checked = s.notifyTurns && notifyPermissionState() === 'granted';
      note.textContent = '';
      dialog.showModal();
    },
  };
}

// ---- Game settings (host's; edits are pending until a restart) ----
//
// hooks: {
//   context()  -> { editable, inGame, hostName }
//   effective() -> the game-settings object currently in force
//   saveDefaults(settings)   -> not in a game: store as the host's defaults
//   applyRestart(settings)   -> in a game: store + restart with the new settings
// }
export function initGameSettings(dialog, hooks) {
  const q = (s) => dialog.querySelector(s);
  const highlight = q('#set-highlight');
  const replay = q('#set-replay');
  const timerMode = q('#set-timermode');
  const thresholdStrip = q('#set-threshold');
  const thresholdRow = q('#set-threshold-row');
  const thresholdLabel = q('#set-threshold-label');
  const penalty = q('#set-penalty');
  const penaltyRow = q('#set-penalty-row');
  const aitype = q('#set-aitype');
  const aitypeRow = q('#set-aitype-row');
  const aitypeDesc = q('#set-aitype-desc');
  const aidiff = q('#set-aidiff');
  const aidiffRow = q('#set-aidiff-row');
  const aidiffDesc = q('#set-aidiff-desc');
  const info = q('#game-host-info');
  const note = q('#game-settings-note');
  const saveBtn = q('#btn-game-save');

  aitype.innerHTML = AI_TYPES.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');

  // Brief, spoiler-free flavor for each opponent (shown under the picker).
  const AI_TYPE_DESC = {
    random: 'Plays random legal moves — a gentle warm-up.',
    gobbler: 'Aggressive: loves gobbling your pieces and fighting for control of the board.',
    speedrunner: 'Rushes to build a line as fast as it can — punishes a slow defense.',
  };
  function paintAiDesc() {
    aitypeDesc.textContent = AI_TYPE_DESC[pending.aiType] || '';
  }

  let pending = {};
  let baseline = {};
  let dirty = false;
  let ctx = { editable: true, inGame: false, hostName: null };

  function paintTimer() {
    const mode = pending.timerMode;
    thresholdRow.classList.toggle('hidden', mode === 'off');
    penaltyRow.classList.toggle('hidden', mode !== 'perturn');
    thresholdLabel.textContent = mode === 'tug' ? 'Lose when behind by' : 'Seconds per turn';
    thresholdStrip.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.v) === pending.timerThreshold);
    });
  }

  function refreshFooter() {
    if (!ctx.editable) {
      saveBtn.classList.add('hidden');
      note.textContent = `Only ${ctx.hostName || 'the host'} can change the game settings.`;
      return;
    }
    saveBtn.classList.remove('hidden');
    if (ctx.inGame) {
      saveBtn.textContent = 'Save & Restart';
      saveBtn.disabled = !dirty;
      note.textContent = dirty
        ? 'Saving restarts the game with these settings.'
        : 'Changing a game setting restarts the game.';
    } else {
      saveBtn.textContent = 'Save';
      saveBtn.disabled = !dirty;
      note.textContent = 'These apply to games you host.';
    }
  }

  // Compare against the values at open time, so toggling a setting and then
  // toggling it back (or re-picking the already-active option) leaves Save off.
  function recomputeDirty() {
    dirty = Object.keys(baseline).some((k) => pending[k] !== baseline[k]);
    refreshFooter();
  }

  const onCheck = (el, key) => el.addEventListener('change', () => { pending[key] = el.checked; recomputeDirty(); });
  const onSel = (el, key, after) => el.addEventListener('change', () => {
    pending[key] = el.value; if (after) after(); recomputeDirty();
  });
  onCheck(highlight, 'highlightMoves');
  onCheck(replay, 'allowReplay');
  onSel(penalty, 'penaltyMode');
  onSel(aitype, 'aiType', paintAiDesc);
  onSel(aidiff, 'aiDifficulty');
  onSel(timerMode, 'timerMode', paintTimer);
  thresholdStrip.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    pending.timerThreshold = Number(btn.dataset.v);
    paintTimer();
    recomputeDirty();
  });

  saveBtn.addEventListener('click', () => {
    if (!ctx.editable || !dirty) return;
    if (ctx.inGame) hooks.applyRestart({ ...pending });
    else hooks.saveDefaults({ ...pending });
    dialog.close();
  });
  q('#btn-game-close').addEventListener('click', () => dialog.close());

  function populate() {
    highlight.checked = pending.highlightMoves;
    replay.checked = pending.allowReplay;
    timerMode.value = pending.timerMode;
    penalty.value = pending.penaltyMode;
    aitype.value = pending.aiType;
    aidiff.value = pending.aiDifficulty;
    paintTimer();
    paintAiDesc();
  }

  return {
    open() {
      ctx = hooks.context();
      pending = { ...gameSettingsFrom(hooks.effective()) };
      baseline = { ...pending };
      dirty = false;
      populate();
      if (!ctx.inGame) info.textContent = 'Defaults for games you host.';
      else if (ctx.mode === 'ai') info.textContent = 'Playing vs the computer.';
      else if (!ctx.editable) info.textContent = `Hosted by ${ctx.hostName || 'the host'}`;
      else if (ctx.hostName) info.textContent = 'You’re hosting this game.';
      else info.textContent = 'Pass & play';
      // The computer-opponent controls only matter vs the computer (or as a default).
      const showAi = ctx.mode === 'ai' || !ctx.inGame;
      aitypeRow.classList.toggle('hidden', !showAi);
      aitypeDesc.classList.toggle('hidden', !showAi);
      aidiffRow.classList.toggle('hidden', !showAi);
      aidiffDesc.classList.toggle('hidden', !showAi);
      // Non-hosts may look and fiddle, but can't save.
      dialog.querySelectorAll('#game-settings-body input, #game-settings-body select, #game-settings-body button')
        .forEach((el) => { el.disabled = false; });
      refreshFooter();
      dialog.showModal();
    },
  };
}
