// Synthesized alert sounds for opponent moves — WebAudio, no asset files.
// Autoplay policies require the AudioContext to be created/resumed from a user
// gesture, so primeAudio() is called from the game-start button handlers.

export const SOUND_OPTIONS = [
  { id: 'none', name: 'None' },
  { id: 'plink', name: 'Plink' },
  { id: 'chime', name: 'Chime' },
  { id: 'knock', name: 'Knock' },
  { id: 'blip', name: 'Blip' },
];

let audioCtx = null;

function ctx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  return audioCtx;
}

export function primeAudio() {
  const c = ctx();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

// One shaped tone: type, start/end frequency, duration, peak gain.
function tone(c, { type = 'triangle', f0, f1 = f0, dur = 0.3, peak = 0.25, at = 0 }) {
  const now = c.currentTime + at;
  const gain = c.createGain();
  gain.connect(c.destination);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peak, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, now);
  if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, now + dur * 0.7);
  osc.connect(gain);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

export function playSound(id) {
  if (!id || id === 'none') return;
  const c = ctx();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  switch (id) {
    case 'plink':
      tone(c, { type: 'triangle', f0: 620, f1: 990, dur: 0.34 });
      break;
    case 'chime':
      tone(c, { type: 'sine', f0: 880, dur: 0.4, peak: 0.22 });
      tone(c, { type: 'sine', f0: 1320, dur: 0.5, peak: 0.16, at: 0.1 });
      break;
    case 'knock':
      tone(c, { type: 'sine', f0: 200, f1: 90, dur: 0.22, peak: 0.4 });
      break;
    case 'blip':
      tone(c, { type: 'square', f0: 740, dur: 0.12, peak: 0.14 });
      break;
    default:
      break;
  }
}
