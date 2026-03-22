/**
 * Scenes Manager v2.0 — Frontend
 * 3 modes: night, day-clear, day-cloudy
 */

const API = '';

const MODE_LABELS = {
  night: 'Nuit',
  'day-clear': 'Jour beau temps',
  'day-cloudy': 'Jour mauvais temps',
};

const MODE_SHORT = {
  night: 'Nuit',
  'day-clear': 'Beau',
  'day-cloudy': 'Couvert',
};

const ALL_MODES = ['night', 'day-clear', 'day-cloudy'];

// --- State ---

let scenes = [];
let rooms = [];
let captureDevices = [];
let currentSceneKey = null;
let selectedMode = 'night';
let currentSceneModes = {}; // modes already saved for current scene

// --- Helpers ---

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(API + path, opts);
  const data = await res.json();
  if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
  return data;
}

function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type} show`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 3000);
}

function intToHex(colorInt) {
  return '#' + Math.round(colorInt).toString(16).padStart(6, '0');
}

function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// --- Navigation ---

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');

    if (btn.dataset.tab === 'ambiances') loadScenes();
    if (btn.dataset.tab === 'capturer') loadCaptureForm();
    if (btn.dataset.tab === 'config') loadConfig();
  });
});

// --- Weather badge ---

async function updateWeatherBadge() {
  try {
    const w = await api('GET', '/weather');
    const badge = document.getElementById('weather-badge');
    const temp = w.temperature !== null ? `${Math.round(w.temperature)}C` : '';
    const mode = w.targetModeLabel || '';
    badge.textContent = `${temp} ${w.weatherDescription || ''} — ${mode}`.trim();
  } catch (e) { /* ignore */ }
}

// =============================================
// TAB: AMBIANCES
// =============================================

async function loadScenes() {
  const data = await api('GET', '/scenes');
  scenes = data.scenes || [];
  renderScenes();
}

function renderScenes() {
  const container = document.getElementById('scenes-list');

  if (scenes.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        Aucune ambiance enregistree.<br>
        Utilisez l'onglet <strong>Capturer</strong> pour en creer une.
      </div>`;
    return;
  }

  // Group by room
  const byRoom = {};
  scenes.forEach((s) => {
    const room = s.room || 'Sans piece';
    if (!byRoom[room]) byRoom[room] = [];
    byRoom[room].push(s);
  });

  let html = '';
  Object.entries(byRoom)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([room, roomScenes]) => {
      html += `<div class="room-section">
      <h2 class="room-title">${room}</h2>
      <div class="scene-cards">`;

      roomScenes.forEach((s) => {
        // Mode badges
        const modeBadges = ALL_MODES.map((m) => {
          const filled = s.modes.includes(m);
          return `<span class="mode-badge ${filled ? 'filled' : 'empty'}">${MODE_SHORT[m]}</span>`;
        }).join('');

        html += `
        <div class="scene-card" data-key="${s.key}">
          <div class="scene-card-header">
            <span class="scene-card-name">${s.name}</span>
            <div class="dropdown">
              <button class="scene-card-menu" onclick="toggleDropdown(event, '${s.key}')">&#8942;</button>
              <div class="dropdown-menu" id="dropdown-${s.key}">
                <button class="dropdown-item" onclick="editScene('${s.key}')">Editer</button>
                <button class="dropdown-item danger" onclick="deleteScene('${s.key}')">Supprimer</button>
              </div>
            </div>
          </div>
          <div class="scene-card-dots" id="dots-${s.key}"></div>
          <div class="scene-card-modes">${modeBadges}</div>
          <div class="scene-card-api" onclick="copyApi('${s.key}')" title="Cliquer pour copier">
            <code>POST /scenes/${s.key}/apply</code>
          </div>
          <div class="scene-card-actions">
            <button class="btn btn-outline btn-sm" onclick="applyScene('${s.key}')">Appliquer</button>
            <button class="btn btn-ghost btn-sm" onclick="testScene('${s.key}')">Tester</button>
          </div>
        </div>`;
      });

      html += '</div></div>';
    });

  container.innerHTML = html;
  scenes.forEach((s) => loadSceneDots(s.key));
}

async function loadSceneDots(key) {
  try {
    const scene = await api('GET', `/scenes/${key}`);
    const dotsEl = document.getElementById(`dots-${key}`);
    if (!dotsEl) return;

    // Get colors from first available mode
    const modes = scene.modes || {};
    const firstMode = Object.values(modes)[0];
    if (!firstMode || !firstMode.features) return;

    const colors = [];
    Object.entries(firstMode.features).forEach(([sel, val]) => {
      if (sel.includes('color') && val) colors.push(intToHex(val));
    });

    if (colors.length > 0) {
      dotsEl.innerHTML = colors.map((c) => `<span class="color-dot" style="background:${c}"></span>`).join('');
    }
  } catch (e) { /* ignore */ }
}

