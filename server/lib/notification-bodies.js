/**
 * Editorial body composers for the noon and evening notification
 * reports. Pure functions — take energy numbers, return display text.
 *
 * Kept separate from notifications.js so the larger orchestration
 * module stays under the 600-line cap, and so the body shapes can be
 * unit-tested without spinning up the alert/offline state machine.
 */

function fmtKwh(wh) { return (Math.round(wh) / 1000).toFixed(1); }

// Threshold below which we treat an accumulator as "held steady" and don't
// mention it. 50 Wh = 0.05 kWh, which rounds to 0.1 at display resolution.
const KWH_NOISE_FLOOR_WH = 50;

function buildEveningBody(gatheredWh, heatingLossWh, leakageLossWh) {
  const gained = gatheredWh >= KWH_NOISE_FLOOR_WH;
  const heating = heatingLossWh >= KWH_NOISE_FLOOR_WH;
  const leakage = leakageLossWh >= KWH_NOISE_FLOOR_WH;
  const netWh = gatheredWh - heatingLossWh - leakageLossWh;
  const netSign = netWh >= 0 ? '+' : '−';
  const netAbs = fmtKwh(Math.abs(netWh));

  if (!gained) {
    if (!heating && !leakage) return 'Tank energy held steady today.';
    if (heating && leakage) {
      return 'No solar gain today. The greenhouse drew ' + fmtKwh(heatingLossWh) +
        ' kWh from the tank; another ' + fmtKwh(leakageLossWh) + ' kWh slipped to air.';
    }
    if (heating) {
      return 'No solar gain today. The greenhouse drew ' + fmtKwh(heatingLossWh) +
        ' kWh from the tank.';
    }
    return 'No solar gain today. The tank released ' + fmtKwh(leakageLossWh) + ' kWh to air.';
  }

  // We gathered something.
  if (!heating && !leakage) {
    return 'Today your collectors gathered ' + fmtKwh(gatheredWh) + ' kWh. The tank is holding steady.';
  }
  if (heating && leakage) {
    return 'Today your collectors gathered ' + fmtKwh(gatheredWh) +
      ' kWh. The greenhouse drew ' + fmtKwh(heatingLossWh) + ' kWh of warmth, ' +
      fmtKwh(leakageLossWh) + ' kWh slipped to air (net ' + netSign + netAbs + ' kWh).';
  }
  if (heating) {
    return 'Today your collectors gathered ' + fmtKwh(gatheredWh) +
      ' kWh. The greenhouse drew ' + fmtKwh(heatingLossWh) +
      ' kWh of warmth (net ' + netSign + netAbs + ' kWh).';
  }
  return 'Today your collectors gathered ' + fmtKwh(gatheredWh) +
    ' kWh. ' + fmtKwh(leakageLossWh) + ' kWh slipped to air since peak (net ' +
    netSign + netAbs + ' kWh).';
}

function buildNoonBody(minutes, heatingLossWh, leakageLossWh, heatingDisabled) {
  const heating = heatingLossWh >= KWH_NOISE_FLOOR_WH;
  const leakage = leakageLossWh >= KWH_NOISE_FLOOR_WH;

  if (heatingDisabled) {
    if (!leakage) return 'Greenhouse heating is resting. The tank held steady overnight.';
    return 'Greenhouse heating is resting. Overnight the tank released ' +
      fmtKwh(leakageLossWh) + ' kWh to air.';
  }

  if (minutes > 0) {
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;
    const duration = hrs > 0 ? hrs + 'h ' + mins + 'min' : mins + ' minutes';
    const tail = heating
      ? ' — ' + fmtKwh(heatingLossWh) + ' kWh delivered' +
        (leakage ? ', ' + fmtKwh(leakageLossWh) + ' kWh slipped to air' : '') + '.'
      : '.';
    return 'Overnight the greenhouse drew warmth for ' + duration + tail;
  }

  if (!leakage) return 'No heating was needed overnight. The greenhouse stayed warm.';
  return 'No heating was needed overnight. The tank released ' +
    fmtKwh(leakageLossWh) + ' kWh to air.';
}

module.exports = {
  buildEveningBody,
  buildNoonBody,
};
