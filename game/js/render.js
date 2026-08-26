import { LIMITS } from './engine.js';

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp01(t) { return Math.max(0, Math.min(1, t)); }

function heatColor(frac) {
  // frac 0..1 -> blue (cold) -> green -> yellow -> red (hot)
  const stops = [
    [0.00, [58, 120, 220]],
    [0.35, [53, 201, 122]],
    [0.65, [240, 178, 59]],
    [0.85, [239, 87, 42]],
    [1.00, [239, 68, 68]],
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (frac >= stops[i][0] && frac <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
  }
  const span = hi[0] - lo[0] || 1;
  const t = clamp01((frac - lo[0]) / span);
  const c = lo[1].map((v, i) => Math.round(lerp(v, hi[1][i], t)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function flowPipe(ctx, points, { baseColor, flowColor, width = 10, speed = 0, time = 0, dashed = true } = {}) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = baseColor;
  ctx.lineWidth = width;
  ctx.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.stroke();
  if (dashed) {
    ctx.strokeStyle = flowColor;
    ctx.lineWidth = width * 0.4;
    ctx.setLineDash([9, 9]);
    ctx.lineDashOffset = -(time / 38) * speed;
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawPump(ctx, cx, cy, radius, { spin, active, time, blades = 5 }) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = '#22303a';
  ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = active ? '#3bb2f0' : '#3a4d5c';
  ctx.lineWidth = Math.max(2, radius * 0.16);
  const angle = active ? (time / spin) : 0;
  for (let i = 0; i < blades; i++) {
    const a = angle + (i * Math.PI * 2) / blades;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * radius * 0.82, Math.sin(a) * radius * 0.82);
    ctx.stroke();
  }
  ctx.strokeStyle = '#4a5f6e';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, radius + 3, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

export function drawCore(ctx, sim, time) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a121a';
  ctx.fillRect(0, 0, W, H);

  const fuelFrac = clamp01((sim.fuelTemp - 200) / (LIMITS.fuelTempMeltdown - 200));
  const coolantColor = heatColor(clamp01((sim.coolantTemp - 200) / 400));
  const primaryFlow = sim.primaryPump / 100;
  const secondaryFlow = (sim.secondaryPump / 100) * (sim.turbineValve > 2 ? 1 : 0.15);

  // Containment structure - encloses the nuclear island (vessel + pressurizer)
  const containX = 26, containY = 14, containW = 336, containH = 452;
  ctx.strokeStyle = '#233038';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 5]);
  roundRect(ctx, containX, containY, containW, containH, 26);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#4a5f6e';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('CONTAINMENT', containX + 14, containY + 16);

  // --- Reactor pressure vessel ---
  const vesselX = 55, vesselY = 52, vesselW = 190, vesselH = 300;
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#3a4d5c';
  roundRect(ctx, vesselX, vesselY, vesselW, vesselH, 20);
  ctx.stroke();

  // Core glow
  const coreX = vesselX + 26, coreY = vesselY + 38, coreW = vesselW - 52, coreH = vesselH - 122;
  const grad = ctx.createLinearGradient(0, coreY, 0, coreY + coreH);
  const col = heatColor(fuelFrac);
  grad.addColorStop(0, col);
  grad.addColorStop(1, heatColor(fuelFrac * 0.85));
  ctx.fillStyle = grad;
  roundRect(ctx, coreX, coreY, coreW, coreH, 8);
  ctx.fill();
  ctx.globalAlpha = 0.35 + 0.25 * Math.sin(time / 220);
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, coreX, coreY, coreW, coreH, 8);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Fuel rod outlines
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1;
  const rods = 7;
  for (let i = 1; i < rods; i++) {
    const x = coreX + (coreW / rods) * i;
    ctx.beginPath(); ctx.moveTo(x, coreY); ctx.lineTo(x, coreY + coreH); ctx.stroke();
  }

  // Control rod bank (descends from top proportional to insertion)
  const rodTravel = coreH * (sim.rodInsertion / 100);
  ctx.fillStyle = sim.scram ? '#e0e6ea' : '#8fa3b0';
  for (let i = 0; i < rods; i++) {
    const cx = coreX + (coreW / rods) * (i + 0.5) - 4;
    ctx.fillRect(cx, coreY - 24, 8, 20 + rodTravel);
  }
  ctx.fillStyle = '#22303a';
  ctx.fillRect(coreX - 10, vesselY + 6, coreW + 20, 15);
  ctx.fillStyle = '#95a9b6';
  ctx.font = '9.5px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('CONTROL ROD DRIVE', coreX + coreW / 2, vesselY + 16);
  ctx.fillStyle = '#5c7181';
  ctx.font = '9.5px sans-serif';
  ctx.fillText('REACTOR PRESSURE VESSEL', vesselX + vesselW / 2, vesselY + vesselH + 15);

  // --- Pressurizer ---
  const przX = vesselX + vesselW + 40, przY = vesselY + 18, przW = 46, przH = 168;
  ctx.strokeStyle = '#3a4d5c'; ctx.lineWidth = 3;
  roundRect(ctx, przX, przY, przW, przH, 12);
  ctx.stroke();
  const steamH = przH * 0.32;
  ctx.fillStyle = 'rgba(59,178,240,0.10)';
  roundRect(ctx, przX + 4, przY + 4, przW - 8, steamH, 8);
  ctx.fill();
  ctx.fillStyle = coolantColor;
  roundRect(ctx, przX + 4, przY + 4 + steamH, przW - 8, przH - steamH - 8, 8);
  ctx.fill();
  // PORV (pilot-operated relief valve) glyph at the top
  ctx.fillStyle = sim.reliefValveOpen && Math.sin(time / 90) > 0 ? '#f0b23b' : '#3a4d5c';
  ctx.fillRect(przX + przW / 2 - 6, przY - 14, 12, 14);
  ctx.fillStyle = '#5c7181'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('PRESSURIZER', przX + przW / 2, przY - 20);
  ctx.fillStyle = '#8399a8'; ctx.font = 'bold 10px sans-serif';
  ctx.fillText(`${sim.pressure.toFixed(0)} bar`, przX + przW / 2, przY + przH + 14);
  // Surge line to the hot leg
  ctx.strokeStyle = '#2e4a5c'; ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(przX, przY + przH - 16);
  ctx.lineTo(vesselX + vesselW + 16, przY + przH - 16);
  ctx.lineTo(vesselX + vesselW + 16, vesselY + 70);
  ctx.stroke();

  // --- Primary loop: hot leg (vessel -> steam generator) ---
  const sgX = containX + containW + 55, sgY = 50, sgW = 92, sgH = 250;
  const hotLegY = vesselY + 50;
  flowPipe(ctx, [[vesselX + vesselW - 14, hotLegY], [sgX, hotLegY]], {
    baseColor: '#2e4a5c', flowColor: coolantColor, width: 11, speed: primaryFlow, time,
  });

  // --- Primary loop: cold leg (steam generator -> pump -> vessel) ---
  const coldLegY = vesselY + vesselH - 40;
  const pumpX = sgX - 90;
  flowPipe(ctx, [[sgX, coldLegY], [pumpX + 26, coldLegY]], { baseColor: '#2e4a5c', flowColor: coolantColor, width: 11, speed: primaryFlow, time });
  flowPipe(ctx, [[pumpX - 26, coldLegY], [vesselX + vesselW - 14, coldLegY], [vesselX + vesselW - 14, vesselY + vesselH - 8]], {
    baseColor: '#2e4a5c', flowColor: coolantColor, width: 11, speed: primaryFlow, time,
  });
  drawPump(ctx, pumpX, coldLegY, 22, { spin: 26, active: sim.primaryPump > 2, time, blades: 6 });
  ctx.fillStyle = '#5c7181'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('MAIN COOLANT PUMP', pumpX, coldLegY + 38);

  // --- Steam generator ---
  ctx.strokeStyle = '#3a4d5c'; ctx.lineWidth = 3;
  roundRect(ctx, sgX, sgY, sgW, sgH, 16);
  ctx.stroke();
  ctx.fillStyle = 'rgba(59,178,240,0.10)';
  roundRect(ctx, sgX + 6, sgY + 6, sgW - 12, sgH - 12, 11);
  ctx.fill();
  // U-tube bundle detail
  ctx.strokeStyle = 'rgba(149,169,182,0.35)'; ctx.lineWidth = 1.5;
  for (let i = 0; i < 5; i++) {
    const tx = sgX + 16 + i * 14;
    ctx.beginPath();
    ctx.moveTo(tx, sgY + sgH - 24);
    ctx.lineTo(tx, sgY + 40);
    ctx.arc(tx + 7, sgY + 40, 7, Math.PI, 0, true);
    ctx.lineTo(tx + 14, sgY + sgH - 24);
    ctx.stroke();
  }
  ctx.fillStyle = '#95a9b6'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('STEAM GENERATOR', sgX + sgW / 2, sgY - 10);

  // --- Main steam line: SG -> turbine ---
  const turbX = sgX + sgW + 95, turbY = sgY + 70;
  flowPipe(ctx, [[sgX + sgW, sgY + 34], [turbX - 40, turbY - 8]], { baseColor: '#2e4a5c', flowColor: '#3bb2f0', width: 8, speed: sim.turbineValve / 100, time, dashed: sim.turbineValve > 2 });

  // --- Turbine + generator ---
  const spin = time / (140 - sim.turbineValve);
  ctx.save();
  ctx.translate(turbX, turbY);
  ctx.fillStyle = '#3a4d5c';
  ctx.beginPath(); ctx.arc(0, 0, 30, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = sim.turbineValve > 2 ? '#3bb2f0' : '#3a4d5c';
  ctx.lineWidth = 5;
  for (let i = 0; i < 6; i++) {
    const a = spin + (i * Math.PI) / 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * 26, Math.sin(a) * 26);
    ctx.stroke();
  }
  ctx.restore();

  const genX = turbX + 60, genY = turbY;
  ctx.strokeStyle = '#4a5f6e'; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(turbX + 30, turbY); ctx.lineTo(genX - 20, genY); ctx.stroke();
  ctx.save();
  ctx.translate(genX, genY);
  ctx.fillStyle = sim.turbineValve > 2 && sim.secondaryPump > 2 ? '#f0b23b' : '#3a4d5c';
  ctx.beginPath(); ctx.arc(0, 0, 20, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#0a121a'; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r = 10 + (i % 2 === 0 ? 3 : -3);
    const px = Math.cos(a) * r, py = Math.sin(a) * r;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath(); ctx.stroke();
  ctx.restore();
  ctx.fillStyle = '#95a9b6'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('TURBINE', turbX, turbY + 46);
  ctx.fillText('GENERATOR', genX, genY + 40);

  // --- Condenser ---
  const condX = turbX - 55, condY = turbY + 100, condW = 170, condH = 78;
  ctx.strokeStyle = '#3a4d5c'; ctx.lineWidth = 3;
  roundRect(ctx, condX, condY, condW, condH, 12);
  ctx.stroke();
  ctx.fillStyle = 'rgba(59,178,240,0.07)';
  roundRect(ctx, condX + 5, condY + 5, condW - 10, condH - 10, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(149,169,182,0.3)'; ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const ty = condY + 16 + i * 14;
    ctx.beginPath(); ctx.moveTo(condX + 10, ty); ctx.lineTo(condX + condW - 10, ty); ctx.stroke();
  }
  ctx.fillStyle = '#95a9b6'; ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('CONDENSER', condX + 12, condY - 8);
  flowPipe(ctx, [[turbX, turbY + 30], [turbX, condY]], { baseColor: '#2e4a5c', flowColor: '#3bb2f0', width: 7, speed: sim.turbineValve / 100, time, dashed: sim.turbineValve > 2 });

  // --- Feedwater loop: condenser -> pump -> steam generator ---
  const fwPumpX = condX + 30, fwY = condY + condH + 34;
  flowPipe(ctx, [[condX + 30, condY + condH], [condX + 30, fwY], [fwPumpX + 20, fwY]], {
    baseColor: '#2e4a5c', flowColor: coolantColor, width: 8, speed: secondaryFlow, time,
  });
  flowPipe(ctx, [[fwPumpX - 20, fwY], [sgX + sgW - 20, fwY], [sgX + sgW - 20, sgY + sgH]], {
    baseColor: '#2e4a5c', flowColor: coolantColor, width: 8, speed: secondaryFlow, time,
  });
  drawPump(ctx, fwPumpX, fwY, 17, { spin: 30, active: sim.secondaryPump > 2, time, blades: 5 });
  ctx.fillStyle = '#5c7181'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('FEEDWATER PUMP', fwPumpX, fwY + 30);

  // Status chips
  ctx.textAlign = 'left';
  const chips = [];
  if (sim.scram) chips.push(['SCRAM ACTIVE', '#ef4444']);
  if (sim.eccsActive) chips.push(['ECCS ACTIVE', '#3bb2f0']);
  if (sim.reliefValveOpen) chips.push(['RELIEF VALVE OPEN', '#f0b23b']);
  if (!sim.offsitePower) chips.push(['GRID OUTAGE', '#f0b23b']);
  if (sim.autoProtectionOverride) chips.push(['PROTECTION OVERRIDDEN', '#ef4444']);
  const cy = H - 30;
  chips.forEach(([label, color], i) => {
    const cx = 16 + i * 190;
    ctx.fillStyle = color;
    roundRect(ctx, cx, cy, 175, 24, 6); ctx.fill();
    ctx.fillStyle = '#06141c'; ctx.font = 'bold 11px sans-serif';
    ctx.fillText(label, cx + 10, cy + 16);
  });
}

const GAUGE_DEFS = [
  { key: 'power', label: 'Power', unit: '%', min: 0, max: 150, warn: 110, crit: 122, get: (s) => s.power },
  { key: 'fuelTemp', label: 'Fuel Temp.', unit: '°C', min: 0, max: 1300, warn: LIMITS.fuelTempWarn, crit: LIMITS.fuelTempTrip, get: (s) => s.fuelTemp },
  { key: 'coolantTemp', label: 'Coolant Temp.', unit: '°C', min: 0, max: 420, warn: LIMITS.coolantTempWarn, crit: LIMITS.coolantTempTrip, get: (s) => s.coolantTemp },
  { key: 'pressure', label: 'Primary Pressure', unit: 'bar', min: 0, max: 220, warn: LIMITS.pressureReliefOpen, crit: LIMITS.pressureVesselRisk, get: (s) => s.pressure },
  { key: 'inventory', label: 'Coolant Level', unit: '%', min: 0, max: 100, warn: 80, crit: 60, invert: true, get: (s) => s.coolantInventory },
  { key: 'xenon', label: 'Xenon-135', unit: '', min: 0, max: 480, warn: 260, crit: 999, get: (s) => s.xenon },
];

export function drawGauges(ctx, sim, sensorNoiseActive) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a121a';
  ctx.fillRect(0, 0, W, H);

  const rowH = H / GAUGE_DEFS.length;
  GAUGE_DEFS.forEach((g, i) => {
    const y = i * rowH + 10;
    let value = g.get(sim);
    if (sensorNoiseActive) value += (Math.sin(Date.now() / 90 + i * 13) * (g.max - g.min) * 0.04);
    const frac = clamp01((value - g.min) / (g.max - g.min));

    ctx.fillStyle = '#c7d6e0';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(g.label, 12, y + 12);
    ctx.textAlign = 'right';
    ctx.fillStyle = sensorNoiseActive ? '#f0b23b' : '#dce8f0';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText(`${value.toFixed(g.unit === '' ? 1 : 0)}${g.unit}`, W - 12, y + 12);

    const barX = 12, barY = y + 20, barW = W - 24, barH = 14;
    ctx.fillStyle = '#1a2530';
    roundRect(ctx, barX, barY, barW, barH, 7);
    ctx.fill();

    const isCrit = g.invert ? value <= g.crit : value >= g.crit;
    const isWarn = g.invert ? value <= g.warn : value >= g.warn;
    const color = isCrit ? '#ef4444' : isWarn ? '#f0b23b' : '#35c97a';
    ctx.fillStyle = color;
    roundRect(ctx, barX, barY, Math.max(8, barW * frac), barH, 7);
    ctx.fill();

    if (g.crit < g.max) {
      const critFrac = clamp01((g.crit - g.min) / (g.max - g.min));
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(barX + barW * critFrac, barY - 2);
      ctx.lineTo(barX + barW * critFrac, barY + barH + 2);
      ctx.stroke();
    }
  });
}
