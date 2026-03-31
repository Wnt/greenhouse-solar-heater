/**
 * Version check module — polls the server for JS source changes
 * and shows an editorial-tone toast when an update is available.
 */

const POLL_INTERVAL = 30000; // 30 seconds

let baselineHash = null;
let isDismissed = false;
let pollTimer = null;
let toastEl = null;

function createToast() {
  const el = document.createElement('div');
  el.className = 'update-toast';
  el.innerHTML =
    '<div class="update-toast-body">' +
      '<div class="update-toast-content">' +
        '<div class="update-toast-headline">A new edition is available</div>' +
      '</div>' +
      '<div class="update-toast-actions">' +
        '<button class="update-toast-refresh">Refresh</button>' +
        '<button class="update-toast-dismiss">\u00d7</button>' +
      '</div>' +
    '</div>';
  el.querySelector('.update-toast-refresh').addEventListener('click', function () {
    location.reload();
  });
  el.querySelector('.update-toast-dismiss').addEventListener('click', function () {
    isDismissed = true;
    el.classList.remove('visible');
  });
  document.body.appendChild(el);
  return el;
}

function showToast() {
  if (!toastEl) toastEl = createToast();
  toastEl.classList.add('visible');
}

function hideToast() {
  if (toastEl) toastEl.classList.remove('visible');
}

async function checkVersion() {
  try {
    const res = await fetch('/version');
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.hash) return;

    if (baselineHash === null) {
      baselineHash = data.hash;
      return;
    }

    if (data.hash !== baselineHash) {
      if (!isDismissed) {
        showToast();
      }
    } else {
      hideToast();
      isDismissed = false;
    }
  } catch (e) {
    // Silent failure — retry next cycle
  }
}

async function pollVersion() {
  // Reset dismissed flag each cycle so the toast can reappear
  isDismissed = false;
  await checkVersion();
}

export function startVersionCheck() {
  // Initial check to capture baseline
  checkVersion();
  // Poll every 30 seconds
  pollTimer = setInterval(pollVersion, POLL_INTERVAL);
}

// Exposed for e2e testing — triggers a poll cycle immediately
export { pollVersion as triggerVersionCheck };
