module.exports = {
  apps: [
    {
      name: 'gesture-lab',
      script: 'app.js',
      cwd: __dirname,
      env: {
        PORT: 3010,
        ESP32_HOST: '172.20.10.4',
        ESP32_PORT: 80,
        ESP32_POLL_INTERVAL_MS: 200
      }
    }
  ]
};
