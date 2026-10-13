#!/usr/bin/env node
'use strict';
/**
 * Renders the PNG app icons from public/icons/icon.svg (needed for "Install app").
 * Dev-only: needs Playwright (`npx playwright` or a global install). The PNGs are committed.
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'public', 'icons');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');

// Full-bleed variant for "maskable" (Windows/Android crop it into their own shape):
// background to the edges, face scaled into the 80% safe zone.
const defs = svg.slice(svg.indexOf('<defs>'), svg.indexOf('</defs>') + 7);
const face = svg.slice(svg.indexOf('<ellipse'), svg.indexOf('<circle'));
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}
  <rect width="512" height="512" fill="url(#g)"/><rect width="512" height="512" fill="url(#shine)"/>
  <g transform="translate(51.2 40) scale(0.8)">${face}</g></svg>`;

// Monochrome silhouette for the small notification badge (only alpha is used).
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <rect x="6" y="6" width="60" height="60" rx="20" fill="none" stroke="#fff" stroke-width="7"/>
  <ellipse cx="26" cy="31" rx="4.5" ry="6" fill="#fff"/><ellipse cx="46" cy="31" rx="4.5" ry="6" fill="#fff"/>
  <path d="M26 45c6 6 14 6 20 0" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
</svg>`;

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
  const render = async (markup, size, file) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${markup.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(dir, file), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log(`  ${file}`);
  };
  await render(svg, 192, 'icon-192.png');
  await render(svg, 512, 'icon-512.png');
  await render(maskable, 512, 'maskable-512.png');
  await render(badge, 72, 'badge-72.png');
  await render(svg, 32, 'favicon-32.png');
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
