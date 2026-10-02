'use strict';

// sustain-forecast-notes.js — operator-facing prose for the 48 h sustain
// forecast. Split out of sustain-forecast.js to keep files under the
// 600-line cap. Pure: takes a summary ctx, returns up to 3 note strings.

const { helsinkiHHMM } = require('./sustain-forecast-fit-base');

const HELSINKI_WEEKDAY_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Helsinki', weekday: 'short',
});

// "When does the space heater first switch on?" — shared by both
// engines. Reads the first emergency entry in which the heater actually
// ran (duty > 0) and the greenhouse temperature at that timestamp. A
// time within 24 h of `now` is a bare HH:MM; later ones get the weekday
// so a 48 h window can't be misread. Returns null when the heater never
// runs. (The note used to name the 48 h greenhouse MINIMUM, which with
// the heater cycling is just the bottom of some later cycle.)
function heaterStartNote(modeForecast, ghTrajectory, now) {
  const first = (modeForecast || []).find(function (m) {
    return m.mode === 'emergency_heating' && typeof m.duty === 'number' && m.duty > 0;
  });
  if (!first) return null;
  const point = (ghTrajectory || []).find(function (p) { return p.ts === first.ts; });
  const tempTxt = point ? point.temp.toFixed(1) + ' °C' : null;
  const startMs = Date.parse(first.ts);
  if (startMs <= now) {
    return 'Space heater is cycling on from now' + (tempTxt ? ' — greenhouse at ' + tempTxt : '') + '.';
  }
  const when = (startMs - now < 24 * 3600 * 1000 ? '' : HELSINKI_WEEKDAY_FMT.format(startMs) + ' ')
    + helsinkiHHMM(startMs);
  return (tempTxt ? 'Greenhouse cools to ' + tempTxt + ' around ' + when : 'Around ' + when)
    + ', when the space heater first switches on.';
}

// Notes are ordered by operational relevance: GH min temp, tank stored
// kWh + sustain hours, backup electric usage, solar gain. Capped at 3.
function buildNotes(ctx) {
  const notes = [];

  if (ctx.usedDefaults) {
    notes.push('Forecast based on default coefficients — model still warming up with limited history.');
  }

  // 1. When the space heater first switches on — or, with no backup in
  //    the window, the greenhouse minimum the tank holds it above.
  if (ctx.ghMin !== undefined && notes.length < 3) {
    const heaterNote = ctx.electricKwh > 0
      ? heaterStartNote(ctx.modeForecast, ctx.ghTrajectory, ctx.now) : null;
    if (heaterNote) {
      notes.push(heaterNote);
    } else {
      notes.push(
        'Greenhouse holds above ' + ctx.ghMin.toFixed(1) + ' °C the whole window — tank covers it without backup.'
      );
    }
  }

  // 2. Tank storage + sustain hours. Same tankStoredEnergyKwh formula
  //    as the gauge tile / balance card / push notifications.
  if (ctx.tankStoredKwhNow !== undefined && notes.length < 3) {
    const stored = ctx.tankStoredKwhNow.toFixed(1);
    if (ctx.hoursUntilBackupNeeded === 0) {
      // Tank too cold for radiator OR backup already cycling — naming
      // this "~0 h until backup" reads as broken; surface it explicitly.
      notes.push(
        'Tank stores ~' + stored + ' kWh above the floor, but it’s too cold ' +
        'to drive the radiator — the space heater is providing the heating.'
      );
    } else if (ctx.hoursUntilBackupNeeded !== null) {
      notes.push(
        'Tank stores ~' + stored + ' kWh above the floor — covers greenhouse heating for about ~' +
        Math.round(ctx.hoursUntilBackupNeeded) + ' h before the space heater kicks in.'
      );
    } else if (ctx.electricKwh > 0) {
      notes.push(
        'Tank stores ~' + stored + ' kWh above the floor; heating bridges most of the night, with ~' +
        Math.round(ctx.electricKwh) + ' h of space-heater backup mixed in.'
      );
    } else {
      notes.push(
        'Tank stores ~' + stored + ' kWh above the floor — enough for the whole window with no backup needed.'
      );
    }
  }

  // 3. Backup electricity summary (cost and hours), if any.
  if (ctx.electricKwh > 0 && notes.length < 3) {
    const eur = ctx.electricCostEur;
    notes.push(
      'Space heater projected: ~' + Math.round(ctx.electricKwh) +
      ' kWh over the next 48 h, costing about €' + eur.toFixed(2) + '.'
    );
  }

  // 4. Solar gain context (today / tomorrow), if there's slot room.
  if (Array.isArray(ctx.solarGainByDay) && ctx.solarGainByDay.length > 0 && notes.length < 3) {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ctx.now));
    const parts = ctx.solarGainByDay.slice(0, 2).map(function (d) {
      const label = d.date === today ? 'Today' : 'Tomorrow';
      const kwh = d.kWh < 0.5 ? d.kWh.toFixed(1) : Math.round(d.kWh);
      return label + ' ~' + kwh + ' kWh';
    });
    if (parts.length > 0) {
      notes.push('Solar gain projected: ' + parts.join(', ') + '.');
    }
  }

  return notes;
}

module.exports = { buildNotes, heaterStartNote };
