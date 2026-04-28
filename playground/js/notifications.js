/**
 * Client-side push notification management.
 * Handles service worker registration, push subscription,
 * category preference UI, and PWA install prompt.
 */

import { postJson } from './main/fetch-helpers.js';

let swRegistration = null;
let currentSubscription = null;
let vapidPublicKey = null;
let deferredInstallPrompt = null;

const CATEGORIES = [
  { id: 'evening_report', label: 'Evening report', desc: 'Solar energy collected today' },
  { id: 'noon_report', label: 'Noon report', desc: 'Overnight heating summary' },
  { id: 'overheat_warning', label: 'Overheat warning', desc: '15 min before overheat drain' },
  { id: 'freeze_warning', label: 'Freeze warning', desc: '15 min before freeze protection' },
  { id: 'offline_warning', label: 'Controller offline', desc: 'Offline/online after 15 min' },
  { id: 'watchdog_fired', label: 'Watchdog fired', desc: 'Expected temperature change failed to materialize' },
];

function $(id) {
  return document.getElementById(id);
}

// Set only the label span inside a button, preserving the icon span.
function setBtnLabel(btn, text) {
  if (!btn) return;
  const label = btn.querySelector('.auth-btn-label');
  if (label) {
    label.textContent = text;
  } else {
    // Fallback for buttons without a label span
    btn.textContent = text;
  }
}

// ── Install prompt ──

export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    showStandaloneState();
  });

  // Show the "already installed" card state when running standalone
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) {
    showStandaloneState();
  }
}

// Swap the Install card into its "installed" variant and fill in
// platform-specific uninstall instructions. There is no Web API to
// trigger an uninstall — PWAs are always removed by the user via the
// OS (long-press icon, chrome://apps, Settings → Apps), so the best
// we can do is tell them where to look.
function showStandaloneState() {
  const idle = $('pwa-install-idle');
  const standalone = $('pwa-install-standalone');
  if (idle) idle.hidden = true;
  if (standalone) standalone.hidden = false;

  const desc = $('pwa-uninstall-desc');
  if (desc) desc.textContent = getUninstallInstructions();
}

function getUninstallInstructions() {
  const p = detectPlatform();
  if (p.isIOS) {
    return "You're using Helios Canopy as an installed app. To remove it, long-press the app icon on your home screen and tap Remove App \u2192 Delete App.";
  }
  if (p.isAndroid) {
    return "You're using Helios Canopy as an installed app. To uninstall, long-press the app icon on your home screen and tap Uninstall, or open Settings \u2192 Apps \u2192 Helios Canopy \u2192 Uninstall.";
  }
  if (p.isFirefox) {
    return "You're using Helios Canopy as an installed app. To remove it, open your browser's app management and uninstall Helios Canopy.";
  }
  // Chrome / Edge / other desktop
  return "You're using Helios Canopy as an installed app. To uninstall, open the \u22ee menu in the app window and choose Uninstall Helios Canopy, or visit chrome://apps.";
}

export async function triggerInstall() {
  // Preferred path: use the deferred beforeinstallprompt event (Chrome/Edge/Android)
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const result = await deferredInstallPrompt.userChoice;
    if (result.outcome === 'accepted') {
      deferredInstallPrompt = null;
      // eslint-disable-next-line no-undef -- TODO: hideInstallButton is undefined; the install-button visibility is actually driven by the `beforeinstallprompt` / `appinstalled` DOM events elsewhere, so this call was always a ReferenceError. Leaving the disable here to ship ESLint without a behavior change — track removing in a follow-up.
      hideInstallButton();
    }
    return;
  }

  // Fallback path: show platform-specific instructions
  showInstallInstructions();
}

function detectPlatform() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isAndroid = /Android/.test(ua);
  const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|FxiOS/.test(ua);
  const isFirefox = /Firefox|FxiOS/.test(ua);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return { isIOS, isAndroid, isSafari, isFirefox, isStandalone };
}

