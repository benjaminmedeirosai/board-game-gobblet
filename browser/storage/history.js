// Local persistence: player profile (name + settings) and per-opponent game
// history. localStorage-backed; the shapes leave room to move to IndexedDB.

const PROFILE_KEY = 'gobblet.profile.v1';
const HISTORY_KEY = 'gobblet.history.v1';

const DEFAULT_SETTINGS = {
  // --- Preferences: local to this device, never synced ---
  inputMode: 'drag', // 'drag' | 'tap'
  theme: 'classic',
  boardScale: 1, // display size of the board + reserves (0.8–1.25); avoids desktop scroll

  animateMoves: true, // slide the opponent's move across the board
  moveSound: 'none', // 'none' | 'plink' | 'chime' | 'knock' | 'blip'
  // Opt-in: enabling it in Settings is what triggers the browser permission
  // prompt, so the user is never prompted before they've asked for the feature.
  notifyTurns: false,

  // --- Game settings: the host's copy governs the whole game (see GAME_SETTING_KEYS) ---
  highlightMoves: true,
  allowReplay: true, // let players replay the opponent's last move
  timerMode: 'off', // 'off' | 'perturn' | 'tug'
  timerThreshold: 20, // seconds (per-turn limit, or max tug-of-war delta)
  penaltyMode: 'accrue', // per-turn only: 'accrue' (track overage) | 'automove'
  aiType: 'gobbler', // vs-computer opponent: 'random' | 'gobbler' | 'speedrunner'
};

// The subset of settings the host stamps onto each game so both players share
// the same rules; the rest are per-device preferences.
export const GAME_SETTING_KEYS = [
  'highlightMoves', 'allowReplay', 'timerMode', 'timerThreshold', 'penaltyMode', 'aiType',
];

export function gameSettingsFrom(settings) {
  const out = {};
  for (const k of GAME_SETTING_KEYS) out[k] = settings[k];
  return out;
}

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || null;
  } catch {
    return null;
  }
}

export function getProfile() {
  const p = readJSON(PROFILE_KEY) || {};
  return {
    name: typeof p.name === 'string' ? p.name : '',
    settings: { ...DEFAULT_SETTINGS, ...(p.settings || {}) },
  };
}

export function saveProfile(patch) {
  const current = getProfile();
  const merged = {
    ...current,
    ...patch,
    settings: { ...current.settings, ...(patch.settings || {}) },
  };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(merged));
  return merged;
}

// History shape: { opponents: { [name]: { games: [{ date, iHosted, result, moveCount }] } } }
// result is 'win' | 'loss' from this device's perspective.
export function getHistory() {
  const h = readJSON(HISTORY_KEY);
  return h && typeof h.opponents === 'object' ? h : { opponents: {} };
}

export function recordGame({ opponent, iHosted, result, moveCount }) {
  const history = getHistory();
  const key = (opponent || '').trim() || 'Unknown';
  if (!history.opponents[key]) history.opponents[key] = { games: [] };
  history.opponents[key].games.push({
    date: new Date().toISOString(),
    iHosted: !!iHosted,
    result,
    moveCount,
  });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}
