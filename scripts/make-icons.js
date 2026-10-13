#!/usr/bin/env node
'use strict';
/**
 * Renders the PNG icons (window, tray, installer) from public/icons/icon.svg.
 * Dev-only: needs Playwright (`npx playwright` or a global install). The PNGs are committed.
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'public', 'icons');
const buildDir = path.join(__dirname, '..', 'build');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');

// Tray icon: no check badge, which would be mush at 16px.
const tray = svg.replace(/<circle cx="404"[\s\S]*?(?=<\/svg>)/, '');

async function main() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('Playwright is needed: npm i -D playwright (or run with a global install on NODE_PATH).');
    process.exit(1);
  }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const render = async (markup, size, file, outDir = dir) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${markup.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(outDir, file), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log(`  ${path.relative(path.join(__dirname, '..'), path.join(outDir, file))}`);
  };
  await render(svg, 192, 'icon-192.png');
  await render(svg, 512, 'icon-512.png');
  await render(svg, 32, 'favicon-32.png');
  // Tray icon: the face only, so it reads at 16px.
  await render(tray, 16, 'tray-16.png');
  await render(tray, 32, 'tray-32.png');
  // Installer / app icon for electron-builder (it makes the .ico and .icns from this).
  fs.mkdirSync(buildDir, { recursive: true });
  await render(svg, 1024, 'icon.png', buildDir);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
