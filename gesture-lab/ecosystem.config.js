module.exports = {
  apps: [
    {
      name: 'gesture-lab',
      script: 'app.js',
      cwd: __dirname,
      env: {
        PORT: 3010,
        ESP32_HOST: '172.20.10.2',
        ESP32_PORT: 80,
        ESP32_DATA_PATH: '/sensor/Movement%20Score',
        ESP32_POLL_INTERVAL_MS: 400
      }
    }
  ]
};
