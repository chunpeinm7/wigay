# Wi-Care 手勢辨識系統

基於 **WiFi CSI（信道狀態資訊）** 技術的被動式手勢/動作辨識系統，整合 ESP32-S3 韌體（[ESPectre](https://github.com/francescopace/espectre)）與 Node.js + LSTM 手勢辨識後端。

> 病房監控 / GPIO 控制等舊有子系統目前未使用，已整批壓縮保存於 [archive/](archive)，需要時可解壓復原。

---

## 功能特色

- **被動運動偵測**：利用 WiFi CSI 訊號分析人體動作，無需額外感測器（ESPectre 韌體內建 MVS 演算法）
- **手勢資料錄製**：[gesture-lab.html](gesture-lab/public/gesture-lab.html) 網頁介面連線 ESP32-S3，錄製 empty_room / squat / wave / clap 等訓練樣本
- **LSTM 動作辨識**：以錄製樣本訓練 LSTM 模型，即時推論並回報目前動作（[live_test.py](gesture-lab/live_test.py)）

---

## 系統架構

```
┌──────────────────────────────────────┐
│         硬體層 (ESP32-S3)            │
│  ESPHome 2026.5.0+ + ESP-IDF        │
│  ‧ WiFi CSI 訊號處理 (C++)          │
│  ‧ MVS 運動偵測演算法               │
└──────────────┬───────────────────────┘
               │ REST API / EventSource / ESPHome API
               ▼
┌──────────────────────────────────────┐
│      後端層 (Node.js, gesture-lab)   │
│  ‧ app.js — 連線 ESP32、錄製資料 :3010│
└──────────────┬───────────────────────┘
               │ 錄製樣本 (JSON)
               ▼
┌──────────────────────────────────────┐
│         訓練 / 推論層 (Python)       │
│  ‧ train_lstm.py — 訓練 LSTM 模型    │
│  ‧ live_test.py  — 即時推論、回報動作 │
└──────────────────────────────────────┘
```

---

## 技術棧

| 層級 | 技術 |
|------|------|
| 微控制器 | ESP32-S3-DevKitC-1（Xtensa 240 MHz，8MB PSRAM） |
| 韌體框架 | ESPHome 2026.5.0+ + ESP-IDF（[ESPectre](https://github.com/francescopace/espectre) v2.8.0 自訂組件） |
| 後端 | Node.js + Express.js + Socket.IO |
| 手勢識別 | LSTM（PyTorch） |
| 運動偵測 | MVS（移動變異數分割）+ Hampel Filter + NBVI 自適應校準（韌體端） |
| 通訊協定 | WiFi CSI、REST API、SSE、mDNS |

---

## 專案結構

```
wigay-main/
├── espectre-s3.yaml          # ESP32-S3 ESPHome 韌體配置
├── secrets.yaml              # WiFi 密碼與 API 金鑰（請勿提交）
├── FIX_MDNS.md               # mDNS 存取疑難排解指南
├── components/
│   └── espectre/             # ESP32 C++ 自訂組件（上游 v2.8.0，2026-08 同步）
│       ├── espectre.h/cpp             # 主組件入口
│       ├── csi_manager.h/cpp          # CSI 硬體配置與初始化
│       ├── base_detector.h/cpp        # 偵測器共用基底類別
│       ├── mvs_detector.h/cpp         # MVS（移動變異數分割）偵測演算法
│       ├── ml_detector.h/cpp          # 元件內建 ML 偵測演算法（可選，非本專案的 LSTM）
│       ├── ml_features.h / ml_weights.h  # 內建 ML 模型特徵與權重
│       ├── threshold.h / filters.h    # 閾值與濾波共用定義
│       ├── csi_filters.cpp            # Hampel / 低通濾波實作
│       ├── nbvi_calibrator.h/cpp      # NBVI 自適應子載波校準
│       ├── calibration_file_buffer.h/cpp  # 校準資料檔案緩衝（取代舊版 calibration_manager）
│       ├── calibrate_switch.h/cpp     # HA 端手動觸發校準開關
│       ├── gain_controller.h/cpp      # AGC / FFT 增益控制
│       ├── sensor_publisher.h/cpp     # HA 感測器資料發布
│       ├── wifi_lifecycle.h/cpp       # WiFi 連線生命週期
│       ├── traffic_generator_manager.h/cpp  # CSI 流量生成（新版預設 ping，取代 DNS）
│       ├── udp_listener.h/cpp         # UDP 監聽（BLE/除錯用）
│       └── threshold_number.h/cpp     # 動作閾值動態調整
├── gesture-lab/               # 手勢辨識後端（自成一個 Node 專案，獨立 package.json）
│   ├── app.js                 # 抓取數據伺服器，連線 ESP32-S3（:3010）
│   ├── ecosystem.config.js    # PM2 啟動設定
│   ├── train_lstm.py          # LSTM 模型訓練腳本
│   ├── live_test.py           # 即時推論、回報目前動作
│   ├── fix_keys.py            # 訓練資料欄位修正腳本
│   ├── lstm_model.pth / scaler.pkl  # 訓練好的 LSTM 模型
│   ├── data/                  # 手勢訓練樣本（empty_room / squat / wave / clap）
│   └── public/
│       └── gesture-lab.html   # 抓取數據網頁
└── archive/                   # 目前未使用的舊子系統（壓縮保存，需要時解壓即可）
    └── wigay-unused-20260801.zip  # 病房監控系統、proxy_server.py 等
```

---

## 硬體需求

- **ESP32-S3-DevKitC-1**
  - 雙核 Xtensa LX7 @ 240 MHz
  - 512KB SRAM + 8MB Octal PSRAM
  - 802.11 b/g/n WiFi（支援 CSI 存取）

> WiFi CSI 技術可透過分析 WiFi 訊號的振幅與相位變化來偵測人體動作，偵測範圍約 10 公尺，可穿透牆壁，無需任何額外感測器。

---

## 快速開始

### 環境需求

- [ESPHome](https://esphome.io/) 2026.5.0+
- Node.js 14+
- Python 3.8+（訓練/推論 LSTM 模型需要 torch、numpy 等套件）

### 1. 韌體燒錄

編輯 `secrets.yaml` 填入 WiFi 憑證，再執行：

```bash
esphome run espectre-s3.yaml
```

### 2. 啟動手勢辨識後端

```bash
cd gesture-lab
npm install
npm start              # 抓取數據伺服器 :3010，開啟 gesture-lab.html 錄製樣本
```

### 3. 訓練 / 即時推論

```bash
cd gesture-lab
python train_lstm.py           # 用 data/ 內樣本訓練 LSTM 模型
python live_test.py            # 即時連線 ESP32 並回報目前動作
```

若無法透過 mDNS（`espectre.local`）存取裝置，請參閱 [FIX_MDNS.md](FIX_MDNS.md)（內含備用的 mDNS 代理方案，代理腳本已收錄於 [archive/](archive)）。

---

## 授權

本專案僅供研究與學術用途。
