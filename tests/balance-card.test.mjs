// Tests for the "Today's balance" card stat renderers.

import test from 'node:test';
import assert from 'node:assert';
import { releasedStatHtml } from '../playground/js/main/balance-card.js';

test('Released stat shows a bare magnitude (no double-negative)', () => {
  // The "Released" label already conveys that energy left the tank, so the
  // value must NOT carry a redundant minus sign. Mirrors how "Gathered" is
  // shown unsigned. (Net today keeps its sign — that one genuinely flips.)
  const html = releasedStatHtml(1.4, 0.35); // total 1.75 → "1.8"
  assert.match(html, /balance-stat-label">Released/);
  assert.match(html, /balance-stat-value">1\.8</, 'value should render as a bare magnitude');
  assert.doesNotMatch(html, /balance-stat-value">−/, 'value must not be prefixed with a minus');
  // Caption still splits the destinations.
  assert.match(html, /1\.4 to greenhouse · 0\.4 to air/);
});

test('Released stat shows the equivalent tank temperature swing', () => {
  // 1.75 kWh ≈ 5 K swing (1.75 · 2.867). Magnitude only, like the kWh.
  const html = releasedStatHtml(1.4, 0.35);
  assert.match(html, /balance-stat-delta">Δ5°C</);
  assert.doesNotMatch(html, /Δ−/, 'released swing is a magnitude, not signed');
});

test('Released caption collapses to a single destination when only one is significant', () => {
  assert.match(releasedStatHtml(0, 2.0), /balance-stat-caption">to air/);
  assert.match(releasedStatHtml(2.0, 0), /balance-stat-caption">to greenhouse/);
});
