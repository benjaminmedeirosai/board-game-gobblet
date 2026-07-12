// A tiny synthesized "plink" for opponent-move alerts — WebAudio, no asset file.
// Autoplay policies require the AudioContext to be created/resumed from a user
// gesture, so primeAudio() is called from the game-start button handlers.

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

export function playMoveSound() {
  const c = ctx();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  const now = c.currentTime;
  const gain = c.createGain();
  gain.connect(c.destination);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
  const osc = c.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(620, now);
  osc.frequency.exponentialRampToValueAtTime(990, now + 0.12);
  osc.connect(gain);
  osc.start(now);
  osc.stop(now + 0.36);
}
