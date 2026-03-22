/**
 * Scenes Manager v2.0 — Smart Ambiance Manager for Gladys Assistant
 *
 * 3 modes: night, day-clear, day-cloudy
 * If only 1 mode captured → implicit default (always applied)
 * Gladys decides WHEN. Scenes Manager decides HOW.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const SunCalc = require('suncalc');

// --- Configuration ---

const PORT = parseInt(process.env.PORT || '8890', 10);
const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const DATA_FILE = process.env.DATA_FILE || '/app/presets.json';
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_CONFIG = {
  gladysUrl: 'http://localhost:8585',
  gladysApiKey: '',
  latitude: 50.5903,
  longitude: 5.6069,
  openWeatherMapApiKey: '',
  weatherCacheDuration: 600000,
  cloudyThreshold: 40,
};

const MODE_LABELS = {
  night: 'Nuit',
  'day-clear': 'Jour beau temps',
  'day-cloudy': 'Jour mauvais temps',
};

const ALL_MODES = ['night', 'day-clear', 'day-cloudy'];

// --- Data store ---

let data = { config: { ...DEFAULT_CONFIG }, scenes: {} };

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    data = {
      config: { ...DEFAULT_CONFIG, ...parsed.config },
      scenes: parsed.scenes || {},
    };
    // Migrate v1 scenes to v2
    let migrated = false;
    for (const [key, scene] of Object.entries(data.scenes)) {
      if (!scene.modes && (scene.variants || scene.default)) {
        data.scenes[key] = migrateSceneV1toV2(scene);
        migrated = true;
      }
      // Ensure modes object exists
      if (!data.scenes[key].modes) {
        data.scenes[key].modes = {};
      }
    }
    if (migrated) {
      saveData();
      console.log('[DATA] Migration v1 → v2 effectuee');
    }
  } catch (e) {
    data = { config: { ...DEFAULT_CONFIG }, scenes: {} };
  }
  const count = Object.keys(data.scenes).length;
  console.log(`[DATA] ${count} scene(s) chargee(s)`);
}

function migrateSceneV1toV2(scene) {
  const modes = {};

  if (scene.variants && Array.isArray(scene.variants)) {
    for (const v of scene.variants) {
      if (!v.when) continue;
      const entry = { features: v.features, capturedAt: v.capturedAt };

      if (v.when.daylight === 'night') {
        // Night variant — prefer the one without weather (most generic)
        if (!modes.night || !v.when.weather) {
          modes.night = entry;
        }
      } else if (v.when.daylight === 'day' || !v.when.daylight) {
        // Day variant, or weather-only (no daylight = day implied)
        if (v.when.weather === 'clear' && !modes['day-clear']) {
          modes['day-clear'] = entry;
        } else if (v.when.weather === 'cloudy' && !modes['day-cloudy']) {
          modes['day-cloudy'] = entry;
        }
      }
    }
  }

  // Use default as night fallback if no night mode found
  if (scene.default && scene.default.features && !modes.night) {
    modes.night = { features: scene.default.features, capturedAt: scene.default.capturedAt };
  }

  return {
    name: scene.name,
    room: scene.room,
    modes,
    createdAt: scene.createdAt,
  };
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// --- Weather cache ---

let weatherCache = { data: null, fetchedAt: 0 };

function fetchWeather() {
  return new Promise((resolve, reject) => {
    const { openWeatherMapApiKey, latitude, longitude, weatherCacheDuration } = data.config;

    if (!openWeatherMapApiKey) {
      resolve({ clouds: { all: 0 }, weather: [{ main: 'Clear' }], sys: { sunrise: 0, sunset: 0 } });
      return;
    }

    if (weatherCache.data && Date.now() - weatherCache.fetchedAt < weatherCacheDuration) {
      resolve(weatherCache.data);
      return;
    }

    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${latitude}&lon=${longitude}&appid=${openWeatherMapApiKey}&units=metric&lang=fr`;

    https.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const w = JSON.parse(body);
          if (res.statusCode === 200) {
            weatherCache = { data: w, fetchedAt: Date.now() };
            console.log(`[WEATHER] ${w.weather[0].description}, nuages ${w.clouds.all}%, ${w.main.temp}C`);
            resolve(w);
          } else {
            console.error(`[WEATHER ERR] Status ${res.statusCode}:`, body);
            resolve(weatherCache.data || { clouds: { all: 0 }, weather: [{ main: 'Clear' }], sys: { sunrise: 0, sunset: 0 } });
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', (e) => {
      console.error('[WEATHER ERR]', e.message);
      resolve(weatherCache.data || { clouds: { all: 0 }, weather: [{ main: 'Clear' }], sys: { sunrise: 0, sunset: 0 } });
    });
  });
}

// --- Conditions engine ---

function getCurrentConditions() {
  const { latitude, longitude } = data.config;
  const now = new Date();
  const sunTimes = SunCalc.getTimes(now, latitude, longitude);
  const isDaylight = now >= sunTimes.sunrise && now <= sunTimes.sunset;

  return {
    daylight: isDaylight ? 'day' : 'night',
    sunTimes: {
      sunrise: sunTimes.sunrise.toISOString(),
      sunset: sunTimes.sunset.toISOString(),
    },
  };
}

async function getFullConditions() {
  const conditions = getCurrentConditions();
  const weather = await fetchWeather();
  const cloudPct = weather.clouds ? weather.clouds.all : 0;

  conditions.weather = cloudPct > data.config.cloudyThreshold ? 'cloudy' : 'clear';
  conditions.cloudPercent = cloudPct;
  conditions.weatherDescription = weather.weather ? weather.weather[0].description : '';
  conditions.temperature = weather.main ? weather.main.temp : null;

  return conditions;
}

// --- Mode selection (v2) ---

function resolveTargetMode(conditions) {
  if (conditions.daylight === 'night') return 'night';
  if (conditions.weather === 'cloudy') return 'day-cloudy';
  return 'day-clear';
}

const MODE_FALLBACKS = {
  night: ['day-cloudy', 'day-clear'],
  'day-clear': ['day-cloudy', 'night'],
  'day-cloudy': ['day-clear', 'night'],
};

function selectMode(scene, conditions) {
  const modes = scene.modes || {};
  const modeKeys = Object.keys(modes);

  if (modeKeys.length === 0) return null;

  // Single mode = implicit default
  if (modeKeys.length === 1) {
    return { ...modes[modeKeys[0]], mode: modeKeys[0], fallback: modeKeys[0] !== resolveTargetMode(conditions) };
  }

  const target = resolveTargetMode(conditions);

  // Exact match
  if (modes[target]) {
    return { ...modes[target], mode: target, fallback: false };
  }

  // Fallback
  for (const fb of (MODE_FALLBACKS[target] || [])) {
    if (modes[fb]) {
      return { ...modes[fb], mode: fb, fallback: true };
    }
  }

  // Last resort
  return { ...modes[modeKeys[0]], mode: modeKeys[0], fallback: true };
}

// --- Gladys API client ---

function gladysRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const { gladysUrl, gladysApiKey } = data.config;
    const parsed = new URL(gladysUrl);
    const separator = apiPath.includes('?') ? '&' : '?';
    const fullPath = `${apiPath}${separator}api_key=${gladysApiKey}`;

    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 8585,
      path: fullPath,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    };

    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: d ? JSON.parse(d) : null });
        } catch (e) {
          resolve({ status: res.statusCode, data: d });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getGladysDevices(room) {
  const lightRes = await gladysRequest('GET', '/api/v1/device?device_feature_category=light');
  if (lightRes.status !== 200) {
    throw new Error(`Gladys API error: ${lightRes.status}`);
  }

  let devices = lightRes.data;

  // Also get dimmer devices (Z-Wave)
  const switchRes = await gladysRequest('GET', '/api/v1/device?device_feature_category=switch&device_feature_type=dimmer');
  if (switchRes.status === 200 && Array.isArray(switchRes.data)) {
    const existingIds = new Set(devices.map((d) => d.id));
    switchRes.data.forEach((d) => {
      if (!existingIds.has(d.id)) devices.push(d);
    });
  }

  // Filter out Matter duplicates
  devices = devices.filter((d) => !d.external_id || !d.external_id.startsWith('matter:'));

  // Filter by room
  if (room) {
    devices = devices.filter((d) => d.room && d.room.name === room);
  }

  return devices.map((d) => ({
    name: d.name,
    selector: d.selector,
    externalId: d.external_id,
    room: d.room ? d.room.name : null,
    service: d.service ? d.service.name : null,
    features: d.features
      .filter((f) => f.category === 'light' || f.type === 'dimmer')
      .map((f) => ({
        selector: f.selector,
        category: f.category,
        type: f.type,
        lastValue: f.last_value,
        min: f.min,
        max: f.max,
      })),
  }));
}

async function applyFeatures(features) {
  const entries = Object.entries(features);
  if (entries.length === 0) return { applied: 0, errors: 0 };

  const powerOns = entries.filter(([sel]) => sel.endsWith('-binary') || sel.endsWith('-power'));
  const others = entries.filter(([sel]) => !sel.endsWith('-binary') && !sel.endsWith('-power'));

  let applied = 0;
  let errors = 0;

  if (powerOns.length > 0) {
    await Promise.all(
      powerOns.map(([selector, value]) =>
        gladysRequest('POST', `/api/v1/device_feature/${selector}/value`, { value })
          .then((r) => {
            if (r.status === 200) applied++;
            else { console.error(`[APPLY ERR] ${selector}: status ${r.status}`); errors++; }
          })
          .catch((e) => { console.error(`[APPLY ERR] ${selector}:`, e.message); errors++; })
      )
    );
    if (powerOns.some(([, v]) => v === 1)) await sleep(150);
  }

  if (others.length > 0) {
    await Promise.all(
      others.map(([selector, value]) =>
        gladysRequest('POST', `/api/v1/device_feature/${selector}/value`, { value })
          .then((r) => {
            if (r.status === 200) applied++;
            else { console.error(`[APPLY ERR] ${selector}: status ${r.status}`); errors++; }
          })
          .catch((e) => { console.error(`[APPLY ERR] ${selector}:`, e.message); errors++; })
      )
    );
  }

  return { applied, errors };
}

// --- Scene application ---

async function applyScene(key, forceMode) {
  const scene = data.scenes[key];
  if (!scene) {
    console.log(`[SCENE] "${key}" introuvable`);
    return { ok: false, error: `Scene "${key}" introuvable` };
  }

  const start = Date.now();
  let selected;
  let conditions;

  if (forceMode) {
    const modeData = scene.modes[forceMode];
    if (!modeData) {
      return { ok: false, error: `Mode "${forceMode}" introuvable` };
    }
    selected = { ...modeData, mode: forceMode, fallback: false };
    conditions = { forced: true, mode: forceMode };
  } else {
    conditions = await getFullConditions();
    selected = selectMode(scene, conditions);
  }

  if (!selected || !selected.features) {
    return { ok: false, error: 'Aucun mode applicable' };
  }

  const modeLabel = MODE_LABELS[selected.mode] || selected.mode;
  const fbTag = selected.fallback ? ' (fallback)' : '';
  console.log(`[SCENE] "${scene.name}" → ${modeLabel}${fbTag} (${Object.keys(selected.features).length} features)`);

  const result = await applyFeatures(selected.features);
  const elapsed = Date.now() - start;

  updateSceneSwitches(key);

  console.log(`[SCENE] "${scene.name}" appliquee en ${elapsed}ms (${result.applied} OK, ${result.errors} erreurs)`);

  return {
    ok: true,
    scene: scene.name,
    mode: selected.mode,
    modeLabel,
    fallback: selected.fallback || false,
    conditions,
    applied: result.applied,
    errors: result.errors,
    elapsed,
  };
}

// --- MQTT switches ---

const AMBIANCE_EXT_PREFIX = 'mqtt:ambiance:';

function ambianceExtId(key) {
  return `${AMBIANCE_EXT_PREFIX}${key}`;
}

function updateSceneSwitches(activeKey) {
  if (!mqttClient || !mqttClient.connected) return;
  const activeScene = data.scenes[activeKey];
  if (!activeScene) return;

  for (const [k, s] of Object.entries(data.scenes)) {
    if (s.room !== activeScene.room) continue;
    const extId = ambianceExtId(k);
    const val = k === activeKey ? 1 : 0;
    mqttClient.publish(`gladys/master/device/${extId}/feature/${extId}:power/state`, String(val));
  }
}

function subscribeSceneSwitch(key) {
  if (!mqttClient || !mqttClient.connected) return;
  const extId = ambianceExtId(key);
  mqttClient.subscribe(`gladys/device/${extId}/feature/${extId}:power/state`);
}

function subscribeAllSceneSwitches() {
  const keys = Object.keys(data.scenes);
  if (keys.length === 0) return;
  for (const key of keys) subscribeSceneSwitch(key);
  console.log(`[MQTT] ${keys.length} switch(es) ambiance abonne(s)`);
}

// --- Static file server ---

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const fullPath = path.join(PUBLIC_DIR, filePath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end();
    return true;
  }

  try {
    const content = fs.readFileSync(fullPath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
    return true;
  } catch (e) {
    return false;
  }
}

// --- HTTP API ---

function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const apiPath = url.pathname;

    if (!apiPath.startsWith('/scenes') && !apiPath.startsWith('/capture') && !apiPath.startsWith('/weather') && !apiPath.startsWith('/status') && !apiPath.startsWith('/config') && !apiPath.startsWith('/rooms')) {
      if (serveStatic(req, res)) return;
    }

    try {
      // ===== SCENES =====

      // GET /scenes
      if (req.method === 'GET' && apiPath === '/scenes') {
        const scenes = Object.entries(data.scenes).map(([key, s]) => ({
          key,
          name: s.name,
          room: s.room,
          modes: Object.keys(s.modes || {}),
          modeCount: Object.keys(s.modes || {}).length,
          switchExtId: ambianceExtId(key),
        }));
        jsonResponse(res, 200, { scenes });
        return;
      }

      // GET /scenes/:key
      if (req.method === 'GET' && apiPath.match(/^\/scenes\/[^/]+$/) && !apiPath.includes('/apply')) {
        const key = apiPath.split('/')[2];
        const scene = data.scenes[key];
        if (!scene) {
          jsonResponse(res, 404, { error: `Scene "${key}" introuvable` });
          return;
        }
        jsonResponse(res, 200, { key, ...scene, switchExtId: ambianceExtId(key) });
        return;
      }

      // POST /scenes
      if (req.method === 'POST' && apiPath === '/scenes') {
        const body = JSON.parse(await readBody(req));
        const { key, name, room } = body;
        if (!key || !name || !room) {
          jsonResponse(res, 400, { error: 'key, name et room requis' });
          return;
        }
        if (!/^[a-z0-9-]+$/.test(key)) {
          jsonResponse(res, 400, { error: 'key: minuscules, chiffres et tirets uniquement' });
          return;
        }
        if (data.scenes[key]) {
          jsonResponse(res, 409, { error: `Scene "${key}" existe deja` });
          return;
        }
        data.scenes[key] = {
          name,
          room,
          modes: {},
          createdAt: new Date().toISOString(),
        };
        saveData();
        subscribeSceneSwitch(key);
        console.log(`[SCENE] "${name}" creee (${key})`);
        jsonResponse(res, 201, { ok: true, key });
        return;
      }

      // PUT /scenes/:key
      if (req.method === 'PUT' && apiPath.match(/^\/scenes\/[^/]+$/)) {
        const key = apiPath.split('/')[2];
        if (!data.scenes[key]) {
          jsonResponse(res, 404, { error: `Scene "${key}" introuvable` });
          return;
        }
        const body = JSON.parse(await readBody(req));
        if (body.name) data.scenes[key].name = body.name;
        if (body.room) data.scenes[key].room = body.room;
        saveData();
        jsonResponse(res, 200, { ok: true, key });
        return;
      }

      // DELETE /scenes/:key
      if (req.method === 'DELETE' && apiPath.match(/^\/scenes\/[^/]+$/)) {
        const key = apiPath.split('/')[2];
        if (!data.scenes[key]) {
          jsonResponse(res, 404, { error: `Scene "${key}" introuvable` });
          return;
        }
        const extId = ambianceExtId(key);
        if (mqttClient && mqttClient.connected) {
          mqttClient.unsubscribe(`gladys/device/${extId}/feature/${extId}:power/state`);
        }
        const name = data.scenes[key].name;
        delete data.scenes[key];
        saveData();
        console.log(`[SCENE] "${name}" supprimee`);
        jsonResponse(res, 200, { ok: true, deleted: key });
        return;
      }

      // DELETE /scenes/:key/mode/:mode
      if (req.method === 'DELETE' && apiPath.match(/^\/scenes\/[^/]+\/mode\/[^/]+$/)) {
        const parts = apiPath.split('/');
        const key = parts[2];
        const mode = parts[4];
        if (!data.scenes[key]) {
          jsonResponse(res, 404, { error: `Scene "${key}" introuvable` });
          return;
        }
        if (!data.scenes[key].modes[mode]) {
          jsonResponse(res, 404, { error: `Mode "${mode}" introuvable` });
          return;
        }
        delete data.scenes[key].modes[mode];
        saveData();
        console.log(`[SCENE] Mode "${MODE_LABELS[mode]}" supprime de "${data.scenes[key].name}"`);
        jsonResponse(res, 200, { ok: true, key, deletedMode: mode });
        return;
      }

      // POST /scenes/:key/apply
      if (req.method === 'POST' && apiPath.match(/^\/scenes\/[^/]+\/apply$/)) {
        const key = apiPath.split('/')[2];
        const result = await applyScene(key);
        jsonResponse(res, result.ok ? 200 : 404, result);
        return;
      }

      // POST /scenes/:key/apply-force
      if (req.method === 'POST' && apiPath.match(/^\/scenes\/[^/]+\/apply-force$/)) {
        const key = apiPath.split('/')[2];
        const body = JSON.parse(await readBody(req));
        const result = await applyScene(key, body.mode);
        jsonResponse(res, result.ok ? 200 : 404, result);
        return;
      }

      // ===== CAPTURE =====

      // GET /capture/devices?room=X
      if (req.method === 'GET' && apiPath === '/capture/devices') {
        const room = url.searchParams.get('room');
        const devices = await getGladysDevices(room || undefined);
        jsonResponse(res, 200, { devices });
        return;
      }

      // POST /capture
      if (req.method === 'POST' && apiPath === '/capture') {
        const body = JSON.parse(await readBody(req));
        const { sceneKey, sceneName, room, features, mode } = body;

        if (!sceneKey || !room || !features || Object.keys(features).length === 0) {
          jsonResponse(res, 400, { error: 'sceneKey, room et features requis' });
          return;
        }
        if (!/^[a-z0-9-]+$/.test(sceneKey)) {
          jsonResponse(res, 400, { error: 'sceneKey: minuscules, chiffres et tirets uniquement' });
          return;
        }
        if (!mode || !ALL_MODES.includes(mode)) {
          jsonResponse(res, 400, { error: `mode requis: ${ALL_MODES.join(', ')}` });
          return;
        }

        // Create scene if it doesn't exist
        if (!data.scenes[sceneKey]) {
          data.scenes[sceneKey] = {
            name: sceneName || sceneKey,
            room,
            modes: {},
            createdAt: new Date().toISOString(),
          };
          subscribeSceneSwitch(sceneKey);
        }

        const scene = data.scenes[sceneKey];
        const isUpdate = !!scene.modes[mode];

        scene.modes[mode] = {
          features,
          capturedAt: new Date().toISOString(),
        };

        saveData();

        const modeLabel = MODE_LABELS[mode];
        const action = isUpdate ? 'mis a jour' : 'enregistre';
        console.log(`[CAPTURE] "${scene.name}" mode "${modeLabel}" ${action} (${Object.keys(features).length} features)`);
        jsonResponse(res, 200, { ok: true, sceneKey, mode, modeLabel, updated: isUpdate });
        return;
      }

      // ===== ROOMS =====

      if (req.method === 'GET' && apiPath === '/rooms') {
        const devices = await getGladysDevices();
        const rooms = [...new Set(devices.map((d) => d.room).filter(Boolean))].sort();
        jsonResponse(res, 200, { rooms });
        return;
      }

      // ===== WEATHER =====

      if (req.method === 'GET' && apiPath === '/weather') {
        const conditions = await getFullConditions();
        const targetMode = resolveTargetMode(conditions);
        conditions.targetMode = targetMode;
        conditions.targetModeLabel = MODE_LABELS[targetMode];
        jsonResponse(res, 200, conditions);
        return;
      }

      // ===== STATUS =====

      if (req.method === 'GET' && apiPath === '/status') {
        let gladysOk = false;
        try {
          const r = await gladysRequest('GET', '/api/v1/device?take=1');
          gladysOk = r.status === 200;
        } catch (e) { /* ignore */ }

        jsonResponse(res, 200, {
          gladys: gladysOk,
          mqtt: mqttClient && mqttClient.connected,
          weatherConfigured: !!data.config.openWeatherMapApiKey,
          sceneCount: Object.keys(data.scenes).length,
          uptime: process.uptime(),
        });
        return;
      }

      // ===== CONFIG =====

      if (req.method === 'GET' && apiPath === '/config') {
        const safe = { ...data.config };
        if (safe.gladysApiKey) safe.gladysApiKey = safe.gladysApiKey.substring(0, 8) + '...';
        if (safe.openWeatherMapApiKey) safe.openWeatherMapApiKey = safe.openWeatherMapApiKey.substring(0, 8) + '...';
        jsonResponse(res, 200, safe);
        return;
      }

      if (req.method === 'PUT' && apiPath === '/config') {
        const body = JSON.parse(await readBody(req));
        const allowed = ['gladysUrl', 'gladysApiKey', 'latitude', 'longitude', 'openWeatherMapApiKey', 'weatherCacheDuration', 'cloudyThreshold'];
        allowed.forEach((k) => {
          if (body[k] !== undefined) data.config[k] = body[k];
        });
        saveData();
        weatherCache = { data: null, fetchedAt: 0 };
        console.log('[CONFIG] Configuration mise a jour');
        jsonResponse(res, 200, { ok: true });
        return;
      }

      // Not found
      if (!serveStatic(req, res)) {
        jsonResponse(res, 404, { error: `Route inconnue: ${req.method} ${apiPath}` });
      }
    } catch (err) {
      console.error('[HTTP ERR]', err.message);
      jsonResponse(res, 500, { error: err.message });
    }
  });

  server.listen(PORT, () => {
    console.log(`[HTTP] Scenes Manager v2.0 sur port ${PORT}`);
  });
}

