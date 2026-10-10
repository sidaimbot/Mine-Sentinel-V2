import { Store } from './Store.js';
import { NetworkModel } from './NetworkModel.js';
import { MapView } from './MapView.js';
import { TrendChart, drawAlarmTimeline } from './Charts.js';
import { SerialSource, BridgeSource, describeOpenError } from './sources.js';
import { rawToPpm, calibrateR0, MQ_MODELS } from './gas.js';
import { loadSettings, saveSettings, DEFAULTS } from './settings.js';
import { renderKpis, renderUnit, renderAnalysis, renderSensorGrid, filterSensorGrid, renderCounts, renderSelected, renderAlarmTable, renderEvents, renderConsole, clock } from './Panels.js';
import { exportCsv, printReport } from './Report.js';
import { LossAlert } from './LossAlert.js';
import { SENSOR_NODES } from '../world/MineLayout.js';

const $ = (id) => document.getElementById(id);
const TICK_S = 0.5;
const CHART_MS = 250;
const CALIBRATION_S = 10;
const AUTO_CALIBRATION_S = 15;
const ERROR_LOG_MS = 10000;

const settings = loadSettings();
const store = new Store();
const network = new NetworkModel(settings);
let pinned = null;
let filter = 'all';
let consolePaused = false;
let calibration = null;
let lastErrorLog = 0;

// ---------- data sources ----------
function onReading(r) {
  // Boards may announce their ADC range; follow it so ppm conversion stays right.
  if (r.adc && r.adc !== settings.adcMax && (r.adc === 1023 || r.adc === 4095)) {
    settings.adcMax = r.adc;
    saveSettings(settings);
    store.event('link', `Board reports ${r.adc === 4095 ? '12' : '10'}-bit ADC`);
  }
  // A raw value above 1023 can only come from a 12-bit ADC (ESP32), even if the board never says so.
  if (r.gas > settings.adcMax && settings.adcMax === 1023) {
    settings.adcMax = 4095;
    settings.r0 = null;
    saveSettings(settings);
    store.event('link', 'Raw gas above 1023 — switched to 12-bit ADC (ESP32)');
  }
  // An uncalibrated MQ reading can be off by 10× or more, so the first packets set the clean-air baseline.
  if (settings.r0 === null && r.gas !== undefined && r.ppm === undefined && !calibration) startCalibration(true);
  const learning = !!calibration?.auto;
  let ppm = r.ppm;
  if (ppm === undefined) ppm = r.gas === undefined || learning ? store.live?.ppm ?? 0 : rawToPpm(r.gas, settings);
  store.packet({ ...r, ppm, hum: r.hum ?? store.live?.hum, temp: r.temp ?? store.live?.temp });
  store.calibrating = learning;
  if (calibration && r.gas !== undefined) calibration.raws.push(r.gas);
}

// Board log lines that explain why readings stop, and what to do about each.
const BOARD_DIAGNOSES = [
  [/lora.*(init|begin).*fail/i, 'crit', 'Board halted: LoRa failed to start, and the sketch stops before sending any sensor data. Check the LoRa wiring/antenna, or flash hardware/esp32_lora_node (keeps running without LoRa).'],
  [/brownout/i, 'crit', 'Board reset by brown-out: USB power is too weak for the MQ heater + LoRa + buzzer. Use a powered USB hub or an external 5 V supply.'],
  [/rst:0x|ets [a-z]{3} +\d|boot:0x/i, 'warn', 'Board rebooted (ESP32 boot log seen).'],
  [/dht.*fail|failed to read from dht/i, 'warn', 'DHT sensor read failed: check its DATA pin, power, and pull-up resistor.'],
];
const diagnosedAt = new Map();

function onLine(text) {
  store.line(text);
  for (const [re, level, msg] of BOARD_DIAGNOSES) {
    if (!re.test(text)) continue;
    if (Date.now() - (diagnosedAt.get(msg) ?? 0) > 30000) store.event(level, msg);
    diagnosedAt.set(msg, Date.now());
  }
}

