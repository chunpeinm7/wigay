# ESPectre - Home Assistant 整合指南

## 📋 概述

本指南將幫助您將 ESPectre 運動偵測設備整合到 Home Assistant 中。

## 🔧 設定步驟

### 1. 編譯並上傳韌體

```bash
# 編譯韌體
esphome compile espectre-s3.yaml

# 上傳到設備
esphome upload espectre-s3.yaml --device /dev/cu.usbmodem1101
```

### 2. 取得 API 加密金鑰

第一次編譯時，檢查日誌輸出，您會看到類似以下的訊息：

```
INFO Generated random API encryption key: xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

將此金鑰複製到 `secrets.yaml` 中的 `api_encryption_key` 欄位。

### 3. 在 Home Assistant 中添加設備

#### 方法一：自動發現（推薦）
1. 確保您的 ESP32 和 Home Assistant 在同一網路
2. 前往 Home Assistant → 設定 → 裝置與服務
3. 應該會自動發現 "ESPectre" 設備
4. 點擊"設定"並輸入加密金鑰（從 secrets.yaml）

#### 方法二：手動添加
1. 前往 Home Assistant → 設定 → 裝置與服務 → 新增整合
2. 搜尋並選擇 "ESPHome"
3. 輸入 ESPectre 的 IP 地址（可從設備日誌查看）
4. 輸入加密金鑰

### 4. 設定儀表板

1. 在 Home Assistant 中，前往 設定 → 儀表板 → 新增儀表板
2. 輸入名稱（例如："ESPectre 運動偵測"）
3. 打開新建立的儀表板
4. 點擊右上角的"編輯"按鈕（鉛筆圖示）
5. 點擊右上角三個點選單 → "原始配置編輯器"
6. 刪除預設內容
7. 開啟 `home-assistant-dashboard.yaml` 並複製全部內容
8. 貼到編輯器中
9. 點擊"儲存"

## 📊 可用的實體

整合完成後，您將獲得以下實體：

### 感測器
- **sensor.espectre_movement_score** - 運動程度分數（0-10）
- **sensor.espectre_wifi_signal_strength** - WiFi 信號強度（dBm）
- **sensor.espectre_uptime** - 設備運行時間
- **sensor.espectre_internal_temperature** - ESP32 內部溫度
- **sensor.espectre_ip_address** - 設備 IP 地址

### 二元感測器
- **binary_sensor.espectre_motion_detected** - 運動偵測狀態（開/關）

### 數字
- **number.espectre_threshold** - 運動偵測靈敏度閾值

### 開關
- **switch.espectre_motion_detection_enabled** - 啟用/停用運動偵測

### 按鈕
- **button.espectre_restart** - 重新啟動設備
- **button.espectre_safe_mode_restart** - 安全模式重啟

### 文字感測器
- **text_sensor.espectre_connected_wifi** - 連接的 WiFi 名稱
- **text_sensor.espectre_mac_address** - MAC 地址
- **text_sensor.espectre_esphome_version** - ESPHome 版本

## 🎯 自動化範例

### 範例 1：運動偵測時開燈

```yaml
automation:
  - alias: "運動偵測開燈"
    trigger:
      - platform: state
        entity_id: binary_sensor.espectre_motion_detected
        to: "on"
    action:
      - service: light.turn_on
        target:
          entity_id: light.living_room
```

### 範例 2：無運動 5 分鐘後關燈

```yaml
automation:
  - alias: "無運動關燈"
    trigger:
      - platform: state
        entity_id: binary_sensor.espectre_motion_detected
        to: "off"
        for:
          minutes: 5
    action:
      - service: light.turn_off
        target:
          entity_id: light.living_room
```

### 範例 3：高運動程度時發送通知

```yaml
automation:
  - alias: "高運動程度警告"
    trigger:
      - platform: numeric_state
        entity_id: sensor.espectre_movement_score
        above: 5
    action:
      - service: notify.mobile_app
        data:
          title: "ESPectre 警告"
          message: "偵測到高運動程度！"
```

### 範例 4：根據時間調整靈敏度

```yaml
automation:
  - alias: "夜間降低靈敏度"
    trigger:
      - platform: time
        at: "22:00:00"
    action:
      - service: number.set_value
        target:
          entity_id: number.espectre_threshold
        data:
          value: 3

  - alias: "白天提高靈敏度"
    trigger:
      - platform: time
        at: "08:00:00"
    action:
      - service: number.set_value
        target:
          entity_id: number.espectre_threshold
        data:
          value: 1.5
```

## 🌐 Web 介面

設備也提供獨立的 Web 介面，您可以通過瀏覽器訪問：

```
http://<設備IP地址>
```

使用 `secrets.yaml` 中設定的帳號密碼登入：
- 使用者名稱：admin
- 密碼：espectre123

## 🔍 故障排除

### 問題：Home Assistant 找不到設備

**解決方案：**
1. 確認設備已連接到 WiFi（檢查設備日誌）
2. 確認 Home Assistant 和設備在同一網路
3. 檢查防火牆設定
4. 嘗試重新啟動設備和 Home Assistant

### 問題：API 連接失敗

**解決方案：**
1. 確認 `secrets.yaml` 中的 `api_encryption_key` 正確
2. 重新編譯並上傳韌體
3. 在 Home Assistant 中刪除並重新添加設備

### 問題：狀態 LED 不亮

**解決方案：**
1. 確認您的開發板有 LED 在 GPIO48
2. 如果 LED 在不同的引腳，修改 `espectre-s3.yaml` 中的 `status_led.pin.number`
3. 如果開發板沒有 LED，可以註解掉 `status_led` 部分

## 📱 手機 App 控制

您可以使用 Home Assistant 手機 App（iOS/Android）來：
- 查看即時運動偵測狀態
- 接收運動偵測通知
- 遠端調整靈敏度
- 重新啟動設備

## 🔐 安全建議

1. **更改預設密碼**：修改 `secrets.yaml` 中的所有密碼
2. **使用強密碼**：使用複雜的密碼組合
3. **定期更新**：保持 ESPHome 和韌體更新
4. **網路隔離**：考慮將 IoT 設備放在獨立的 VLAN

## 📚 更多資源

- [ESPHome 文檔](https://esphome.io/)
- [Home Assistant 文檔](https://www.home-assistant.io/)
- [ESPectre GitHub](https://github.com/francescopace/espectre)

## 💡 進階功能

### 與其他感測器結合

您可以將 ESPectre 與其他感測器結合，創建更智能的自動化：

```yaml
automation:
  - alias: "綜合判斷是否有人在家"
    trigger:
      - platform: state
        entity_id: binary_sensor.espectre_motion_detected
        to: "on"
    condition:
      - condition: state
        entity_id: binary_sensor.door_sensor
        state: "off"  # 門是關的
      - condition: state
        entity_id: light.living_room
        state: "on"   # 燈是開的
    action:
      - service: climate.set_temperature
        target:
          entity_id: climate.living_room
        data:
          temperature: 22  # 調整溫度
```

### Node-RED 整合

ESPectre 也可以與 Node-RED 整合，用於更複雜的自動化邏輯。

---

如有任何問題，請查閱官方文檔或提交 Issue。
