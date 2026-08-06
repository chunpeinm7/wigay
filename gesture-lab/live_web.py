"""
live_web.py — LSTM 即時測試網頁
連上 ESP32-S3 後，網頁會顯示即時波型，並持續用 lstm_model.pth
判斷目前動作最接近 empty_room / squat / wave 哪一個。

用法:
    python live_web.py
    python live_web.py --host 172.20.10.11 --port 3020
開啟瀏覽器: http://localhost:3020
"""

import argparse
import json
import os
import sys
import socket
import threading
import time
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train_lstm import predict, CLASSES, SEQ_LEN, MODEL_PATH

DEFAULT_ESP_HOST = "172.20.10.9"
DEFAULT_ESP_PORT = 80
DEFAULT_WEB_PORT = 3020
SMOOTH_WINDOW = 5          # 移動平均視窗
MIN_FRAMES = 5             # 最少幾幀才開始預測
HISTORY_MAXLEN = 300       # 波型圖保留幾個點
PREDICT_INTERVAL = 0.7     # 最快幾秒重新推論一次（避免每幀都重載模型）
EMOJI = {"empty_room": "🏠 空房間", "squat": "🏋 蹲下", "wave": "👋 揮手"}

LIVE_STALE_SECONDS = 2.5   # 超過這麼久沒收到新資料才算「未連線」（避免 SSE 短暫斷線造成畫面閃爍）

# 韌體每次開機都會重新校準，同一個動作量到的原始數值尺度會跟著飄動。
# 連線後先安靜收集這幾秒資料當「現場基準值」，換算回訓練時的尺度再推論，
# 這樣裝置重開機後不用重新錄資料訓練模型。
CALIBRATION_SECONDS = 4
CALIBRATION_MIN_FRAMES = 5


def load_model_baseline():
    import torch
    try:
        ckpt = torch.load(MODEL_PATH, map_location="cpu", weights_only=True)
        return ckpt["config"].get("baseline_mean")
    except Exception:
        return None


lock = threading.Lock()
state = {
    "connected": False,
    "live": False,           # 最近有沒有實際收到資料，UI 用這個判斷連線狀態比較穩定
    "esp_host": DEFAULT_ESP_HOST,
    "esp_port": DEFAULT_ESP_PORT,
    "error": None,
    "history": [],          # [{raw, smoothed}]
    "prediction": None,     # {label, emoji, probs: {cls: p}}
    "calibrating": True,
    "calibration_progress": 0.0,   # 0~1
    "device_calibrating": False,   # ESP32 韌體端校準中（value=null）
    "model_baseline": load_model_baseline(),
    "live_baseline": None,
}
last_data_ts = 0.0
stop_event = threading.Event()
worker_thread = None
calibration_samples = []
calibration_start_ts = 0.0


class MovingAverage:
    def __init__(self, window):
        self.buf = deque(maxlen=window)

    def push(self, v):
        self.buf.append(v)
        return sum(self.buf) / len(self.buf)


def test_connection(host, port):
    try:
        ip = socket.gethostbyname(host)
        s = socket.create_connection((ip, port), timeout=5)
        s.close()
        return True
    except Exception:
        return False


def run_prediction(window_frames, live_baseline):
    label, probs = predict(list(window_frames), live_baseline=live_baseline)
    with lock:
        state["prediction"] = {
            "label": label,
            "emoji": EMOJI.get(label, label),
            "probs": {cls: float(p) for cls, p in zip(CLASSES, probs)},
        }


def reset_calibration():
    global calibration_start_ts
    calibration_samples.clear()
    calibration_start_ts = time.time()
    with lock:
        state["calibrating"] = True
        state["calibration_progress"] = 0.0
        state["live_baseline"] = None
        state["prediction"] = None