function onError(message) {
  store.packets.errors++;
  store.line(`! ${message}`);
  if (Date.now() - lastErrorLog > ERROR_LOG_MS) {
    lastErrorLog = Date.now();
    store.event('warn', `Data link: ${message}`);
  }
}

const linkCallbacks = {
  onReading, onLine, onError,
  onStatus(state, detail) {
    if (state === 'waiting') {
      store.line(`# ${detail}`);
      if (/denied|not found|not reachable|no USB board/i.test(detail)) store.event('warn', `Serial: ${detail}`);
    } else if (state === 'connected') {
      store.source = { kind: 'usb', detail };
      store.event('link', `USB connected · ${detail} · ${settings.baud} baud`);
    } else {
      store.source = { kind: 'none', detail: '' };
      if (calibration?.auto) {
        calibration = null;
        store.calibrating = false;
        $('calibBanner').classList.add('hidden');
      }
      store.event('link', `USB disconnected (${detail})`);
      store.line('# board disconnected — waiting for USB');
      // Only an unexpected loss is an incident; the operator's own Disconnect / Release is not.
      if (!/closed by operator|port released/.test(detail)) lossAlert?.linkLost(detail);
    }
    renderHeader();
  },
};
const serial = new SerialSource(linkCallbacks);
const bridge = new BridgeSource(linkCallbacks);
// The server bridge is preferred when available; Web Serial ("Connect USB") is the fallback.
let link = serial;

async function connectUsb(e) {
  if (link === bridge) {
    // Releasing lets the Arduino IDE upload or open its Serial Monitor.
    if (bridge.active) bridge.stop();
    else bridge.start();
    renderHeader();
    return;
  }
  try {
    if (serial.connected) {
      await serial.disconnect();
    } else {
      await serial.connect(settings.baud, e?.shiftKey);
    }
  } catch (err) {
    if (err.name === 'NotFoundError') {
      // Picker cancelled, or it was empty because no Arduino/ESP32 USB chip is plugged in.
      store.line('# no board selected — if the list was empty: check the USB cable is a data cable (not charge-only), try another port, install the CH340/CP210x driver; Shift+click Connect USB lists every port');
      toast('warn', 'No board selected. If the list was empty, check the USB data cable and the CH340/CP210x driver, or Shift+click Connect USB to list every port.');
    } else {
      const why = describeOpenError(err);
      store.line(`! connect failed: ${why}`);
      store.event('warn', `USB connect failed: ${why}`);
    }
    refreshPanels();
  }
  renderHeader();
}

// Connected but silent usually means a wrong baud rate, a sketch that isn't running, or a non-board port.
const SILENT_MS = 6000;
let silenceWarned = false;
function checkSilence() {
  if (!link.connected) { silenceWarned = false; return; }
  if (Date.now() - Math.max(link.openedAt, store.packets.lastAt) < SILENT_MS) { silenceWarned = false; return; }
  if (silenceWarned) return;
  silenceWarned = true;
  const msg = link.linesSinceOpen
    ? `board is sending text but no sensor readings for ${SILENT_MS / 1000} s — the sketch may have halted; check the serial console for an error`
    : `connected but no data for ${SILENT_MS / 1000} s — check the sketch is uploaded, baud is ${settings.baud} on both sides, and the port is the board (not Bluetooth)`;
  store.line(`! ${msg}`);
  store.event('warn', msg);
}

function renderHeader() {
  const phys = network.physical;
  const noSignal = store.source.kind === 'usb' && store.packetAge > 3;
  const kind = noSignal ? 'nosignal' : store.source.kind;
  const el = $('srcState');
  el.className = `src-state ${kind}`;
  el.querySelector('span').textContent = { usb: 'LIVE · USB', none: 'NO BOARD', nosignal: 'USB · NO SIGNAL' }[kind];
  if (link === bridge) {
    $('btnConnect').textContent = bridge.active ? 'Release port' : 'Connect board';
    $('btnConnect').title = 'Server bridge: release the COM port so the Arduino IDE can upload / monitor';
    $('btnConnect').disabled = false;
  } else {
    $('btnConnect').textContent = serial.connected ? 'Disconnect' : 'Connect USB';
    $('btnConnect').disabled = !SerialSource.supported;
  }
  $('trendNode').textContent = `${selectedNode()}${pinned ? '' : phys && selectedNode() === phys.id ? ' (PU-01)' : ''}`;
  renderLinkState(kind);
}

