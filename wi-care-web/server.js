const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const basicAuth = require('express-basic-auth');
const os = require('os');
const EventEmitter = require('events');

// 初始化 Express 應用
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 中介軟體配置
app.use(cors({
  origin: '*',
  credentials: true
}));
app.use(compression()); // Gzip 壓縮
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// HTTP Basic Auth 認證
const authMiddleware = basicAuth({
  users: { 'admin': 'admin123' },
  challenge: true,
  realm: 'Wi-Care System'
});

// 配置系統
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');
let systemConfig = {
  deviceName: 'Wi-Care Hub',
  timezone: 'Asia/Taipei',
  gpioStates: {},
  pwmValues: {},
  settings: {}
};

// 載入配置
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      systemConfig = { ...systemConfig, ...JSON.parse(data) };
    }
  } catch (error) {
    console.error('載入配置失敗:', error);
  }
}

// 儲存配置
function saveConfig() {
  try {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(systemConfig, null, 2));
  } catch (error) {
    console.error('儲存配置失敗:', error);
  }
}

// 系統狀態
let systemState = {
  devices: [],
  sensors: {},
  gpioStates: {},
  systemInfo: {}
};

// GPIO 模擬（實際應用中需要使用 onoff 或類似套件）
const GPIO_PINS = [2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27];

// 初始化 GPIO 狀態
GPIO_PINS.forEach(pin => {
  systemState.gpioStates[pin] = { state: false, mode: 'output' };
});

// ==================== RESTful API 端點 ====================

// GET /api/status - 取得系統狀態
app.get('/api/status', (req, res) => {
  const status = {
    ...systemState,
    systemInfo: getSystemInfo(),
    timestamp: new Date().toISOString()
  };
  res.json(status);
});

