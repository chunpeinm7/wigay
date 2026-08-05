const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3010;
const ESP32_HOST = process.env.ESP32_HOST || '172.20.10.11';
const ESP32_PORT = Number(process.env.ESP32_PORT || 80);
const ESP32_DATA_PATH = process.env.ESP32_DATA_PATH || '/sensor/movement_score';
const ESP32_POLL_INTERVAL_MS = Number(process.env.ESP32_POLL_INTERVAL_MS || 100);
const DATA_DIR = path.join(__dirname, 'data');
const TEMPLATE_FILE = path.join(DATA_DIR, 'gesture-templates.json');
const GESTURE_FILES = {
  wave: path.join(DATA_DIR, 'wave.json'),
  squat: path.join(DATA_DIR, 'squat.json'),
  clap: path.join(DATA_DIR, 'clap.json'),
  empty: path.join(DATA_DIR, 'empty_room.json')
};
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function ensureTemplateStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Migrate from legacy gesture-templates.json to individual files if needed
  let legacy = null;
  if (fs.existsSync(TEMPLATE_FILE)) {
    try {
      legacy = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'));
    } catch {}
  }

  for (const [gesture, filePath] of Object.entries(GESTURE_FILES)) {
    if (!fs.existsSync(filePath)) {
      const data = legacy ? normalizeGestureTemplates(legacy[gesture]) : [];
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }
  }
}

function isValidTemplateSample(sample) {
  return sample
    && typeof sample === 'object'
    && Number.isFinite(Number(sample.deviceA))
    && Number.isFinite(Number(sample.deviceB))
    && Number.isFinite(Number(sample.timestamp));
}

function normalizeTemplateSample(sample) {
  return {
    deviceA: Math.round(Number(sample.deviceA) * 1000) / 1000,
    deviceB: Math.round(Number(sample.deviceB) * 1000) / 1000,
    timestamp: Number(sample.timestamp)
  };
}

function normalizeTemplateEntry(entry) {
  if (!Array.isArray(entry)) {
    return [];
  }

  return entry
    .filter(isValidTemplateSample)
    .map(normalizeTemplateSample);
}

function normalizeGestureTemplates(value) {
  if (!Array.isArray(value) || !value.length) {
    return [];
  }

  if (Array.isArray(value[0])) {
    return value
      .map(normalizeTemplateEntry)
      .filter((entry) => entry.length > 0);
  }

  if (isValidTemplateSample(value[0])) {
    const migratedEntry = normalizeTemplateEntry(value);
    return migratedEntry.length ? [migratedEntry] : [];
  }

  return [];
}

function loadTemplateStore() {
  ensureTemplateStore();

  const store = { updatedAt: null };
  for (const [gesture, filePath] of Object.entries(GESTURE_FILES)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      store[gesture] = normalizeGestureTemplates(JSON.parse(raw));
    } catch {
      store[gesture] = [];
    }
  }
  return store;
}

function saveTemplateStore(store) {
  ensureTemplateStore();
  const updatedAt = new Date().toISOString();
  const payload = { updatedAt };
  for (const [gesture, filePath] of Object.entries(GESTURE_FILES)) {
    payload[gesture] = normalizeGestureTemplates(store[gesture]);
    fs.writeFileSync(filePath, JSON.stringify(payload[gesture], null, 2));
  }
  return payload;
}

app.get('/health', (req, res) => {
  res.json({ ok: true, port: PORT, timestamp: Date.now() });
});

app.get('/api/config', (req, res) => {
  res.json({
    port: PORT,
    templateFile: TEMPLATE_FILE,
    expectedPayload: {
      event: 'sensor:data',
      shape: {
        deviceA: 'number',
        deviceB: 'number',
        timestamp: 'optional number'
      }
    }
  });
});

app.get('/api/templates', (req, res) => {
  res.json(loadTemplateStore());
});

