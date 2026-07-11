const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// 嘗試載入 mqtt（可選依賴）
let mqtt;
try { mqtt = require('mqtt'); } catch { mqtt = null; }

// ==================== 配置 ====================
const PORT = process.env.PORT || 3001;
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
const MQTT_TOPIC = process.env.MQTT_TOPIC || 'esp32/csi';
const ENABLE_MQTT = process.env.ENABLE_MQTT === 'true'; // 預設關閉 MQTT
const ESP32_HOST = process.env.ESP32_HOST || '192.168.0.128'; // ESP32-S3 位址
const GESTURE_TEMPLATE_FILE = path.join(__dirname, 'gesture-lab', 'data', 'gesture-templates.json');
const MODEL_MATCH_THRESHOLD = 65;
const MODEL_MIN_CONFIDENCE_GAP = 6;
const MODEL_MIN_TEMPLATE_POINTS = 8;
const MODEL_RESAMPLE_POINTS = 24;
const MODEL_TOP_MATCHES = 3;
const MODEL_RECENT_WINDOW_MS = 12000;
const WAVE_EVENT_HOLD_MS = 500;
const WAVE_REARM_STDDEV = 0.03;
const ESP32_POLL_INTERVAL_MS = 1000;

// ==================== Express 初始化 ====================
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors({ origin: '*' }));
app.use(express.json());

// 根路徑直接顯示 CSI 監控頁面
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'csi-monitor.html'));
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

function calculateMean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateStdDev(values) {
  if (!values.length) return 0;
  const mean = calculateMean(values);
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

function countDirectionChanges(values) {
  let changes = 0;
  let previousDirection = 0;

  for (let index = 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    const direction = Math.abs(delta) < 0.002 ? 0 : Math.sign(delta);

    if (direction && previousDirection && direction !== previousDirection) {
      changes += 1;
    }

    if (direction) {
      previousDirection = direction;
    }
  }

  return changes;
}

function calculateMotionEnergy(values) {
  if (values.length < 2) return 0;
  let total = 0;
  for (let index = 1; index < values.length; index += 1) {
    total += Math.abs(values[index] - values[index - 1]);
  }
  return total;
}

function calculateTemplateDuration(sequence) {
  if (!sequence.length) return 0;
  return Math.max(1, sequence[sequence.length - 1].timestamp - sequence[0].timestamp);
}

function resampleSequence(sequence, targetPoints = MODEL_RESAMPLE_POINTS) {
  if (!sequence.length) return [];

  if (sequence.length === 1) {
    return Array.from({ length: targetPoints }, () => ({ ...sequence[0] }));
  }

  return Array.from({ length: targetPoints }, (_, index) => {
    const scaledIndex = (index * (sequence.length - 1)) / (targetPoints - 1);
    const leftIndex = Math.floor(scaledIndex);
    const rightIndex = Math.min(sequence.length - 1, leftIndex + 1);
    const fraction = scaledIndex - leftIndex;
    const left = sequence[leftIndex];
    const right = sequence[rightIndex];

    return {
      deviceA: left.deviceA + ((right.deviceA - left.deviceA) * fraction),
      deviceB: left.deviceB + ((right.deviceB - left.deviceB) * fraction),
      timestamp: left.timestamp + ((right.timestamp - left.timestamp) * fraction)
    };
  });
}

function normalizeValues(values) {
  const mean = calculateMean(values);
  const stdDev = calculateStdDev(values);
  const scale = stdDev > 0.0001 ? stdDev : Math.max(...values.map((value) => Math.abs(value - mean)), 1);
  return values.map((value) => (value - mean) / scale);
}

function extractTemplateFeatures(sequence) {
  const valuesA = sequence.map((sample) => sample.deviceA);
  const valuesB = sequence.map((sample) => sample.deviceB);
  const meanA = calculateMean(valuesA);
  const meanB = calculateMean(valuesB);

  return {
    durationMs: calculateTemplateDuration(sequence),
    rangeA: Math.max(...valuesA) - Math.min(...valuesA),
    rangeB: Math.max(...valuesB) - Math.min(...valuesB),
    stdA: calculateStdDev(valuesA),
    stdB: calculateStdDev(valuesB),
    driftA: valuesA[valuesA.length - 1] - valuesA[0],
    driftB: valuesB[valuesB.length - 1] - valuesB[0],
    motionA: calculateMotionEnergy(valuesA),
    motionB: calculateMotionEnergy(valuesB),
    oscillationA: countDirectionChanges(valuesA.map((value) => value - meanA)),
    oscillationB: countDirectionChanges(valuesB.map((value) => value - meanB))
  };
}

function prepareSequence(sequence) {
  const resampled = resampleSequence(sequence, MODEL_RESAMPLE_POINTS);
  const normalizedA = normalizeValues(resampled.map((sample) => sample.deviceA));
  const normalizedB = normalizeValues(resampled.map((sample) => sample.deviceB));

  return {
    points: normalizedA.map((deviceA, index) => ({
      deviceA,
      deviceB: normalizedB[index]
    })),
    features: extractTemplateFeatures(sequence)
  };
}

function dtwDistance(sequenceA, sequenceB) {
  const rows = sequenceA.length;
  const cols = sequenceB.length;
  if (!rows || !cols) return Number.POSITIVE_INFINITY;

  const matrix = Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(Number.POSITIVE_INFINITY));
  matrix[0][0] = 0;

  for (let row = 1; row <= rows; row += 1) {
    for (let col = 1; col <= cols; col += 1) {
      const pointA = sequenceA[row - 1];
      const pointB = sequenceB[col - 1];
      const cost = Math.abs(pointA.deviceA - pointB.deviceA) + Math.abs(pointA.deviceB - pointB.deviceB);
      matrix[row][col] = cost + Math.min(
        matrix[row - 1][col],
        matrix[row][col - 1],
        matrix[row - 1][col - 1]
      );
    }
  }

  return matrix[rows][cols] / (rows + cols);
}

