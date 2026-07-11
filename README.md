# Wi-Care 智能病房監測系統

基於 **WiFi CSI（信道狀態資訊）** 技術的被動式運動偵測系統，整合 ESP32-S3 韌體、Node.js 後端與 Web 看護面板，並支援 Home Assistant 整合。

---

## 功能特色

- **被動運動偵測**：利用 WiFi CSI 訊號分析人體動作，無需額外感測器
- **病房監控面板**：即時顯示多樓層病房（1F 12 間、2F 6 間）的狀態
- **GPIO 裝置控制**：透過 REST API 控制病房門禁與照明開關
- **手勢辨識實驗室**：錄製訓練樣本並使用 DTW 演算法識別揮手、蹲下、拍手等動作
- **Home Assistant 整合**：透過 ESPHome API 與智慧家居生態系統無縫整合
- **即時資料推送**：WebSocket / SSE 即時傳送感測器數值與事件

---

## 系統架構

```
┌──────────────────────────────────────┐
│         硬體層 (ESP32-S3)            │
│  ESPHome 2024.11.0 + ESP-IDF        │
│  ‧ WiFi CSI 訊號處理 (C++)          │
│  ‧ MVS 運動偵測演算法               │
│  ‧ GPIO 輸出控制                    │
└──────────────┬───────────────────────┘
               │ REST API / EventSource / ESPHome API
               ▼
┌──────────────────────────────────────┐
│         後端層 (Node.js)             │
│  ‧ server.js   — 主伺服器 :3000     │
│  ‧ csi-server.js — CSI 分析 :3001  │
│  ‧ gesture-lab/app.js — 訓練 :3010 │
└──────────────┬───────────────────────┘
               │ WebSocket / HTTP
               ▼
┌──────────────────────────────────────┐
│         前端層 (Web UI)              │
│  ‧ 病房監控儀表板                   │
│  ‧ 即時日誌與系統資訊               │
│  ‧ 手勢訓練介面                     │
└──────────────────────────────────────┘
```

---

## 技術棧

| 層級 | 技術 |
|------|------|
| 微控制器 | ESP32-S3-DevKitC-1（Xtensa 240 MHz，8MB PSRAM） |
| 韌體框架 | ESPHome 2024.11.0 + ESP-IDF（C++ 自訂組件） |
| 後端 | Node.js + Express.js + WebSocket / Socket.IO |
| 前端 | 原生 HTML / JavaScript |
| 手勢識別 | DTW（動態時間規整） |
| 運動偵測 | MVS（移動變異數分割）+ Hampel Filter + Low-pass IIR |
| 通訊協定 | WiFi CSI、WebSocket、REST API、SSE、MQTT（可選）、mDNS |
| 智慧家居 | Home Assistant（ESPHome 整合） |
| 輔助工具 | Python（mDNS 代理伺服器） |

---

## 專案結構

```
wigay-main/
├── espectre-s3.yaml          # ESP32-S3 ESPHome 韌體配置
├── secrets.yaml              # WiFi 密碼與 API 金鑰（請勿提交）
├── proxy_server.py           # Python mDNS 代理（解決 Windows 相容問題）
├── FIX_MDNS.md               # mDNS 存取疑難排解指南
├── components/
│   └── espectre/             # ESP32 C++ 自訂組件
│       ├── espectre.h/cpp        # 主組件入口
│       ├── csi_manager.h/cpp     # CSI 硬體配置與初始化
│       ├── csi_processor.h/cpp   # MVS 運動偵測核心演算法
│       ├── calibration_manager.h/cpp  # 自適應校準系統
│       ├── gain_controller.h/cpp      # AGC / FFT 增益控制
│       ├── sensor_publisher.h/cpp     # HA 感測器資料發布
│       ├── config_manager.h/cpp       # NVS 配置持久化
│       ├── wifi_lifecycle.h/cpp       # WiFi 連線生命週期
│       ├── traffic_generator_manager.h/cpp  # CSI 流量生成
│       └── threshold_number.h/cpp     # 動作閾值動態調整
└── wi-care-web/
    ├── server.js             # 主伺服器（:3000）
    ├── server-v2.js          # 主伺服器 v2（:3001）
    ├── csi-server.js         # CSI 動作分析伺服器
    ├── package.json
    ├── data/
    │   └── entities.json     # 病房 GPIO 開關設定（18 間病房）
    ├── gesture-lab/
    │   ├── app.js            # 手勢訓練伺服器（:3010）
    │   ├── train_lstm.py     # LSTM 模型訓練腳本
    │   └── data/             # 手勢訓練樣本（wave / squat / clap）
    └── public/
        ├── app.js            # 前端主程式
        └── index.html        # 病房監控儀表板
```

---

## 硬體需求

- **ESP32-S3-DevKitC-1**
  - 雙核 Xtensa LX7 @ 240 MHz
  - 512KB SRAM + 8MB Octal PSRAM
  - 802.11 b/g/n WiFi（支援 CSI 存取）
  - 46 個 GPIO

> WiFi CSI 技術可透過分析 WiFi 訊號的振幅與相位變化來偵測人體動作，偵測範圍約 10 公尺，可穿透牆壁，無需任何額外感測器。

---

## 快速開始

### 環境需求

- [ESPHome](https://esphome.io/) 2024.11.0+
- Node.js 14+
- Python 3.8+（僅 Windows 需要代理伺服器）

### 1. 韌體燒錄

編輯 `secrets.yaml` 填入 WiFi 憑證，再執行：

```bash
esphome run espectre-s3.yaml
```

### 2. 啟動 Web 伺服器

```bash
cd wi-care-web
npm install

npm run web:start     # 主伺服器 :3000
npm run csi           # CSI 動作分析 :3001
npm run gesture-lab   # 手勢訓練實驗室 :3010
```

### 3. Windows mDNS 代理（可選）

若無法透過 `espectre.local` 存取裝置，請執行代理伺服器：

```bash
pip install requests
python proxy_server.py
```

詳細說明請參閱 [FIX_MDNS.md](FIX_MDNS.md)。

---

## 主要 API

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/status` | 系統狀態 |
| GET | `/api/sensors` | 感測器數值 |
| GET | `/api/gpio` | GPIO 狀態 |
| POST | `/api/control` | 控制 GPIO / PWM |
| WS | `/` | 即時事件推送 |
| SSE | `/events` | CSI 資料串流 |

---

## 病房配置

| 樓層 | 病房 | GPIO |
|------|------|------|
| 1F（南側）| 101A – 109A | 2, 4, 5, 12–17 |
| 1F（北側）| 110A – 112A | 32–34 |
| 2F（東側）| 201B – 206B | 18, 19, 21–23, 25 |

---

## 授權

本專案僅供研究與學術用途。