app.post('/api/templates', (req, res) => {
  const { gesture, samples, templates } = req.body || {};
  const current = loadTemplateStore();

  if (templates && typeof templates === 'object') {
    const saved = saveTemplateStore({
      wave: templates.wave,
      squat: templates.squat,
      clap: templates.clap,
      empty: templates.empty
    });
    return res.json(saved);
  }

  if (!['wave', 'squat', 'clap', 'empty'].includes(gesture)) {
    return res.status(400).json({ error: 'gesture must be wave, squat, clap, or empty' });
  }

  if (samples !== null && !Array.isArray(samples)) {
    return res.status(400).json({ error: 'samples must be an array or null' });
  }

  const normalizedSamples = normalizeTemplateEntry(samples);
  current[gesture] = normalizedSamples.length ? [...current[gesture], normalizedSamples] : current[gesture];
  return res.json(saveTemplateStore(current));
});

app.delete('/api/templates/:gesture', (req, res) => {
  const gesture = req.params.gesture;
  if (!['wave', 'squat', 'clap', 'empty'].includes(gesture)) {
    return res.status(400).json({ error: 'gesture must be wave, squat, clap, or empty' });
  }

  const current = loadTemplateStore();
  const index = Number.parseInt(req.query.index, 10);
  if (Number.isInteger(index) && index >= 0 && index < current[gesture].length) {
    current[gesture] = current[gesture].filter((_, itemIndex) => itemIndex !== index);
  } else {
    current[gesture] = [];
  }
  return res.json(saveTemplateStore(current));
});

app.get('/api/templates/export', (req, res) => {
  const store = loadTemplateStore();
  res.setHeader('Content-Disposition', 'attachment; filename="gesture-templates.json"');
  res.json(store);
});

function normalizeSensorPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const deviceA = Number(payload.deviceA ?? payload.a ?? payload.sensorA ?? payload.valueA);
  const deviceB = Number(payload.deviceB ?? payload.b ?? payload.sensorB ?? payload.valueB);
  const timestamp = Number(payload.timestamp ?? Date.now());

  if (!Number.isFinite(deviceA) || !Number.isFinite(deviceB)) {
    return null;
  }

  return { deviceA, deviceB, timestamp };
}

function buildDetectionMessage(socketId, sample) {
  return {
    source: socketId,
    sample,
    receivedAt: Date.now()
  };
}

let esp32PollingTimer = null;
let lastBridgeValue = null;
let bridgeRequestInFlight = false;
const smoothingWindow = [];

function pushSmoothingValue(value) {
  smoothingWindow.push(value);
  while (smoothingWindow.length > 5) {
    smoothingWindow.shift();
  }

  const total = smoothingWindow.reduce((sum, current) => sum + current, 0);
  return total / smoothingWindow.length;
}

function parseESP32ResponseValue(raw) {
  if (!raw) {
    return null;
  }

  function normalizeValue(value) {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value === 'boolean') {
      return value ? 1 : 0;
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    const text = String(value).trim().toLowerCase();
    if (!text) {
      return null;
    }

    if (['on', 'true', 'detected', 'motion'].includes(text)) {
      return 1;
    }
    if (['off', 'false', 'clear', 'idle', 'none'].includes(text)) {
      return 0;
    }

    const numeric = Number(text);
    return Number.isFinite(numeric) ? numeric : null;
  }

  try {
    const parsed = JSON.parse(raw);
    let value = null;
    if (parsed.state !== undefined) {
      value = normalizeValue(parsed.state);
    } else if (parsed.value !== undefined) {
      value = normalizeValue(parsed.value);
    } else if (parsed.movement_score !== undefined) {
      value = normalizeValue(parsed.movement_score);
    }
    return Number.isFinite(value) ? value : null;
  } catch {
    const matched = String(raw).match(/"(?:state|value|movement_score)"\s*:\s*"?([^",}\s]+)"?/i);
    if (!matched) {
      return null;
    }
    const value = normalizeValue(matched[1]);
    return Number.isFinite(value) ? value : null;
  }
}