function featureDistance(left, right) {
  const keys = ['rangeA', 'rangeB', 'stdA', 'stdB', 'driftA', 'driftB', 'motionA', 'motionB', 'oscillationA', 'oscillationB'];
  const total = keys.reduce((sum, key) => {
    const scale = Math.max(Math.abs(left[key]), Math.abs(right[key]), 0.05);
    return sum + Math.min(4, Math.abs(left[key] - right[key]) / scale);
  }, 0);

  return total / keys.length;
}

function similarityFromDistance(distance) {
  if (!Number.isFinite(distance)) return 0;
  return Math.max(0, Math.min(100, Math.round(100 * Math.exp(-distance * 1.35))));
}

function isTemplateSample(sample) {
  return sample
    && typeof sample === 'object'
    && Number.isFinite(Number(sample.deviceA))
    && Number.isFinite(Number(sample.deviceB))
    && Number.isFinite(Number(sample.timestamp));
}

function normalizeTemplateEntry(entry) {
  if (!Array.isArray(entry)) return [];
  return entry
    .filter(isTemplateSample)
    .map((sample) => ({
      deviceA: Number(sample.deviceA),
      deviceB: Number(sample.deviceB),
      timestamp: Number(sample.timestamp)
    }));
}

function normalizeTemplateCollection(value) {
  if (!Array.isArray(value) || !value.length) return [];

  if (Array.isArray(value[0])) {
    return value
      .map(normalizeTemplateEntry)
      .filter((entry) => entry.length >= MODEL_MIN_TEMPLATE_POINTS);
  }

  if (isTemplateSample(value[0])) {
    const migrated = normalizeTemplateEntry(value);
    return migrated.length >= MODEL_MIN_TEMPLATE_POINTS ? [migrated] : [];
  }

  return [];
}

class GestureModelClassifier {
  constructor(templateFile) {
    this.templateFile = templateFile;
    this.templates = { wave: [], squat: [], updatedAt: null };
    this.recentSamples = [];
    this.smoothingWindow = [];
    this.lastLoadedMtimeMs = 0;
    this.loadTemplates();
  }

  loadTemplates() {
    try {
      const stats = fs.statSync(this.templateFile);
      if (stats.mtimeMs === this.lastLoadedMtimeMs) {
        return;
      }

      const raw = fs.readFileSync(this.templateFile, 'utf8');
      const parsed = JSON.parse(raw);
      this.templates = {
        wave: normalizeTemplateCollection(parsed.wave),
        squat: normalizeTemplateCollection(parsed.squat),
        updatedAt: parsed.updatedAt ?? null
      };
      this.lastLoadedMtimeMs = stats.mtimeMs;
      console.log(`[MODEL] 已載入訓練集 wave=${this.templates.wave.length} squat=${this.templates.squat.length}`);
    } catch (error) {
      this.templates = { wave: [], squat: [], updatedAt: null };
      this.lastLoadedMtimeMs = 0;
    }
  }

  reset() {
    this.recentSamples = [];
    this.smoothingWindow = [];
  }

  pushSample(score, timestamp = Date.now()) {
    this.loadTemplates();
    this.smoothingWindow.push(score);
    while (this.smoothingWindow.length > 5) this.smoothingWindow.shift();
    const smoothedScore = calculateMean(this.smoothingWindow);

    this.recentSamples.push({
      deviceA: Math.round(score * 1000) / 1000,
      deviceB: Math.round(smoothedScore * 1000) / 1000,
      timestamp
    });

    const dynamicWindowMs = Math.max(
      MODEL_RECENT_WINDOW_MS,
      this.getLongestTemplatePointCount() * 350
    );
    this.recentSamples = this.recentSamples.filter((sample) => timestamp - sample.timestamp <= dynamicWindowMs);
  }

  getLongestTemplatePointCount() {
    return Math.max(
      MODEL_MIN_TEMPLATE_POINTS,
      ...this.templates.wave.map((entry) => entry.length),
      ...this.templates.squat.map((entry) => entry.length)
    );
  }

  hasCompleteTraining() {
    return this.templates.wave.length > 0 && this.templates.squat.length > 0;
  }

  scoreWindowAgainstTemplate(templateSamples) {
    if (templateSamples.length < MODEL_MIN_TEMPLATE_POINTS || this.recentSamples.length < templateSamples.length) {
      return null;
    }

    const liveSlice = this.recentSamples.slice(-templateSamples.length);
    const livePrepared = prepareSequence(liveSlice);
    const templatePrepared = prepareSequence(templateSamples);
    const sequenceDistance = dtwDistance(livePrepared.points, templatePrepared.points);
    const engineeredPenalty = featureDistance(livePrepared.features, templatePrepared.features);
    const totalDistance = (sequenceDistance * 0.72) + (engineeredPenalty * 0.28);

    return {
      distance: totalDistance,
      similarity: similarityFromDistance(totalDistance)
    };
  }

