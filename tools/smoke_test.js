// Smoke test of the built site + README screenshots (media/):
//   node tools/smoke_test.js [BASE_URL] [NODE_MODULES_DIR] [--no-shots] [--only=<kit folder>]
// --only runs one kit: a quick partial check while working on it, not the full test.
// BASE_URL: where the site is served (default http://localhost:8766/; the live site works too).
// NODE_MODULES_DIR: a folder whose node_modules has @playwright/test and iwer (or set NODE_PATH / install them here).
// Desktop: menu, kit list, every kit played to the end with the mouse, the instruction page, no third-party names.
// VR: an emulated Quest 3 (IWER) with tracked hands only - the session must start in Table mode with the panel up,
//     then every part of every kit is pinched, carried to its place and must snap (the hands-only walk).
const fs = require('fs'), path = require('path');
const BASE = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'http://localhost:8766/';
const MODS = process.argv[3] && !process.argv[3].startsWith('--') ? path.join(process.argv[3], 'node_modules') : null;
const mod = name => MODS ? path.join(MODS, name) : name;
const { chromium } = require(mod('@playwright/test'));
const IWER_JS = fs.readFileSync(MODS ? path.join(MODS, 'iwer/build/iwer.min.js') : require.resolve('iwer/build/iwer.min.js'), 'utf8');
const MEDIA = path.join(__dirname, '..', 'media');
const SHOTS = !process.argv.includes('--no-shots');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);
// page: the instruction page checked at time t (seconds) - its file name and natural size [width, max height]
const KITS = [
  { slug: 'new-horizons', steps: 4, parts: 9, page: { t: 7.3, rx: /p03/, w: 1100, maxH: 760 }, shots: { parts: 'desktop-parts.png', done: 'desktop-done.png', step: 'desktop-step.png', vr: 'vr-table-hands.png' } },
  { slug: 'soho', steps: 4, parts: 7, page: { t: 2.8, rx: /p02/, w: 1100, maxH: 760 }, shots: { step: 'desktop-soho.png' } },
  { slug: 'farmbot-gantry-wheel-plate', steps: 5, parts: 43, page: { t: 3.2, rx: /p02/, w: 1100, maxH: 760 }, shots: { step: 'desktop-farmbot.png' } },
  { slug: 'farmbot-cross-slide', steps: 8, parts: 68, page: { t: 118.0, rx: /p06/, w: 1100, maxH: 760 }, shots: { step: 'desktop-farmbot-cross-slide.png' } },
  { slug: 'farmbot-z-axis', steps: 10, parts: 54, page: { t: 26.0, rx: /p05/, w: 1100, maxH: 760 }, shots: { step: 'desktop-farmbot-z-axis.png' } },
  { slug: 'mission-piano-bench', steps: 3, parts: 18, page: { t: 17.0, rx: /p02/, w: 1100, maxH: 760 }, shots: { step: 'desktop-piano-bench.png' } },
];

const fails = [];
const check = (ok, what) => { console.log((ok ? 'ok    ' : 'FAIL  ') + what); if (!ok) fails.push(what); };
function watch(page) {
  const msgs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') msgs.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', e => msgs.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400) msgs.push(`http ${r.status()}: ${r.url()}`); });
  return () => msgs.filter(m => !/GPU stall due to ReadPixels|GL Driver Message|swiftshader|WebGL: INVALID_|Automatic fallback to software WebGL/i.test(m));
}
const shot = (page, name) => SHOTS && name ? page.screenshot({ path: path.join(MEDIA, name) }) : null;
const ready = page => page.waitForFunction(() => window.player && !document.getElementById('panel').classList.contains('hidden'), null, { timeout: 120_000 });