function emitBridgedSample(score) {
  const smoothedScore = pushSmoothingValue(score);
  const sample = {
    deviceA: Math.round(score * 1000) / 1000,
    deviceB: Math.round(smoothedScore * 1000) / 1000,
    timestamp: Date.now()
  };

  io.emit('sensor:update', buildDetectionMessage('esp32-bridge', sample));
}

async function pollESP32MovementScore() {
  if (bridgeRequestInFlight) {
    return;
  }

  bridgeRequestInFlight = true;
  try {
    const url = `http://${ESP32_HOST}:${ESP32_PORT}${ESP32_DATA_PATH}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const reader = response.body?.getReader?.();
    let body = '';
    if (reader) {
      const firstChunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('BodyReadTimeout')), 1500))
      ]);
      if (firstChunk && !firstChunk.done && firstChunk.value) {
        body = Buffer.from(firstChunk.value).toString('utf8');
      }
      await reader.cancel().catch(() => {});
    }

    if (!body) {
      body = await response.text();
    }

    const value = parseESP32ResponseValue(body);
    if (Number.isFinite(value)) {
      lastBridgeValue = value;
      emitBridgedSample(value);
    }
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    console.error(`[ESP32 bridge timeout] ${ESP32_HOST}:${ESP32_PORT}`);
    io.emit('server:log', {
      level: 'warn',
      message: isTimeout
        ? `ESP32 橋接超時：連線到 ${ESP32_HOST}:${ESP32_PORT} 回應過慢`
        : `ESP32 橋接連線錯誤：無法連線到 ${ESP32_HOST}:${ESP32_PORT}`,
      timestamp: Date.now()
    });
  } finally {
    bridgeRequestInFlight = false;
  }
}

function startESP32Bridge() {
  if (esp32PollingTimer) {
    clearInterval(esp32PollingTimer);
  }

  pollESP32MovementScore();
  esp32PollingTimer = setInterval(pollESP32MovementScore, ESP32_POLL_INTERVAL_MS);
}

app.get('/api/source-status', (req, res) => {
  res.json({
    esp32Host: ESP32_HOST,
    esp32Port: ESP32_PORT,
    esp32DataPath: ESP32_DATA_PATH,
    pollingIntervalMs: ESP32_POLL_INTERVAL_MS,
    lastBridgeValue
  });
});

io.on('connection', (socket) => {
  socket.emit('server:ready', {
    socketId: socket.id,
    message: 'Gesture lab connected',
    expectedEvent: 'sensor:data',
    bridge: {
      enabled: true,
      source: `http://${ESP32_HOST}:${ESP32_PORT}${ESP32_DATA_PATH}`
    }
  });

  socket.on('sensor:data', (payload) => {
    const sample = normalizeSensorPayload(payload);
    if (!sample) {
      socket.emit('sensor:error', {
        message: 'Invalid payload. Expected numeric deviceA and deviceB fields.',
        payload
      });
      return;
    }

    io.emit('sensor:update', buildDetectionMessage(socket.id, sample));
  });

  socket.on('sensor:batch', (payload) => {
    const samples = Array.isArray(payload?.samples) ? payload.samples : [];
    const normalized = samples
      .map(normalizeSensorPayload)
      .filter(Boolean)
      .map((sample) => buildDetectionMessage(socket.id, sample));

    if (!normalized.length) {
      socket.emit('sensor:error', {
        message: 'Invalid batch payload. Expected samples with numeric deviceA and deviceB.'
      });
      return;
    }

    normalized.forEach((item) => io.emit('sensor:update', item));
  });

  socket.on('disconnect', () => {
    io.emit('server:log', {
      level: 'info',
      message: `Client disconnected: ${socket.id}`,
      timestamp: Date.now()
    });
  });
});

server.listen(PORT, () => {
  ensureTemplateStore();
  startESP32Bridge();
  console.log(`Gesture lab listening on http://localhost:${PORT}`);
  console.log('Socket.IO event: sensor:data');
  console.log(`ESP32 bridge: http://${ESP32_HOST}:${ESP32_PORT}${ESP32_DATA_PATH}`);
});