  evaluateGesture(gesture) {
    const matches = this.templates[gesture]
      .map((entry) => this.scoreWindowAgainstTemplate(entry))
      .filter(Boolean)
      .sort((left, right) => left.distance - right.distance);

    if (!matches.length) return null;

    const top = matches.slice(0, Math.min(MODEL_TOP_MATCHES, matches.length));
    return {
      gesture,
      distance: top.reduce((sum, item) => sum + item.distance, 0) / top.length,
      similarity: Math.round(top.reduce((sum, item) => sum + item.similarity, 0) / top.length),
      support: top.length
    };
  }

  classify() {
    this.loadTemplates();
    if (!this.hasCompleteTraining()) return null;

    const results = ['wave', 'squat']
      .map((gesture) => this.evaluateGesture(gesture))
      .filter(Boolean)
      .sort((left, right) => right.similarity - left.similarity);

    if (results.length < 2) return null;

    const best = results[0];
    const runnerUp = results[1];
    const similarityGap = best.similarity - runnerUp.similarity;

    if (best.similarity < MODEL_MATCH_THRESHOLD || similarityGap < MODEL_MIN_CONFIDENCE_GAP) {
      return {
        mode: 'uncertain',
        best,
        runnerUp,
        similarityGap,
        results
      };
    }

    return {
      mode: 'classified',
      best,
      runnerUp,
      similarityGap,
      results
    };
  }
}

const gestureClassifier = new GestureModelClassifier(GESTURE_TEMPLATE_FILE);

// ==================== CSI 數據分析引擎 ====================
class CSIAnalyzer {
  constructor() {
    // 滑動窗口保存最近的 CSI 數據
    this.windowSize = 30;       // 窗口大小（只儲存不重複的值）
    this.dataWindow = [];        // 數據窗口
    this.prevStatus = 'empty';   // 前一次狀態
    this.statusHistory = [];     // 狀態歷史
    this.alertActive = false;    // 警報是否啟動
    this.waveEventUntil = 0;     // 揮手事件顯示到何時
    this.waveEventState = null;  // 最近一次揮手事件資訊
    this.waveArmed = true;       // 是否允許下一次揮手觸發

    // 閾值設定（已針對 ESP32 movement_score 範圍 0~10 調整）
    this.thresholds = {
      emptyStdDev: 0.08,          // 標準差 < 此值 => 空房間（movement_score 通常 0~0.5 為靜止）
      waveHighFreqThreshold: 0.05, // 揮手需要的最低近期標準差
      waveMinCount: 2,            // 揮手至少需要的零交叉次數
      waveMaxDisplacement: 1.5,   // 揮手時位移上限（走路位移 > 1.5）
      fallDisplacement: 0.8,      // 跌倒位移閾值（均值突然下降）
      fallStillStdDev: 0.1,       // 跌倒後靜止的標準差閾值
      fallStillWindow: 8,         // 跌倒後靜止判斷窗口（~16 秒）
    };
  }

  // 計算標準差
  calcStdDev(arr) {
    if (arr.length === 0) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length;
    return Math.sqrt(variance);
  }

