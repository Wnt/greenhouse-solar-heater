// PWA install button + push-notification subscribe/test UI. Extracted
// from main.js. Pure DOM wiring; the actual subscribe/install logic
// lives in ../notifications.js.

import {
  triggerInstall, wireInstallModal, subscribePush, updateCategories,
  unsubscribePush, isSubscribed, getSelectedCategories, sendTest,
} from '../notifications.js';

// The install button is always visible; when beforeinstallprompt is not
// available (Safari/Firefox) the handler shows a platform-specific
// instructions modal. The notifications section is also always visible;
// if push isn't supported the toggle stays disabled with an explanation.
export function wireNotificationUI() {
  wireInstallModal();

  var installBtn = document.getElementById('pwa-install-btn');
  if (installBtn) {
    installBtn.addEventListener('click', function () {
      triggerInstall();
    });
  }

  var toggleBtn = document.getElementById('notif-toggle-btn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', function () {
      if (toggleBtn.disabled) return;
      if (isSubscribed()) {
        unsubscribePush();
      } else {
        var cats = getSelectedCategories();
        subscribePush(cats);
      }
    });
  }

  // Category checkboxes — update server on change
  var checkboxes = document.querySelectorAll('[id^="notif-cat-"]');
  checkboxes.forEach(function (cb) {
    cb.addEventListener('change', function () {
      if (isSubscribed()) {
        updateCategories(getSelectedCategories());
      }
    });
  });

  // Per-category test buttons — send a mock notification of the
  // selected category to this device's subscription.
  var testButtons = document.querySelectorAll('[data-test-category]');
  testButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      if (!isSubscribed()) {
        flashTestBtn(btn, 'error');
        return;
      }
      var category = btn.dataset.testCategory;
      btn.disabled = true;
      sendTest(category).then(function (ok) {
        flashTestBtn(btn, ok ? 'sent' : 'error');
      }).catch(function () {
        flashTestBtn(btn, 'error');
      });
    });
  });
}

function flashTestBtn(btn, state) {
  btn.dataset.testing = state;
  setTimeout(function () {
    btn.dataset.testing = '';
    btn.disabled = false;
  }, state === 'sent' ? 1500 : 2500);
}