def sse_worker(host, port, my_stop_event):
    global last_data_ts
    ma = MovingAverage(SMOOTH_WINDOW)
    window = deque(maxlen=SEQ_LEN)
    last_predict = 0.0

    while not my_stop_event.is_set():
        with lock:
            state["connected"] = False

        if not test_connection(host, port):
            with lock:
                state["error"] = f"無法連線到 {host}:{port}"
            if my_stop_event.wait(3):
                return
            continue

        url = f"http://{host}:{port}/events"
        try:
            req = urllib.request.Request(url, headers={
                "Accept": "text/event-stream",
                "Cache-Control": "no-cache",
            })
            with urllib.request.urlopen(req, timeout=15) as resp:
                with lock:
                    state["connected"] = True
                    state["error"] = None
                buf = b""
                while not my_stop_event.is_set():
                    chunk = resp.read(512)
                    if not chunk:
                        break
                    buf += chunk
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        line = line.strip()
                        if not line.startswith(b"data:"):
                            continue
                        try:
                            data = json.loads(line[5:].strip())
                        except Exception:
                            continue
                        if data.get("id") != "sensor-movement_score":
                            continue

                        # 收到 movement_score 事件就更新時間戳，即使值是 null（ESP32 校準期間）
                        last_data_ts = time.time()

                        raw_value = data.get("value", data.get("state", "nan"))
                        # ESP32 校準期間 value 為 null，此時保持連線狀態但不處理數值
                        if raw_value is None:
                            with lock:
                                state["live"] = True
                                state["device_calibrating"] = True
                            continue
                        try:
                            raw = float(raw_value)
                        except (TypeError, ValueError):
                            continue
                        if raw != raw:  # NaN
                            continue

                        with lock:
                            state["device_calibrating"] = False
                        smooth = ma.push(raw)
                        frame = {"Raw Score": raw, "Smoothed Score": smooth}
                        window.append(frame)
                        last_data_ts = time.time()
                        with lock:
                            state["live"] = True
                            state["history"].append({"raw": raw, "smoothed": smooth})
                            if len(state["history"]) > HISTORY_MAXLEN:
                                del state["history"][: len(state["history"]) - HISTORY_MAXLEN]

                        now = time.time()

                        # 校準階段：先安靜收集現場基準值，還沒收完不做推論
                        if state["calibrating"]:
                            calibration_samples.append(raw)
                            elapsed = now - calibration_start_ts
                            with lock:
                                state["calibration_progress"] = min(1.0, elapsed / CALIBRATION_SECONDS)
                            if elapsed >= CALIBRATION_SECONDS and len(calibration_samples) >= CALIBRATION_MIN_FRAMES:
                                live_baseline = sum(calibration_samples) / len(calibration_samples)
                                with lock:
                                    state["calibrating"] = False
                                    state["live_baseline"] = live_baseline
                                    state["calibration_progress"] = 1.0
                            continue

                        if len(window) >= MIN_FRAMES and now - last_predict >= PREDICT_INTERVAL:
                            last_predict = now
                            try:
                                run_prediction(window, state["live_baseline"])
                            except Exception as e:
                                with lock:
                                    state["error"] = f"推論失敗: {e}"
        except Exception as e:
            with lock:
                state["connected"] = False
                state["error"] = str(e)
                if time.time() - last_data_ts > LIVE_STALE_SECONDS:
                    state["live"] = False

        if my_stop_event.wait(0.3):
            return


def start_worker(host, port):
    global worker_thread, stop_event, last_data_ts
    if worker_thread is not None:
        stop_event.set()
        worker_thread.join(timeout=5)
    stop_event = threading.Event()
    last_data_ts = 0.0
    with lock:
        state["esp_host"] = host
        state["esp_port"] = port
        state["history"] = []
        state["prediction"] = None
        state["error"] = None
        state["live"] = False
    reset_calibration()
    worker_thread = threading.Thread(target=sse_worker, args=(host, port, stop_event), daemon=True)
    worker_thread.start()


PAGE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public", "live-monitor.html")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/" or self.path == "/index.html":
            try:
                with open(PAGE_PATH, "rb") as f:
                    body = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except FileNotFoundError:
                self.send_response(404)
                self.end_headers()
            return

        if self.path == "/api/state":
            with lock:
                snapshot = json.loads(json.dumps(state))
            self._send_json(snapshot)
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path == "/api/connect":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length else b"{}"
            try:
                payload = json.loads(body)
            except Exception:
                payload = {}
            host = str(payload.get("host") or DEFAULT_ESP_HOST).strip()
            port = int(payload.get("port") or DEFAULT_ESP_PORT)
            start_worker(host, port)
            self._send_json({"ok": True, "host": host, "port": port})
            return

        if self.path == "/api/recalibrate":
            reset_calibration()
            self._send_json({"ok": True})
            return

        self.send_response(404)
        self.end_headers()


def main():
    parser = argparse.ArgumentParser(description="LSTM 即時測試網頁")
    parser.add_argument("--host", default=DEFAULT_ESP_HOST, help="ESP32-S3 位址")
    parser.add_argument("--esp-port", default=DEFAULT_ESP_PORT, type=int)
    parser.add_argument("--port", default=DEFAULT_WEB_PORT, type=int, help="網頁伺服器埠")
    args = parser.parse_args()

    start_worker(args.host, args.esp_port)

    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"[live_web] 網頁: http://localhost:{args.port}  (ESP32: {args.host}:{args.esp_port})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
        stop_event.set()


if __name__ == "__main__":
    main()