async function applyScene(key) {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '...';

  try {
    const result = await api('POST', `/scenes/${key}/apply`);
    if (result.ok) {
      const fb = result.fallback ? ' (fallback)' : '';
      toast(`${result.scene} — ${result.modeLabel}${fb} (${result.elapsed}ms)`);
    } else {
      toast(result.error || 'Erreur', 'error');
    }
  } catch (e) {
    toast(e.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Appliquer';
}

async function testScene(key) {
  try {
    // Get scene to find first available mode
    const scene = await api('GET', `/scenes/${key}`);
    const modes = Object.keys(scene.modes || {});
    if (modes.length === 0) {
      toast('Aucun mode enregistre', 'error');
      return;
    }
    const result = await api('POST', `/scenes/${key}/apply-force`, { mode: modes[0] });
    if (result.ok) {
      toast(`Test: ${result.scene} — ${result.modeLabel} (${result.elapsed}ms)`);
    } else {
      toast(result.error || 'Erreur', 'error');
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteScene(key) {
  if (!confirm('Supprimer cette ambiance ?')) return;
  const result = await api('DELETE', `/scenes/${key}`);
  if (result.ok) {
    toast('Ambiance supprimee');
    loadScenes();
  } else {
    toast(result.error, 'error');
  }
  closeDropdowns();
}

function editScene(key) {
  document.querySelector('[data-tab="capturer"]').click();

  setTimeout(() => {
    const modeRadio = document.querySelector('input[name="capture-mode"][value="existing"]');
    modeRadio.checked = true;
    modeRadio.dispatchEvent(new Event('change', { bubbles: true }));

    setTimeout(() => {
      const select = document.getElementById('capture-existing-scene');
      select.value = key;
    }, 200);
  }, 100);

  closeDropdowns();
}

function copyApi(key) {
  const url = `http://localhost:8890/scenes/${key}/apply`;
  navigator.clipboard.writeText(url).then(() => {
    toast('URL copiee', 'info');
  }).catch(() => {
    toast(url, 'info');
  });
}

function toggleDropdown(event, key) {
  event.stopPropagation();
  closeDropdowns();
  document.getElementById(`dropdown-${key}`).classList.toggle('open');
}

function closeDropdowns() {
  document.querySelectorAll('.dropdown-menu').forEach((d) => d.classList.remove('open'));
}

document.addEventListener('click', closeDropdowns);

// =============================================
// TAB: CAPTURER
// =============================================

async function loadCaptureForm() {
  try {
    const data = await api('GET', '/rooms');
    rooms = data.rooms || [];
    const select = document.getElementById('capture-room');
    select.innerHTML = '<option value="">Choisir une piece...</option>';
    rooms.forEach((r) => {
      select.innerHTML += `<option value="${r}">${r}</option>`;
    });
  } catch (e) {
    toast('Erreur chargement pieces', 'error');
  }

  await refreshExistingScenes();
  showCaptureStep(1);
}

async function refreshExistingScenes() {
  const data = await api('GET', '/scenes');
  const select = document.getElementById('capture-existing-scene');
  select.innerHTML = '<option value="">Choisir...</option>';
  (data.scenes || []).forEach((s) => {
    select.innerHTML += `<option value="${s.key}">${s.name} (${s.room})</option>`;
  });
}

function showCaptureStep(step) {
  document.getElementById('capture-step1').style.display = step === 1 ? 'block' : 'none';
  document.getElementById('capture-step2').style.display = step === 2 ? 'block' : 'none';
}

// Mode toggle (new vs existing)
document.querySelectorAll('input[name="capture-mode"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    const isNew = e.target.value === 'new';
    document.getElementById('capture-new-fields').style.display = isNew ? 'block' : 'none';
    document.getElementById('capture-existing-fields').style.display = isNew ? 'none' : 'block';
  });
});

// Auto-generate key from name
document.getElementById('capture-name').addEventListener('input', (e) => {
  document.getElementById('capture-key').value = slugify(e.target.value);
});

// Mode selector buttons
document.getElementById('mode-selector').addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-selector-btn');
  if (!btn) return;

  document.querySelectorAll('.mode-selector-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  selectedMode = btn.dataset.mode;
});

// Scan button
document.getElementById('btn-scan').addEventListener('click', async () => {
  const room = document.getElementById('capture-room').value;
  if (!room) {
    toast('Selectionnez une piece', 'error');
    return;
  }

  const isNew = document.querySelector('input[name="capture-mode"]:checked').value === 'new';

  if (isNew) {
    const name = document.getElementById('capture-name').value.trim();
    if (!name) {
      toast("Donnez un nom a l'ambiance", 'error');
      return;
    }
    currentSceneKey = slugify(name);
    currentSceneModes = {};
  } else {
    currentSceneKey = document.getElementById('capture-existing-scene').value;
    if (!currentSceneKey) {
      toast('Selectionnez une ambiance existante', 'error');
      return;
    }
    // Load existing modes
    try {
      const scene = await api('GET', `/scenes/${currentSceneKey}`);
      currentSceneModes = scene.modes || {};
    } catch (e) {
      currentSceneModes = {};
    }
  }

  const btn = document.getElementById('btn-scan');
  btn.disabled = true;
  btn.textContent = 'Scan en cours...';

  try {
    const data = await api('GET', `/capture/devices?room=${encodeURIComponent(room)}`);
    captureDevices = data.devices || [];
    renderCaptureDevices();
    renderModeStatus();
    updateModeSelectorIndicators();
    showCaptureStep(2);

    const title = isNew
      ? document.getElementById('capture-name').value
      : document.getElementById('capture-existing-scene').selectedOptions[0].text;
    document.getElementById('capture-title').textContent = title;
  } catch (e) {
    toast('Erreur: ' + e.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Scanner les lumieres';
});

function renderCaptureDevices() {
  const container = document.getElementById('capture-devices');
  let html = '';

  captureDevices.forEach((dev) => {
    const powerFeature = dev.features.find((f) => f.type === 'binary');
    const colorFeature = dev.features.find((f) => f.type === 'color');
    const brightnessFeature = dev.features.find((f) => f.type === 'brightness');
    const dimmerFeature = dev.features.find((f) => f.type === 'dimmer');
    const tempFeature = dev.features.find((f) => f.type === 'temperature');

    const isOn = powerFeature ? powerFeature.lastValue === 1 : (dimmerFeature ? dimmerFeature.lastValue > 0 : false);
    const color = colorFeature && colorFeature.lastValue ? intToHex(colorFeature.lastValue) : '#666';
    const brightness = brightnessFeature ? Math.round(brightnessFeature.lastValue) : (dimmerFeature ? Math.round(dimmerFeature.lastValue) : null);

    html += `
      <div class="device-row ${isOn ? '' : 'off'}" data-device="${dev.selector}">
        <input type="checkbox" class="device-check" ${isOn ? 'checked' : ''} data-device-sel="${dev.selector}">
        <div class="device-color" style="background:${isOn ? color : '#444'}"></div>
        <div class="device-info">
          <div class="device-name">${dev.name}</div>
          <div class="device-detail">${dev.service || ''}${tempFeature ? ' | temp: ' + Math.round(tempFeature.lastValue) : ''}</div>
        </div>
        ${brightness !== null ? `<div class="device-brightness">${brightness}%</div>` : ''}
      </div>`;
  });

  container.innerHTML = html;
}

function renderModeStatus() {
  const container = document.getElementById('mode-status');

  const html = ALL_MODES.map((m) => {
    const filled = !!currentSceneModes[m];
    return `<div class="mode-status-item ${filled ? 'filled' : ''}">
      <span class="mode-status-dot"></span>
      <span>${MODE_LABELS[m]}</span>
    </div>`;
  }).join('');

  container.innerHTML = html;
}

function updateModeSelectorIndicators() {
  document.querySelectorAll('.mode-selector-btn').forEach((btn) => {
    const mode = btn.dataset.mode;
    btn.classList.toggle('has-data', !!currentSceneModes[mode]);
  });
}

// Back button
document.getElementById('btn-back').addEventListener('click', () => showCaptureStep(1));

// Refresh button
document.getElementById('btn-refresh').addEventListener('click', async () => {
  const room = document.getElementById('capture-room').value;
  if (!room) return;

  const btn = document.getElementById('btn-refresh');
  btn.disabled = true;
  btn.textContent = 'Scan...';

  try {
    const data = await api('GET', `/capture/devices?room=${encodeURIComponent(room)}`);
    captureDevices = data.devices || [];
    renderCaptureDevices();
    toast('Lumieres rafraichies', 'info');
  } catch (e) {
    toast('Erreur: ' + e.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Rafraichir';
});

// Save button
document.getElementById('btn-save').addEventListener('click', async () => {
  const isNew = document.querySelector('input[name="capture-mode"]:checked').value === 'new';
  const room = document.getElementById('capture-room').value;

  // Build features from checked devices
  const features = {};
  const checkedDevices = document.querySelectorAll('.device-check:checked');

  checkedDevices.forEach((cb) => {
    const deviceSel = cb.dataset.deviceSel;
    const dev = captureDevices.find((d) => d.selector === deviceSel);
    if (!dev) return;

    dev.features.forEach((f) => {
      if (f.lastValue !== null && f.lastValue !== undefined) {
        features[f.selector] = f.lastValue;
      }
    });
  });

  if (Object.keys(features).length === 0) {
    toast('Selectionnez au moins un appareil', 'error');
    return;
  }

  const body = {
    sceneKey: currentSceneKey,
    sceneName: isNew ? document.getElementById('capture-name').value.trim() : undefined,
    room,
    features,
    mode: selectedMode,
  };

  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  btn.textContent = 'Enregistrement...';

  try {
    const result = await api('POST', '/capture', body);
    if (result.ok) {
      const action = result.updated ? 'mis a jour' : 'enregistre';
      toast(`${result.modeLabel} ${action}`);

      // Update local state
      currentSceneModes[selectedMode] = true;
      renderModeStatus();
      updateModeSelectorIndicators();
    } else {
      toast(result.error, 'error');
    }
  } catch (e) {
    toast(e.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Enregistrer ce mode';
});

// =============================================
// TAB: CONFIG
// =============================================

async function loadConfig() {
  const cfg = await api('GET', '/config');
  document.getElementById('cfg-gladys-url').value = cfg.gladysUrl || '';
  document.getElementById('cfg-gladys-key').value = cfg.gladysApiKey || '';
  document.getElementById('cfg-lat').value = cfg.latitude || '';
  document.getElementById('cfg-lon').value = cfg.longitude || '';
  document.getElementById('cfg-owm-key').value = cfg.openWeatherMapApiKey || '';
  document.getElementById('cfg-cloudy').value = cfg.cloudyThreshold || 40;
  document.getElementById('cfg-cache').value = (cfg.weatherCacheDuration || 600000) / 1000;
}

document.getElementById('btn-save-config').addEventListener('click', async () => {
  const body = {
    gladysUrl: document.getElementById('cfg-gladys-url').value,
    gladysApiKey: document.getElementById('cfg-gladys-key').value,
    latitude: parseFloat(document.getElementById('cfg-lat').value),
    longitude: parseFloat(document.getElementById('cfg-lon').value),
    openWeatherMapApiKey: document.getElementById('cfg-owm-key').value,
    cloudyThreshold: parseInt(document.getElementById('cfg-cloudy').value),
    weatherCacheDuration: parseInt(document.getElementById('cfg-cache').value) * 1000,
  };

  const result = await api('PUT', '/config', body);
  if (result.ok) toast('Configuration enregistree');
  else toast(result.error, 'error');
});

document.getElementById('btn-test-gladys').addEventListener('click', async () => {
  const statusEl = document.getElementById('config-status');
  statusEl.style.display = 'block';
  statusEl.className = 'status-box';
  statusEl.textContent = 'Test en cours...';

  try {
    const status = await api('GET', '/status');
    if (status.gladys) {
      statusEl.className = 'status-box ok';
      statusEl.textContent = `Gladys OK\nMQTT: ${status.mqtt ? 'connecte' : 'deconnecte'}\nScenes: ${status.sceneCount}\nUptime: ${Math.round(status.uptime)}s`;
    } else {
      statusEl.className = 'status-box error';
      statusEl.textContent = "Gladys inaccessible. Verifiez l'URL et la cle API.";
    }
  } catch (e) {
    statusEl.className = 'status-box error';
    statusEl.textContent = 'Erreur: ' + e.message;
  }
});

document.getElementById('btn-test-weather').addEventListener('click', async () => {
  const statusEl = document.getElementById('config-status');
  statusEl.style.display = 'block';
  statusEl.className = 'status-box';
  statusEl.textContent = 'Test meteo...';

  try {
    const w = await api('GET', '/weather');
    statusEl.className = 'status-box ok';
    statusEl.textContent = `Meteo OK\nConditions: ${w.weatherDescription}\nNuages: ${w.cloudPercent}%\nTemperature: ${w.temperature}C\nMode actif: ${w.targetModeLabel}\nLever: ${w.sunTimes.sunrise}\nCoucher: ${w.sunTimes.sunset}`;
  } catch (e) {
    statusEl.className = 'status-box error';
    statusEl.textContent = 'Erreur: ' + e.message;
  }
});

// =============================================
// INIT
// =============================================

loadScenes();
updateWeatherBadge();
setInterval(updateWeatherBadge, 600000);
