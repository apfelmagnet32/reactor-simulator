// Incident/event system layered on top of ReactorSim. Keeps its own small
// state machine per active incident and mutates the sim's actuator flags.

function rand(rng) { return rng ? rng() : Math.random(); }

const DEFS = {
  pump_trip_primary: {
    title: 'Main Coolant Pump Failure',
    detail: 'The primary pump has failed. Reduce power or reset the pump.',
    minGap: 90,
    weight: 1.0,
    duration: () => 40 + rand() * 40,
    start(sim) { sim.primaryPumpTripped = true; },
    tick(sim) { sim.primaryPumpTarget = Math.min(sim.primaryPumpTarget, 0); },
    end(sim) { sim.primaryPumpTripped = false; sim.primaryPumpTarget = 100; },
    resolvable: true,
    resolve(sim) { sim.primaryPumpTripped = false; sim.primaryPumpTarget = 100; },
  },
  loss_offsite_power: {
    title: 'Grid Outage',
    detail: 'The external power grid has failed. Start the emergency diesel until the grid returns.',
    minGap: 150,
    weight: 0.7,
    duration: () => 50 + rand() * 50,
    start(sim) { sim.offsitePower = false; sim.dieselActive = false; },
    tick(sim) {},
    end(sim) { sim.offsitePower = true; },
    resolvable: false,
  },
  stuck_rod: {
    title: 'Control Rod Bank Stuck',
    detail: 'A control rod bank is not responding to commands and has to free itself up over time.',
    minGap: 120,
    weight: 0.9,
    duration: () => 35 + rand() * 35,
    start(sim, data) { data.until = sim.simSeconds + data.dur; sim.rodsStuckUntil = data.until; },
    tick(sim, data) { sim.rodsStuckUntil = Math.max(sim.rodsStuckUntil, data.until); },
    end(sim) {},
    resolvable: false,
  },
  small_loca: {
    title: 'Small Loss-of-Coolant Accident (LOCA)',
    detail: 'A leak in the primary loop is lowering the coolant level. Activate the emergency core cooling system (ECCS) to make up coolant and isolate the leak.',
    minGap: 220,
    weight: 0.45,
    duration: () => 999999,
    start(sim, data) { data.eccsHeld = 0; },
    tick(sim, data, dt) {
      const LEAK_RATE = 0.15; // %/sim-second - a real reaction window, not a ~7s sprint to core uncovery
      const ECCS_INJECTION_RATE = 0.5; // %/sim-second - real ECCS is sized to outpace a "small" LOCA break
      if (sim.eccsActive) {
        sim.coolantInventory = Math.min(100, sim.coolantInventory + (ECCS_INJECTION_RATE - LEAK_RATE) * dt);
        data.eccsHeld += dt;
      } else {
        sim.coolantInventory = Math.max(0, sim.coolantInventory - LEAK_RATE * dt);
        data.eccsHeld = Math.max(0, data.eccsHeld - dt * 0.5);
      }
      if (data.eccsHeld >= 12) data.done = true;
    },
    end(sim) {},
    resolvable: false,
    isDone(sim, data) { return !!data.done; },
  },
  sensor_fault: {
    title: 'Sensor Fault',
    detail: 'Instrumentation is delivering noisy readings. Interpret the gauges with caution.',
    minGap: 100,
    weight: 0.8,
    duration: () => 30 + rand() * 30,
    start(sim, data) { sim.sensorFaultUntil = sim.simSeconds + data.dur; },
    tick(sim, data) { sim.sensorFaultUntil = Math.max(sim.sensorFaultUntil, sim.simSeconds + 1); },
    end(sim) {},
    resolvable: false,
  },
  control_glitch: {
    title: 'Reactivity Disturbance',
    detail: 'A brief reactor control glitch is generating reactivity noise. Trim the control rods.',
    minGap: 130,
    weight: 0.6,
    duration: () => 20 + rand() * 20,
    start() {},
    tick(sim) { sim._perturbation = (Math.random() - 0.5) * 0.06; },
    end(sim) { sim._perturbation = 0; },
    resolvable: false,
  },
};

export class IncidentManager {
  constructor(difficulty) {
    this.diff = difficulty;
    this.active = [];
    this.lastByType = {};
    this.nextCheck = 20;
  }

  toggleDiesel(sim, on) {
    sim.dieselActive = !!on;
    if (on && !sim.offsitePower) {
      sim.primaryPumpTarget = Math.min(sim.primaryPumpTarget, 55);
      sim.secondaryPumpTarget = Math.min(sim.secondaryPumpTarget, 55);
    }
  }

  resolveIncident(sim, typeId) {
    const inst = this.active.find((i) => i.type === typeId);
    if (!inst) return;
    const def = DEFS[typeId];
    if (def.resolvable) {
      def.resolve(sim, inst.data);
      this._end(sim, inst);
    }
  }

  _end(sim, inst) {
    const def = DEFS[inst.type];
    def.end(sim, inst.data);
    inst.finished = true;
    sim._pushLog(`Resolved: ${def.title}`);
    this.active = this.active.filter((i) => i !== inst);
  }

  update(sim, dt) {
    if (sim.gameOver) return;
    for (const inst of [...this.active]) {
      const def = DEFS[inst.type];
      def.tick(sim, inst.data, dt);
      inst.elapsed += dt;
      const isDone = def.isDone ? def.isDone(sim, inst.data) : inst.elapsed >= inst.data.dur;
      if (isDone) this._end(sim, inst);
    }

    if (sim.simSeconds < this.nextCheck) return;
    this.nextCheck = sim.simSeconds + 6;
    if (this.active.length >= 2) return;

    const candidates = Object.entries(DEFS).filter(([id]) => {
      const last = this.lastByType[id] || -9999;
      const gapOk = sim.simSeconds - last >= DEFS[id].minGap;
      const notActive = !this.active.some((i) => i.type === id);
      return gapOk && notActive;
    });
    if (!candidates.length) return;

    const perMinuteChance = 0.10 * this.diff.incidentRate;
    const chanceThisCheck = perMinuteChance * (6 / 60);
    if (Math.random() > chanceThisCheck) return;

    const totalWeight = candidates.reduce((s, [, d]) => s + d.weight, 0);
    let r = Math.random() * totalWeight;
    let chosen = candidates[0];
    for (const c of candidates) { r -= c[1].weight; if (r <= 0) { chosen = c; break; } }
    const [id, def] = chosen;
    const data = { dur: def.duration() };
    const inst = { type: id, data, elapsed: 0 };
    def.start(sim, data);
    this.active.push(inst);
    this.lastByType[id] = sim.simSeconds;
    sim._pushLog(`INCIDENT: ${def.title} – ${def.detail}`);
  }

  activeSummaries() {
    return this.active.map((i) => ({ type: i.type, title: DEFS[i.type].title, detail: DEFS[i.type].detail, resolvable: DEFS[i.type].resolvable }));
  }
}

export { DEFS as INCIDENT_DEFS };
