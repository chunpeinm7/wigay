# 修復 espectre.local 無法訪問問題

## 問題診斷

錯誤：`ERR_NAME_NOT_RESOLVED (-105)` 無法訪問 `http://espectre.local/`

這是因為 Windows 不支援 mDNS (.local 域名解析)

---

## 解決方案

### 方案一：安裝 Bonjour Print Services（最簡單）

1. **下載並安裝 Bonjour**
   - [下載 Bonjour Print Services](https://support.apple.com/kb/DL999)
   - 或直接從這裡下載：https://support.apple.com/kb/DL999
   - 安裝完成後重啟電腦

2. **重啟後測試**
   - 開啟瀏覽器訪問 `http://espectre.local/`

### 方案二：使用 IP 位址直接訪問

1. **找到 ESP32 的 IP 位址**
   - 方法 A: 檢查你的路由器管理頁面，查看連接設備
   - 方法 B: 使用串口監控查看 IP（需要 USB 連接）
   - 方法 C: 使用 Home Assistant 查看設備 IP

2. **使用 IP 直接訪問**
   ```
   http://192.168.x.x/
   ```
   （將 x.x 替換為實際 IP）

### 方案三：透過代理伺服器

專案已包含 `proxy_server.py`，可以透過它訪問：

```bash
# 1. 先找到 ESP32 的 IP 位址
# 2. 修改 proxy_server.py 中的 ESP32_IP 設定
# 3. 啟動代理
python proxy_server.py
```

然後訪問：`http://localhost:8080/`

### 方案四：使用 mDNS 掃描工具查找設備

```bash
# 安裝 dns-sd (Windows)
# 或使用 avahi-browse (如果已安裝 WSL)

# 掃描網路上的 ESPHome 設備
dns-sd -B _esphomelib._tcp
```

---

## 檢查設備是否在線

### 方法 1: Ping 測試（安裝 Bonjour 後）

```bash
ping espectre.local
```

### 方法 2: 掃描網路

```bash
# 使用 nmap 掃描（需要安裝）
nmap -sn 192.168.1.0/24

# 或使用 arp
arp -a
```

### 方法 3: 使用 ESPHome 儀表板

```bash
esphome logs espectre-s3.yaml
```

這會顯示設備的 IP 和狀態

---

## 確認 ESP32 已連接 WiFi

1. **檢查 secrets.yaml**
   - 確認 WiFi SSID 和密碼正確

2. **查看序列埠輸出**
   ```bash
   esphome logs espectre-s3.yaml
   ```

3. **如果無法連接，連接到後備 AP**
   - SSID: `ESPectre Fallback`
   - 密碼: `espectre123`
   - 然後在瀏覽器訪問 `192.168.4.1` 進行配置

---

## 推薦：啟用 mDNS 組件（ESPHome 已預設啟用）

ESPHome 預設會啟用 mDNS，但你可以在 `espectre-s3.yaml` 中明確設定：

```yaml
# 明確啟用 mDNS
mdns:
  disabled: false
```

---

## 常見問題

### Q: 我已經安裝 Bonjour，但仍然無法訪問？

A: 
1. 確認 ESP32 已連接到**相同的 WiFi 網路**
2. 檢查防火牆是否封鎖了 mDNS (UDP 5353)
3. 重啟電腦和 ESP32 設備

### Q: 我找不到設備的 IP？

A:
1. 使用 USB 連接查看串口日誌：`esphome logs espectre-s3.yaml`
2. 檢查路由器的 DHCP 客戶端列表
3. 使用網路掃描工具（如 Advanced IP Scanner）

### Q: 可以改用固定 IP 嗎？

A: 可以！在 `espectre-s3.yaml` 的 wifi 部分加入：

```yaml
wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password
  
  # 使用固定 IP
  manual_ip:
    static_ip: 192.168.1.100
    gateway: 192.168.1.1
    subnet: 255.255.255.0
```

---

## 快速解決步驟

1. **立即可用**：安裝 Bonjour Print Services
2. **臨時方案**：找到 IP 直接訪問
3. **長期方案**：設定固定 IP

**最快方式：先用 `esphome logs espectre-s3.yaml` 查看 IP，然後直接用 IP 訪問！**
