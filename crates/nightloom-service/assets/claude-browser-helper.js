// Claude's browser, the helper (nightshift item 508): one headless WebKit
// for one chat, owned by the Nightloom app and kept between messages.
//
//   node claude-browser-helper.js <install dir>
//
// <install dir> holds the pinned `node_modules/playwright-core` the MCP
// server runs from. Public Playwright calls only. WebKit only: one engine,
// one launch, logins kept in memory (they end with this process), and none
// of Playwright's own viewer apps.
//
// One JSON object per line each way.
//   in : {op:"watch",on} {op:"input",input} {op:"nav",action,url}
//        {op:"dialogs",auto} {op:"status"} {op:"close"}; end of stdin closes.
//   out: {ev:"ready",endpoint} {ev:"status",url,title,pages}
//        {ev:"frame",seq,jpeg,w,h} {ev:"dialog",kind,message,answered}
//        {ev:"error",message}
// Frames go to the app's window and nowhere else; the model never sees one.
'use strict';
const path = require('path');
const readline = require('readline');

const WIDTH = 1280;
const HEIGHT = 800;
// Item 550: the page draws at 2 device pixels per CSS pixel, so the tab can
// be sharp on a Retina display (it showed a 1280-px frame stretched over
// ~3000 device pixels). WebKit's screencast never sends frames larger than
// the CSS viewport (measured: 1280×800 at any size asked, any scale), so
// while the page moves the tab shows those, and once it has been still for
// SETTLE_MS a full-resolution screenshot (2560×1600, ~60–90 ms, ~110 KB)
// replaces the last one. The page and what the model reads are unchanged:
// the viewport is still 1280×800 CSS px, and the MCP server's screenshots
// default to CSS scale. The MCP server attaches with --endpoint and no
// --isolated, so it uses this context (`browser.contexts()[0]`).
const SCALE = 2;
const QUALITY = 80;
const SETTLE_MS = 250;

const out = (o) => {
  try {
    process.stdout.write(JSON.stringify(o) + '\n');
  } catch {}
};
const fail = (what, e) => out({ ev: 'error', message: what + ': ' + ((e && e.message) || e) });

let browser = null;
let active = null; // the page shown and acted on
let watching = false;
let casting = null; // the page whose screencast runs
let seq = 0;
let autoDialogs = true;
let last = '';
let closing = false;
const seenContexts = new Set();
const seenPages = new Set();

function pages() {
  return browser ? browser.contexts().flatMap((c) => c.pages()) : [];
}

async function status(force) {
  const all = pages();
  if (active && (active.isClosed() || !all.includes(active))) active = null;
  if (!active) active = all[all.length - 1] || null;
  let url = '';
  let title = '';
  if (active) {
    url = active.url();
    title = await active.title().catch(() => '');
  }
  const line = JSON.stringify({ url, title, pages: all.length });
  if (force || line !== last) {
    last = line;
    out({ ev: 'status', url, title, pages: all.length });
  }
  await recast();
}

// The screencast follows the active page, and runs only while watched.
async function recast() {
  const want = watching ? active : null;
  if (casting === want) return;
  const old = casting;
  casting = want;
  if (old && !old.isClosed()) await old.screencast.stop().catch(() => {});
  if (!want) return;
  let got = false;
  let settle = null;
  let shooting = false;
  // The sharp still: taken once the page has stopped changing. A frame the
  // shot itself causes (WebKit repaints for it) does not start another.
  const sharp = async () => {
    settle = null;
    if (casting !== want || want.isClosed()) return;
    shooting = true;
    try {
      const data = await want.screenshot({ type: 'jpeg', quality: QUALITY });
      if (casting === want) out({ ev: 'frame', seq: ++seq, jpeg: data.toString('base64'), w: WIDTH, h: HEIGHT });
    } catch {}
    setTimeout(() => (shooting = false), 60);
  };
  const onFrame = ({ data }) => {
    if (casting !== want) return;
    got = true;
    if (shooting) return;
    out({ ev: 'frame', seq: ++seq, jpeg: data.toString('base64'), w: WIDTH, h: HEIGHT });
    if (settle) clearTimeout(settle);
    settle = setTimeout(sharp, SETTLE_MS);
  };
  try {
    await want.screencast.start({ size: { width: WIDTH * SCALE, height: HEIGHT * SCALE }, quality: QUALITY, onFrame });
  } catch (e) {
    casting = null;
    return fail('screencast', e);
  }
  // A still page sends nothing: one picture so the tab is never blank.
  setTimeout(async () => {
    if (got || casting !== want || want.isClosed()) return;
    try {
      const data = await want.screenshot({ type: 'jpeg', quality: QUALITY });
      if (!got && casting === want)
        out({ ev: 'frame', seq: ++seq, jpeg: data.toString('base64'), w: WIDTH, h: HEIGHT });
    } catch {}
  }, 400);
}