// POST /api/control - 控制設備
app.post('/api/control', authMiddleware, (req, res) => {
  const { action, device, value, pin } = req.body;
  
  try {
    switch (action) {
      case 'gpio':
        if (GPIO_PINS.includes(pin)) {
          systemState.gpioStates[pin].state = value;
          broadcastToClients({ type: 'gpio', pin, value });
          res.json({ success: true, pin, value });
        } else {
          res.status(400).json({ error: '無效的 GPIO 針腳' });
        }
        break;
        
      case 'pwm':
        if (pin && value >= 0 && value <= 255) {
          systemConfig.pwmValues[pin] = value;
          broadcastToClients({ type: 'pwm', pin, value });
          res.json({ success: true, pin, value });
        } else {
          res.status(400).json({ error: '無效的 PWM 值' });
        }
        break;
        
      case 'device':
        // 控制自定義設備
        broadcastToClients({ type: 'device', device, value });
        res.json({ success: true, device, value });
        break;
        
      default:
        res.status(400).json({ error: '未知的動作' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/gpio - 取得所有 GPIO 狀態
app.get('/api/gpio', (req, res) => {
  res.json(systemState.gpioStates);
});

// POST /api/gpio/:pin - 控制特定 GPIO
app.post('/api/gpio/:pin', authMiddleware, (req, res) => {
  const pin = parseInt(req.params.pin);
  const { state, mode } = req.body;
  
  if (GPIO_PINS.includes(pin)) {
    if (state !== undefined) {
      systemState.gpioStates[pin].state = state;
    }
    if (mode) {
      systemState.gpioStates[pin].mode = mode;
    }
    
    broadcastToClients({ 
      type: 'gpio', 
      pin, 
      state: systemState.gpioStates[pin].state,
      mode: systemState.gpioStates[pin].mode
    });
    
    res.json({ success: true, gpio: systemState.gpioStates[pin] });
  } else {
    res.status(400).json({ error: '無效的 GPIO 針腳' });
  }
});

// GET /api/sensors - 取得感測器數據
app.get('/api/sensors', (req, res) => {
  // 模擬感測器數據
  const sensorData = {
    temperature: (20 + Math.random() * 10).toFixed(2),
    humidity: (40 + Math.random() * 30).toFixed(2),
    pressure: (1000 + Math.random() * 50).toFixed(2),
    light: Math.floor(Math.random() * 1024),
    motion: Math.random() > 0.8,
    timestamp: new Date().toISOString()
  };
  
  systemState.sensors = sensorData;
  res.json(sensorData);
});

// GET /api/config - 取得配置
app.get('/api/config', authMiddleware, (req, res) => {
  res.json(systemConfig);
});

// POST /api/config - 更新配置
app.post('/api/config', authMiddleware, (req, res) => {
  try {
    systemConfig = { ...systemConfig, ...req.body };
    saveConfig();
    res.json({ success: true, config: systemConfig });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/system - 系統資訊
app.get('/api/system', (req, res) => {
  res.json(getSystemInfo());
});

// ==================== SSE (Server-Sent Events) ====================

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // 發送初始狀態
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);
  
  // 定期發送系統狀態更新
  const interval = setInterval(() => {
    const data = {
      type: 'status',
      systemInfo: getSystemInfo(),
      sensors: systemState.sensors,
      timestamp: Date.now()
    };
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }, 3000);
  
  // 客戶端斷開連接時清理
  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

// ==================== WebSocket Server ====================

// WebSocket 連接管理
const clients = new Set();

wss.on('connection', (ws, req) => {
  console.log('WebSocket 客戶端已連接');
  clients.add(ws);
  
  // 發送歡迎消息
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Wi-Care System WebSocket 連接成功',
    timestamp: Date.now()
  }));
  
  // 發送當前狀態
  ws.send(JSON.stringify({
    type: 'status',
    data: systemState,
    timestamp: Date.now()
  }));
  
  // 處理接收到的消息
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleWebSocketMessage(ws, data);
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  });
  
  // 處理斷開連接
  ws.on('close', () => {
    console.log('WebSocket 客戶端已斷開');
    clients.delete(ws);
  });
  
  // 錯誤處理
  ws.on('error', (error) => {
    console.error('WebSocket 錯誤:', error);
    clients.delete(ws);
  });
});

// 處理 WebSocket 消息
function handleWebSocketMessage(ws, data) {
  switch (data.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;
      
    case 'getStatus':
      ws.send(JSON.stringify({ 
        type: 'status', 
        data: systemState,
        timestamp: Date.now()
      }));
      break;
      
    case 'control':
      // 處理控制指令
      if (data.action === 'gpio' && data.pin) {
        systemState.gpioStates[data.pin].state = data.value;
        broadcastToClients({ 
          type: 'gpio', 
          pin: data.pin, 
          value: data.value 
        });
      }
      break;
      
    default:
      ws.send(JSON.stringify({ type: 'error', message: '未知的消息類型' }));
  }
}

// 廣播消息給所有連接的客戶端
function broadcastToClients(data) {
  const message = JSON.stringify({ ...data, timestamp: Date.now() });
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ==================== 系統監控功能 ====================

function getSystemInfo() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptime: os.uptime(),
    loadavg: os.loadavg(),
    memory: {
      total: totalMem,
      free: freeMem,
      used: usedMem,
      percentage: ((usedMem / totalMem) * 100).toFixed(2)
    },
    cpus: os.cpus().length,
    networkInterfaces: Object.keys(os.networkInterfaces()),
    timestamp: Date.now()
  };
}

// 定期更新系統狀態和感測器數據
setInterval(() => {
  // 模擬感測器數據更新
  systemState.sensors = {
    temperature: (20 + Math.random() * 10).toFixed(2),
    humidity: (40 + Math.random() * 30).toFixed(2),
    pressure: (1000 + Math.random() * 50).toFixed(2),
    light: Math.floor(Math.random() * 1024),
    motion: Math.random() > 0.8,
    timestamp: new Date().toISOString()
  };
  
  // 廣播更新
  broadcastToClients({
    type: 'sensorUpdate',
    data: systemState.sensors
  });
}, 5000);

// ==================== 啟動服務器 ====================

const PORT = process.env.PORT || 3000;

// 載入配置
loadConfig();

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║       Wi-Care Home Automation System          ║
╠════════════════════════════════════════════════╣
║  Web Server: http://localhost:${PORT}        ║
║  WebSocket:  ws://localhost:${PORT}          ║
║  SSE Events: http://localhost:${PORT}/api/events
║                                                ║
║  預設帳號: admin / admin123                   ║
╚════════════════════════════════════════════════╝
  `);
  console.log('系統已啟動，正在監聽連接...\n');
});

// 優雅關閉
process.on('SIGTERM', () => {
  console.log('收到 SIGTERM 信號，正在關閉服務器...');
  saveConfig();
  server.close(() => {
    console.log('服務器已關閉');
    process.exit(0);
  });
});