// --- Helpers ---

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- MQTT ---

let mqttClient = null;

function startMqtt() {
  mqttClient = mqtt.connect(MQTT_URL, {
    clientId: 'scenes-manager',
    clean: true,
    reconnectPeriod: 5000,
  });

  mqttClient.on('connect', () => {
    console.log('[MQTT] Connecte a', MQTT_URL);
    subscribeAllSceneSwitches();
  });

  mqttClient.on('message', async (topic, message) => {
    const value = message.toString().trim();
    const match = topic.match(/^gladys\/device\/([^/]+)\/feature\/([^/]+)\/state$/);
    if (!match) return;

    const [, deviceExtId] = match;

    if (deviceExtId.startsWith(AMBIANCE_EXT_PREFIX)) {
      const sceneKey = deviceExtId.slice(AMBIANCE_EXT_PREFIX.length);
      const isOn = parseInt(value, 10) === 1;

      if (isOn && data.scenes[sceneKey]) {
        console.log(`[SWITCH] Activation ambiance "${data.scenes[sceneKey].name}"`);
        try {
          await applyScene(sceneKey);
        } catch (err) {
          console.error(`[SWITCH ERR] ${sceneKey}:`, err.message);
        }
      }
    }
  });

  mqttClient.on('error', (err) => console.error('[MQTT ERR]', err.message));
  mqttClient.on('reconnect', () => console.log('[MQTT] Reconnexion...'));
}

// --- Graceful shutdown ---

process.on('SIGTERM', () => {
  console.log('[SM] Arret...');
  if (mqttClient) mqttClient.end();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[SM] Arret (SIGINT)...');
  if (mqttClient) mqttClient.end();
  process.exit(0);
});

// --- Startup ---

console.log('[SM] Scenes Manager v2.0');
loadData();
startMqtt();
startHttpServer();
