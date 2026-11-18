// Smoke test of the built site + README screenshots (media/):
//   node tools/smoke_test.js [BASE_URL] [WEBTESTS_DIR]
// BASE_URL: where the site is served (default http://localhost:8766/, e.g. python serve.py 8766 <this repo>; the live
// site works too). WEBTESTS_DIR: a folder whose node_modules has @playwright/test and iwer (the pipeline's WebTests).
// Desktop: menu, product list, the whole assembly played with the mouse, the instruction page, no third-party names.
// VR: an emulated Quest 3 (IWER) with tracked hands only - the session must start in Table mode with the panel up.
const fs = require('fs'), path = require('path');
const BASE = process.argv[2] || 'http://localhost:8766/';
const WT = process.argv[3] || 'C:/Projekty/IKEA_assembly_project/WebTests';
const { chromium } = require(path.join(WT, 'node_modules/@playwright/test'));
const IWER_JS = fs.readFileSync(path.join(WT, 'node_modules/iwer/build/iwer.min.js'), 'utf8');
const MEDIA = path.join(__dirname, '..', 'media');
const SHOTS = !process.argv.includes('--no-shots');
const PRODUCT = 'new-horizons';

const fails = [];
const check = (ok, what) => { console.log((ok ? 'ok    ' : 'FAIL  ') + what); if (!ok) fails.push(what); };
function watch(page) {
  const msgs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') msgs.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', e => msgs.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400) msgs.push(`http ${r.status()}: ${r.url()}`); });
  return () => msgs.filter(m => !/GPU stall due to ReadPixels|GL Driver Message|swiftshader|WebGL: INVALID_|Automatic fallback to software WebGL/i.test(m));
}
const shot = (page, name) => SHOTS ? page.screenshot({ path: path.join(MEDIA, name) }) : null;
const ready = page => page.waitForFunction(() => window.player && !document.getElementById('panel').classList.contains('hidden'), null, { timeout: 120_000 });

