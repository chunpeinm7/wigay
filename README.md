# WIGAY - Wi-Care 智能感測與家居自動化整合專案

本專案整合了 ESPectre WiFi CSI 運動感測系統與 Wi-Care 智能家居自動化平台。

## 📁 專案結構

```
wigay-main/
├── espectre-s3.yaml              # ESPHome 主設定檔
├── secrets.yaml                  # ESPHome 密鑰設定（不入版控）
├── home-assistant-dashboard.yaml # Home Assistant 儀表板設定
├── proxy_server.py               # ESP32 代理伺服器（避免 CORS）
├── espectre-monitor-esphome.html # ESPectre 監控頁面
├── package.json                  # 根目錄便捷腳本
│
├── components/espectre/          # ESPHome 自訂元件
│   ├── __init__.py
│   ├── espectre.cpp / .h         # 主要元件
│   ├── csi_processor.cpp / .h    # CSI 信號處理
│   ├── csi_manager.cpp / .h      # CSI 管理器
│   ├── calibration_manager.cpp / .h  # 校準管理
│   ├── config_manager.cpp / .h   # 設定管理
│   ├── gain_controller.cpp / .h  # 增益控制
│   ├── sensor_publisher.cpp / .h # 感測器發佈
│   ├── wifi_lifecycle.cpp / .h   # WiFi 生命週期
│   └── ...
│
├── espectre/                     # ESPectre 完整原始碼庫
│   ├── components/espectre/      # 元件原始碼
│   ├── examples/                 # 各型號 ESP32 設定範例
│   ├── micro-espectre/           # MicroPython 研發平台
│   ├── test/                     # 測試套件
│   └── docs/                     # 文件網站
│
└── wi-care-web/                  # Wi-Care 智能家居 Web 平台
    ├── server.js                 # v1 伺服器（基礎 GPIO 控制）
    ├── server-v2.js              # v2 伺服器（完整家居自動化）
    ├── package.json              # Node.js 依賴
    ├── .env.example              # 環境變數範例
    ├── public/                   # 前端靜態檔案
    │   ├── index.html            # v2 主頁面
    │   ├── index-v1.html         # v1 頁面
    │   ├── index-v2.html         # v2 備用頁面
    │   └── app.js                # 前端 JavaScript
    └── data/                     # 資料存儲
        ├── entities.json         # 實體資料
        ├── automations.json      # 自動化規則
        ├── scenes.json           # 場景設定
        └── history.json          # 歷史記錄
```

## 🚀 快速開始

### 1. Wi-Care Web 平台

```bash
# 安裝依賴
npm run web:install

# 啟動 v2 伺服器（推薦）
npm run web:start

# 或啟動開發模式（自動重載）
npm run web:dev
```

啟動後開啟瀏覽器訪問 `http://localhost:3000`

- 預設帳號：`admin`
- 預設密碼：`admin123`

### 2. ESPectre 感測器

```bash
# 編譯並上傳 ESPHome 韌體
esphome compile espectre-s3.yaml
esphome upload espectre-s3.yaml

# 啟動代理伺服器（連接 ESP32）
npm run proxy
# 或直接執行
python proxy_server.py
```

### 3. Home Assistant 整合

詳見 [HOME_ASSISTANT_INTEGRATION.md](HOME_ASSISTANT_INTEGRATION.md)

## 📖 相關文件

- [HOME_ASSISTANT_INTEGRATION.md](HOME_ASSISTANT_INTEGRATION.md) - Home Assistant 整合指南
- [NEXT_STEPS.md](NEXT_STEPS.md) - 進階功能實施計劃
- [espectre/README.md](espectre/README.md) - ESPectre 詳細說明
- [espectre/SETUP.md](espectre/SETUP.md) - ESPectre 設定指南
- [espectre/TUNING.md](espectre/TUNING.md) - 感測器調校指南
