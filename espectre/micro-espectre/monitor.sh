#!/bin/bash
# ESPectre 即時監控腳本

cd /Users/nitama/wi-care-project
source venv/bin/activate
cd espectre/micro-espectre

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║         ESPectre 即時監控 - 按 Ctrl+C 停止               ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""
echo "⏳ 啟動中... 請稍候"
echo ""

./me run --port /dev/cu.usbmodem5B140570401