// Every expected part: pinch it at its centre, carry it to its place, let go - it must snap. Runs in the page.
const WALK = async () => {
  const T = xrSession.host.THREE, H = xrSession.handsOn, host = xrSession.host, S = host.steps.length;
  const sleep = ms => new Promise(r => setTimeout(r, ms)), side = xrSession.input.sides.right, dev = xrDevice.hands.right;
  const part = n => host.parts.find(p => p.name === n);
  async function setGrip(want) {                       // move the emulated hand until its pinch point is at `want`
    const wantP = new T.Vector3().setFromMatrixPosition(want);
    for (let i = 0; i < 30; i++) {
      if (i >= 8 && side.grabPose.position.distanceTo(wantP) < 0.004 * xrSession.rig.scale.x) break;
      const cur = new T.Matrix4().compose(side.grabPose.position, side.grabPose.quaternion, new T.Vector3(1, 1, 1));
      const C = new T.Matrix4().compose(new T.Vector3(dev.position.x, dev.position.y, dev.position.z),
        new T.Quaternion(dev.quaternion.x, dev.quaternion.y, dev.quaternion.z, dev.quaternion.w), new T.Vector3(1, 1, 1));
      const rigInv = xrSession.rig.matrixWorld.clone().invert();
      const off = C.clone().invert().multiply(rigInv).multiply(cur);
      const nC = rigInv.clone().multiply(want).multiply(off.invert());
      const p = new T.Vector3(), q = new T.Quaternion(), sc = new T.Vector3(); nC.decompose(p, q, sc);
      dev.position.set(p.x, p.y, p.z); dev.quaternion.set(q.x, q.y, q.z, q.w);
      await sleep(45);
    }
  }
  const pinch = async on => { dev.updatePinchValue(on ? 1 : 0); await sleep(110); };
  // Close the fingers ON the part, as a hand does. The emulator's pinch point moves 77 mm (real) between the open and the
  // closed hand; aimed open and then snapped shut, it lands outside the 4 cm reach of thin large parts (a rod, a plate on
  // edge) and nothing is picked up. So: close nearly all the way, aim again, then close.
  async function pinchAt(c) {
    dev.updatePinchValue(0.8); await sleep(90);                      // nearly closed: not yet a pinch
    if (!side.grabPressed && !H.debug().held.right) await setGrip(new T.Matrix4().compose(c, side.grabPose.quaternion, new T.Vector3(1, 1, 1)));
    dev.updatePinchValue(1); await sleep(150);
  }
  const snaps = () => __ev.filter(e => e.type === 'snap').length;
  const out = { input: side.type, scale: xrSession.scaleMode, steps: S, carries: 0, snapped: 0, fails: [], stuck: null };
  xrSession.setMode('handson'); host.transport.seekGlobal(host.steps[0].start + 1e-4);
  const t0 = performance.now();
  let lastKey = '', same = 0;
  while (performance.now() - t0 < 25 * 60_000) {
    const d = H.debug();
    if (d.autoUntil != null || d.finishing) { await sleep(60); continue; }
    const free = d.expected.filter(n => !d.locked.includes(n));
    if (!free.length) {
      if (d.step >= S) break;
      const st = d.step; H.nextStep(); await sleep(80);
      if (H.debug().step === st) await sleep(150);
      continue;
    }
    const key = d.step + '|' + d.move + '|' + d.locked.length;
    same = key === lastKey ? same + 1 : 0; lastKey = key;
    if (same > 3) { out.fails.push({ step: d.step, part: free[0], why: 'no progress' }); H.skipMove(); continue; }
    const name = free[0], c = host.partBox(part(name)).getCenter(new T.Vector3());
    await setGrip(new T.Matrix4().compose(c, side.grabPose.quaternion, new T.Vector3(1, 1, 1)));
    const g0 = snaps();
    await pinchAt(c);
    const held = H.debug().held.right;
    if (!held && snaps() > g0) { out.carries++; out.snapped++; await pinch(false); continue; }   // was already within its snap distance
    if (!held) { out.fails.push({ step: d.step, part: name, why: 'not grabbed' }); await pinch(false); H.skipMove(); continue; }
    const n0 = snaps();
    if (!H.targetWorld(held)) { out.fails.push({ step: d.step, part: name, why: 'grabbed another part', held }); await pinch(false); H.skipMove(); continue; }
    const Tw = new T.Matrix4().fromArray(H.targetWorld(held));
    const hp = part(held); hp.node.updateMatrixWorld(true);
    const Gc = new T.Matrix4().compose(side.grabPose.position, side.grabPose.quaternion, new T.Vector3(1, 1, 1));
    await setGrip(Tw.clone().multiply(hp.node.matrixWorld.clone().invert()).multiply(Gc));
    await pinch(false); await sleep(60);
    out.carries++;
    if (snaps() > n0) out.snapped++;
    else { out.fails.push({ step: d.step, part: held, why: 'no snap' }); H.skipMove(); }
  }
  if (H.debug().step < S || !__ev.some(e => e.type === 'stepComplete' && e.step === S)) out.stuck = H.debug().step;
  out.wrong = __ev.filter(e => e.type === 'wrongPart').map(e => e.part);
  out.seconds = Math.round((performance.now() - t0) / 1000);
  return out;
};

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
  const browse = (await page.locator('#mBrowse').textContent()).trim();
  check(browse === 'Browse assemblies', `menu button "${browse}"`);
  await shot(page, 'desktop-menu.png');

  await page.goto('player.html?view=products');
  await page.waitForSelector('#grid a');
  const cards = await page.locator('#grid a').count();
  check(cards === KITS.length, `kit browser: ${cards} card(s)`);

  for (const kit of KITS.filter(k => !ONLY || k.slug === ONLY)) {
    const K = `[${kit.slug}] `;
    await page.goto('player.html?p=' + kit.slug);
    await ready(page);
    const info = await page.evaluate(() => ({ S: player.sc.steps.length, parts: player.parts.length, dur: player.sc.duration, name: player.sc.product.name,
      ds: player.sc.camera.detailScale, title: document.getElementById('title').textContent, body: document.getElementById('body').textContent }));
    check(info.S === kit.steps && info.parts === kit.parts, K + `assembly loaded: ${info.S} steps, ${info.parts} parts, ${info.dur} s, detailScale ${info.ds}`);
    check(/You need:/.test(info.body) && info.title === 'Check all parts', K + 'parts screen wording');
    await page.waitForTimeout(SHOTS ? 3500 : 500);
    await shot(page, kit.shots.parts);

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
    check(end.chapter === info.S && end.g > info.dur - 0.05 && seen.size === info.S, K + `played to the end with the mouse (step ${end.chapter}, t ${end.g.toFixed(2)} of ${info.dur})`);
    await page.waitForTimeout(SHOTS ? 3500 : 300);
    await shot(page, kit.shots.done);

    await page.evaluate(t => { player.pause(); player.seekGlobal(t); }, kit.page.t);
    await page.waitForFunction(rx => { const im = document.getElementById('pageImg'); return im.complete && im.naturalWidth > 0 && new RegExp(rx).test(im.src); }, kit.page.rx.source);
    await page.waitForTimeout(SHOTS ? 3500 : 300);
    const pg = await page.evaluate(() => { const im = document.getElementById('pageImg'), r = im.getBoundingClientRect(); return { nat: [im.naturalWidth, im.naturalHeight], box: [Math.round(r.width), Math.round(r.height)] }; });
    check(pg.nat[0] === kit.page.w && pg.nat[1] < kit.page.maxH && Math.abs(pg.box[0] / pg.box[1] - pg.nat[0] / pg.nat[1]) < 0.02, K + `instruction page: ${pg.nat.join('x')}, shown ${pg.box.join('x')}`);
    await shot(page, kit.shots.step);
  }
  check(msgs().length === 0, 'desktop: no console errors / failed requests' + (msgs().length ? ' - ' + msgs().slice(0, 4).join(' | ') : ''));
  await ctx.close();

  // ---------------- VR, tracked hands only ----------------
  for (const kit of KITS.filter(k => !ONLY || k.slug === ONLY)) {
    const K = `[${kit.slug}] `;
    ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
    page = await ctx.newPage(); msgs = watch(page);
    await page.addInitScript(({ src }) => {
      try { localStorage.setItem('openLab.xr.intro', 'seen'); } catch (e) {}   // the first-visit help card
      (0, eval)(src);
      const d = new IWER.XRDevice(IWER.metaQuest3);
      d.installRuntime(); d.stereoEnabled = false; d.position.set(0, 1.6, 0); d.primaryInputMode = 'hand';
      window.xrDevice = d;
    }, { src: IWER_JS });
    await page.goto('player.html?p=' + kit.slug);
    await ready(page);
    await page.evaluate(() => { window.__ev = []; player.events.on('*', e => __ev.push({ type: e.type, part: e.part, step: e.step })); });
    await page.waitForSelector('#xrButtons button[data-mode="immersive-vr"]', { timeout: 30_000 });
    await page.click('#xrButtons button[data-mode="immersive-vr"]');
    await page.waitForFunction(() => window.xrSession && window.xrSession.placed, null, { timeout: 60_000 });
    await page.waitForFunction(() => xrSession.input.sides.right.type !== 'none', null, { timeout: 30_000 });
    await page.waitForFunction(() => xrSession.handsTable && xrSession.scaleMode === 'table' && xrSession.placed, null, { timeout: 30_000 }).catch(() => {});
    const xr = await page.evaluate(() => ({ hands: xrSession.input.sides.right.type, table: !!xrSession.handsTable, mode: xrSession.scaleMode, scale: +xrSession.rig.scale.x.toFixed(3),
      panel: !!xrSession.panel, handsOn: !!xrSession.handsOn }));
    check(xr.hands === 'hand' && xr.table && xr.mode === 'table', K + `VR with hands only: input ${xr.hands}, mode ${xr.mode}, kit shown at ${(1 / xr.scale).toFixed(2)} of real size, panel ${xr.panel}`);
    if (SHOTS && kit.shots.vr) {   // look down at the table for the picture (the emulated headset starts level)
      await page.evaluate(() => { const a = -38 * Math.PI / 360; xrDevice.quaternion.set(Math.sin(a), 0, 0, Math.cos(a)); });
      await page.waitForTimeout(2500);
      await shot(page, kit.shots.vr);
      await page.evaluate(() => xrDevice.quaternion.set(0, 0, 0, 1));
      await page.waitForTimeout(300);
    }
    const w = await page.evaluate(WALK);
    check(w.input === 'hand' && w.snapped === kit.parts && w.carries === kit.parts && !w.fails.length && w.stuck === null && !w.wrong.length,
      K + `hands-only walk: ${w.snapped} of ${kit.parts} parts placed, ${w.fails.length} fail(s), ${w.seconds} s` + (w.fails.length ? ' - ' + JSON.stringify(w.fails.slice(0, 4)) : '') + (w.stuck !== null ? ` - stuck at step ${w.stuck}` : ''));
    await page.evaluate(() => xrSession.exit());
    await page.waitForFunction(() => !window.xrSession, null, { timeout: 30_000 });
    check(msgs().length === 0, K + 'VR: no console errors / failed requests' + (msgs().length ? ' - ' + msgs().slice(0, 4).join(' | ') : ''));
    await ctx.close();
  }

  await browser.close();
  console.log(fails.length ? `\n${fails.length} check(s) FAILED` : ONLY ? `\nall checks passed for ${ONLY} only (partial run)` : '\nall checks passed');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