function trackPage(p) {
  if (seenPages.has(p)) return;
  seenPages.add(p);
  active = p; // a new page (target=_blank, the model's new tab) is the one shown
  p.on('close', () => {
    seenPages.delete(p);
    if (casting === p) casting = null;
    status().catch(() => {});
  });
  p.on('framenavigated', (f) => {
    if (f === p.mainFrame()) status().catch(() => {});
  });
  p.on('load', () => status().catch(() => {}));
  p.on('dialog', async (d) => {
    const kind = d.type() === 'beforeunload' ? 'confirm' : d.type();
    out({ ev: 'dialog', kind, message: d.message(), answered: autoDialogs });
    // Answered here only when nobody else will: the user holds the browser,
    // or no message is running. Otherwise it is the model's to handle.
    if (!autoDialogs) return;
    try {
      if (kind === 'prompt') await d.accept('');
      else await d.accept();
    } catch {}
  });
  p.on('filechooser', async (fc) => {
    out({ ev: 'dialog', kind: 'file', message: '', answered: autoDialogs });
    if (!autoDialogs) return;
    try {
      await fc.setFiles([]);
    } catch {}
  });
}

function sweep() {
  if (!browser) return;
  for (const c of browser.contexts()) {
    if (!seenContexts.has(c)) {
      seenContexts.add(c);
      c.on('page', (p) => {
        trackPage(p);
        status().catch(() => {});
      });
      c.on('close', () => seenContexts.delete(c));
    }
    for (const p of c.pages()) trackPage(p);
  }
}

const MODS = new Set(['Alt', 'Control', 'Meta', 'Shift']);

async function input(i) {
  const p = active;
  if (!p || p.isClosed()) return;
  const mods = (i.modifiers || []).filter((m) => MODS.has(m));
  switch (i.kind) {
    case 'click': {
      for (const m of mods) await p.keyboard.down(m);
      try {
        await p.mouse.click(i.x, i.y, {
          button: ['left', 'right', 'middle'].includes(i.button) ? i.button : 'left',
          clickCount: i.clicks === 2 ? 2 : 1,
        });
      } finally {
        for (const m of mods.reverse()) await p.keyboard.up(m).catch(() => {});
      }
      break;
    }
    case 'move':
      await p.mouse.move(i.x, i.y);
      break;
    case 'wheel':
      await p.mouse.move(i.x, i.y);
      await p.mouse.wheel(i.dx || 0, i.dy || 0);
      break;
    case 'key': {
      const key = String(i.key || '');
      if (!key) break;
      await p.keyboard.press(mods.length && !key.includes('+') ? mods.concat(key).join('+') : key);
      break;
    }
    case 'text':
      await p.keyboard.insertText(String(i.text || ''));
      break;
    default:
      throw new Error('unknown input kind ' + i.kind);
  }
}

async function nav(action, url) {
  const p = active;
  if (!p || p.isClosed()) return;
  const opts = { waitUntil: 'commit', timeout: 30000 };
  if (action === 'back') await p.goBack(opts);
  else if (action === 'forward') await p.goForward(opts);
  else if (action === 'reload') await p.reload(opts);
  else if (action === 'goto') {
    let u = String(url || '').trim();
    if (!u) return;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
    await p.goto(u, opts);
  } else throw new Error('unknown navigation ' + action);
}

async function close() {
  if (closing) return;
  closing = true;
  try {
    if (browser) await browser.close();
  } catch {}
  process.exit(0);
}

// One command at a time, in the order they arrived.
let chain = Promise.resolve();
function handle(line) {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  chain = chain
    .then(async () => {
      switch (m.op) {
        case 'watch':
          watching = !!m.on;
          await recast();
          break;
        case 'input':
          await input(m.input || {});
          break;
        case 'nav':
          await nav(m.action, m.url);
          break;
        case 'dialogs':
          autoDialogs = !!m.auto;
          break;
        case 'status':
          await status(true);
          break;
        case 'close':
          await close();
          break;
      }
    })
    .catch((e) => fail(m.op || 'command', e));
}

(async () => {
  const pw = require(path.join(process.argv[2], 'node_modules', 'playwright-core'));
  browser = await pw.webkit.launch({ headless: true });
  browser.on('disconnected', () => process.exit(0));
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: SCALE });
  await context.newPage();
  sweep();
  const { endpoint } = await browser.bind('nightloom-claude-browser-' + process.pid, {
    workspaceDir: process.argv[2],
  });
  out({ ev: 'ready', endpoint });
  await status(true);
  // Contexts the MCP server makes are not announced; look once a second,
  // and catch a title that changed without a navigation.
  setInterval(() => {
    sweep();
    status().catch(() => {});
  }, 1000);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', handle);
  rl.on('close', close);
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
})().catch((e) => {
  fail('start', e);
  process.exit(1);
});
