import { ReactorSim, DIFFICULTY } from './engine.js';
import { IncidentManager } from './events.js';
import { drawCore, drawGauges } from './render.js';

const HIGHSCORE_KEY = 'reaktor_leitstand_highscore_v1';
const TOS_ACCEPTED_KEY = 'reaktor_leitstand_tos_accepted_v1';
const INTRO_SEEN_KEY = 'reaktor_leitstand_intro_seen_v1';
const TOS_URL = 'https://gist.github.com/apfelmagnet32/37dc3da37e3163e5d9dc0e6090fd4f05';
const LICENSE_URL = 'https://gist.github.com/apfelmagnet32/c283cf1be9c7e995368220e801d32e3d';

const TUTORIAL_STEPS = [
  'Welcome aboard. The reactor is in cold shutdown – rods fully inserted, power essentially zero. Pull the Control rods slider out a few percent (toward 0%) to start bringing it critical.',
  'A cold core has more margin than a hot one, so it responds faster than you might expect. Withdraw in small steps and wait each time: once power starts climbing, pause it there for a bit before pulling further.',
  'As power and temperature rise, slow down even more – pull the rods out in smaller and smaller steps the closer you get to 100%. Rushing the last stretch is the most common way to trip the reactor during startup.',
  'The Main coolant pump and Feedwater pump are already running at 100% and carry heat out of the core. Leave them there during normal operation.',
  'The Turbine valve turns steam into your energy and score. It is already open – once the reactor is producing power, energy starts counting.',
  'Watch the gauges on the right. Each has a red mark – that is the critical threshold, not the top of the scale. A banner appears above if something needs your attention.',
  'If anything looks dangerous, the red SCRAM button instantly shuts the reactor down. It costs points, but never the shift – when in doubt, use it.',
  'Random incidents will show up under "Active Incidents" with an explanation and, if needed, a button to acknowledge or resolve them.',
  'That is the whole control room. Bring the reactor critical, hold it steady, and see how much energy you can generate. Good luck.',
];

const el = (id) => document.getElementById(id);
const menuScreen = el('menu-screen');
const gameScreen = el('game-screen');
const gameoverScreen = el('gameover-screen');

let state = { difficulty: 'normal', shiftHours: 8, tutorial: false };
let sim = null;
let incidents = null;
let rafId = null;
let lastFrameTime = null;
let tutorialStepIndex = 0;

function fmtClock(simSeconds) {
  const totalMin = Math.floor(simSeconds / 60);
  const h = Math.floor(totalMin / 60).toString().padStart(2, '0');
  const m = (totalMin % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

function bestScore() {
  try { return parseInt(localStorage.getItem(HIGHSCORE_KEY) || '0', 10); }
  catch { return 0; }
}
function saveBestScore(v) {
  try { localStorage.setItem(HIGHSCORE_KEY, String(v)); } catch { /* storage unavailable */ }
}

function tosAccepted() {
  try { return localStorage.getItem(TOS_ACCEPTED_KEY) === '1'; }
  catch { return false; }
}
function setTosAccepted(v) {
  try { v ? localStorage.setItem(TOS_ACCEPTED_KEY, '1') : localStorage.removeItem(TOS_ACCEPTED_KEY); }
  catch { /* storage unavailable */ }
}

function introSeen() {
  try { return localStorage.getItem(INTRO_SEEN_KEY) === '1'; }
  catch { return true; }
}
function markIntroSeen() {
  try { localStorage.setItem(INTRO_SEEN_KEY, '1'); } catch { /* storage unavailable */ }
}

function initMenu() {
  el('highscore-line').textContent = `Best score: ${bestScore()} points`;

  el('tos-link').href = TOS_URL;
  el('tos-link-2').href = TOS_URL;
  el('license-link').href = LICENSE_URL;
  const tosCheckbox = el('tos-checkbox');
  const startBtn = el('start-btn');
  const tutorialBtn = el('tutorial-btn');
  tosCheckbox.checked = tosAccepted();
  startBtn.disabled = !tosCheckbox.checked;
  tutorialBtn.disabled = !tosCheckbox.checked;
  tosCheckbox.addEventListener('change', () => {
    startBtn.disabled = !tosCheckbox.checked;
    tutorialBtn.disabled = !tosCheckbox.checked;
    setTosAccepted(tosCheckbox.checked);
  });

  el('diff-select').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-diff]');
    if (!btn) return;
    state.difficulty = btn.dataset.diff;
    [...el('diff-select').children].forEach((b) => b.classList.toggle('active', b === btn));
  });
  el('shift-select').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-hours]');
    if (!btn) return;
    state.shiftHours = parseInt(btn.dataset.hours, 10);
    [...el('shift-select').children].forEach((b) => b.classList.toggle('active', b === btn));
  });
  el('start-btn').addEventListener('click', () => { state.tutorial = false; startGame(); });
  el('tutorial-btn').addEventListener('click', () => { applyTutorialPreset(); state.tutorial = true; startGame(); });
  el('restart-btn').addEventListener('click', () => {
    gameoverScreen.classList.add('hidden');
    menuScreen.classList.remove('hidden');
    el('highscore-line').textContent = `Best score: ${bestScore()} points`;
  });

  if (!introSeen()) {
    el('intro-modal').classList.remove('hidden');
  }
  el('intro-tutorial-btn').addEventListener('click', () => {
    markIntroSeen();
    el('intro-modal').classList.add('hidden');
    applyTutorialPreset();
    if (tosAccepted()) {
      state.tutorial = true;
      startGame();
    } else {
      const tosField = el('tos-checkbox').closest('label');
      tosField.classList.remove('pulse');
      void tosField.offsetWidth; // restart the animation
      tosField.classList.add('pulse');
    }
  });
  el('intro-skip-btn').addEventListener('click', () => {
    markIntroSeen();
    el('intro-modal').classList.add('hidden');
  });
}

