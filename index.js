/**
 * Scenes Manager — Smart Ambiance Manager for Gladys Assistant v1.0
 *
 * Captures light states from Gladys, stores presets with adaptive variants
 * (day/night, weather), and applies the right variant automatically.
 *
 * Gladys decides WHEN (triggers/scenes). Scenes Manager decides HOW (which variant).
 *
 * HTTP API on port 8890, MQTT switches for Gladys integration.
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
  weatherCacheDuration: 600000, // 10 min
  cloudyThreshold: 40, // % clouds above this = "cloudy"
};

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
  } catch (e) {
    data = { config: { ...DEFAULT_CONFIG }, scenes: {} };
  }
  const count = Object.keys(data.scenes).length;
  console.log(`[DATA] ${count} scene(s) chargee(s)`);
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

    // Return cache if fresh
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
            console.log(`[WEATHER] ${w.weather[0].description}, nuages ${w.clouds.all}%, ${w.main.temp}°C`);
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

function selectVariant(scene, conditions) {
  if (!scene.variants || scene.variants.length === 0) {
    return scene.default || null;
  }

  const active = scene.adaptiveConditions || [];
  if (active.length === 0) {
    return scene.default || scene.variants[0] || null;
  }

  // Try exact match
  const exactMatch = scene.variants.find((v) => {
    if (!v.when) return false;
    return active.every((cond) => {
      if (!v.when[cond]) return true; // condition not specified in variant = wildcard
      return v.when[cond] === conditions[cond];
    });
  });
  if (exactMatch) return exactMatch;

  // Try partial match (daylight has priority over weather)
  const priorityOrder = ['daylight', 'weather'];
  for (const cond of priorityOrder) {
    if (!active.includes(cond)) continue;
    const partial = scene.variants.find((v) => v.when && v.when[cond] === conditions[cond]);
    if (partial) return partial;
  }

  // Fallback to default
  return scene.default || scene.variants[0] || null;
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
  // Get light devices
  const lightRes = await gladysRequest('GET', '/api/v1/device?device_feature_category=light');
  if (lightRes.status !== 200) {
    throw new Error(`Gladys API error: ${lightRes.status}`);
  }

  let devices = lightRes.data;

  // Also get dimmer devices (Z-Wave)
  const switchRes = await gladysRequest('GET', '/api/v1/device?device_feature_category=switch&device_feature_type=dimmer');
  if (switchRes.status === 200 && Array.isArray(switchRes.data)) {
    // Add Z-Wave dimmers that aren't already in the list
    const existingIds = new Set(devices.map((d) => d.id));
    switchRes.data.forEach((d) => {
      if (!existingIds.has(d.id)) devices.push(d);
    });
  }

  // Filter out Matter duplicates
  devices = devices.filter((d) => !d.external_id || !d.external_id.startsWith('matter:'));

  // Filter by room if specified
  if (room) {
    devices = devices.filter((d) => d.room && d.room.name === room);
  }

  // Transform to a cleaner format
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

  // Separate power-on commands from the rest
  const powerOns = entries.filter(([sel]) => sel.endsWith('-binary') || sel.endsWith('-power'));
  const others = entries.filter(([sel]) => !sel.endsWith('-binary') && !sel.endsWith('-power'));

  let applied = 0;
  let errors = 0;

  // First: power on devices (in parallel)
  if (powerOns.length > 0) {
    const results = await Promise.all(
      powerOns.map(([selector, value]) =>
        gladysRequest('POST', `/api/v1/device_feature/${selector}/value`, { value })
          .then((r) => {
            if (r.status === 200) applied++;
            else {
              console.error(`[APPLY ERR] ${selector}: status ${r.status}`);
              errors++;
            }
          })
          .catch((e) => {
            console.error(`[APPLY ERR] ${selector}:`, e.message);
            errors++;
          })
      )
    );

    // Small delay to let devices power on before setting color/brightness
    if (powerOns.some(([, v]) => v === 1)) {
      await sleep(150);
    }
  }

  // Then: apply colors, brightness, temperature, dimmers (in parallel)
  if (others.length > 0) {
    await Promise.all(
      others.map(([selector, value]) =>
        gladysRequest('POST', `/api/v1/device_feature/${selector}/value`, { value })
          .then((r) => {
            if (r.status === 200) applied++;
            else {
              console.error(`[APPLY ERR] ${selector}: status ${r.status}`);
              errors++;
            }
          })
          .catch((e) => {
            console.error(`[APPLY ERR] ${selector}:`, e.message);
            errors++;
          })
      )
    );
  }

  return { applied, errors };
}

// --- Scene application ---

async function applyScene(key, forceVariant) {
  const scene = data.scenes[key];
  if (!scene) {
    console.log(`[SCENE] "${key}" introuvable`);
    return { ok: false, error: `Scene "${key}" introuvable` };
  }

  const start = Date.now();
  let variant;
  let conditions;

  if (forceVariant) {
    // Force a specific variant by label or index
    variant = scene.variants.find((v) => v.label === forceVariant);
    if (!variant && forceVariant === 'default') variant = scene.default;
    if (!variant) {
      return { ok: false, error: `Variante "${forceVariant}" introuvable` };
    }
    conditions = { forced: true };
  } else {
    // Smart selection
    conditions = await getFullConditions();
    variant = selectVariant(scene, conditions);
  }

  if (!variant || !variant.features) {
    return { ok: false, error: 'Aucune variante applicable' };
  }

  console.log(`[SCENE] Application "${scene.name}" → ${variant.label || 'default'} (${Object.keys(variant.features).length} features)`);

  const result = await applyFeatures(variant.features);
  const elapsed = Date.now() - start;

  // Update MQTT switch state (radio buttons per room)
  updateSceneSwitches(key);

  console.log(`[SCENE] "${scene.name}" appliquee en ${elapsed}ms (${result.applied} OK, ${result.errors} erreurs)`);

  return {
    ok: true,
    scene: scene.name,
    variant: variant.label || 'default',
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

  // Security: prevent path traversal
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

    // Serve static files first (only for non-API routes)
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
          adaptiveConditions: s.adaptiveConditions || [],
          variantCount: (s.variants || []).length,
          hasDefault: !!s.default,
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
          adaptiveConditions: body.adaptiveConditions || [],
          variants: [],
          default: null,
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
        if (body.adaptiveConditions) data.scenes[key].adaptiveConditions = body.adaptiveConditions;
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
        const result = await applyScene(key, body.variant);
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
        const { sceneKey, sceneName, room, features, isDefault, conditions, label } = body;

        if (!sceneKey || !room || !features || Object.keys(features).length === 0) {
          jsonResponse(res, 400, { error: 'sceneKey, room et features requis' });
          return;
        }
        if (!/^[a-z0-9-]+$/.test(sceneKey)) {
          jsonResponse(res, 400, { error: 'sceneKey: minuscules, chiffres et tirets uniquement' });
          return;
        }

        // Create scene if it doesn't exist
        if (!data.scenes[sceneKey]) {
          data.scenes[sceneKey] = {
            name: sceneName || sceneKey,
            room,
            adaptiveConditions: [],
            variants: [],
            default: null,
            createdAt: new Date().toISOString(),
          };
          subscribeSceneSwitch(sceneKey);
        }

        const scene = data.scenes[sceneKey];
        const variantData = {
          features,
          capturedAt: new Date().toISOString(),
        };

        if (isDefault) {
          // Save as default
          scene.default = { ...variantData, label: 'default' };
          console.log(`[CAPTURE] Default de "${scene.name}" enregistre (${Object.keys(features).length} features)`);
        } else {
          // Save as variant
          const when = conditions || {};
          const variantLabel = label || buildLabel(when);
          variantData.when = when;
          variantData.label = variantLabel;

          // Update adaptiveConditions
          Object.keys(when).forEach((cond) => {
            if (!scene.adaptiveConditions.includes(cond)) {
              scene.adaptiveConditions.push(cond);
            }
          });

          // Replace existing variant with same conditions or add new
          const existingIdx = scene.variants.findIndex(
            (v) => v.when && JSON.stringify(v.when) === JSON.stringify(when)
          );
          if (existingIdx >= 0) {
            scene.variants[existingIdx] = variantData;
            console.log(`[CAPTURE] Variante "${variantLabel}" de "${scene.name}" mise a jour`);
          } else {
            scene.variants.push(variantData);
            console.log(`[CAPTURE] Variante "${variantLabel}" ajoutee a "${scene.name}"`);
          }
        }

        saveData();
        jsonResponse(res, 200, { ok: true, sceneKey, variant: variantData.label || 'default' });
        return;
      }

      // ===== ROOMS =====

      // GET /rooms
      if (req.method === 'GET' && apiPath === '/rooms') {
        const devices = await getGladysDevices();
        const rooms = [...new Set(devices.map((d) => d.room).filter(Boolean))].sort();
        jsonResponse(res, 200, { rooms });
        return;
      }

      // ===== WEATHER =====

      // GET /weather
      if (req.method === 'GET' && apiPath === '/weather') {
        const conditions = await getFullConditions();
        jsonResponse(res, 200, conditions);
        return;
      }

      // ===== STATUS =====

      // GET /status
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

      // GET /config
      if (req.method === 'GET' && apiPath === '/config') {
        // Don't expose full API keys
        const safe = { ...data.config };
        if (safe.gladysApiKey) safe.gladysApiKey = safe.gladysApiKey.substring(0, 8) + '...';
        if (safe.openWeatherMapApiKey) safe.openWeatherMapApiKey = safe.openWeatherMapApiKey.substring(0, 8) + '...';
        jsonResponse(res, 200, safe);
        return;
      }

      // PUT /config
      if (req.method === 'PUT' && apiPath === '/config') {
        const body = JSON.parse(await readBody(req));
        const allowed = ['gladysUrl', 'gladysApiKey', 'latitude', 'longitude', 'openWeatherMapApiKey', 'weatherCacheDuration', 'cloudyThreshold'];
        allowed.forEach((k) => {
          if (body[k] !== undefined) data.config[k] = body[k];
        });
        saveData();
        // Invalidate weather cache on config change
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
    console.log(`[HTTP] Scenes Manager disponible sur port ${PORT}`);
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

function buildLabel(when) {
  const parts = [];
  if (when.daylight) parts.push(when.daylight === 'day' ? 'Jour' : 'Nuit');
  if (when.weather) parts.push(when.weather === 'clear' ? 'Clair' : 'Couvert');
  return parts.join(' + ') || 'default';
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

console.log('[SM] Scenes Manager v1.0');
loadData();
startMqtt();
startHttpServer();