// Sidebar USB card, "monitoring paused" banner and footer all mirror the same link state.
function renderLinkState(kind) {
  const usb = $('usbCard');
  usb.className = `usb-card ${kind === 'usb' ? 'live' : kind}`;
  const bridged = link === bridge;
  $('usbTitle').textContent = { usb: 'USB connected · live', none: bridged ? 'Board released' : 'USB disconnected', nosignal: 'USB · no signal' }[kind];
  $('usbText').textContent = {
    usb: store.source.detail || 'Receiving sensor readings.',
    none: bridged ? 'The COM port is free for the Arduino IDE. Connect to resume readings.' : 'Connect your sensor unit to resume sensor readings.',
    nosignal: 'Connected, but no packets from PU-01. Check the board and its sketch.',
  }[kind];
  $('btnConnect').classList.toggle('primary', !link.connected && !(bridged && bridge.active));

  const paused = kind === 'none' && !(bridged && bridge.active);
  $('pausedBanner').classList.toggle('hidden', !paused || !$('serialNotice').classList.contains('hidden'));
  $('pausedTitle').textContent = bridged ? 'Monitoring paused · board released' : 'Monitoring paused · USB is not connected';
  const banner = $('btnConnectBanner');
  banner.lastChild.textContent = bridged ? 'Connect board' : 'Connect USB';
  banner.disabled = $('btnConnect').disabled;

  $('consoleSub').textContent = `${bridged ? 'Server bridge (tools/serve.py)' : 'USB gateway · Web Serial'} · ${settings.baud} baud`;
  const foot = $('footState');
  foot.className = kind === 'usb' ? 'ok' : '';
  foot.lastChild.textContent = { usb: 'Live data from PU-01 · network nodes simulated', none: 'No board · gas and humidity unavailable', nosignal: 'Board connected · no signal' }[kind];
  const cal = $('calPill');
  cal.className = `pill ${settings.r0 === null ? 'warn' : 'ok'}`;
  cal.textContent = settings.r0 === null ? 'Estimate' : 'Applied';
}

// ---------- calibration ----------
function startCalibration(auto = false) {
  if (calibration) return;
  if (!auto && (store.source.kind !== 'usb' || store.packetAge > 3)) {
    store.event('warn', 'Calibration needs live USB readings — connect the board first');
    return;
  }
  const duration = auto ? AUTO_CALIBRATION_S : CALIBRATION_S;
  calibration = { raws: [], started: Date.now(), auto, duration };
  $('calibTitle').textContent = auto ? 'Learning the clean-air baseline…' : 'Calibrating in clean air…';
  $('calibBanner').classList.remove('hidden');
  store.event('link', auto
    ? `Gas sensor uncalibrated — learning clean-air baseline (${duration} s). Recalibrate with Calibration if gas was present.`
    : `Calibration started (${duration} s clean-air sample)`);
}

function updateCalibration() {
  if (!calibration) return;
  const { duration } = calibration;
  const elapsed = (Date.now() - calibration.started) / 1000;
  $('calibBar').style.width = `${Math.min(100, (elapsed / duration) * 100)}%`;
  $('calibText').textContent = `${Math.min(duration, elapsed).toFixed(0)} / ${duration} s · ${calibration.raws.length} samples`;
  if (elapsed < duration) return;
  const { raws } = calibration;
  calibration = null;
  store.calibrating = false;
  $('calibBanner').classList.add('hidden');
  if (raws.length < 5) {
    store.event('warn', 'Calibration failed: too few samples');
    return;
  }
  // Median, so a stray spike during sampling can't skew the baseline.
  const clean = raws.slice().sort((a, b) => a - b)[Math.floor(raws.length / 2)];
  settings.r0 = calibrateR0(clean, settings);
  saveSettings(settings);
  store.event('ok', `Gas sensor calibrated · clean-air raw ${clean} · R0 ${settings.r0.toFixed(3)}`);
}

