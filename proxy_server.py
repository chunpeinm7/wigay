"""
ESPectre Proxy Server
Serves the monitor HTML and proxies EventSource/REST requests to the ESP32-S3.
This avoids browser CORS restrictions when connecting to the ESP32-S3 web server.

Usage: python proxy_server.py [host:port] [esp32_ip]
Default: python proxy_server.py 0.0.0.0:8080 172.20.10.4
"""

import http.server
import urllib.request
import urllib.error
import socket
import sys
import os
import json

ESP32_HOST = "172.20.10.4"
ESP32_PORT = 80
SERVE_DIR = os.path.dirname(os.path.abspath(__file__))
LISTEN_PORT = 8080

# Parse command line args
if len(sys.argv) >= 2:
    try:
        parts = sys.argv[1].split(":")
        LISTEN_PORT = int(parts[-1])
    except Exception:
        pass
if len(sys.argv) >= 3:
    ESP32_HOST = sys.argv[2]

ESP32_BASE = f"http://{ESP32_HOST}:{ESP32_PORT}"

class ProxyHandler(http.server.SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SERVE_DIR, **kwargs)

    def log_message(self, format, *args):
        # Only log non-asset requests
        if not any(self.path.endswith(ext) for ext in ('.js', '.css', '.ico', '.png')):
            super().log_message(format, *args)

    def do_GET(self):
        # Proxy /api/* to ESP32-S3
        if self.path.startswith("/api/"):
            esp_path = self.path[4:]  # strip /api prefix
            self._proxy_request(esp_path)
            return

        # Proxy /events SSE stream (EventSource)
        if self.path == "/events" or self.path.startswith("/events?"):
            self._proxy_sse()
            return

        # Direct sensor/binary_sensor/number REST endpoints proxied too
        for prefix in ("/sensor/", "/binary_sensor/", "/number/", "/text_sensor/",
                       "/switch/", "/button/"):
            if self.path.startswith(prefix):
                self._proxy_request(self.path)
                return

        # Serve local files (HTML, JS, CSS)
        super().do_GET()

    def do_POST(self):
        # Proxy POST requests (switch toggle, button press etc.)
        for prefix in ("/switch/", "/button/", "/number/", "/sensor/"):
            if self.path.startswith(prefix):
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length) if content_length > 0 else None
                self._proxy_request(self.path, method="POST", body=body)
                return
        self.send_error(404, "Not Found")

    def _proxy_request(self, path, method="GET", body=None):
        """Forward a regular HTTP request to the ESP32-S3 and return the response."""
        url = f"{ESP32_BASE}{path}"
        try:
            req = urllib.request.Request(url, data=body, method=method)
            req.add_header("Accept", "application/json")
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type",
                                 resp.headers.get("Content-Type", "application/json"))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.URLError as e:
            self.send_error(502, f"ESP32-S3 unreachable: {e.reason}")
        except Exception as e:
            self.send_error(500, str(e))

    def _proxy_sse(self):
        """Stream EventSource (SSE) from ESP32-S3 to browser."""
        url = f"{ESP32_BASE}/events"
        try:
            req = urllib.request.Request(url)
            req.add_header("Accept", "text/event-stream")
            req.add_header("Cache-Control", "no-cache")

            with urllib.request.urlopen(req, timeout=None) as resp:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()

                # Stream data line by line
                while True:
                    try:
                        line = resp.readline()
                        if not line:
                            break
                        self.wfile.write(line)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        break
        except urllib.error.URLError as e:
            self.send_error(502, f"ESP32-S3 EventSource unreachable: {e.reason}")
        except Exception as e:
            self.send_error(500, str(e))


def run():
    server_address = ("0.0.0.0", LISTEN_PORT)
    httpd = http.server.HTTPServer(server_address, ProxyHandler)
    print(f"╔══════════════════════════════════════════════════╗")
    print(f"║       ESPectre Monitor Proxy Server              ║")
    print(f"╠══════════════════════════════════════════════════╣")
    print(f"║  Monitor URL : http://localhost:{LISTEN_PORT}/               ║")
    print(f"║    espectre-monitor-esphome.html                 ║")
    print(f"║  ESP32-S3    : {ESP32_BASE:<35}║")
    print(f"╚══════════════════════════════════════════════════╝")
    print(f"\n在瀏覽器開啟: http://localhost:{LISTEN_PORT}/espectre-monitor-esphome.html")
    print(f"按 Ctrl+C 停止\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    run()
