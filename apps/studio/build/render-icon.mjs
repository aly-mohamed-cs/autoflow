// Render build/icon.svg to build/icon.png (256x256) for the installer and window icon.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const svg = readFileSync(new URL('./icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await page.screenshot({ path: new URL('./icon.png', import.meta.url).pathname.slice(1), omitBackground: true });
await browser.close();