// ---------- settings dialog ----------
const form = $('settingsForm');
form.sensorModel.innerHTML = Object.entries(MQ_MODELS).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join('');
form.physicalNode.innerHTML = SENSOR_NODES.map((n) => `<option value="${n.id}">${n.id} · ${n.zone} (${n.mount === 'air' ? 'arch' : 'floor'})</option>`).join('');

function openSettings() {
  for (const key of Object.keys(DEFAULTS)) if (form[key]) form[key].value = settings[key];
  $('calStatus').textContent = settings.r0 === null
    ? 'Uncalibrated — ppm uses a typical clean-air estimate. Use Calibration with the sensor warmed up (≥ 2 min) in clean air.'
    : `Calibrated · R0 ${settings.r0.toFixed(3)} (resets if you change gas sensor or ADC).`;
  $('settingsDlg').showModal();
}

$('settingsDlg').addEventListener('close', async () => {
  if ($('settingsDlg').returnValue !== 'save') return;
  const prev = { ...settings };
  for (const key of ['baud', 'adcMax', 'sensorVcc', 'gasWarn', 'gasAlarm', 'humWarn', 'humAlarm', 'waterWarn', 'waterAlarm']) settings[key] = Number(form[key].value);
  settings.sensorModel = form.sensorModel.value;
  settings.physicalNode = form.physicalNode.value;
  // R0 is only meaningful for the sensor model, ADC and supply it was measured with.
  if (prev.sensorModel !== settings.sensorModel || prev.adcMax !== settings.adcMax || prev.sensorVcc !== settings.sensorVcc) settings.r0 = null;
  saveSettings(settings);
  store.event('link', 'Settings saved');
  if (serial.connected && prev.baud !== settings.baud) {
    await serial.disconnect(false);
    await serial.autoConnect(settings.baud).catch((err) => store.event('warn', `Reconnect failed: ${err.message}`));
  }
  refreshPanels();
});

$('btnResetCal').addEventListener('click', () => {
  settings.r0 = null;
  saveSettings(settings);
  $('calStatus').textContent = 'Reset to the uncalibrated estimate.';
  store.event('link', 'Gas calibration reset');
});

// ---------- UI ----------
const selectedNode = () => pinned ?? network.physical.id;
const select = (id) => {
  pinned = pinned === id ? null : id;
  refreshPanels();
};

const map = new MapView($('mapCanvas'), $('mapTip'), store, network, settings, select);
const lossAlert = new LossAlert({ store, network, map });
const charts = [...document.querySelectorAll('.chart canvas')].map((c) => new TrendChart(c, c.dataset.metric, store, settings, $(`cv_${c.dataset.metric}`)));

function refreshPanels() {
  renderKpis(store, settings);
  renderUnit(store, settings);
  renderAnalysis(store, settings);
  renderAlarmTable(store);
  renderSensorGrid(store, selectedNode(), select);
  filterSensorGrid(store, $('nodeStatus').value, $('nodeSearch').value);
  renderCounts(store);
  renderSelected(store, settings, selectedNode());
  renderThresholds();
  renderConsole(store, consolePaused);
  map.selected = selectedNode();
  $('selFollow').classList.toggle('hidden', !pinned);
  renderHeader();
}

const THRESHOLD_TEXT = {
  gas: () => [`Warning ≥ ${settings.gasWarn} ppm · alarm ≥ ${settings.gasAlarm} ppm`, `${settings.gasWarn} ppm warning`],
  hum: () => [`Warning ≥ ${settings.humWarn} % · alarm ≥ ${settings.humAlarm} %`, `${settings.humWarn} % warning`],
  water: () => [`Warning ≥ ${settings.waterWarn} cm · alarm ≥ ${settings.waterAlarm} cm`, `${settings.waterWarn} cm warning`],
};
function renderThresholds() {
  for (const [metric, text] of Object.entries(THRESHOLD_TEXT)) {
    const [card, chart] = text();
    document.querySelector(`[data-thr="${metric}"]`).textContent = card;
    document.querySelector(`[data-thr-chart="${metric}"]`).textContent = chart;
  }
}

