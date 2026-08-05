"""
live_test.py — 即時手勢偵測測試
直接向 ESP32 板子收資料，然後用 LSTM 預測動作類別

用法:
    python live_test.py
    python live_test.py --host 172.20.10.11 --seconds 5
"""

import argparse
import time
import sys
import socket
import urllib.request
import urllib.error
import json
from collections import deque

# ── 從 train_lstm.py 匯入 predict ────────────────────────────────────────────
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train_lstm import predict

# ── 預設設定 ─────────────────────────────────────────────────────────────────
DEFAULT_HOST    = "172.20.10.11"
DEFAULT_PORT    = 80
SMOOTH_WINDOW   = 5     # 移動平均視窗
MIN_FRAMES      = 5     # 最少幾幀才預測
COLLECT_SECONDS = 5     # 每次收幾秒

# ── 測試 ESP32 是否可達（TCP 連線測試，不佔用 web server slot）──────────────────
def test_connection(host: str, port: int) -> bool:
    try:
        ip = socket.gethostbyname(host)
        s = socket.create_connection((ip, port), timeout=5)
        s.close()
        return True
    except Exception:
        return False

# ── 用 SSE 串流收集資料（一條長連線，不反覆建立 TCP）────────────────────────────
def collect_via_sse(host: str, port: int, seconds: float) -> list:
    """透過 /events SSE 端點收集 movement_score，回傳 frames list"""
    url = f"http://{host}:{port}/events"
    ma  = MovingAverage(SMOOTH_WINDOW)
    frames = []
    end_time = time.time() + seconds

    try:
        req = urllib.request.Request(url, headers={
            "Accept": "text/event-stream",
            "Cache-Control": "no-cache",
        })
        with urllib.request.urlopen(req, timeout=seconds + 3) as resp:
            buf = b""
            while time.time() < end_time:
                chunk = resp.read(512)
                if not chunk:
                    break
                buf += chunk
                # 逐行解析 SSE
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.strip()
                    if not line.startswith(b"data:"):
                        continue
                    try:
                        data = json.loads(line[5:].strip())
                        if data.get("id") != "sensor-movement_score":
                            continue
                        raw = float(data.get("value", data.get("state", "nan")))
                        if raw != raw:  # NaN check
                            continue
                        smooth = ma.push(raw)
                        frames.append({"Raw Score": raw, "Smoothed Score": smooth})
                        dot = "." if len(frames) % 5 != 0 else str(len(frames))
                        print(dot, end="", flush=True)
                    except Exception:
                        continue
    except Exception as e:
        print(f"\n[SSE 錯誤] {e}", flush=True)

    return frames

# ── 移動平均 ──────────────────────────────────────────────────────────────────
class MovingAverage:
    def __init__(self, window: int):
        self.buf = deque(maxlen=window)

    def push(self, v: float) -> float:
        self.buf.append(v)
        return sum(self.buf) / len(self.buf)

# ── 單次收集 + 預測 ───────────────────────────────────────────────────────────
def collect_and_predict(host: str, port: int, seconds: float) -> tuple[str, list[float]]:
    print(f"  收集中 ({seconds:.0f}秒)...", end="", flush=True)
    frames = collect_via_sse(host, port, seconds)
    print()
    print(f"  收到 {len(frames)} 幀", flush=True)

    if len(frames) < MIN_FRAMES:
        return "（資料不足）", [0.0, 0.0, 0.0]

    label, probs = predict(frames)
    return label, probs.tolist()

# ── 主流程 ────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="即時手勢 LSTM 推論")
    parser.add_argument("--host",    default=DEFAULT_HOST)
    parser.add_argument("--port",    default=DEFAULT_PORT, type=int)
    parser.add_argument("--seconds", default=COLLECT_SECONDS, type=float,
                        help="每次收集幾秒（預設 5）")
    parser.add_argument("--loop",    action="store_true",
                        help="持續重複偵測（Ctrl+C 停止）")
    args = parser.parse_args()

    # 先確認板子連線
    print(f"[連線測試] {args.host}:{args.port} ... ", end="", flush=True)
    if not test_connection(args.host, args.port):
        print("失敗！\n請確認板子已開機，且 IP/mDNS 可解析。")
        sys.exit(1)
    print(f"OK")

    classes = ["empty_room", "squat", "wave"]
    emojis  = {"empty_room": "🏠 空房間", "squat": "🏋 蹲下", "wave": "👋 揮手"}

    print("\n準備好後按 Enter 開始收集，Ctrl+C 退出")
    try:
        while True:
            input()
            label, probs = collect_and_predict(args.host, args.port, args.seconds)
            print(f"\n  ┌─ 預測結果 ─────────────────┐")
            print(f"  │  {emojis.get(label, label):<20}       │")
            for c, p in zip(classes, probs):
                bar = "█" * int(p * 20)
                print(f"  │  {c:<12} {p*100:5.1f}% {bar:<20}│")
            print(f"  └────────────────────────────┘\n")

            if not args.loop:
                another = input("繼續再測一次？(Enter=是 / q=退出) ")
                if another.strip().lower() == "q":
                    break
    except KeyboardInterrupt:
        print("\n已停止。")

if __name__ == "__main__":
    main()
