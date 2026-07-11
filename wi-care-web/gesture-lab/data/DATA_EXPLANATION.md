# 手勢數據解析說明

## 數據來源

這些數字來自 **ESP32-S3 開發板上的 WiFi CSI（Channel State Information）技術**。

ESP32-S3 會持續發射 WiFi 探測封包（Probe Packets），當人體在空間中移動時，身體會反射／吸收無線電波，導致訊號的振幅和相位發生細微變化。ESP32 的 CSI 模組可以偵測到這些變化，再透過韌體（ESPectre 元件）計算出一個「運動強度分數」。

系統中有**兩個 ESP32 裝置**同時偵測，分別對應 `Raw Score` 與 `Smoothed Score` 兩組測量值。

---

## 欄位說明

| 欄位 | 說明 |
|---|---|
| **Raw Score** | 原始運動分數，直接從 CSI 訊號的 Moving Variance（移動變異數）計算出來，未經平滑處理，對突發運動敏感，數值容易抖動 |
| **Smoothed Score** | 平滑後的運動分數，經過低通濾波器（1st-order Butterworth IIR）處理，消除雜訊，曲線更穩定 |

數值越高 = 偵測到越明顯的肢體運動。安靜時通常在 `0.05 ~ 0.2` 之間，明顯動作（如鼓掌）可達 `1.5` 以上。

---

## timestamp 是什麼

`timestamp` 是 **Unix 毫秒時間戳（ms）**，記錄這筆測量值被伺服器接收到的時間點（JavaScript `Date.now()` 格式）。

範例：
```
1779027479298  →  轉換後約為 2026年5月19日 某時刻
```

用途：
- 在時序圖上標記 X 軸（時間軸）
- 計算每段手勢的**持續時間**（用最後一筆的 timestamp 減去第一筆）
- 讓 DTW（Dynamic Time Warping）手勢比對演算法能對齊時間序列

---

## 偵測頻率

從 `espectre-s3.yaml`：
```yaml
traffic_generator_rate: 30   # 每秒發送 30 個 WiFi 探測封包
publish_interval: 0.1        # 每 0.1 秒（100ms）發布一次數據
```

從 `csi-server.js`：
```js
ESP32_POLL_INTERVAL_MS = 1000  // 舊版輪詢模式 1 秒一次
```

實際 clap.json 的 timestamp 差距大約 **200~400ms 一筆**，表示在現有設定下資料大概每 **100~300ms** 到達一次。

---

## IP 位址

| 元件 | 位址 |
|---|---|
| ESP32（CSI Server 使用） | `192.168.0.128` |
| ESP32（Gesture Lab 使用） | `espectre.local`（mDNS） |
| Gesture Lab 伺服器 | Port `3010` |
| CSI Server | Port `3001` |

---

## 數據功能與流程

這些 JSON 檔案各代表一種**錄製好的手勢模板**：

| 檔案 | 對應手勢 |
|---|---|
| `clap.json` | 鼓掌 |
| `wave.json` | 揮手 |
| `squat.json` | 深蹲 |
| `empty_room.json` | 空房間（背景基準值） |

每個 JSON 內有多段陣列，每段陣列代表**一次手勢錄製**的完整時序數據。

### 系統運作流程

```
ESP32-S3 發射 WiFi 探測封包
        ↓
人體運動改變訊號特性（CSI 變化）
        ↓
Moving Variance 計算 → Raw Score
        ↓
低通濾波器（Butterworth IIR）→ Smoothed Score
        ↓
每 100ms 發送一筆資料到伺服器
        ↓
與儲存的手勢模板用 DTW 演算法比對
        ↓
相似度 > 65% 且領先第二名 > 6% → 觸發手勢事件
        ↓
整合 Home Assistant 進行智慧家居控制
```