  // 計算平均值
  calcMean(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  // 計算零交叉率（高頻波動指標）
  calcZeroCrossingRate(arr) {
    if (arr.length < 2) return 0;
    const mean = this.calcMean(arr);
    let crossings = 0;
    for (let i = 1; i < arr.length; i++) {
      if ((arr[i] - mean) * (arr[i - 1] - mean) < 0) {
        crossings++;
      }
    }
    return crossings;
  }

  // 加入新數據並分析
  analyze(newData) {
    const now = Date.now();

    // newData 可以是單一數值或陣列
    if (Array.isArray(newData)) {
      this.dataWindow.push(...newData);
    } else {
      this.dataWindow.push(newData);
    }

    // 維持窗口大小
    while (this.dataWindow.length > this.windowSize) {
      this.dataWindow.shift();
    }

    // 數據不足時不判斷
    if (this.dataWindow.length < 5) {
      return { status: 'initializing', confidence: 0, stdDev: 0, zeroCrossRate: 0 };
    }

    // 去除連續重複值（keepalive 重複推送同一值會稀釋統計）
    const uniqueData = [];
    for (let i = 0; i < this.dataWindow.length; i++) {
      if (i === 0 || this.dataWindow[i] !== this.dataWindow[i - 1]) {
        uniqueData.push(this.dataWindow[i]);
      }
    }
    if (uniqueData.length < 3) {
      return { status: 'initializing', confidence: 0, stdDev: 0, zeroCrossRate: 0 };
    }

    const stdDev = this.calcStdDev(uniqueData);
    const recentWindow = uniqueData.slice(-5);  // 最近 5 筆不重複值
    const recentStdDev = this.calcStdDev(recentWindow);
    const zeroCrossRate = this.calcZeroCrossingRate(recentWindow);

    // 計算位移（最近數據與前段數據的均值差）- 使用去重後的資料
    const recentMean = this.calcMean(uniqueData.slice(-this.thresholds.fallStillWindow));
    const previousMean = this.calcMean(
      uniqueData.slice(
        Math.max(0, uniqueData.length - this.thresholds.fallStillWindow * 2),
        uniqueData.length - this.thresholds.fallStillWindow
      )
    );
    const displacement = Math.abs(recentMean - previousMean);
    const tailStdDev = this.calcStdDev(uniqueData.slice(-this.thresholds.fallStillWindow));

    let status = 'unknown';
    let confidence = 0;
    let source = 'heuristic';
    let model = null;
    let waveEventCandidate = null;

    // DEBUG: 顯示分析數值
    const heuristicWaveDetected = recentStdDev > this.thresholds.waveHighFreqThreshold
      && zeroCrossRate >= this.thresholds.waveMinCount
      && displacement < this.thresholds.waveMaxDisplacement
      && esp32MotionDetected;

    console.log(`[分析] unique=${uniqueData.length}/${this.dataWindow.length} stdDev=${stdDev.toFixed(3)} recentStdDev=${recentStdDev.toFixed(3)} zcr=${zeroCrossRate} displacement=${displacement.toFixed(3)} motion=${esp32MotionDetected} → ${heuristicWaveDetected ? 'WAVE!' : ''}`);

    // ===== 優先使用訓練模型 =====
    if (typeof newData === 'number' && Number.isFinite(newData)) {
      gestureClassifier.pushSample(newData);
      const modelResult = gestureClassifier.classify();

      if (modelResult?.mode === 'classified') {
        model = modelResult;
        if (modelResult.best.gesture === 'squat') {
          status = 'fall';
          confidence = modelResult.best.similarity / 100;
          source = 'trained-model';
          this.alertActive = true;
        } else {
          waveEventCandidate = {
            source: 'trained-model',
            confidence: modelResult.best.similarity / 100,
            modelBestGesture: modelResult.best.gesture,
            modelBestSimilarity: modelResult.best.similarity,
            modelRunnerUpSimilarity: modelResult.runnerUp?.similarity ?? null,
            modelSimilarityGap: modelResult.similarityGap ?? null
          };
        }
      } else if (modelResult?.mode === 'uncertain') {
        model = modelResult;
      }
    }

    // ===== 判斷邏輯 =====

    // 1. 若模型未明確命中，退回原本 heuristic
    if (source !== 'trained-model' && displacement > this.thresholds.fallDisplacement && tailStdDev < this.thresholds.fallStillStdDev) {
      status = 'fall';
      confidence = Math.min(1, displacement / (this.thresholds.fallDisplacement * 2));
      this.alertActive = true;
    }
    // 2. 揮手：中等活動 + 位移小（在原地有動作，而非走動）
    else if (source !== 'trained-model' && heuristicWaveDetected) {
      waveEventCandidate = {
        source: 'heuristic',
        confidence: Math.min(
          1,
          ((recentStdDev / (this.thresholds.waveHighFreqThreshold * 3)) * 0.65)
            + ((Math.min(zeroCrossRate, this.thresholds.waveMinCount + 2) / (this.thresholds.waveMinCount + 2)) * 0.35)
        ),
        modelBestGesture: model?.best?.gesture || null,
        modelBestSimilarity: model?.best?.similarity ?? null,
        modelRunnerUpSimilarity: model?.runnerUp?.similarity ?? null,
        modelSimilarityGap: model?.similarityGap ?? null
      };
      this.alertActive = false;
    }
    // 3. 空房間：標準差極小
    else if (source !== 'trained-model' && stdDev < this.thresholds.emptyStdDev) {
      status = 'empty';
      confidence = Math.min(1, (this.thresholds.emptyStdDev - stdDev) / this.thresholds.emptyStdDev);
      this.alertActive = false;
    }
    // 4. 有人活動（預設）
    else if (source !== 'trained-model') {
      status = 'occupied';
      confidence = 0.5;
      this.alertActive = false;
    }

    if (!waveEventCandidate && recentStdDev < WAVE_REARM_STDDEV && !esp32MotionDetected) {
      this.waveArmed = true;
    }

    if (waveEventCandidate && this.waveArmed) {
      this.waveArmed = false;
      this.waveEventUntil = now + WAVE_EVENT_HOLD_MS;
      this.waveEventState = waveEventCandidate;
    }

    if (status !== 'fall' && now < this.waveEventUntil && this.waveEventState) {
      status = 'wave';
      confidence = this.waveEventState.confidence;
      source = this.waveEventState.source;
      this.alertActive = false;
      model = {
        best: {
          gesture: this.waveEventState.modelBestGesture,
          similarity: this.waveEventState.modelBestSimilarity
        },
        runnerUp: {
          similarity: this.waveEventState.modelRunnerUpSimilarity
        },
        similarityGap: this.waveEventState.modelSimilarityGap
      };
    }

    this.prevStatus = status;

    const result = {
      status,
      confidence: Math.round(confidence * 100) / 100,
      stdDev: Math.round(stdDev * 100) / 100,
      recentStdDev: Math.round(recentStdDev * 100) / 100,
      zeroCrossRate,
      displacement: Math.round(displacement * 100) / 100,
      tailStdDev: Math.round(tailStdDev * 100) / 100,
      alertActive: this.alertActive,
      source,
      modelBestGesture: model?.best?.gesture || null,
      modelBestSimilarity: model?.best?.similarity ?? null,
      modelRunnerUpSimilarity: model?.runnerUp?.similarity ?? null,
      modelSimilarityGap: model?.similarityGap ?? null,
      trainingCounts: {
        wave: gestureClassifier.templates.wave.length,
        squat: gestureClassifier.templates.squat.length
      },
      timestamp: Date.now(),
      dataPoints: this.dataWindow.length
    };

    // 記錄狀態歷史
    this.statusHistory.push({ status, timestamp: Date.now() });
    if (this.statusHistory.length > 500) this.statusHistory.shift();

    return result;
  }

  // 取得閾值
  getThresholds() {
    return { ...this.thresholds };
  }

  // 更新閾值
  updateThresholds(newThresholds) {
    Object.keys(newThresholds).forEach(key => {
      if (key in this.thresholds) {
        this.thresholds[key] = Number(newThresholds[key]);
      }
    });
  }

  // 重置
  reset() {
    this.dataWindow = [];
    this.prevStatus = 'empty';
    this.alertActive = false;
    this.waveEventUntil = 0;
    this.waveEventState = null;
    this.waveArmed = true;
    gestureClassifier.reset();
  }
}

const analyzer = new CSIAnalyzer();

// ==================== MQTT 連線 ====================
let mqttClient = null;
let mqttConnected = false;
const MQTT_MAX_RETRIES = 3;
let mqttRetryCount = 0;

function connectMQTT() {
  try {
    mqttClient = mqtt.connect(MQTT_BROKER, {
      reconnectPeriod: 0, // 停用自動重連，手動控制
      connectTimeout: 5000,
    });

    mqttClient.on('connect', () => {
      console.log(`[MQTT] 已連線至 ${MQTT_BROKER}`);
      mqttConnected = true;
      mqttRetryCount = 0;
      mqttClient.subscribe(MQTT_TOPIC, (err) => {
        if (!err) {
          console.log(`[MQTT] 已訂閱主題: ${MQTT_TOPIC}`);
        }
      });
    });

    mqttClient.on('message', (topic, message) => {
      try {
        const payload = message.toString();
        let csiValues;

        // 嘗試 JSON 解析
        try {
          const json = JSON.parse(payload);
          csiValues = json.csi || json.data || json.values || json;
        } catch {
          // 嘗試逗號分隔數值
          csiValues = payload.split(',').map(Number).filter(n => !isNaN(n));
        }

        if (Array.isArray(csiValues) && csiValues.length > 0) {
          // 取振幅（若為複數則取模）
          const amplitudes = csiValues.map(v => Math.abs(v));
          const avgAmplitude = amplitudes.reduce((a, b) => a + b, 0) / amplitudes.length;
          processCSIData(avgAmplitude);
        } else if (typeof csiValues === 'number') {
          processCSIData(csiValues);
        }
      } catch (error) {
        console.error('[MQTT] 解析訊息失敗:', error.message);
      }
    });

    mqttClient.on('error', (err) => {
      mqttConnected = false;
      mqttRetryCount++;
      if (mqttRetryCount <= MQTT_MAX_RETRIES) {
        console.log(`[MQTT] 連線失敗 (${mqttRetryCount}/${MQTT_MAX_RETRIES})，稍後重試...`);
      }
      if (mqttRetryCount >= MQTT_MAX_RETRIES) {
        console.log('[MQTT] 已達最大重試次數，停止 MQTT 連線。可透過 WebSocket 或 HTTP 傳送數據。');
        mqttClient.end(true);
      }
    });

    mqttClient.on('close', () => {
      mqttConnected = false;
      // 手動重連（限次數）
      if (mqttRetryCount < MQTT_MAX_RETRIES) {
        setTimeout(() => {
          if (mqttRetryCount < MQTT_MAX_RETRIES) {
            mqttClient.reconnect();
          }
        }, 10000);
      }
    });
  } catch (error) {
    console.error('[MQTT] 初始化失敗:', error.message);
  }
}

// ==================== 數據處理 ====================
function processCSIData(value) {
  const result = analyzer.analyze(value);

  // 廣播給所有 WebSocket 客戶端
  const payload = JSON.stringify({
    type: 'csi_update',
    value: Math.round(value * 100) / 100,
    analysis: result,
    timestamp: Date.now()
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// ==================== WebSocket 處理 ====================
wss.on('connection', (ws) => {
  console.log('[WS] 新客戶端連線');

  // 發送當前狀態
  ws.send(JSON.stringify({
    type: 'init',
    thresholds: analyzer.getThresholds(),
    mqttConnected,
    esp32Connected,
    esp32Host: ESP32_HOST,
    esp32MotionDetected,
    esp32MovementScore,
    timestamp: Date.now()
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'csi_data':
          // 透過 WebSocket 直接接收 CSI 數據（不經 MQTT）
          if (typeof data.value === 'number') {
            processCSIData(data.value);
          } else if (Array.isArray(data.values)) {
            data.values.forEach(v => processCSIData(v));
          }
          break;

        case 'update_thresholds':
          analyzer.updateThresholds(data.thresholds);
          // 廣播新閾值
          broadcastAll({
            type: 'thresholds_updated',
            thresholds: analyzer.getThresholds()
          });
          break;

        case 'reset':
          analyzer.reset();
          broadcastAll({ type: 'reset', timestamp: Date.now() });
          break;

        case 'clear_alert':
          analyzer.alertActive = false;
          broadcastAll({ type: 'alert_cleared', timestamp: Date.now() });
          break;
      }
    } catch (error) {
      console.error('[WS] 處理訊息失敗:', error.message);
    }
  });

  ws.on('close', () => {
    console.log('[WS] 客戶端斷線');
  });
});

function broadcastAll(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function broadcastESP32Data(timestamp = Date.now()) {
  if (esp32MovementScore == null) return;
  broadcastAll({
    type: 'esp32_data',
    movementScore: esp32MovementScore,
    motionDetected: esp32MotionDetected,
    timestamp
  });
}

// ==================== REST API ====================

// CSI 監控頁面（別名）
app.get('/csi', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'csi-monitor.html'));
});

// 接收 CSI 數據（HTTP POST，適用於 ESP32 HTTP 方式傳送）
app.post('/api/csi', (req, res) => {
  const { value, values, csi } = req.body;

  if (typeof value === 'number') {
    processCSIData(value);
    res.json({ success: true });
  } else if (Array.isArray(values || csi)) {
    const arr = values || csi;
    arr.forEach(v => processCSIData(Number(v)));
    res.json({ success: true, count: arr.length });
  } else {
    res.status(400).json({ error: '無效的數據格式。需要 { value: number } 或 { values: number[] }' });
  }
});

// 取得目前狀態
app.get('/api/csi/status', (req, res) => {
  const result = analyzer.analyze([]);
  res.json({
    ...result,
    mqttConnected,
    thresholds: analyzer.getThresholds()
  });
});

// 取得/更新閾值
app.get('/api/csi/thresholds', (req, res) => {
  res.json(analyzer.getThresholds());
});

app.post('/api/csi/thresholds', (req, res) => {
  analyzer.updateThresholds(req.body);
  broadcastAll({
    type: 'thresholds_updated',
    thresholds: analyzer.getThresholds()
  });
  res.json({ success: true, thresholds: analyzer.getThresholds() });
});

// 取得狀態歷史
app.get('/api/csi/history', (req, res) => {
  res.json(analyzer.statusHistory.slice(-200));
});

// 重置分析器
app.post('/api/csi/reset', (req, res) => {
  analyzer.reset();
  broadcastAll({ type: 'reset', timestamp: Date.now() });
  res.json({ success: true });
});

// ==================== ESP32 SSE 即時數據橋接 ====================
let esp32Connected = false;
let esp32MotionDetected = false;
let esp32MovementScore = null;
let esp32LastUpdate = null;
let esp32ReconnectTimer = null;
let esp32HeartbeatTimer = null;
let esp32EventTotal = 0;

// 自動開啟 ESP32 動作偵測（ESPHome web_server v3 使用中文名稱路徑）
function enableMotionDetection() {
  const http = require('http');
  const switchPath = '/switch/' + encodeURIComponent('啟用動作偵測') + '/turn_on';
  const req = http.request({
    hostname: ESP32_HOST, port: 80, method: 'POST',
    path: switchPath,
    timeout: 5000
  }, (res) => {
    if (res.statusCode === 200) console.log('[ESP32] ✅ 動作偵測已自動開啟');
    else console.log(`[ESP32] 開啟動作偵測回應: ${res.statusCode}`);
    res.resume();
  });
  req.on('error', (e) => console.log(`[ESP32] 開啟動作偵測失敗: ${e.message}`));
  req.end();
}

function connectESP32SSE() {
  const net = require('net');
  const host = ESP32_HOST;
  const port = 80;
  console.log(`[ESP32] 正在連線至 ${host}:${port}/events (raw TCP)...`);

  const socket = net.createConnection({ host, port, timeout: 10000 }, () => {
    // SSE 長連線不設 idle timeout（ESPHome 值不變時不推事件是正常的）
    // 靠輪詢 /sensor/movement_score 保證數據持續流入
    socket.setTimeout(0);
    socket.write(`GET /events HTTP/1.1\r\nHost: ${host}\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n`);
  });

  let rawBuffer = Buffer.alloc(0);  // 用 Buffer 避免 UTF-8 被截斷
  let headersParsed = false;
  let sseBuffer = '';
  let eventCount = 0;

  // 不用 setEncoding，手動處理 Buffer → String 轉換

  socket.on('data', (chunk) => {
    rawBuffer = Buffer.concat([rawBuffer, chunk]);

    // 先跳過 HTTP 回應標頭
    if (!headersParsed) {
      const headerEndStr = '\r\n\r\n';
      const headerEnd = rawBuffer.indexOf(headerEndStr);
      if (headerEnd === -1) return;
      const headers = rawBuffer.subarray(0, headerEnd).toString('utf8');
      if (!headers.includes('200')) {
        const statusLine = headers.split('\r\n')[0];
        console.log(`[ESP32] HTTP 回應非 200: ${statusLine}`);

        // Newer ESPHome web_server builds may not expose /events. Fall back to
        // polling the JSON sensor endpoint so the monitor still works.
        if (statusLine.includes('404')) {
          console.log(`[ESP32] 改用輪詢模式連線 ${host}/sensor/movement_score`);
          esp32Connected = true;
          esp32EventTotal = 0;
          broadcastAll({ type: 'esp32_status', connected: true, host, mode: 'polling' });
          enableMotionDetection();
          startKeepaliveBroadcast();
          startESP32Polling();
          socket.destroy();
          return;
        }

        socket.destroy();
        scheduleReconnect();
        return;
      }
      rawBuffer = rawBuffer.subarray(headerEnd + 4);
      headersParsed = true;
      console.log(`[ESP32] ✅ SSE 已連線至 ${host}`);
      esp32Connected = true;
      esp32EventTotal = 0;
      broadcastAll({ type: 'esp32_status', connected: true, host });

      // 連線成功後自動開啟動作偵測
      enableMotionDetection();

      // 啟動 keepalive 廣播（每 2 秒推送最新值給前端，確保圖表不卡）
      startKeepaliveBroadcast();

      // 啟動輪詢補充（每 5 秒更新 esp32MovementScore 真實值）
      startESP32Polling();

      // 啟動心跳計時器 - 每 30 秒報告數據流狀態
      if (esp32HeartbeatTimer) clearInterval(esp32HeartbeatTimer);
      esp32HeartbeatTimer = setInterval(() => {
        if (esp32Connected) {
          const age = esp32LastUpdate ? Math.round((Date.now() - esp32LastUpdate) / 1000) : '?';
          console.log(`[ESP32] 💓 心跳: 已收 ${esp32EventTotal} 筆 movement 數據, 最後更新 ${age}s 前`);
        }
      }, 30000);
    }

    // 解碼 chunked transfer encoding → 提取純 SSE payload
    const decoded = dechunkBuffer(rawBuffer);
    rawBuffer = decoded.remainder;
    if (!decoded.payload.length) return;

    sseBuffer += decoded.payload.toString('utf8');

    // 解析 SSE 事件（以空行分隔，統一換行符）
    sseBuffer = sseBuffer.replace(/\r\n/g, '\n');
    const events = sseBuffer.split('\n\n');
    sseBuffer = events.pop(); // 保留未完成的部分

    events.forEach(eventBlock => {
      const cleaned = eventBlock.trim();
      if (!cleaned) return;

      let eventType = '';
      let eventData = '';

      cleaned.split('\n').forEach(line => {
        if (line.startsWith('event: ')) eventType = line.slice(7).trim();
        else if (line.startsWith('data: ')) eventData += line.slice(6);
        else if (line.startsWith('data:')) eventData += line.slice(5);
      });

      if (eventType === 'state' && eventData) {
        try {
          const parsed = JSON.parse(eventData);
          eventCount++;
          if (eventCount <= 15) console.log(`[ESP32] 事件: ${parsed.id} = ${parsed.value !== undefined ? parsed.value : parsed.state}`);
          else if (eventCount === 16) console.log('[ESP32] (後續事件省略 log...)');
          handleESP32State(parsed);
        } catch (e) {
          // JSON 不完整，忽略
        }
      }
    });

    // 防止 buffer 過大
    if (sseBuffer.length > 50000) sseBuffer = sseBuffer.slice(-5000);
    if (rawBuffer.length > 100000) rawBuffer = rawBuffer.subarray(-10000);
  });

  socket.on('end', () => {
    console.log('[ESP32] SSE 連線結束');
    esp32Connected = false;
    stopESP32Polling();
    stopKeepaliveBroadcast();
    if (esp32HeartbeatTimer) { clearInterval(esp32HeartbeatTimer); esp32HeartbeatTimer = null; }
    broadcastAll({ type: 'esp32_status', connected: false });
    scheduleReconnect();
  });

  socket.on('error', (err) => {
    console.error(`[ESP32] 連線錯誤: ${err.message}`);
    esp32Connected = false;
    stopESP32Polling();
    stopKeepaliveBroadcast();
    if (esp32HeartbeatTimer) { clearInterval(esp32HeartbeatTimer); esp32HeartbeatTimer = null; }
    broadcastAll({ type: 'esp32_status', connected: false });
    scheduleReconnect();
  });

  socket.on('timeout', () => {
    // 只在初始連線階段觸發（連線成功後 setTimeout(0) 已停用）
    console.log('[ESP32] 連線逾時');
    socket.destroy();
    esp32Connected = false;
    stopESP32Polling();
    stopKeepaliveBroadcast();
    if (esp32HeartbeatTimer) { clearInterval(esp32HeartbeatTimer); esp32HeartbeatTimer = null; }
    scheduleReconnect();
  });
}

// 正確解碼 HTTP chunked transfer encoding
function dechunkBuffer(buf) {
  const payloadParts = [];
  let pos = 0;

  while (pos < buf.length) {
    // 找 chunk size 行的結尾 \r\n
    const lineEnd = buf.indexOf('\r\n', pos);
    if (lineEnd === -1) break; // 不完整，等更多數據

    const sizeLine = buf.subarray(pos, lineEnd).toString('ascii').trim();
    const chunkSize = parseInt(sizeLine, 16);

    if (isNaN(chunkSize)) break; // 解析失敗，等更多數據

    if (chunkSize === 0) {
      // 結束 chunk
      pos = lineEnd + 2;
      break;
    }

    const dataStart = lineEnd + 2;
    const dataEnd = dataStart + chunkSize;
    const chunkEnd = dataEnd + 2; // 跳過結尾的 \r\n

    if (chunkEnd > buf.length) break; // 不完整，等更多數據

    payloadParts.push(buf.subarray(dataStart, dataEnd));
    pos = chunkEnd;
  }

  return {
    payload: Buffer.concat(payloadParts),
    remainder: buf.subarray(pos)
  };
}

function handleESP32State(state) {
  const id = state.id || '';

  // 動作偵測開關狀態監控
  if (id.includes('switch') && id.includes('motion')) {
    const isOn = state.value === true || state.value === 'true' || state.state === 'ON';
    if (!isOn) {
      console.log('[ESP32] ⚠️ 動作偵測已關閉！正在嘗試重新開啟...');
      enableMotionDetection();
    }
  }

  // Movement Score（移動方差）→ 更新最新值（keepalive 會定時廣播）
  if (id === 'sensor-movement_score') {
    const val = parseFloat(state.value);
    if (!isNaN(val) && val !== null) {
      esp32MovementScore = val;
      esp32EventTotal++;
      esp32LastUpdate = Date.now();
      processCSIData(val);
      broadcastESP32Data(esp32LastUpdate);
    }
  }

  // Motion Detected（二元動作偵測）
  if (id === 'binary_sensor-motion_detected') {
    esp32MotionDetected = state.value === true || state.value === 'true' || state.state === 'ON';
    broadcastAll({
      type: 'esp32_motion',
      motionDetected: esp32MotionDetected,
      timestamp: Date.now()
    });
  }
}

function scheduleReconnect() {
  if (esp32ReconnectTimer) return;
  console.log('[ESP32] 5 秒後重新連線...');
  esp32ReconnectTimer = setTimeout(() => {
    esp32ReconnectTimer = null;
    connectESP32SSE();
  }, 5000);
}

// ==================== 前端 keepalive 廣播（確保圖表永不卡住）====================
let keepaliveBroadcastTimer = null;

function startKeepaliveBroadcast() {
  if (keepaliveBroadcastTimer) return;
  console.log('[ESP32] 📊 啟動 keepalive 廣播（每 1 秒）');
  keepaliveBroadcastTimer = setInterval(() => {
    // 不管 ESP32 有沒有新數據，都把最新已知的值推給前端
    // 這樣圖表的 X 軸持續移動，不會視覺卡住
    if (esp32MovementScore != null) {
      broadcastESP32Data();
    }
  }, 1000);
}

function stopKeepaliveBroadcast() {
  if (keepaliveBroadcastTimer) {
    clearInterval(keepaliveBroadcastTimer);
    keepaliveBroadcastTimer = null;
  }
}

// ==================== ESP32 輪詢補充（解決 ESPHome 值不變時不推送的問題）====================
let esp32PollTimer = null;

function startESP32Polling() {
  if (esp32PollTimer) return;
  console.log(`[ESP32] 📊 啟動輪詢補充（每 ${ESP32_POLL_INTERVAL_MS / 1000} 秒）`);
  esp32PollTimer = setInterval(() => {
    if (!esp32Connected) return;
    const http = require('http');
    const req = http.get({
      hostname: ESP32_HOST, port: 80,
      path: '/sensor/movement_score',
      timeout: 3000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const val = parseFloat(data.value);
          if (!isNaN(val)) {
            esp32MovementScore = val;
            esp32EventTotal++;
            esp32LastUpdate = Date.now();
            processCSIData(val);
            broadcastESP32Data(esp32LastUpdate);
          }
        } catch (e) { /* 忽略解析錯誤 */ }
      });
    });
    req.on('error', () => {}); // 忽略錯誤
    req.end();
  }, ESP32_POLL_INTERVAL_MS);
}