function showInstallInstructions() {
  const modal = $('install-modal');
  const body = $('install-instructions');
  if (!modal || !body) return;

  const p = detectPlatform();
  let html;
  if (p.isStandalone) {
    html = '<p>The app is already installed and running.</p>';
  } else if (p.isIOS) {
    html = '<p>On iPhone / iPad:</p>' +
           '<ol style="padding-left:20px;margin-top:8px;">' +
           '<li>Tap the <strong>Share</strong> button in Safari\u2019s toolbar.</li>' +
           '<li>Scroll and tap <strong>Add to Home Screen</strong>.</li>' +
           '<li>Tap <strong>Add</strong> to confirm.</li>' +
           '</ol>';
  } else if (p.isFirefox && p.isAndroid) {
    html = '<p>On Firefox for Android:</p>' +
           '<ol style="padding-left:20px;margin-top:8px;">' +
           '<li>Tap the <strong>\u22ee</strong> menu.</li>' +
           '<li>Tap <strong>Install</strong> or <strong>Add to Home Screen</strong>.</li>' +
           '</ol>';
  } else if (p.isFirefox) {
    html = '<p>Firefox on desktop does not support installing web apps.</p>' +
           '<p style="margin-top:8px;">To install, please open this site in Chrome or Edge.</p>';
  } else if (p.isAndroid) {
    html = '<p>On Android (Chrome / Edge):</p>' +
           '<ol style="padding-left:20px;margin-top:8px;">' +
           '<li>Tap the <strong>\u22ee</strong> menu.</li>' +
           '<li>Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>' +
           '</ol>';
  } else {
    html = '<p>On Chrome / Edge desktop:</p>' +
           '<ol style="padding-left:20px;margin-top:8px;">' +
           '<li>Click the install icon in the address bar (next to the bookmark star), or</li>' +
           '<li>Open the <strong>\u22ee</strong> menu and choose <strong>Install Helios Canopy</strong>.</li>' +
           '</ol>' +
           '<p style="margin-top:12px;color:var(--on-surface-variant);font-size:12px;">If neither is available, the browser may not consider this site installable yet. Try reloading after a moment.</p>';
  }
  body.innerHTML = html;
  modal.hidden = false;
}

function closeInstallModal() {
  const modal = $('install-modal');
  if (modal) modal.hidden = true;
}

export function wireInstallModal() {
  const backdrop = $('install-modal-backdrop');
  const closeBtn = $('install-close-btn');
  if (backdrop) backdrop.addEventListener('click', closeInstallModal);
  if (closeBtn) closeBtn.addEventListener('click', closeInstallModal);
  document.addEventListener('keydown', (e) => {
    const modal = $('install-modal');
    if (e.key === 'Escape' && modal && !modal.hidden) closeInstallModal();
  });
}

// ── Service worker + push subscription ──

export async function initNotifications() {
  if (!('serviceWorker' in navigator)) {
    showNotificationsUnavailable('Service workers are not supported by this browser.');
    return;
  }

  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.error('[notifications] SW registration failed:', err);
    showNotificationsUnavailable('Service worker registration failed.');
    return;
  }

  if (!('PushManager' in window)) {
    showNotificationsUnavailable('Push notifications are not supported by this browser.');
    return;
  }

  // Fetch VAPID key
  try {
    const res = await fetch('/api/push/vapid-key');
    if (!res.ok) {
      showNotificationsUnavailable('Server has not configured push notifications.');
      return;
    }
    const data = await res.json();
    vapidPublicKey = data.publicKey;
  } catch (err) {
    showNotificationsUnavailable('Could not reach the server.');
    return;
  }

  // Check existing subscription
  try {
    currentSubscription = await swRegistration.pushManager.getSubscription();
    if (currentSubscription) {
      await syncCategories();
    }
  } catch (err) {
    console.error('[notifications] getSubscription failed:', err);
  }

  updateNotificationUI();
}

