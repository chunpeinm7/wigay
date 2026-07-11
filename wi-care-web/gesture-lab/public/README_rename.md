# 檔名衝突與解決方案

- wi-care-web/public/index.html 及 wi-care-web/gesture-lab/public/index.html 會造成路徑衝突，導致伺服器只會回傳一個 index.html。
- 建議 gesture-lab/public/index.html 改名為 gesture-lab/public/gesture-lab.html，並同步修改 wi-care-web/gesture-lab/app.js 及相關路徑引用。
- 修改後，請用 http://localhost:3010/gesture-lab/public/gesture-lab.html 開啟。
- 若有其他 public/index.html 也建議改名避免衝突。

# 步驟
1. gesture-lab/public/index.html → gesture-lab/public/gesture-lab.html
2. 檢查 app.js 或 server-v2.js 是否有引用 index.html，並一併修正。
3. 重新啟動伺服器。