function stopESP32Polling() {
  if (esp32PollTimer) {
    clearInterval(esp32PollTimer);
    esp32PollTimer = null;
  }
}

// ==================== 啟動伺服器 ====================
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   Wi-Care CSI 長照監測系統 v1.1                 ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Web 介面:  http://localhost:${PORT}                   ║`);
  console.log(`║  WebSocket: ws://localhost:${PORT}                  ║`);
  console.log(`║  CSI API:   http://localhost:${PORT}/api/csi         ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  資料來源:                                       ║');
  console.log(`║  ✅ ESP32-S3 SSE (${ESP32_HOST})              ║`);
  console.log('║  ✅ WebSocket 即時傳送                           ║');
  console.log('║  ✅ HTTP POST /api/csi                           ║');
  console.log(`║  ${ENABLE_MQTT && mqtt ? '✅' : '⬜'} MQTT (設定 ENABLE_MQTT=true 啟用)         ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  狀態判斷:                                       ║');
  console.log('║  🟢 空房間 - 標準差極小                          ║');
  console.log('║  🟡 揮手   - 高頻波動                            ║');
  console.log('║  🔴 蹲下/跌倒 - 大幅位移後靜止                  ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // 連線 ESP32 SSE
  connectESP32SSE();

  // 僅在明確啟用時才連線 MQTT
  if (ENABLE_MQTT && mqtt) {
    connectMQTT();
  } else {
    console.log('[INFO] MQTT 未啟用。使用 ESP32 SSE 或 WebSocket 傳送 CSI 數據。');
  }
});