// Buttons report through the event log and serial console, both far down the page, so every new
// event (and a few console-only hints) also pops up where the operator is looking.
const TOAST_MS = { crit: 9000, warn: 6000 };
const MAX_TOASTS = 4;
function toast(level, text) {
  const box = $('toasts');
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `toast ${level}`;
  el.innerHTML = '<i></i><span></span>';
  el.lastChild.textContent = text;
  el.addEventListener('click', () => el.remove());
  box.prepend(el);
  while (box.children.length > MAX_TOASTS) box.lastChild.remove();
  setTimeout(() => el.remove(), TOAST_MS[level] ?? 4000);
}

store.onChange((kind) => {
  if (kind !== 'event') return;
  renderEvents(store, filter);
  const latest = store.events[0];
  if (latest) toast(latest.level, latest.text);
});

const report = () => printReport(store, settings, $('mapCanvas'));
// Wrapped so the click event isn't taken as startCalibration's `auto` flag.
const calibrate = () => startCalibration();
$('btnConnect').addEventListener('click', connectUsb);
$('btnConnectBanner').addEventListener('click', connectUsb);
for (const id of ['btnCalibrate', 'navCalibrate', 'selCalibrate']) $(id).addEventListener('click', calibrate);
for (const id of ['btnSettings', 'navSettings', 'btnAlarmSettings']) $(id).addEventListener('click', openSettings);
for (const id of ['btnCsv', 'btnExportLog']) $(id).addEventListener('click', () => exportCsv(store, settings));
for (const id of ['btnReport', 'navReport']) $(id).addEventListener('click', report);
$('selFollow').addEventListener('click', () => select(pinned));
$('nodeStatus').addEventListener('change', refreshPanels);
$('nodeSearch').addEventListener('input', refreshPanels);

// Highlight the sidebar link of the section currently in view.
const navLinks = [...document.querySelectorAll('#sideNav a')];
const spy = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    for (const a of navLinks) a.classList.toggle('on', a.getAttribute('href') === `#${e.target.id}`);
  }
}, { rootMargin: '-30% 0px -60% 0px' });
for (const a of navLinks) spy.observe($(a.getAttribute('href').slice(1)));
$('btnPauseConsole').addEventListener('click', (e) => {
  consolePaused = !consolePaused;
  e.target.textContent = consolePaused ? 'Resume' : 'Pause';
  e.target.classList.toggle('on', consolePaused);
});
$('btnClearConsole').addEventListener('click', () => {
  store.console.length = 0;
  renderConsole(store, false);
});
$('eventFilters').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  filter = btn.dataset.f;
  for (const b of $('eventFilters').children) b.classList.toggle('on', b === btn);
  renderEvents(store, filter);
});

// ---------- loops ----------
setInterval(() => {
  store.update(network.tick(TICK_S, store.live));
  updateCalibration();
  checkSilence();
  lossAlert.update(store.source.kind);
  refreshPanels();
  $('sessionClock').textContent = clock(store.now);
  $('utcClock').textContent = `${new Date().toISOString().slice(11, 19)} UTC`;
}, TICK_S * 1000);

let lastCharts = 0;
function frame(now) {
  map.draw(now / 1000);
  if (now - lastCharts > CHART_MS) {
    lastCharts = now;
    for (const c of charts) c.draw(selectedNode());
    drawAlarmTimeline($('timeline'), store);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- start ----------
window.__dashboardReady = true;
store.event('link', 'Dashboard started');
if (await BridgeSource.available()) {
  link = bridge;
  store.line('# reading the board through the dashboard server (tools/serve.py) — no browser USB permission needed');
  bridge.start();
  renderHeader();
} else if (!SerialSource.supported) {
  $('serialNotice').classList.remove('hidden');
  $('serialNotice').innerHTML = '<b>USB sensors need Chrome or Edge.</b> This browser has no Web Serial API, so the board cannot be read here.';
} else {
  store.line('# no board connected — plug in the sensor unit and click Connect USB');
  serial.autoConnect(settings.baud)
    .catch((err) => {
      const why = describeOpenError(err);
      store.line(`! auto-connect failed: ${why}`);
      store.event('warn', `USB auto-connect failed: ${why}`);
    });
}