function applyTutorialPreset() {
  state.difficulty = 'easy';
  state.shiftHours = 2;
  [...el('diff-select').children].forEach((b) => b.classList.toggle('active', b.dataset.diff === 'easy'));
  [...el('shift-select').children].forEach((b) => b.classList.toggle('active', b.dataset.hours === '2'));
}

function bindSlider(sliderId, readoutId, onChange, suffix = '%') {
  const slider = el(sliderId);
  const readout = el(readoutId);
  slider.addEventListener('input', () => {
    readout.textContent = `${slider.value}${suffix}`;
    onChange(Number(slider.value));
  });
}

function setupControls() {
  bindSlider('rod-slider', 'rod-readout', (v) => sim.setRodTarget(v));
  bindSlider('primary-slider', 'primary-readout', (v) => sim.setPrimaryPump(v));
  bindSlider('secondary-slider', 'secondary-readout', (v) => sim.setSecondaryPump(v));
  bindSlider('turbine-slider', 'turbine-readout', (v) => sim.setTurbineValve(v));

  el('scram-btn').addEventListener('click', () => sim.manualScram());
  el('scram-reset-btn').addEventListener('click', () => sim.resetScram());

  el('eccs-btn').addEventListener('click', () => {
    const on = !sim.eccsActive;
    sim.toggleEccs(on);
    el('eccs-btn').classList.toggle('on', on);
  });
  el('diesel-btn').addEventListener('click', () => {
    const on = !sim.dieselActive;
    incidents.toggleDiesel(sim, on);
    el('diesel-btn').classList.toggle('on', on);
  });
  el('override-btn').addEventListener('click', () => {
    const on = !sim.autoProtectionOverride;
    sim.toggleAutoProtectionOverride(on);
    el('override-btn').classList.toggle('on', on);
  });
  el('makeup-btn').addEventListener('click', () => {
    const on = !sim.makeupPumpActive;
    sim.toggleMakeupPump(on);
    el('makeup-btn').classList.toggle('on', on);
  });

  el('tutorial-next-btn').addEventListener('click', () => {
    if (tutorialStepIndex < TUTORIAL_STEPS.length - 1) showTutorialStep(tutorialStepIndex + 1);
    else el('tutorial-box').classList.add('hidden');
  });
  el('tutorial-skip-btn').addEventListener('click', () => el('tutorial-box').classList.add('hidden'));
}

function showTutorialStep(i) {
  tutorialStepIndex = i;
  el('tutorial-text').textContent = TUTORIAL_STEPS[i];
  el('tutorial-next-btn').textContent = i === TUTORIAL_STEPS.length - 1 ? 'Got it' : 'Next';
}

function resetControlsUI() {
  const rodDefault = Math.round(sim.rodInsertion);
  el('rod-slider').value = rodDefault; el('rod-readout').textContent = `${rodDefault}%`;
  el('primary-slider').value = 100; el('primary-readout').textContent = '100%';
  el('secondary-slider').value = 100; el('secondary-readout').textContent = '100%';
  el('turbine-slider').value = 100; el('turbine-readout').textContent = '100%';
  el('eccs-btn').classList.remove('on');
  el('diesel-btn').classList.remove('on');
  el('override-btn').classList.remove('on');
  el('makeup-btn').classList.remove('on');
}

function startGame() {
  sim = new ReactorSim(state.difficulty, state.shiftHours, { startShutdown: true });
  incidents = new IncidentManager(DIFFICULTY[state.difficulty]);
  window.__debug = { sim, incidents };
  resetControlsUI();
  menuScreen.classList.add('hidden');
  gameoverScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  el('tutorial-box').classList.toggle('hidden', !state.tutorial);
  if (state.tutorial) showTutorialStep(0);
  lastFrameTime = null;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loop);
}

const coreCanvas = el('core-canvas');
const gaugesCanvas = el('gauges-canvas');
const coreCtx = coreCanvas.getContext('2d');
const gaugesCtx = gaugesCanvas.getContext('2d');

const SIM_SPEED = 12; // simulated seconds per real second

