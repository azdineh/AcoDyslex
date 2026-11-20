const {defineConfig} = require('@playwright/test');
const fs = require('node:fs');

const localPython = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
const python = process.env.ACODYSLEX_TEST_PYTHON || (fs.existsSync(localPython) ? localPython : 'python');
module.exports = defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  workers: 2,
  reporter: 'list',
  use: {baseURL: 'http://127.0.0.1:8765', headless: true, launchOptions: {
    ...(process.env.ACODYSLEX_CHROMIUM ? {executablePath: process.env.ACODYSLEX_CHROMIUM} : {}),
    args: process.env.ACODYSLEX_CHROMIUM ? ['--no-sandbox'] : [],
  }},
  webServer: {
    // Real local app, temporary recordings, fake key and a mocked Modal transport.
    command: `"${python}" tests/browser_server.py`,
    url: 'http://127.0.0.1:8765',
    reuseExistingServer: false,
  },
});