(async () => {
  fs.mkdirSync(MEDIA, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

  // ---------------- desktop ----------------
  let ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
  let page = await ctx.newPage(); let msgs = watch(page);
  await page.goto('player.html');
  await page.waitForSelector('#menu:not(.hidden)');
  check((await page.title()) === 'Open Assembly Lab', 'main menu, title "' + await page.title() + '"');
  await page.waitForSelector('#featured a'); await page.waitForTimeout(1200);
  await shot(page, 'desktop-menu.png');

  await page.goto('player.html?view=products');
  await page.waitForSelector('#grid a');
  const cards = await page.locator('#grid a').count();
  check(cards === 1, `product browser: ${cards} product card(s)`);

  await page.goto('player.html?p=' + PRODUCT);
  await ready(page);
  const info = await page.evaluate(() => ({ S: player.sc.steps.length, parts: player.parts.length, dur: player.sc.duration, name: player.sc.product.name,
    ds: player.sc.camera.detailScale, title: document.getElementById('title').textContent, body: document.getElementById('body').textContent }));
  check(info.S === 4 && info.parts === 9, `assembly loaded: ${info.S} steps, ${info.parts} parts, ${info.dur} s, detailScale ${info.ds}`);
  check(/You need:/.test(info.body) && info.title === 'Check all parts', 'parts screen wording');
  await page.waitForTimeout(3500);
  await shot(page, 'desktop-parts.png');

  // the whole assembly with the mouse: Play, then Next through every step
  await page.click('#play');
  const seen = new Set();
  for (let guard = 0; guard < 4 * info.S + 4; guard++) {
    await page.waitForFunction(() => player.st.chapter === 0 || document.getElementById('header').textContent.includes(`STEP ${player.st.chapter} OF`));
    const c = await page.evaluate(() => player.st.chapter); if (c > 0) seen.add(c);
    if (await page.locator('#next').isDisabled()) break;
    await page.locator('#next').click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(150);
  }
  const end = await page.evaluate(() => ({ chapter: player.st.chapter, g: player.globalTime }));
  check(end.chapter === info.S && end.g > info.dur - 0.05 && seen.size === info.S, `played to the end with the mouse (step ${end.chapter}, t ${end.g.toFixed(2)} of ${info.dur})`);
  await page.waitForTimeout(3500);
  await shot(page, 'desktop-done.png');

  await page.evaluate(() => { player.pause(); player.seekGlobal(7.3); });
  await page.waitForFunction(() => { const im = document.getElementById('pageImg'); return im.complete && im.naturalWidth > 0 && /p03/.test(im.src); });
  await page.waitForTimeout(3500);
  const pg = await page.evaluate(() => { const im = document.getElementById('pageImg'), r = im.getBoundingClientRect(); return { nat: [im.naturalWidth, im.naturalHeight], box: [Math.round(r.width), Math.round(r.height)] }; });
  check(pg.nat[0] === 1100 && pg.nat[1] < 760 && Math.abs(pg.box[0] / pg.box[1] - pg.nat[0] / pg.nat[1]) < 0.02, `instruction page: cropped ${pg.nat.join('x')}, shown ${pg.box.join('x')}`);
  await shot(page, 'desktop-step.png');

  const words = await page.evaluate(() => document.documentElement.innerHTML.match(/ikea/gi));
  check(!words, 'no third-party brand name in the page');
  check(msgs().length === 0, 'desktop: no console errors / failed requests' + (msgs().length ? ' - ' + msgs().slice(0, 4).join(' | ') : ''));
  await ctx.close();

  // ---------------- VR, tracked hands only ----------------
  ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
  page = await ctx.newPage(); msgs = watch(page);
  await page.addInitScript(({ src }) => {
    try { localStorage.setItem('openLab.xr.intro', 'seen'); } catch (e) {}   // the first-visit help card
    (0, eval)(src);
    const d = new IWER.XRDevice(IWER.metaQuest3);
    d.installRuntime(); d.stereoEnabled = false; d.position.set(0, 1.6, 0); d.primaryInputMode = 'hand';
    window.xrDevice = d;
  }, { src: IWER_JS });
  await page.goto('player.html?p=' + PRODUCT);
  await ready(page);
  await page.waitForSelector('#xrButtons button[data-mode="immersive-vr"]', { timeout: 30_000 });
  await page.click('#xrButtons button[data-mode="immersive-vr"]');
  await page.waitForFunction(() => window.xrSession && window.xrSession.placed, null, { timeout: 60_000 });
  await page.waitForFunction(() => xrSession.input.sides.right.type !== 'none', null, { timeout: 30_000 });
  await page.waitForFunction(() => xrSession.handsTable && xrSession.scaleMode === 'table' && xrSession.placed, null, { timeout: 30_000 }).catch(() => {});
  const xr = await page.evaluate(() => ({ hands: xrSession.input.sides.right.type, table: !!xrSession.handsTable, mode: xrSession.scaleMode, scale: +xrSession.rig.scale.x.toFixed(3),
    panel: !!xrSession.panel, handsOn: !!xrSession.handsOn }));
  check(xr.hands === 'hand' && xr.table && xr.mode === 'table', `VR with hands only: input ${xr.hands}, mode ${xr.mode}, model shown at ${xr.scale}x, panel ${xr.panel}`);
  // look down at the table for the picture (the emulated headset starts level)
  await page.evaluate(() => { const a = -38 * Math.PI / 360; xrDevice.quaternion.set(Math.sin(a), 0, 0, Math.cos(a)); });
  await page.waitForTimeout(2500);
  await shot(page, 'vr-table-hands.png');
  await page.evaluate(() => xrSession.exit());
  await page.waitForFunction(() => !window.xrSession, null, { timeout: 30_000 });
  check(msgs().length === 0, 'VR: no console errors / failed requests' + (msgs().length ? ' - ' + msgs().slice(0, 4).join(' | ') : ''));
  await ctx.close();

  await browser.close();
  console.log(fails.length ? `\n${fails.length} check(s) FAILED` : '\nall checks passed');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
