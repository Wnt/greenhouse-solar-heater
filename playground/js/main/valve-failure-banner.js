// Loud valve-failure warning banner — global (sibling of the script-crash
// banner, outside the view sections, so it shows on every view). The device
// publishes cause="failed" when a staged transition bails after its VSA
// attempts are exhausted, and the cause persists in every snapshot until
// the next successful transition — so the banner tracks the live cause
// directly: no arm/disarm state needed. Without this the Status view read
// "Greenhouse cold — heating" over a STABLE gauge while every heating
// attempt was dying (2026-07-28 Valve Control 1 WiFi-flap incident).

const FAILED_TARGET_LABELS = {
  greenhouse_enter: 'Greenhouse Heating',
  solar_enter: 'Solar Charging',
  solar_refill: 'Solar Charging',
  freeze_drain: 'Active Drain',
  overheat_drain: 'Active Drain',
};

export function updateValveFailureBanner(result) {
  const bannerEl = document.getElementById('valve-failure-banner');
  const msgEl = document.getElementById('valve-failure-banner-msg');
  if (!bannerEl || !msgEl) return;
  if (!result || result.cause !== 'failed') {
    bannerEl.style.display = 'none';
    return;
  }
  const target = (result.eval_reason && FAILED_TARGET_LABELS[result.eval_reason]) || null;
  msgEl.textContent =
    'A valve did not respond' +
    (target ? ' — the controller could not enter ' + target : '') +
    ' and fell back to Idle. Check that the valve controllers are powered and reachable on the network.';
  bannerEl.style.display = '';
}
