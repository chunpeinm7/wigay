# ESPectre 進階功能實施計劃

## 🎯 目標功能
1. ✅ 基礎動作偵測（已完成）
2. 🔄 人數計數（進行中）
3. 🔄 活動識別（行走、摔倒、坐著、睡覺）
4. 🔄 本地化和跟蹤

---

## 📊 當前狀態分析

### ESPectre (生產環境) - 您目前使用的版本
- ✅ 適合：智能家居自動化
- ✅ 功能：基礎動作偵測 (IDLE/MOTION)
- ❌ 限制：無法做人數計數、活動識別、定位

### Micro-ESPectre (研發平台) - 需要切換到這個
- ✅ CSI 特徵提取（熵、變異數、偏度、峰度）
- ✅ 機器學習數據收集基礎設施
- ✅ 快速實驗（無需編譯）
- ✅ 支援您需要的所有進階功能

---

## 🚀 實施路線圖

### 階段 1：環境設置（1-2 天）

#### 步驟 1.1：安裝 Micro-ESPectre 環境

```bash
cd /Users/nitama/wi-care-project/espectre/micro-espectre

# 安裝 Python 依賴
pip install -r requirements.txt

# 驗證安裝
./me --help
```

#### 步驟 1.2：燒錄 MicroPython 固件

```bash
# 擦除 Flash 並燒錄 MicroPython（含 CSI 支援）
./me flash --erase --port /dev/cu.usbmodem5B140570401

# 驗證固件
./me verify
```

#### 步驟 1.3：配置 MQTT

編輯 `src/config.py`：
```python
# WiFi 設定
WIFI_SSID = "Nitama 的 iPhone"
WIFI_PASSWORD = "nitama960822"

# MQTT 設定（使用 Home Assistant 的 MQTT）
MQTT_BROKER = "192.168.1.xxx"  # 您的 Home Assistant IP
MQTT_PORT = 1883
MQTT_USER = "mqtt_user"
MQTT_PASSWORD = "mqtt_password"

# 啟用 CSI 特徵提取（關鍵！）
ENABLE_FEATURES = True  # 用於 ML 和進階分析
```

#### 步驟 1.4：部署程式碼

```bash
# 部署到 ESP32（~5 秒）
./me deploy

# 執行
./me run
```

---

### 階段 2：數據收集（2-4 週）

#### 2.1 人數計數數據

收集不同人數的 CSI 數據：

```bash
# 0 人（空房間）
./me collect --label "person_count_0" --duration 60

# 1 人
./me collect --label "person_count_1" --duration 60

# 2 人
./me collect --label "person_count_2" --duration 60

# 3 人以上
./me collect --label "person_count_3+" --duration 60
```

**每類建議收集：**
- 最少 500 個樣本
- 不同時間段
- 不同位置

#### 2.2 活動識別數據

```bash
# 行走
./me collect --label "activity_walking" --duration 120

# 坐著
./me collect --label "activity_sitting" --duration 120

# 躺下/睡覺
./me collect --label "activity_lying" --duration 120

# 摔倒（模擬）
./me collect --label "activity_fall" --duration 60
```

**數據品質要求：**
- 每個活動 1000+ 樣本
- 多個受試者
- 不同環境條件

#### 2.3 定位數據

```bash
# 使用串流模式收集位置數據
./me stream --ip 192.168.1.xxx
```

在電腦上執行分析腳本（需要在 `tools/` 目錄）：
- 記錄不同位置的 CSI 特徵
- 建立位置指紋資料庫

---

### 階段 3：模型訓練（1-2 個月）

#### 3.1 使用 Micro-ESPectre 的分析工具

查看收集的數據：

```bash
cd tools/
python analyze_csi_data.py --input ../data/person_count_0.csv
```

#### 3.2 訓練模型（範例）

**人數計數模型：**
```python
# 使用收集的數據訓練分類器
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split

# 載入數據
X, y = load_csi_features('data/')  # CSI 特徵
X_train, X_test, y_train, y_test = train_test_split(X, y)

# 訓練
model = RandomForestClassifier(n_estimators=100)
model.fit(X_train, y_train)

# 評估
accuracy = model.score(X_test, y_test)
print(f"人數計數準確率: {accuracy:.2%}")
```