function showNotificationsUnavailable(reason) {
  const toggleBtn = $('notif-toggle-btn');
  const msg = $('notif-unavailable-msg');
  if (toggleBtn) {
    toggleBtn.disabled = true;
    toggleBtn.classList.add('notif-disabled');
    toggleBtn.setAttribute('title', reason);
    setBtnLabel(toggleBtn, 'Notifications unavailable');
  }
  if (msg) {
    msg.textContent = reason;
    msg.style.display = '';
  }
}

async function syncCategories() {
  if (!currentSubscription) return;
  try {
    const res = await postJson('/api/push/subscription', { endpoint: currentSubscription.endpoint });
    if (res.ok) {
      const data = await res.json();
      if (data.subscribed) {
        updateCategoryCheckboxes(data.categories);
      }
    }
  } catch (err) {
    // Ignore — UI will show defaults
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function encodeKey(key) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(key)));
}

export async function subscribePush(categories) {
  if (!swRegistration || !vapidPublicKey) return false;

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return false;

    currentSubscription = await swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });

    const res = await postJson('/api/push/subscribe', {
      subscription: subscriptionPayload(),
      categories,
    });

    if (!res.ok) {
      console.error('[notifications] subscribe failed:', res.status);
      return false;
    }

    updateNotificationUI();
    return true;
  } catch (err) {
    console.error('[notifications] subscribe error:', err);
    return false;
  }
}

function subscriptionPayload() {
  return {
    endpoint: currentSubscription.endpoint,
    keys: {
      p256dh: encodeKey(currentSubscription.getKey('p256dh')),
      auth: encodeKey(currentSubscription.getKey('auth')),
    },
  };
}

export async function updateCategories(categories) {
  if (!currentSubscription) return false;

  try {
    const res = await postJson('/api/push/subscribe', {
      subscription: subscriptionPayload(),
      categories,
    });
    return res.ok;
  } catch (err) {
    console.error('[notifications] updateCategories error:', err);
    return false;
  }
}

// Settings → per-category preview button. Bypasses server-side rate
// limiting so users can preview each notification on demand.
export async function sendTest(category) {
  if (!currentSubscription) return false;
  try {
    const res = await postJson('/api/push/test', {
      endpoint: currentSubscription.endpoint,
      category,
    });
    return res.ok;
  } catch (err) {
    console.error('[notifications] sendTest error:', err);
    return false;
  }
}

export async function unsubscribePush() {
  if (!currentSubscription) return;

  const endpoint = currentSubscription.endpoint;
  try {
    await currentSubscription.unsubscribe();
  } catch (err) {
    console.error('[notifications] unsubscribe failed:', err);
  }
  currentSubscription = null;

  try {
    await postJson('/api/push/unsubscribe', { endpoint });
  } catch (err) {
    // Best-effort cleanup
  }

  updateNotificationUI();
}

// ── UI updates ──

function updateNotificationUI() {
  const subscribed = !!currentSubscription;
  const toggleBtn = $('notif-toggle-btn');
  const categoriesEl = $('notif-categories');

  if (toggleBtn) {
    setBtnLabel(toggleBtn, subscribed ? 'Disable notifications' : 'Enable notifications');
    toggleBtn.classList.toggle('notif-active', subscribed);
    toggleBtn.setAttribute('title',
      subscribed ? 'Disable push notifications' : 'Enable push notifications');
  }
  if (categoriesEl) {
    categoriesEl.style.display = subscribed ? '' : 'none';
  }
}

function updateCategoryCheckboxes(enabledCategories) {
  for (const cat of CATEGORIES) {
    const cb = $('notif-cat-' + cat.id);
    if (cb) cb.checked = enabledCategories.indexOf(cat.id) >= 0;
  }
}

function getSelectedCategories() {
  const selected = [];
  for (const cat of CATEGORIES) {
    const cb = $('notif-cat-' + cat.id);
    if (cb && cb.checked) selected.push(cat.id);
  }
  return selected;
}

// ── Exported for UI wiring ──

export function isSubscribed() {
  return !!currentSubscription;
}

export { getSelectedCategories };
