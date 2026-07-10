// Local persistence: player profile (name + settings) and per-opponent game
// history. localStorage-backed; the shapes leave room to move to IndexedDB.

const PROFILE_KEY = 'gobblet.profile.v1';
const HISTORY_KEY = 'gobblet.history.v1';

const DEFAULT_SETTINGS = {
  highlightMoves: true,
  inputMode: 'drag', // 'drag' | 'tap'
  theme: 'classic',
  notifyTurns: true, // browser notification when the opponent moves (tab hidden)
};

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
