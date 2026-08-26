// Reactor physics core. Pure state + update(dt), no DOM access, so it can run
// headless (Node) or inside a browser/Electron/Capacitor webview unchanged.

export const DIFFICULTY = {
  easy: { incidentRate: 0.55, feedbackStrength: 1.3, rodSpeed: 9, sensorNoise: 0.15, label: 'Trainee' },
  normal: { incidentRate: 1.0, feedbackStrength: 1.0, rodSpeed: 6, sensorNoise: 0.4, label: 'Shift Supervisor' },
  hard: { incidentRate: 1.7, feedbackStrength: 0.75, rodSpeed: 4.5, sensorNoise: 0.8, label: 'Incident Expert' },
};

const LIMITS = {
  fuelTempNominal: 600,
  fuelTempWarn: 780,
  fuelTempTrip: 850,
  fuelTempMeltdown: 1200,
  coolantTempNominal: 315,
  coolantTempWarn: 335,
  coolantTempTrip: 345,
  pressureNominal: 155,
  pressureReliefOpen: 172,
  pressureReliefClose: 165,
  pressureVesselRisk: 195,
  powerTrip: 122,
  ratedPowerMWe: 1100,
};

export { LIMITS };

// Iodine-135 / Xenon-135 buildup and burnout (simplified, time-compressed for
// gameplay pacing). Chosen so equilibrium xenon at 100% power is worth about
// -0.38 reactivity (a real but not overwhelming drag against the ~2.7-wide
// rod reactivity span) - see xenonEquilibrium() below, used both to size the
// starting state and by _updateNeutronics().
const XENON = { yI: 0.0124, yXe: 0.0006, lambdaI: 0.0021, lambdaXe: 0.00075, sigmaX: 0.000065 };
const XENON_REACTIVITY_COEFF = 0.0021;

