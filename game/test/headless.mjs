import { ReactorSim, DIFFICULTY, LIMITS } from '../js/engine.js';
import { IncidentManager } from '../js/events.js';

function run(name, fn) {
  try { fn(); console.log(`OK   ${name}`); }
  catch (e) { console.log(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

run('steady state at criticality does not diverge or NaN', () => {
  const sim = new ReactorSim('normal', 8);
  for (let i = 0; i < 6000; i++) {
    sim.update(0.25);
    assert(Number.isFinite(sim.power), `power NaN at t=${sim.simSeconds}`);
    assert(Number.isFinite(sim.fuelTemp), `fuelTemp NaN at t=${sim.simSeconds}`);
    assert(Number.isFinite(sim.pressure), `pressure NaN at t=${sim.simSeconds}`);
    if (sim.gameOver) break;
  }
  assert(sim.fuelTemp < LIMITS.fuelTempMeltdown, 'unexpected meltdown holding rods steady near critical');
});

run('withdrawing rods fully causes power excursion and eventual auto-scram', () => {
  const sim = new ReactorSim('normal', 8);
  sim.setRodTarget(0);
  let scrammed = false;
  for (let i = 0; i < 20000 && !sim.gameOver; i++) {
    sim.update(0.25);
    if (sim.scram) { scrammed = true; break; }
  }
  assert(scrammed || sim.gameOver, 'expected auto-protection to trip reactor on full rod withdrawal');
});

run('SCRAM drives power down and rods to fully inserted', () => {
  const sim = new ReactorSim('normal', 8);
  for (let i = 0; i < 400; i++) sim.update(0.25);
  sim.manualScram('test scram');
  for (let i = 0; i < 800; i++) sim.update(0.25);
  assert(sim.rodInsertion > 95, `rods should be fully inserted after scram, got ${sim.rodInsertion}`);
  assert(sim.power < 20, `power should have collapsed after scram, got ${sim.power}`);
});

run('resetScram lets the reactor be restarted (rods and turbine respond again)', () => {
  const sim = new ReactorSim('normal', 8);
  for (let i = 0; i < 400; i++) sim.update(0.25);
  sim.manualScram('test scram');
  for (let i = 0; i < 400; i++) sim.update(0.25);
  sim.setRodTarget(5);
  for (let i = 0; i < 40; i++) sim.update(0.25);
  assert(sim.rodInsertion > 95, `rods should stay pinned near 100 while still scrammed, got ${sim.rodInsertion}`);
  assert(sim.turbineValve < 5, `turbine valve should stay pinned near 0 while still scrammed, got ${sim.turbineValve}`);

  sim.resetScram();
  assert(sim.scram === false, 'scram flag should clear after resetScram');
  for (let i = 0; i < 80; i++) sim.update(0.25);
  assert(sim.rodInsertion < 50, `rods should move back out toward the target after reset, got ${sim.rodInsertion}`);
  assert(sim.turbineValve > 50, `turbine valve should reopen after reset, got ${sim.turbineValve}`);
});

run('restarting after a SCRAM is not imperceptibly slow (power has a source-range floor)', () => {
  const SIM_SPEED = 12; // matches main.js
  const sim = new ReactorSim('normal', 8);
  for (let i = 0; i < 400; i++) sim.update(0.25);
  sim.manualScram('test scram');
  for (let i = 0; i < 400; i++) sim.update(0.25); // let it fully decay and cool
  sim.resetScram();
  sim.setRodTarget(0); // pull rods fully back out to restart
  const realSecondsBudget = 60;
  const simSecondsBudget = realSecondsBudget * SIM_SPEED;
  for (let i = 0; i < simSecondsBudget / 0.25 && sim.power < 20; i++) sim.update(0.25);
  assert(sim.power >= 20, `expected power to climb back above 20% within ${realSecondsBudget} real seconds of restarting, got ${sim.power.toFixed(2)}% after ${(simSecondsBudget / SIM_SPEED).toFixed(0)}s of real time`);
});

run('a sustained deep SCRAM settles power to a small but still-live reading, not a hard-clamped constant', () => {
  const sim = new ReactorSim('normal', 8);
  for (let i = 0; i < 400; i++) sim.update(0.25);
  sim.manualScram('test scram');
  for (let i = 0; i < 200; i++) sim.update(0.25);
  const earlySettled = sim.power;
  for (let i = 0; i < 400; i++) sim.update(0.25);
  const laterSettled = sim.power;
  assert(earlySettled < 10 && laterSettled < 10, `settled subcritical power should stay in the low single digits, got ${earlySettled.toFixed(3)} then ${laterSettled.toFixed(3)}`);
  assert(earlySettled !== laterSettled, `power should keep responding to still-changing reactivity while deeply scrammed, not lock onto one fixed value (both read ${earlySettled})`);
});

run('resetScram refuses an immediate reset while the trip condition still holds (no re-trip loop)', () => {
  const sim = new ReactorSim('normal', 8);
  sim.setRodTarget(0);
  let tripped = false;
  for (let i = 0; i < 3000 && !tripped; i++) {
    sim.update(0.25);
    if (sim.scram) tripped = true;
  }
  assert(tripped, 'expected the power excursion to trip the reactor');
  assert(sim.canResetScram() === false, 'reset should not be offered while power is still above the trip limit');

  sim.resetScram();
  assert(sim.scram === true, 'resetScram should refuse and leave scram engaged while still unsafe');

  sim.update(0.25);
  assert(sim.scramCount === 1, `refused reset must not count as (or trigger) a second SCRAM, got scramCount=${sim.scramCount}`);
});

run('xenon starts at equilibrium and stays flat when the player does nothing', () => {
  const sim = new ReactorSim('normal', 8);
  const startXenon = sim.xenon;
  assert(startXenon > 50, `expected a non-trivial starting xenon equilibrium, got ${startXenon}`);
  for (let i = 0; i < 480; i++) sim.update(0.25); // 120 sim-seconds untouched
  const drift = Math.abs(sim.xenon - startXenon) / startXenon;
  assert(drift < 0.02, `xenon should stay essentially flat at equilibrium with no player input, drifted ${(drift * 100).toFixed(1)}% (from ${startXenon.toFixed(1)} to ${sim.xenon.toFixed(1)})`);
});

run('xenon pit develops after scram (poison rises then falls)', () => {
  const sim = new ReactorSim('normal', 8);
  for (let i = 0; i < 2000; i++) sim.update(0.25); // run up xenon at steady power first
  sim.manualScram('test scram for xenon pit');
  let peak = 0;
  const xenonTrace = [];
  for (let i = 0; i < 4000; i++) {
    sim.update(0.25);
    xenonTrace.push(sim.xenon);
    peak = Math.max(peak, sim.xenon);
  }
  const finalXenon = xenonTrace[xenonTrace.length - 1];
  assert(peak > xenonTrace[0], `expected xenon to rise after scram (pit), start=${xenonTrace[0]} peak=${peak}`);
  assert(finalXenon < peak, `expected xenon to decay after peaking, peak=${peak} final=${finalXenon}`);
});

run('LOCA gives a real reaction window before core uncovery if ignored', () => {
  const SIM_SPEED = 12; // matches main.js
  const sim = new ReactorSim('normal', 8);
  const im = new IncidentManager(DIFFICULTY.normal);
  im.active.push({ type: 'small_loca', data: { dur: 999999, eccsHeld: 0 }, elapsed: 0 });
  const realSecondsUntouched = 20;
  for (let i = 0; i < (realSecondsUntouched * SIM_SPEED) / 0.25; i++) { sim.update(0.25); im.update(sim, 0.25); }
  assert(sim.coolantInventory > 50, `expected a real reaction window, not a sprint to 0 - after ${realSecondsUntouched}s untouched, inventory was ${sim.coolantInventory.toFixed(1)}%`);
});

run('LOCA drains coolant and ECCS actually recovers it (injection outpaces the leak)', () => {
  const sim = new ReactorSim('normal', 8);
  const im = new IncidentManager(DIFFICULTY.normal);
  im.active.push({ type: 'small_loca', data: { dur: 999999, eccsHeld: 0 }, elapsed: 0 });
  for (let i = 0; i < 400 && !sim.gameOver; i++) { sim.update(0.25); im.update(sim, 0.25); }
  const beforeEccs = sim.coolantInventory;
  assert(beforeEccs < 100, 'expected coolant inventory to drop during LOCA');
  sim.toggleEccs(true);
  for (let i = 0; i < 200 && !sim.gameOver; i++) { sim.update(0.25); im.update(sim, 0.25); }
  assert(sim.coolantInventory >= 0, 'coolant inventory should not go negative');
  assert(sim.coolantInventory > beforeEccs, `expected ECCS injection to net-recover inventory, not just hold the drain - was ${beforeEccs.toFixed(1)}%, now ${sim.coolantInventory.toFixed(1)}%`);
});

run('makeup pump refills inventory back to 100% once a leak is isolated', () => {
  const sim = new ReactorSim('normal', 8);
  sim.coolantInventory = 70; // simulate a leak that was already isolated at 70%
  sim.toggleMakeupPump(true);
  for (let i = 0; i < 4000; i++) sim.update(0.25); // 1000 sim-seconds, no active incident
  assert(sim.coolantInventory === 100, `makeup pump should fully top off inventory with no leak active, got ${sim.coolantInventory}`);
});

run('makeup pump alone cannot outrun an active LOCA leak (ECCS is still required)', () => {
  const sim = new ReactorSim('normal', 8);
  const im = new IncidentManager(DIFFICULTY.normal);
  im.active.push({ type: 'small_loca', data: { dur: 999999, eccsHeld: 0 }, elapsed: 0 });
  sim.toggleMakeupPump(true);
  for (let i = 0; i < 800 && !sim.gameOver; i++) { sim.update(0.25); im.update(sim, 0.25); } // 200 sim-seconds
  assert(sim.coolantInventory < 100, `makeup pump alone should not be able to hold off an active leak, got ${sim.coolantInventory.toFixed(1)}%`);
});

run('overriding auto-protection lets an excursion run past the trip point uncaught', () => {
  const sim = new ReactorSim('normal', 8);
  sim.toggleAutoProtectionOverride(true);
  sim.setRodTarget(0);
  for (let i = 0; i < 3000 && !sim.gameOver; i++) sim.update(0.25);
  assert(sim.scram === false, 'auto-protection should not trip while overridden');
  assert(sim.power > LIMITS.powerTrip, `expected power to run past the normal trip limit while overridden, got ${sim.power}`);
  assert(sim.alarms.some((a) => a.text.includes('OVERRIDDEN')), 'a standing alarm should warn that protection is overridden');

  sim.toggleAutoProtectionOverride(false);
  sim.update(0.25);
  assert(sim.scram === true, 'auto-protection should trip immediately once override is switched back off with power still past the limit');
});

run('full meltdown scenario ends game with reason set', () => {
  const sim = new ReactorSim('hard', 1);
  sim.setRodTarget(0);
  sim.setPrimaryPump(0);
  sim.setSecondaryPump(0);
  for (let i = 0; i < 12000 && !sim.gameOver; i++) sim.update(0.25);
  assert(sim.gameOver, 'expected game over eventually under worst-case operator inputs');
  assert(typeof sim.gameOverReason === 'string' && sim.gameOverReason.length > 0, 'gameOverReason should be set');
  assert(['meltdown', 'vessel', 'coolant'].includes(sim.gameOverKind), `expected a catastrophe gameOverKind, got ${sim.gameOverKind}`);
});

run('vessel failure is classified and scored as a catastrophe, not a normal shift end', () => {
  const sim = new ReactorSim('hard', 1);
  sim.toggleAutoProtectionOverride(true);
  sim.setRodTarget(0);
  sim.setSecondaryPump(0);
  sim.setTurbineValve(0);
  for (let i = 0; i < 20000 && !sim.gameOver; i++) sim.update(0.25);
  assert(sim.gameOver, 'expected the vessel to fail under these worst-case conditions');
  assert(sim.gameOverKind === 'vessel', `expected gameOverKind 'vessel', got ${sim.gameOverKind}`);
  assert(sim.finalScore() === 0, `a vessel failure should incur the catastrophe penalty and floor the score at 0, got ${sim.finalScore()}`);
});

run('incident manager produces incidents over a long run without throwing', () => {
  const sim = new ReactorSim('hard', 8);
  const im = new IncidentManager(DIFFICULTY.hard);
  let sawAny = false;
  for (let i = 0; i < 8000 && !sim.gameOver; i++) {
    sim.update(0.25);
    im.update(sim, 0.25);
    if (im.active.length) sawAny = true;
  }
  assert(sawAny, 'expected at least one incident to fire over a long hard-mode run');
});

run('resolving a main coolant pump failure actually restores the pump target', () => {
  const sim = new ReactorSim('normal', 8);
  const im = new IncidentManager(DIFFICULTY.normal);
  im.active.push({ type: 'pump_trip_primary', data: { dur: 999999 }, elapsed: 0 });
  im.lastByType.pump_trip_primary = sim.simSeconds;
  for (let i = 0; i < 20; i++) { sim.update(0.25); im.update(sim, 0.25); }
  assert(sim.primaryPumpTarget <= 0, `pump target should be clamped to 0 while tripped, got ${sim.primaryPumpTarget}`);
  im.resolveIncident(sim, 'pump_trip_primary');
  assert(sim.primaryPumpTarget === 100, `resolving the pump failure should restore the pump target to 100, got ${sim.primaryPumpTarget}`);
});

run('a main coolant pump failure that times out on its own also restores the pump target', () => {
  const sim = new ReactorSim('normal', 8);
  const im = new IncidentManager(DIFFICULTY.normal);
  im.active.push({ type: 'pump_trip_primary', data: { dur: 1 }, elapsed: 0 });
  for (let i = 0; i < 20; i++) { sim.update(0.25); im.update(sim, 0.25); }
  assert(im.active.length === 0, 'the incident should have expired on its own');
  assert(sim.primaryPumpTarget === 100, `pump target should recover once the failure expires, got ${sim.primaryPumpTarget}`);
});

run('finalScore is a finite number', () => {
  const sim = new ReactorSim('normal', 8);
  for (let i = 0; i < 1000; i++) sim.update(0.25);
  assert(Number.isFinite(sim.finalScore()), 'finalScore should be finite');
});

run('cold start begins subcritical and can be brought critical by withdrawing rods', () => {
  const sim = new ReactorSim('normal', 8, { startShutdown: true });
  assert(sim.rodInsertion === 100, `cold start should begin with rods fully inserted, got ${sim.rodInsertion}`);
  assert(sim.power < 5, `cold start should begin at a near-zero power reading, got ${sim.power}`);
  assert(sim.xenon === 0, `cold start should begin with no xenon history, got ${sim.xenon}`);
  for (let i = 0; i < 40; i++) {
    assert(Number.isFinite(sim.power), `power NaN at t=${sim.simSeconds}`);
    sim.update(0.25);
  }
  assert(sim.power < 5, `power should stay near-zero while rods stay fully inserted, got ${sim.power}`);

  // A cold core has a much bigger reactivity margin than a hot one (fuel and
  // coolant temperature feedback are strongly negative, so cold = more
  // positive reactivity at any given rod position) - a careful startup slows
  // the withdrawal rate down as power climbs, exactly like a real operator
  // would, rather than jumping straight to the hot-equilibrium rod position.
  let target = 100;
  for (let step = 0; step < 200 && sim.power < 95 && !sim.scram; step++) {
    const stepSize = sim.power > 60 ? 1 : (sim.power > 20 ? 2 : 4);
    target = Math.max(19.4, target - stepSize);
    sim.setRodTarget(target);
    for (let i = 0; i < 240; i++) sim.update(0.25);
  }
  assert(!sim.scram, `a careful, gradual cold startup should not trip automatic protection, tripped at power=${sim.power}`);
  assert(sim.power >= 90, `a careful cold startup should reach near-full power, got ${sim.power}`);
  assert(!sim.gameOver, 'a normal cold startup should not trip any protection on its own');
});

run('cold coolant does not runaway-heat on the very first tick (heat-sink formula must not go negative)', () => {
  const sim = new ReactorSim('normal', 8, { startShutdown: true });
  const startCoolant = sim.coolantTemp;
  sim.update(0.25);
  assert(sim.coolantTemp < startCoolant + 5, `coolant temp should barely move in one 0.25s tick from cold, went from ${startCoolant} to ${sim.coolantTemp}`);
  assert(!sim.scram, 'a single tick from cold shutdown should never trip protection');
});

run('runningScore can recover from a SCRAM penalty instead of sitting pinned at 0', () => {
  const sim = new ReactorSim('normal', 8);
  sim.manualScram();
  const deepInDebt = sim.runningScore();
  assert(deepInDebt < 0, `runningScore should go negative right after a SCRAM penalty, got ${deepInDebt}`);
  assert(sim.finalScore() === 0, `finalScore should still floor at 0 while in debt, got ${sim.finalScore()}`);
  sim.resetScram();
  sim.setRodTarget(19.4);
  for (let i = 0; i < 4000; i++) sim.update(0.25);
  const recovered = sim.runningScore();
  assert(recovered > deepInDebt, `runningScore should climb back up as energy is generated, was ${deepInDebt}, now ${recovered}`);
});

console.log('\nHeadless engine tests complete.');
