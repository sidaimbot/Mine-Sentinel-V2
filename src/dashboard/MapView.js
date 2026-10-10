import { THEME } from './theme.js';

const VIEW = { zMin: -92, zMax: 8, xMin: -8, xMax: 28 };
const ZONES = [
  ['ENTRY A', 0, 0], ['MAIN SHAFT', 0, -30], ['JUNCTION A', 0, -60], ['NORTH DRIFT', 0, -84],
  ['CROSS DRIFT', 12, -60], ['TUNNEL B', 20, -38], ['CHAMBER', 20, -8], ['BYPASS', 10, -4],
];
const OVERLAY_MS = 1000;
const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${a})`;
const fmt = (n) => Math.round(n).toLocaleString('en-US');

// Schematic of the sensor network with hazard shading interpolated from node readings along the tunnels.
export class MapView {
  constructor(canvas, tip, store, network, settings, onSelect) {
    Object.assign(this, { canvas, tip, store, network, settings, onSelect });
    this.layout = network.layout;
    this.selected = null;
    this.hover = null;
    this.ctx = canvas.getContext('2d');
    this.cells = [];
    for (let iz = 0; iz < this.layout.rows; iz++) {
      for (let ix = 0; ix < this.layout.cols; ix++) {
        if (this.layout.isWalkableCell(ix, iz)) this.cells.push({ ix, iz, ...this.layout.cellCenter(ix, iz) });
      }
    }
    this.base = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    this.overlayAt = 0;
    new ResizeObserver(() => this.resize()).observe(canvas);

    canvas.addEventListener('mousemove', (e) => this.onHover(e));
    canvas.addEventListener('mouseleave', () => { this.hover = null; this.tip.classList.add('hidden'); });
    canvas.addEventListener('click', () => this.hover && this.onSelect(this.hover.id));
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    for (const c of [this.canvas, this.base, this.overlay]) { c.width = w * dpr; c.height = h * dpr; }
    Object.assign(this, { dpr, w, h });
    this.scale = Math.min((w - 40) / (VIEW.zMax - VIEW.zMin), (h - 40) / (VIEW.xMax - VIEW.xMin));
    this.ox = (w - (VIEW.zMax - VIEW.zMin) * this.scale) / 2;
    this.oy = (h - (VIEW.xMax - VIEW.xMin) * this.scale) / 2;
    this.renderBase();
    this.overlayAt = 0;
  }

  // North (-z) points right so the long main shaft runs across the wide card.
  toMap(x, z) {
    return [this.ox + (VIEW.zMax - z) * this.scale, this.oy + (x - VIEW.xMin) * this.scale];
  }

  renderBase() {
    const ctx = this.base.getContext('2d');
    const s = this.scale;
    const L = this.layout;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = THEME.canvasBg;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.strokeStyle = THEME.grid;
    for (let x = 0; x < this.w; x += 24) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.h); ctx.stroke(); }
    for (let y = 0; y < this.h; y += 24) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.w, y); ctx.stroke(); }

    ctx.fillStyle = THEME.tunnel;
    for (const c of this.cells) {
      const [sx, sy] = this.toMap(c.x, c.z);
      ctx.fillRect(sx - s / 2, sy - s / 2, s + 0.5, s + 0.5);
    }
    ctx.fillStyle = THEME.wall;
    for (const c of this.cells) {
      const [sx, sy] = this.toMap(c.x, c.z);
      if (!L.isWalkableCell(c.ix + 1, c.iz)) ctx.fillRect(sx - s / 2, sy + s / 2 - 1, s, 1.5);
      if (!L.isWalkableCell(c.ix - 1, c.iz)) ctx.fillRect(sx - s / 2, sy - s / 2 - 0.5, s, 1.5);
      if (!L.isWalkableCell(c.ix, c.iz + 1)) ctx.fillRect(sx - s / 2 - 0.5, sy - s / 2, 1.5, s);
      if (!L.isWalkableCell(c.ix, c.iz - 1)) ctx.fillRect(sx + s / 2 - 1, sy - s / 2, 1.5, s);
    }

    ctx.font = `600 10px ${THEME.font}`;
    ctx.fillStyle = THEME.zoneLabel;
    ctx.textAlign = 'center';
    for (const [label, x, z] of ZONES) {
      const [sx, sy] = this.toMap(x, z);
      ctx.fillText(label, sx, sy + (x > 15 ? -s * 3.2 : s * 3.6));
    }
  }

  // Each cell takes the strongest reading of nearby nodes, decaying with tunnel distance, so shading
  // follows the passages rather than bleeding through rock.
  renderOverlay() {
    const ctx = this.overlay.getContext('2d');
    const s = this.scale;
    const { gasWarn, waterWarn } = this.settings;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const nodes = this.store.nodes.filter((n) => !n.offline);
    for (const c of this.cells) {
      let gas = 0, water = 0;
      for (const n of nodes) {
        const d = this.layout.pathDistance(c, n);
        if (!Number.isFinite(d) || d > 30) continue;
        const f = Math.exp(-d / 7);
        gas = Math.max(gas, (n.gas / gasWarn) * f);
        if (n.water !== null) water = Math.max(water, (n.water / waterWarn) * f);
      }
      const top = Math.max(gas, water);
      if (top < 0.3) continue;
      const a = Math.min(0.65, 0.12 + top * 0.25);
      const H = THEME.hazard;
      ctx.fillStyle = water >= gas ? rgba(H.water, a) : rgba(gas >= 2 ? H.gasAlarm : H.gasWarn, a);
      const [sx, sy] = this.toMap(c.x, c.z);
      ctx.fillRect(sx - s / 2, sy - s / 2, s + 0.5, s + 0.5);
    }
  }

  draw(time) {
    const { ctx } = this;
    if (!this.dpr || !this.store.nodes.length) return;
    if (performance.now() - this.overlayAt > OVERLAY_MS) {
      this.overlayAt = performance.now();
      this.renderOverlay();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.base, 0, 0);
    ctx.drawImage(this.overlay, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.textAlign = 'center';

    for (const n of this.store.nodes) {
      const [sx, sy] = this.toMap(n.x, n.z);
      const color = n.offline ? THEME.dim : THEME.level[n.level];
      const r = n.physical ? 7 : 4.5;

      if (n.physical || n.level !== 'normal') {
        const phase = (time * (n.physical ? 0.6 : 1.1)) % 1;
        ctx.strokeStyle = n.physical && n.level === 'normal' ? THEME.trend.normal : color;
        ctx.lineWidth = n.physical ? 2 : 1.5;
        ctx.globalAlpha = 1 - phase;
        ctx.beginPath();
        ctx.arc(sx, sy, r + 2 + phase * (n.physical ? 18 : 12), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (this.selected === n.id) {
        const b = r + 6;
        ctx.fillStyle = THEME.accentTint;
        ctx.strokeStyle = THEME.accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(sx - b, sy - b, b * 2, b * 2, 4);
        ctx.fill();
        ctx.stroke();
      }
      // Hollow marker with a level-coloured ring and core: circle = arch unit, square = floor unit.
      const floor = n.mount === 'floor' && !n.physical;
      const ring = floor ? 5 : r + 1;
      ctx.fillStyle = THEME.nodeFill;
      ctx.strokeStyle = color;
      ctx.lineWidth = n.physical ? 2.2 : 1.6;
      ctx.beginPath();
      if (floor) ctx.roundRect(sx - ring, sy - ring, ring * 2, ring * 2, 2);
      else ctx.arc(sx, sy, ring, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      if (floor) ctx.rect(sx - 2.2, sy - 2.2, 4.4, 4.4);
      else ctx.arc(sx, sy, n.physical ? 3.5 : 2.4, 0, Math.PI * 2);
      ctx.fill();

      const below = floor;
      ctx.font = n.physical ? `700 11px ${THEME.font}` : `500 10px ${THEME.font}`;
      ctx.fillStyle = this.selected === n.id ? THEME.accent : n.physical ? THEME.text : THEME.soft;
      const label = n.physical ? `${n.id} · PU-01 ${n.offline ? 'NO SIGNAL' : 'LIVE'}` : n.id;
      ctx.fillText(label, sx, sy + (below ? 18 : -r - 9));
      ctx.font = `500 9.5px ${THEME.font}`;
      ctx.fillStyle = n.level === 'normal' ? THEME.muted : color;
      ctx.fillText(n.physical && n.offline ? '— ppm' : `${fmt(n.gas)} ppm`, sx, sy + (below ? 29 : -r - 20));
    }
  }

  onHover(e) {
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bestD = 16;
    for (const n of this.store.nodes) {
      const [sx, sy] = this.toMap(n.x, n.z);
      const d = Math.hypot(sx - mx, sy - my);
      if (d < bestD) { bestD = d; best = n; }
    }
    this.hover = best;
    this.tip.classList.toggle('hidden', !best);
    if (!best) return;
    const tag = (m) => (best.physical ? (best.live[m] ? ' <i class="live">LIVE</i>' : ' <i class="sim">SIM</i>') : '');
    this.tip.innerHTML = `<b>${best.id}</b> · ${best.zone} · ${best.physical ? 'physical unit PU-01' : best.mount === 'air' ? 'arch unit' : 'floor unit'}`
      + `${best.offline ? ' · <em>NO SIGNAL</em>' : ''}<br>`
      + `CO ${fmt(best.gas)} ppm${tag('gas')} · RH ${best.hum.toFixed(1)} %${tag('hum')}<br>`
      + `${best.pres.toFixed(1)} hPa${tag('pres')} · water ${best.water === null ? '—' : `${Math.round(best.water)} cm`}${tag('water')}<br>`
      + `signal ${Math.round(best.rssi)} dBm · battery ${Math.round(best.battery)} %`;
    this.tip.style.left = `${Math.min(mx + 14, r.width - 280)}px`;
    this.tip.style.top = `${my + 14}px`;
  }
}

export default MapView;
