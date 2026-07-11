import requests
import json
import random
import time

# 後端同學的區網 IP
SERVER_IP = "172.16.37.106"  
# 你的 ESP32 MAC 位址 (可以替換成真實的 MAC)
DEVICE_MAC = "AA:BB:CC:DD:EE:FF"  

url = f"http://{SERVER_IP}:5000/api/csi/{DEVICE_MAC}"

# 模擬產生一段 64 個數值的 CSI 原始波形陣列 (符合後端升級後的 JSONB 格式)
simulated_csi = [round(random.uniform(-10, 10), 2) for _ in range(64)]

payload = {
    "csi_data": simulated_csi,
    "rssi": -45,
    "movement_score": 55
}

print(f"📡 準備發送測試數據至: {url}")
print(f"📦 數據內容: {json.dumps(payload, ensure_ascii=False)[:100]}... (省略)")

try:
    # 發送給後端同學的 Flask
    response = requests.post(url, json=payload, timeout=5) 
    if response.status_code == 200:
        print("✅ 數據成功送達後端並寫入資料庫！")
        print(f"📄 後端回應: {response.text}")
    else:
        print(f"⚠️ 請求成功，但後端回傳非 200 狀態碼: HTTP {response.status_code}")
except Exception as e:
    print(f"❌ 連線失敗，請檢查：\n1. 是否與後端同學連到同一個 Wi-Fi 網路。\n2. 後端同學的 Flask 伺服器是否已啟動。\n錯誤詳情: {e}")