**活動識別模型（LSTM）：**
```python
import tensorflow as tf

# 建立 LSTM 模型用於時間序列分類
model = tf.keras.Sequential([
    tf.keras.layers.LSTM(64, input_shape=(window_size, n_features)),
    tf.keras.layers.Dense(32, activation='relu'),
    tf.keras.layers.Dense(n_activities, activation='softmax')
])

model.compile(optimizer='adam', loss='categorical_crossentropy', metrics=['accuracy'])
model.fit(X_train, y_train, epochs=50, validation_split=0.2)
```

#### 3.3 模型優化

- **量化**：轉換為 TensorFlow Lite
- **壓縮**：減少模型大小以適應 ESP32
- **測試**：在真實環境中驗證

---

### 階段 4：部署（1-2 週）

#### 選項 A：邊緣推理（ESP32）

限制：
- 內存有限（320KB RAM）
- 僅適合小型模型
- 需要 TensorFlow Lite Micro

#### 選項 B：混合架構（推薦）

```
ESP32-S3 (Micro-ESPectre)
    ↓ MQTT (CSI 特徵)
MLOps Server (樹莓派/電腦)
    ↓ 推理結果
Home Assistant
    ↓ 自動化
智能家居設備
```

**優點：**
- ESP32 專注於 CSI 採集
- 伺服器執行複雜 ML 推理
- 可使用任何大小的模型
- 易於更新模型

---

## 🛠️ 實用工具

### Micro-ESPectre CLI 指令參考

```bash
# 基礎操作
./me flash --erase              # 燒錄固件
./me deploy                     # 部署程式碼
./me run                        # 執行應用

# 數據收集
./me collect --label walking    # 收集標註數據
./me stream --ip 192.168.1.100  # 即時串流 CSI

# 互動模式
./me                            # MQTT 控制面板
```

### MQTT 主題

訂閱這些主題來獲取數據：

```
espectre/motion              # 動作狀態 (0/1)
espectre/movement_score      # 動作分數 (0-100)
espectre/features/entropy    # 熵（混亂度）
espectre/features/variance   # 變異數
espectre/features/skewness   # 偏度
espectre/features/kurtosis   # 峰度
```

---

## 📚 參考資料

### Micro-ESPectre 文件
- [README](../espectre/micro-espectre/README.md) - 完整使用說明
- [ALGORITHMS](../espectre/micro-espectre/ALGORITHMS.md) - 演算法詳解
- [ML_DATA_COLLECTION](../espectre/micro-espectre/ML_DATA_COLLECTION.md) - ML 數據收集指南

### 專案文件
- [ROADMAP](../espectre/ROADMAP.md) - 專案發展路線圖
- [PERFORMANCE](../espectre/PERFORMANCE.md) - 效能指標

---

## ⚠️ 重要注意事項

### 現階段限制

根據 ROADMAP，進階功能目前處於：

| 功能 | 狀態 | 可行性 |
|------|------|--------|
| 人數計數 | Planned (Q3-Q4 2026) | ⚠️ 需要自行訓練模型 |
| 活動識別 | Planned (Q2-Q3 2026) | ⚠️ 需要大量標註數據 |
| 定位追蹤 | Exploratory (2027) | ⚠️ 研究階段 |

### 實際建議

**短期（1-2 個月）：**
1. 切換到 Micro-ESPectre
2. 開始收集數據
3. 實驗簡單的分類器（人數計數）

**中期（3-6 個月）：**
1. 建立完整的標註資料集
2. 訓練基礎 ML 模型
3. 部署混合架構

**長期（6-12 個月）：**
1. 優化模型準確率
2. 實現活動識別
3. 探索定位功能

---

## 🎯 下一步行動

### 立即執行（今天）

1. 前往 Micro-ESPectre 目錄
2. 安裝依賴
3. 查看完整文檔

```bash
cd /Users/nitama/wi-care-project/espectre/micro-espectre
cat README.md
```

### 本週目標

1. ✅ 燒錄 MicroPython 固件
2. ✅ 配置 MQTT 連接
3. ✅ 啟用 CSI 特徵提取
4. ✅ 開始收集第一批數據

### 本月目標

1. 收集 500+ 人數計數樣本
2. 訓練第一個分類器
3. 測試準確率

---

## 💡 需要協助？

- GitHub Issues: https://github.com/francescopace/espectre/issues
- Discussions: https://github.com/francescopace/espectre/discussions
- Email: francesco.pace@espectre.dev
