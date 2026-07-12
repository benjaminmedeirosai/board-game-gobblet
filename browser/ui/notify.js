// Turn notifications. Fire only while the tab is open but hidden — WebRTC (and
// therefore the game) dies with the page, so there is nothing to notify about
// once the site is closed. Uses the service worker's showNotification when
// available (required on Android Chrome; page-level `new Notification` throws).

let swReg = null;

export async function initNotifications() {
  if ('serviceWorker' in navigator) {
    try {
      swReg = await navigator.serviceWorker.register('sw.js');
    } catch { /* notifications degrade gracefully without the SW */ }
  }
}

export function notifyPermissionState() {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

// iOS only exposes web notifications to sites installed on the Home Screen.
// True when we're on an iOS browser tab that would need installing first.
export function needsHomeScreenInstall() {
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS
  const installed = window.matchMedia('(display-mode: standalone)').matches
    || navigator.standalone === true;
  return isIOS && !installed;
}

// Must be called from a user gesture (button click) to get the permission prompt.
// Resolves to: 'granted' | 'denied' (declined just now) | 'default' (prompt
// dismissed) | 'blocked' (denied in the past — browsers will not re-prompt;
// only the browser's own site settings can undo it) | 'unsupported'.
export async function requestNotifyPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'blocked';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

// A one-off preview so the user can see what a turn alert looks like — fired
// right after they enable notifications, regardless of tab visibility.
export function showSampleNotification() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const options = { body: 'Your opponent moved — it’s your turn!', tag: 'gobblet-sample' };
  try {
    if (swReg?.showNotification) {
      swReg.showNotification('Gobblet', options);
    } else {
      const n = new Notification('Gobblet', options);
      n.onclick = () => { window.focus(); n.close(); };
    }
  } catch { /* platform without page notifications */ }
}

export function notifyIfHidden(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!document.hidden) return;
  const options = { body, tag: 'gobblet-turn' };
  try {
    if (swReg?.showNotification) {
      swReg.showNotification(title, options);
    } else {
      const n = new Notification(title, options);
      n.onclick = () => { window.focus(); n.close(); };
    }
  } catch { /* platform without page notifications */ }
}
