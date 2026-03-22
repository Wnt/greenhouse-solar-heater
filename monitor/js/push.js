/**
 * Browser-side push notification subscription management.
 * Communicates with the server push API endpoints.
 */

/**
 * Fetch the VAPID public key from the server.
 * @returns {Promise<string>} Base64url-encoded public key
 */
export async function getVapidKey() {
  const res = await fetch('/api/push/vapid-public-key');
  if (!res.ok) throw new Error('Failed to get VAPID key: ' + res.status);
  const data = await res.json();
  return data.publicKey;
}

/**
 * Get the current push subscription state.
 * @returns {Promise<PushSubscription|null>}
 */
export async function getSubscriptionState() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/**
 * Subscribe to push notifications.
 * @param {string} vapidPublicKey - Base64url VAPID public key from server
 * @returns {Promise<PushSubscription>}
 */
export async function subscribe(vapidPublicKey) {
  const reg = await navigator.serviceWorker.ready;

  // Convert base64url to Uint8Array for applicationServerKey
  const key = urlBase64ToUint8Array(vapidPublicKey);

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });

  // Send subscription to server
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription.toJSON()),
  });

  if (!res.ok) throw new Error('Failed to save subscription: ' + res.status);
  return subscription;
}

/**
 * Unsubscribe from push notifications.
 * @returns {Promise<boolean>} true if successfully unsubscribed
 */
export async function unsubscribe() {
  const subscription = await getSubscriptionState();
  if (!subscription) return false;

  // Unsubscribe from browser
  await subscription.unsubscribe();

  // Remove from server
  await fetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });

  return true;
}

/**
 * Check if push notifications are supported.
 * @returns {boolean}
 */
export function isSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window;
}

/**
 * Convert a base64url string to a Uint8Array (for applicationServerKey).
 * @param {string} base64String
 * @returns {Uint8Array}
 */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