function loop(t) {
  if (lastFrameTime === null) lastFrameTime = t;
  let realDt = (t - lastFrameTime) / 1000;
  lastFrameTime = t;
  realDt = Math.min(realDt, 0.1); // guard against tab-hidden jumps
  const dt = realDt * SIM_SPEED;

  if (!sim.gameOver) {
    sim.update(dt);
    incidents.update(sim, dt);
  }

  render(t);

  if (sim.gameOver) { endGame(); return; }
  rafId = requestAnimationFrame(loop);
}

function render(t) {
  drawCore(coreCtx, sim, t);
  const sensorNoise = sim.simSeconds < sim.sensorFaultUntil;
  drawGauges(gaugesCtx, sim, sensorNoise);

  // The primary pump target can be overridden by an incident (tripped to 0,
  // restored on resolve/expiry) without any slider input from the player -
  // keep the slider's displayed position in sync so it never shows a stale
  // value the pump isn't actually running at.
  const primarySlider = el('primary-slider');
  const primaryRounded = Math.round(sim.primaryPumpTarget);
  if (Number(primarySlider.value) !== primaryRounded) {
    primarySlider.value = primaryRounded;
    el('primary-readout').textContent = `${primaryRounded}%`;
  }

  el('shift-time').textContent = fmtClock(sim.simSeconds);
  el('energy-val').textContent = `${sim.energyMWh.toFixed(1)} MWh`;
  el('score-val').textContent = `${sim.runningScore()}`;
  const resetBtn = el('scram-reset-btn');
  resetBtn.classList.toggle('hidden', !sim.scram);
  if (sim.scram) {
    const ready = sim.canResetScram();
    resetBtn.disabled = !ready;
    resetBtn.classList.toggle('not-ready', !ready);
    resetBtn.textContent = ready ? 'RESET SCRAM' : 'NOT SAFE YET…';
  }

  const banner = el('alarm-banner');
  if (!sim.alarms.length) {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
    const worst = sim.alarms.some((a) => a.level === 'crit') ? 'crit' : 'warn';
    banner.classList.toggle('warn-only', worst !== 'crit');
    banner.textContent = sim.alarms.map((a) => a.text).join('   •   ');
  }

  const incList = el('incidents-list');
  const active = incidents.activeSummaries();
  if (!active.length) {
    incList.className = 'empty';
    incList.textContent = 'No active incidents.';
  } else {
    incList.className = '';
    incList.innerHTML = '';
    active.forEach((inc) => {
      const card = document.createElement('div');
      card.className = 'incident-card';
      const title = document.createElement('div');
      title.className = 'ititle'; title.textContent = inc.title;
      const detail = document.createElement('div');
      detail.className = 'idetail'; detail.textContent = inc.detail;
      card.appendChild(title); card.appendChild(detail);
      if (inc.resolvable) {
        const btn = document.createElement('button');
        btn.textContent = 'Acknowledge / Reset';
        btn.addEventListener('click', () => incidents.resolveIncident(sim, inc.type));
        card.appendChild(btn);
      }
      incList.appendChild(card);
    });
  }

  const logList = el('log-list');
  const entries = sim.log.slice(-40).reverse();
  logList.innerHTML = '';
  for (const entry of entries) {
    const line = document.createElement('div');
    if (/SCRAM|MELTDOWN|FAILURE|UNCOVERY|INCIDENT/.test(entry.text)) line.className = 'crit';
    line.textContent = `[${fmtClock(entry.t)}] ${entry.text}`;
    logList.appendChild(line);
  }
}

const GAMEOVER_COPY = {
  meltdown: { title: 'MELTDOWN', tagline: 'The core has melted through. This is now officially a sarcophagus project.' },
  vessel: { title: 'VESSEL FAILURE', tagline: 'The reactor pressure vessel could no longer withstand the pressure. Point of no return.' },
  coolant: { title: 'CORE UNCOVERY', tagline: 'The core sat dry before anyone could react.' },
  'shift-end': { title: 'Shift Ended', tagline: 'Handover to the next shift – no incidents.' },
};

function endGame() {
  gameScreen.classList.add('hidden');
  gameoverScreen.classList.remove('hidden');
  el('tutorial-box').classList.add('hidden');
  const score = sim.finalScore();
  const copy = GAMEOVER_COPY[sim.gameOverKind] || GAMEOVER_COPY['shift-end'];
  const isFailure = sim.gameOverKind !== 'shift-end';
  el('gameover-title').textContent = copy.title;
  el('gameover-title').classList.toggle('failure', isFailure);
  el('gameover-reason').textContent = copy.tagline;
  el('result-energy').textContent = `${sim.energyMWh.toFixed(1)} MWh`;
  el('result-scrams').textContent = String(sim.scramCount);
  el('result-releases').textContent = String(sim.reliefReleases);
  el('result-score').textContent = String(score);

  const best = bestScore();
  const line = el('new-highscore-line');
  if (score > best) {
    saveBestScore(score);
    line.textContent = `New best score: ${score} points!`;
  } else {
    line.textContent = `Best score: ${best} points`;
  }
}

document.addEventListener('visibilitychange', () => { lastFrameTime = null; });

setupControls();
initMenu();