function xenonEquilibrium(power) {
  const iodine = (XENON.yI * power) / XENON.lambdaI;
  const xenon = (power * (XENON.yI + XENON.yXe)) / (XENON.lambdaXe + XENON.sigmaX * power);
  return { iodine, xenon };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export class ReactorSim {
  constructor(difficultyKey = 'normal', shiftHours = 8, options = {}) {
    this.difficultyKey = difficultyKey;
    this.diff = DIFFICULTY[difficultyKey] || DIFFICULTY.normal;
    const startShutdown = !!options.startShutdown;

    if (startShutdown) {
      // Cold shutdown: rods fully in, no prior operating history (fresh
      // core, no iodine/xenon), plant at ambient temperature/pressure.
      // Pulling the rods out from here is what brings the reactor critical -
      // this is the state a real startup begins from.
      this.power = 1; // small nonzero source-range reading, not literal zero
      this.fuelTemp = 35;
      this.coolantTemp = 35;
      this.pressure = 1;
      this.coolantInventory = 100;
      this.iodine = 0;
      this.xenon = 0;
      this.rodTarget = 100;
      this.rodInsertion = 100;
    } else {
      // Core state - fuelTemp/coolantTemp/pressure are the exact thermal
      // equilibrium at P=100 (see _updateThermal's comment), and iodine/xenon
      // are seeded at THEIR equilibrium for that same power (xenonEquilibrium
      // above) so the shift starts genuinely steady: nothing "runs toward" a
      // resting state it wasn't already at, xenon included.
      this.power = 100; // % of rated thermal power
      this.fuelTemp = 600;
      this.coolantTemp = 315;
      this.pressure = 155;
      this.coolantInventory = 100; // %
      const eq = xenonEquilibrium(this.power);
      this.iodine = eq.iodine;
      this.xenon = eq.xenon;

      // ~19.4% rod insertion is where rodReactivity cancels the equilibrium
      // xenon feedback above, so the reactor opens exactly critical instead
      // of drifting the moment the shift starts.
      this.rodTarget = 19.4; // 0 = rods fully out, 100 = fully in
      this.rodInsertion = 19.4;
    }

    // Controls (player-set targets).
    this.primaryPumpTarget = 100;
    this.secondaryPumpTarget = 100;
    this.turbineValveTarget = 100;
    this.eccsActive = false;
    this.autoProtectionOverride = false;
    this.makeupPumpActive = false;

    // Actual (lag-limited) actuator state
    this.primaryPump = 100;
    this.secondaryPump = 100;
    this.turbineValve = 100;

    this.reliefValveOpen = false;
    this.scram = false;
    this.scramReason = null;
    this.offsitePower = true;
    this.rodsStuckUntil = 0;
    this.sensorFaultUntil = 0;

    this.simSeconds = 0;
    this.shiftLengthSeconds = shiftHours * 3600;
    this.energyMWh = 0;
    this.penaltyScore = 0;
    this.reliefReleases = 0;
    this.scramCount = 0;

    this.gameOver = false;
    this.gameOverReason = null;
    this.gameOverKind = null;
    this.alarms = [];
    this.log = [];
    this.activeIncidents = [];

    this._pushLog(startShutdown
      ? 'Shift started. Reactor in cold shutdown – withdraw the control rods to bring it critical.'
      : 'Shift started. Reactor in normal operation.');
  }

  _pushLog(text) {
    this.log.push({ t: this.simSeconds, text });
    if (this.log.length > 200) this.log.shift();
  }

  setRodTarget(v) { this.rodTarget = clamp(v, 0, 100); }
  setPrimaryPump(v) { this.primaryPumpTarget = clamp(v, 0, 100); }
  setSecondaryPump(v) { this.secondaryPumpTarget = clamp(v, 0, 100); }
  setTurbineValve(v) { this.turbineValveTarget = clamp(v, 0, 100); }
  toggleEccs(on) { this.eccsActive = !!on; }
  toggleMakeupPump(on) { this.makeupPumpActive = !!on; }

  toggleAutoProtectionOverride(on) {
    const next = !!on;
    if (next === this.autoProtectionOverride) return;
    this.autoProtectionOverride = next;
    this._pushLog(next
      ? 'Automatic SCRAM OVERRIDDEN – reactor protection no longer responds to limits.'
      : 'Automatic SCRAM active again.');
  }

  manualScram(reason = 'Manual SCRAM triggered by operator') {
    if (this.scram || this.gameOver) return;
    this.scram = true;
    this.scramReason = reason;
    this.scramCount++;
    this.rodTarget = 100;
    this._pushLog(reason);
  }

  _tripBlockers() {
    const blockers = [];
    if (this.fuelTemp >= LIMITS.fuelTempTrip) blockers.push(`fuel temperature still too high (${this.fuelTemp.toFixed(0)} °C)`);
    if (this.coolantTemp >= LIMITS.coolantTempTrip) blockers.push(`coolant temperature still too high (${this.coolantTemp.toFixed(0)} °C)`);
    if (this.power >= LIMITS.powerTrip) blockers.push(`power still too high (${this.power.toFixed(0)}%)`);
    if (this.pressure >= LIMITS.pressureVesselRisk) blockers.push(`pressure still too high (${this.pressure.toFixed(0)} bar)`);
    return blockers;
  }

  canResetScram() {
    return this.scram && !this.gameOver && this._tripBlockers().length === 0;
  }

  resetScram() {
    if (!this.scram || this.gameOver) return;
    const blockers = this._tripBlockers();
    if (blockers.length) {
      // Mirrors a real trip interlock: resetting while the tripping condition
      // still holds would just have _autoProtection() re-trip on the very
      // next tick, which reads to the player as "the button does nothing".
      this._pushLog(`SCRAM cannot be reset yet: ${blockers.join(', ')}.`);
      return;
    }
    this.scram = false;
    this.scramReason = null;
    this._pushLog('SCRAM reset – control rods and turbine valve released again.');
  }

  _autoProtection() {
    if (this.scram || this.gameOver || this.autoProtectionOverride) return;
    if (this.fuelTemp >= LIMITS.fuelTempTrip) this.manualScram('AUTOMATIC SCRAM: fuel temperature too high');
    else if (this.coolantTemp >= LIMITS.coolantTempTrip) this.manualScram('AUTOMATIC SCRAM: coolant temperature too high');
    else if (this.power >= LIMITS.powerTrip) this.manualScram('AUTOMATIC SCRAM: power excursion');
    else if (this.pressure >= LIMITS.pressureVesselRisk) this.manualScram('AUTOMATIC SCRAM: pressure limit exceeded');
  }

  _reactivity() {
    const k = this.diff.feedbackStrength;
    const rodsBlocked = this.simSeconds < this.rodsStuckUntil;
    // rods fully out -> +0.95, fully in -> -1.35 (shutdown margin)
    // 0.9 at fully withdrawn, -1.8 at fully inserted; crosses zero (critical) at ~33% insertion
    const insertionFrac = this.rodInsertion / 100;
    const rodReactivity = 0.9 - insertionFrac * 2.7;
    const fuelFeedback = -0.00085 * k * (this.fuelTemp - LIMITS.fuelTempNominal);
    const coolantFeedback = -0.0011 * k * (this.coolantTemp - LIMITS.coolantTempNominal);
    const xenonFeedback = -XENON_REACTIVITY_COEFF * this.xenon;
    const boronOrNoise = this._perturbation || 0;
    this._rodsBlockedNow = rodsBlocked;
    return rodReactivity + fuelFeedback + coolantFeedback + xenonFeedback + boronOrNoise;
  }

  _updateActuators(dt) {
    const rodSpeed = this.diff.rodSpeed; // %/s
    if (this.scram) {
      // Gravity-driven SCRAM drop overrides a stuck rod bank and is much faster
      // than normal control-rod drive speed.
      const dropSpeed = rodSpeed * 3.2;
      const d = clamp(100 - this.rodInsertion, -dropSpeed * dt, dropSpeed * dt);
      this.rodInsertion = clamp(this.rodInsertion + d, 0, 100);
    } else if (this.simSeconds >= this.rodsStuckUntil) {
      const d = clamp(this.rodTarget - this.rodInsertion, -rodSpeed * dt, rodSpeed * dt);
      this.rodInsertion = clamp(this.rodInsertion + d, 0, 100);
    }

    const pumpRate = 25; // %/s
    const towards = (cur, target) => cur + clamp(target - cur, -pumpRate * dt, pumpRate * dt);
    this.primaryPump = clamp(towards(this.primaryPump, this.offsitePower ? this.primaryPumpTarget : Math.min(this.primaryPumpTarget, 35)), 0, 100);
    this.secondaryPump = clamp(towards(this.secondaryPump, this.offsitePower ? this.secondaryPumpTarget : Math.min(this.secondaryPumpTarget, 35)), 0, 100);
    this.turbineValve = clamp(towards(this.turbineValve, this.scram ? 0 : this.turbineValveTarget), 0, 100);
  }

  _updateNeutronics(dt) {
    const rho = this._reactivity();
    this._lastReactivity = rho;
    const LAMBDA = 26; // effective reactor period constant (s) - larger = more sluggish/stable
    // A shut-down reactor is never mathematically at zero power - spontaneous
    // fission and photoneutron sources leave a small but nonzero "source
    // range" population. Modeled as a constant source term (real subcritical-
    // multiplication physics) rather than a hard floor: it settles power to
    // a SMALL reading that still tracks how deep the shutdown is (more
    // negative reactivity -> lower reading), instead of clamping to one
    // fixed number no matter what - a fixed clamp reads as the sim being
    // frozen, since the displayed value stops responding to anything. The
    // same source term is what lets a restart still climb to full power
    // within seconds of pulling the rods back out, since it keeps power
    // from ever decaying all the way to a literal (and slow-to-regrow-from)
    // zero.
    const SOURCE = 0.08;
    const dP = (this.power * (rho / LAMBDA) + SOURCE) * dt;
    this.power = clamp(this.power + dP, 0, 150);

    const { yI, yXe, lambdaI, lambdaXe, sigmaX } = XENON;
    const dI = (yI * this.power - lambdaI * this.iodine) * dt;
    const dXe = (lambdaI * this.iodine + yXe * this.power - lambdaXe * this.xenon - sigmaX * this.xenon * this.power) * dt;
    this.iodine = Math.max(0, this.iodine + dI);
    this.xenon = Math.max(0, this.xenon + dXe);
  }

  _updateThermal(dt) {
    // Coefficients are calibrated so nominal (P=100, flowFactor=1, coolantFactor=1,
    // secondaryFactor=1) is an exact equilibrium at fuelTemp=600 / coolantTemp=315:
    // Q = kGen*100 = kT*(600-315) = (kOut+kLeak)*(315-260)
    const coolantFactor = this.coolantInventory / 100;
    const flowFactor = 0.25 + 0.75 * (this.primaryPump / 100);
    const kGen = 3.1;
    const kT = 1.0877 * flowFactor * (0.15 + 0.85 * coolantFactor);
    // Heat leaving the fuel node equals heat entering the coolant node (energy-conserving).
    const qFuelToCoolant = kT * (this.fuelTemp - this.coolantTemp);
    const dFuel = (kGen * this.power - qFuelToCoolant) * dt;
    this.fuelTemp = Math.max(15, this.fuelTemp + dFuel);

    // Heat removal via the steam generator/auxiliary feedwater tracks the secondary
    // pump, not the turbine valve: decay heat still needs removing after a SCRAM even
    // though the turbine itself has isolated (steam goes to the dump valve instead).
    const secondaryFactor = this.secondaryPump / 100;
    const kOut = 5.336, kLeak = 0.3;
    // Clamped to never go negative: below their reference temperatures (260
    // for the secondary/condenser sink, 180 for ECCS) these terms model "no
    // heat transfer", not a heat source running in reverse. Only reachable
    // with a cold start (ambient coolant is well below both references) -
    // without the clamp the unclamped negative term flips sign and injects
    // runaway heat into the coolant loop instead of removing it.
    const heatOut = Math.max(0, kOut * secondaryFactor * (this.coolantTemp - 260) + kLeak * (this.coolantTemp - 260));
    const eccsCooling = this.eccsActive ? Math.max(0, 0.4 * (this.coolantTemp - 180)) : 0;
    const dCoolant = (qFuelToCoolant - heatOut - eccsCooling) * dt;
    this.coolantTemp = Math.max(15, this.coolantTemp + dCoolant);

    const targetPressure = 155 + (this.coolantTemp - 315) * 1.15 - (this.eccsActive ? 25 : 0);
    this.pressure += (targetPressure - this.pressure) * clamp(dt * 0.4, 0, 1);
    this.pressure = Math.max(1, this.pressure);

    if (!this.reliefValveOpen && this.pressure >= LIMITS.pressureReliefOpen) {
      this.reliefValveOpen = true;
      this.reliefReleases++;
      this.penaltyScore += 45;
      this._pushLog('Relief valve has opened – minor release registered.');
    }
    if (this.reliefValveOpen) {
      this.pressure -= 18 * dt;
      if (this.pressure <= LIMITS.pressureReliefClose) this.reliefValveOpen = false;
    }
  }

  _updateEnergyAndScore(dt) {
    if (this.gameOver) return;
    const electrical = Math.max(0, this.power) / 100 * LIMITS.ratedPowerMWe * (this.turbineValve / 100) * (this.secondaryPump / 100);
    this.energyMWh += electrical * (dt / 3600);
    if (this.fuelTemp >= LIMITS.fuelTempWarn) this.penaltyScore += 0.6 * dt;
  }

  _endGame(kind, reason) {
    this.gameOver = true;
    this.gameOverKind = kind;
    this.gameOverReason = reason;
    this._pushLog(reason);
  }

  _checkMeltdown() {
    if (this.gameOver) return;
    if (this.fuelTemp >= LIMITS.fuelTempMeltdown) {
      this._endGame('meltdown', 'MELTDOWN – fuel temperature has exceeded the limit.');
    } else if (this.pressure >= LIMITS.pressureVesselRisk + 15) {
      this._endGame('vessel', 'VESSEL FAILURE – rupture disc has failed.');
    } else if (this.coolantInventory <= 0) {
      this._endGame('coolant', 'CORE UNCOVERY – loss of coolant not brought under control.');
    } else if (this.simSeconds >= this.shiftLengthSeconds) {
      this._endGame('shift-end', 'SHIFT ENDED – handover to the next shift.');
    }
  }

  _updateAlarms() {
    const alarms = [];
    if (this.fuelTemp >= LIMITS.fuelTempTrip) alarms.push({ level: 'crit', text: 'Fuel temperature CRITICAL' });
    else if (this.fuelTemp >= LIMITS.fuelTempWarn) alarms.push({ level: 'warn', text: 'Fuel temperature high' });
    if (this.coolantTemp >= LIMITS.coolantTempTrip) alarms.push({ level: 'crit', text: 'Coolant temperature CRITICAL' });
    else if (this.coolantTemp >= LIMITS.coolantTempWarn) alarms.push({ level: 'warn', text: 'Coolant temperature high' });
    if (this.pressure >= LIMITS.pressureVesselRisk) alarms.push({ level: 'crit', text: 'Primary pressure CRITICAL' });
    else if (this.pressure >= LIMITS.pressureReliefOpen) alarms.push({ level: 'warn', text: 'Relief valve active' });
    if (this.coolantInventory < 60) alarms.push({ level: 'crit', text: 'Coolant loss – level low' });
    if (!this.offsitePower) alarms.push({ level: 'warn', text: 'Grid outage – running on emergency power' });
    if (this.xenon > 260) alarms.push({ level: 'info', text: 'Pronounced xenon poisoning' });
    if (this.power >= LIMITS.powerTrip - 8) alarms.push({ level: 'warn', text: 'Power approaching trip limit' });
    if (this.autoProtectionOverride) alarms.push({ level: 'crit', text: 'REACTOR PROTECTION OVERRIDDEN – no automatic shutdown' });
    this.alarms = alarms;
  }

  _updateMakeupPump(dt) {
    // A normal-operation charging/makeup system, separate from ECCS: slow
    // enough that it can't outpace an active LOCA leak on its own (ECCS is
    // still what you need for that), but lets the player top the inventory
    // back up to 100% once a leak is actually isolated instead of it
    // sitting at whatever reduced level it happened to settle at.
    const MAKEUP_RATE = 0.05; // %/sim-second
    if (this.makeupPumpActive && this.coolantInventory < 100) {
      this.coolantInventory = Math.min(100, this.coolantInventory + MAKEUP_RATE * dt);
    }
  }

  update(dt) {
    if (this.gameOver) return;
    this.simSeconds += dt;
    this._updateActuators(dt);
    this._autoProtection();
    this._updateNeutronics(dt);
    this._updateThermal(dt);
    this._updateMakeupPump(dt);
    this._updateEnergyAndScore(dt);
    this._updateAlarms();
    this._checkMeltdown();
    this._perturbation = 0;
  }

  // Unfloored running total - lets the live in-shift display actually move
  // (e.g. climb back up from a negative balance) while a SCRAM/temperature
  // penalty outweighs the energy generated so far, instead of just sitting
  // at a flat 0 the whole time and then jumping once it clears - which reads
  // to the player as the score being stuck/broken rather than recovering.
  runningScore() {
    const base = this.energyMWh;
    const scramPenalty = this.scramCount * 180;
    const isCatastrophe = this.gameOverKind === 'meltdown' || this.gameOverKind === 'vessel' || this.gameOverKind === 'coolant';
    const meltdownPenalty = isCatastrophe ? 5000 : 0;
    return Math.round(base - this.penaltyScore - scramPenalty - meltdownPenalty);
  }

  finalScore() {
    return Math.max(0, this.runningScore());
  }
}
