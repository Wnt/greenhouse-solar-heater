/**
 * Client-side push notification management.
 * Handles service worker registration, push subscription,
 * and category preference UI.
 */

let swRegistration = null;
let currentSubscription = null;
let vapidPublicKey = null;
let deferredInstallPrompt = null;

const CATEGORIES = [
  { id: 'evening_report', label: 'Evening report', desc: 'Solar energy collected today' },
  { id: 'noon_report', label: 'Noon report', desc: 'Overnight heating summary' },
  { id: 'overheat_warning', label: 'Overheat warning', desc: '15 min before overheat drain' },
  { id: 'freeze_warning', label: 'Freeze warning', desc: '15 min before freeze protection' },
];

// ── Install prompt ──

export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    showInstallButton(true);
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    showInstallButton(false);
  });

  // Check if already installed (standalone mode)
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) {
    showInstallButton(false);
  }
}

function showInstallButton(show) {
  const btn = document.getElementById('pwa-install-btn');
  if (btn) btn.style.display = show ? '' : 'none';
}

export async function triggerInstall() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const result = await deferredInstallPrompt.userChoice;
  if (result.outcome === 'accepted') {
    deferredInstallPrompt = null;
    showInstallButton(false);
  }
}

// ── Service worker + push subscription ──

export async function initNotifications() {
  if (!('serviceWorker' in navigator)) return;

  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.error('[notifications] SW registration failed:', err);
    return;
  }

  // Fetch VAPID key
  try {
    const res = await fetch('/api/push/vapid-key');
    if (!res.ok) return;
    const data = await res.json();
    vapidPublicKey = data.publicKey;
  } catch (err) {
    // Push not available (e.g. GitHub Pages, local dev)
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

async function syncCategories() {
  if (!currentSubscription) return;
  try {
    const res = await fetch('/api/push/subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: currentSubscription.endpoint }),
    });
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

export async function subscribePush(categories) {
  if (!swRegistration || !vapidPublicKey) return false;

  try {
    // Request notification permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return false;

    // Create push subscription
    currentSubscription = await swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });

    // Send to server
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: currentSubscription.endpoint,
          keys: {
            p256dh: btoa(String.fromCharCode.apply(null, new Uint8Array(currentSubscription.getKey('p256dh')))),
            auth: btoa(String.fromCharCode.apply(null, new Uint8Array(currentSubscription.getKey('auth')))),
          },
        },
        categories: categories,
      }),
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

export async function updateCategories(categories) {
  if (!currentSubscription) return false;

  try {
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: currentSubscription.endpoint,
          keys: {
            p256dh: btoa(String.fromCharCode.apply(null, new Uint8Array(currentSubscription.getKey('p256dh')))),
            auth: btoa(String.fromCharCode.apply(null, new Uint8Array(currentSubscription.getKey('auth')))),
          },
        },
        categories: categories,
      }),
    });

    return res.ok;
  } catch (err) {
    console.error('[notifications] updateCategories error:', err);
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
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: endpoint }),
    });
  } catch (err) {
    // Best-effort cleanup
  }

  updateNotificationUI();
}

// ── UI updates ──

function updateNotificationUI() {
  const section = document.getElementById('notification-settings');
  if (!section) return;

  const subscribed = !!currentSubscription;
  const toggleBtn = document.getElementById('notif-toggle-btn');
  const categoriesEl = document.getElementById('notif-categories');

  if (toggleBtn) {
    toggleBtn.textContent = subscribed ? 'Disable' : 'Enable';
    toggleBtn.classList.toggle('notif-active', subscribed);
  }
  if (categoriesEl) {
    categoriesEl.style.display = subscribed ? '' : 'none';
  }
}

function updateCategoryCheckboxes(enabledCategories) {
  for (const cat of CATEGORIES) {
    const cb = document.getElementById('notif-cat-' + cat.id);
    if (cb) cb.checked = enabledCategories.indexOf(cat.id) >= 0;
  }
}

function getSelectedCategories() {
  const selected = [];
  for (const cat of CATEGORIES) {
    const cb = document.getElementById('notif-cat-' + cat.id);
    if (cb && cb.checked) selected.push(cat.id);
  }
  return selected;
}

// ── Exported for UI wiring ──

export function isSubscribed() {
  return !!currentSubscription;
}

export function isPushAvailable() {
  return !!vapidPublicKey && 'PushManager' in window;
}

export function isInstallAvailable() {
  return !!deferredInstallPrompt;
}

export { CATEGORIES, getSelectedCategories };
