/**
 * Editorial body composers for the noon and evening notification
 * reports. Pure functions — take energy numbers, return display text.
 *
 * Kept separate from notifications.js so the larger orchestration
 * module stays under the 600-line cap, and so the body shapes can be
 * unit-tested without spinning up the alert/offline state machine.
 */

const { tankKwhToDeltaC } = require('./energy-balance.js');

function fmtKwh(wh) { return (Math.round(wh) / 1000).toFixed(1); }

// "<n> kWh (Δ<d>°C)" — the energy figure plus the equivalent tank
// temperature swing, so the abstract kWh has an intuitive companion. The
// label/verb around it carries direction, so the swing is a magnitude.
function fmtKwhDelta(wh) {
  return fmtKwh(wh) + ' kWh (Δ' + Math.round(Math.abs(tankKwhToDeltaC(wh / 1000))) + '°C)';
}

// Threshold below which we treat an accumulator as "held steady" and don't
// mention it. 50 Wh = 0.05 kWh, which rounds to 0.1 at display resolution.
const KWH_NOISE_FLOOR_WH = 50;

function buildEveningBody(gatheredWh, heatingLossWh, leakageLossWh) {
  const gained = gatheredWh >= KWH_NOISE_FLOOR_WH;
  const heating = heatingLossWh >= KWH_NOISE_FLOOR_WH;
  const leakage = leakageLossWh >= KWH_NOISE_FLOOR_WH;
  const netWh = gatheredWh - heatingLossWh - leakageLossWh;
  const netSign = netWh >= 0 ? '+' : '−';
  const netDeltaC = Math.round(Math.abs(tankKwhToDeltaC(netWh / 1000)));
  // "net +0.8 kWh, Δ+2°C" — the net keeps its sign on both figures.
  const net = 'net ' + netSign + fmtKwh(Math.abs(netWh)) + ' kWh, Δ' + netSign + netDeltaC + '°C';

  if (!gained) {
    if (!heating && !leakage) return 'Tank energy held steady today.';
    if (heating && leakage) {
      return 'No solar gain today. The greenhouse drew ' + fmtKwhDelta(heatingLossWh) +
        ' from the tank; another ' + fmtKwhDelta(leakageLossWh) + ' slipped to air.';
    }
    if (heating) {
      return 'No solar gain today. The greenhouse drew ' + fmtKwhDelta(heatingLossWh) +
        ' from the tank.';
    }
    return 'No solar gain today. The tank released ' + fmtKwhDelta(leakageLossWh) + ' to air.';
  }

  // We gathered something.
  if (!heating && !leakage) {
    return 'Today your collectors gathered ' + fmtKwhDelta(gatheredWh) + '. The tank is holding steady.';
  }
  if (heating && leakage) {
    return 'Today your collectors gathered ' + fmtKwhDelta(gatheredWh) +
      '. The greenhouse drew ' + fmtKwhDelta(heatingLossWh) + ' of warmth, ' +
      fmtKwhDelta(leakageLossWh) + ' slipped to air (' + net + ').';
  }
  if (heating) {
    return 'Today your collectors gathered ' + fmtKwhDelta(gatheredWh) +
      '. The greenhouse drew ' + fmtKwhDelta(heatingLossWh) +
      ' of warmth (' + net + ').';
  }
  return 'Today your collectors gathered ' + fmtKwhDelta(gatheredWh) +
    '. ' + fmtKwhDelta(leakageLossWh) + ' slipped to air since peak (' + net + ').';
}

function buildNoonBody(minutes, heatingLossWh, leakageLossWh, heatingDisabled) {
  const heating = heatingLossWh >= KWH_NOISE_FLOOR_WH;
  const leakage = leakageLossWh >= KWH_NOISE_FLOOR_WH;

  if (heatingDisabled) {
    if (!leakage) return 'Greenhouse heating is resting. The tank held steady overnight.';
    return 'Greenhouse heating is resting. Overnight the tank released ' +
      fmtKwhDelta(leakageLossWh) + ' to air.';
  }

  if (minutes > 0) {
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;
    const duration = hrs > 0 ? hrs + 'h ' + mins + 'min' : mins + ' minutes';
    const tail = heating
      ? ' — ' + fmtKwhDelta(heatingLossWh) + ' delivered' +
        (leakage ? ', ' + fmtKwhDelta(leakageLossWh) + ' slipped to air' : '') + '.'
      : '.';
    return 'Overnight the greenhouse drew warmth for ' + duration + tail;
  }

  if (!leakage) return 'No heating was needed overnight. The greenhouse stayed warm.';
  return 'No heating was needed overnight. The tank released ' +
    fmtKwhDelta(leakageLossWh) + ' to air.';
}

module.exports = {
  buildEveningBody,
  buildNoonBody,
};
