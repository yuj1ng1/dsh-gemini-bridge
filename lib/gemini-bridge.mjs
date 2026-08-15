// gemini-bridge.mjs
// A full-Node bridge that drives the user's Edge browser (Chromium CDP) to
// gemini.google.com, uploads an image, sends a prompt, and returns the reply.
//
// Usage:
//   node gemini-bridge.mjs <command> <argsJson>
//
// Commands:
//   ensure       launch Edge with a dedicated automation profile on the CDP port
//                (no interaction; prints JSON {ok, port, edge, profile})
//   vision       open/reuse a gemini.google.com tab, upload <imagePath>,
//                type <prompt>, send, wait for the model reply, print
//                JSON {ok, text, url, model}
//
// argsJson fields:
//   port          CDP debugging port (default 9229)
//   edgePath      absolute path to msedge.exe
//   profileDir    dedicated user-data-dir (never the user's normal profile)
//   imagePath     absolute path to the image to upload (vision)
//   prompt        prompt text (vision)
//   headless      if true, run Edge headless=new (default false)
//   newChat       if true, click "New chat" first (default false)
//   timeoutMs     overall budget (default 240000)

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const [, , cmd, argsPath] = process.argv;

function loadArgs() {
  if (!argsPath) return {};
  try {
    return JSON.parse(readFileSync(argsPath, 'utf8'));
  } catch {
    return {};
  }
}

const args = loadArgs();
const PORT = args.port ?? 9229;
const EDGE = args.edgePath ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = args.profileDir ?? 'D:\\dsp use1\\.gemini\\edge-profile';
const HEADLESS = args.headless === true;
const TIMEOUT_MS = args.timeoutMs ?? 240000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function fail(obj) {
  out({ ok: false, ...obj });
  process.exit(0);
}

function edgeRunning() {
  return new Promise((resolve) => {
    const req = new Promise((res) => {
      const r = fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })
        .then((x) => x.json())
        .then(res)
        .catch(() => res(null));
    });
    req.then((v) => resolve(!!v && typeof v.webSocketDebuggerUrl === 'string'));
  });
}

function launchEdge() {
  return new Promise((resolve, reject) => {
    if (!existsSync(EDGE)) {
      reject(new Error(`Edge not found at ${EDGE}`));
      return;
    }
    const flags = [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msEdgeFirstRunExperience',
      '--disable-sync',
      '--disable-background-networking',
      '--noerrdialogs',
      '--window-size=1280,900',
      'about:blank',
    ];
    if (HEADLESS) flags.unshift('--headless=new');
    const child = spawn(EDGE, flags, { detached: true, stdio: 'ignore' });
    child.unref();
    // Wait up to 20s for the debug endpoint.
    const start = Date.now();
    const poll = async () => {
      if (await edgeRunning()) return resolve(child);
      if (Date.now() - start > 20000) {
        reject(new Error('Edge did not expose the CDP endpoint in time'));
        return;
      }
      setTimeout(poll, 500);
    };
    poll();
  });
}

// ---- minimal CDP client over the page WebSocket ----
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method && this.listeners.has(msg.method)) {
        for (const fn of this.listeners.get(msg.method)) {
          try {
            fn(msg.params);
          } catch {}
        }
      }
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('WebSocket connect failed'));
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function jsonList() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

async function createTarget(url) {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  return r.json();
}

async function findGeminiTab() {
  const list = await jsonList();
  const pages = (list || []).filter((t) => t.type === 'page');
  return pages.find((t) => t.url && t.url.includes('gemini.google.com')) || null;
}

// Evaluate JS in the page; returns the value or null on error.
async function evalJs(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error('page eval failed: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'unknown'));
  }
  return res.result && res.result.value;
}

async function waitFor(cdp, expression, timeoutMs = 30000, intervalMs = 1000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await evalJs(cdp, expression);
    if (last) return last;
    await sleep(intervalMs);
  }
  return last || null;
}

// ---- vision flow ----
async function runVision() {
  // filePath (any type) is the generic attachment; imagePath is kept as an
  // alias for image-only callers.
  const filePath = args.filePath || args.imagePath || null;
  const chatId = args.chatId || '';
  const prompt = args.prompt ?? 'Describe this image in detail.';

  // 1. Ensure Edge is up.
  if (!(await edgeRunning())) {
    await launchEdge();
  }

  // 2. Find or create a gemini tab.
  let tab = await findGeminiTab();
  if (!tab) {
    tab = await createTarget('https://gemini.google.com/');
  }
  if (!tab || !tab.webSocketDebuggerUrl) {
    fail({ error: 'no gemini tab and could not create one' });
  }

  const cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');

    // 3. Navigate — to the given chat when chatId is set (continue a
    //    conversation), otherwise a fresh chat; unless the tab is already
    //    mid-login (accounts.google.com), which we must not interrupt.
    const currentUrl = await evalJs(cdp, 'location.href').catch(() => '');
    if (typeof currentUrl === 'string' && currentUrl.includes('accounts.google.com')) {
      // Stay on the login page; let the user finish signing in.
      const pageInfo = await evalJs(cdp, `({url: location.href, title: document.title})`).catch(() => null);
      fail({
        error: 'gemini.google.com is not logged in — finish the sign-in in the automation Edge window, then retry',
        needsLogin: true,
        page: pageInfo,
      });
    }
    const targetUrl = chatId
      ? 'https://gemini.google.com/app/' + encodeURIComponent(chatId)
      : 'https://gemini.google.com/app';
    await cdp.send('Page.navigate', { url: targetUrl });
    await sleep(2500);

    // If we are NOT continuing a chat, force a fresh conversation so the
    // composer is guaranteed clean (no leftover attachments or an upload
    // dialog stuck in a weird state from a previous run).
    if (!chatId) {
      await evalJs(cdp, `(() => {
        const els = [...document.querySelectorAll('button, [role="button"], a')];
        const b = els.find((e) => {
          const a = (e.getAttribute('aria-label') || '').toLowerCase();
          const t = (e.innerText || '').trim().toLowerCase();
          // Prefer the explicit "New chat" nav item (href /app); skip the
          // sidebar "Gemini" brand link (also aria "New chat", href "/").
          if (a === 'new chat' && t === 'new chat') return true;
          return false;
        });
        if (b) { b.click(); return true; }
        return false;
      })()`).catch(() => null);
      await sleep(2000);
    }

    // 4. Wait for the composer (contenteditable) — the login wall shows otherwise.
    const composerSel = `(() => {
      const el = document.querySelector('rich-textarea') || document.querySelector('div[contenteditable="true"]');
      return !!el;
    })()`;
    const ready = await waitFor(cdp, composerSel, 30000, 1000);
    if (!ready) {
      const pageInfo = await evalJs(cdp, `({url: location.href, title: document.title})`).catch(() => null);
      const needsLogin = !!(pageInfo && pageInfo.url && pageInfo.url.includes('accounts.google.com'));
      fail({
        error: 'gemini composer not found — ' + (needsLogin ? 'not logged in' : 'page did not reach the chat composer'),
        needsLogin,
        page: pageInfo,
      });
    }

    // 4b. Even with a composer present, the page may still show a login wall
    // (Gemini renders a sign-in button without redirecting). Detect it so the
    // caller can ask the user to log in.
    const loginState = await evalJs(cdp, `(() => {
      const btns = [...document.querySelectorAll('button, [role="button"], a')];
      const hasSignIn = btns.some((e) => {
        const a = (e.getAttribute('aria-label') || '').toLowerCase();
        const t = (e.innerText || '').trim().toLowerCase();
        return a === '登录' || a === 'sign in' || a.includes('sign in') || t === '登录' || t === 'sign in';
      });
      return { hasSignIn, url: location.href };
    })()`).catch(() => null);
    if (loginState && loginState.hasSignIn) {
      fail({
        error: 'gemini.google.com is not logged in (sign-in button present)',
        needsLogin: true,
        page: { url: loginState.url },
      });
    }

    // 5. (New chat for non-continued calls is already forced above; the
    //    `newChat` flag only matters when continuing a chat with chatId.)

    // 5b. Clean slate: close any leftover dialog/menu from a previous run and,
    //     for text-only calls, drop stale attachments so they are not sent.
    await evalJs(cdp, `(() => {
      const dlg = document.querySelector('[role="dialog"]');
      if (dlg) {
        const close = [...dlg.querySelectorAll('button')].find((b) => {
          const a = (b.getAttribute('aria-label') || '').toLowerCase();
          return a.includes('close');
        });
        if (close) close.click();
      }
      return !!dlg;
    })()`).catch(() => null);
    // Always clear leftover attachments from the composer (both for text-only
    // calls and before uploading a new file), via the "close attachment"
    // button or by removing the file chips.
    await evalJs(cdp, `(() => {
      const close = [...document.querySelectorAll('button')].find((b) => {
        const a = (b.getAttribute('aria-label') || '').toLowerCase();
        return a === 'close attachment';
      });
      if (close) { close.click(); return 'close-btn'; }
      const chips = [...document.querySelectorAll('mat-basic-chip, [class*="file-preview-chip"], gem-media-attachment, uploader-file-preview')];
      for (const chip of chips) {
        const remove = chip.querySelector('button[aria-label*="remove"], button[aria-label*="Remove"], [aria-label*="删除"], [aria-label*="移除"]');
        if (remove) { remove.click(); }
        else { chip.remove(); }
      }
      return chips.length > 0 ? 'chips-removed' : 'clean';
    })()`).catch(() => null);
    await sleep(1000);

    // 6. Upload the file through the composer's file input.
    if (filePath) {
      // Verified flow: click the composer's "Upload & tools" button, which
      // mounts a hidden <input type="file">; then DOM.setFileInputFiles the
      // file directly (the accept attribute is not enforced by CDP, so any
      // file type — image, PDF, text, code — uploads).
      let diag = null;
      try {
        diag = await evalJs(cdp, `(() => {
          const btns = [...document.querySelectorAll('button, [role="button"]')].map((e) => ({
            aria: e.getAttribute('aria-label') || '',
          })).filter((b) => b.aria).slice(0, 40);
          return { buttons: btns };
        })()`);
      } catch { /* keep diag null */ }

      // Open the upload dialog FIRST (click at most once — repeated clicks
      // toggle it), then wait for the file input to mount.
      await evalJs(cdp, `(() => {
        const els = [...document.querySelectorAll('button, [role="button"]')];
        const label = (e) => (e.getAttribute('aria-label') || '').toLowerCase();
        const b = els.find((e) => {
          const l = label(e);
          // Exact composer upload button. NEVER match "More options for
          // <chat title>" sidebar buttons (titles may contain "上传").
          if (l.startsWith('more options')) return false;
          return l === 'upload & tools' || l === 'add files' || l === 'add image'
            || l.includes('插入图片') || (l.includes('添加文件') && !l.includes('more'));
        });
        if (b) { b.click(); return true; }
        return false;
      })()`).catch(() => null);
      await sleep(1500);

      // Wait for the file input to mount (poll until found).
      let nodeIds = [];
      const startPoll = Date.now();
      while (Date.now() - startPoll < 12000) {
        const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
        const q = await cdp.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type="file"]' });
        nodeIds = (q && q.nodeIds) || [];
        if (nodeIds.length > 0) break;
        await sleep(1000);
      }

      if (nodeIds.length === 0) {
        const probe = await evalJs(cdp, `(() => {
          const all = [];
          const walk = (root) => {
            const inputs = root.querySelectorAll ? root.querySelectorAll('input[type="file"]') : [];
            inputs.forEach((el) => all.push({ aria: el.getAttribute('aria-label') || '', accept: (el.getAttribute('accept') || '').slice(0, 120) }));
            const roots = root.querySelectorAll ? root.querySelectorAll('*') : [];
            roots.forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
          };
          walk(document);
          return all.slice(0, 10);
        })()`).catch(() => null);
        fail({ error: 'no file input after opening upload dialog', diag, probe });
      }

      let set = false;
      for (const nodeId of nodeIds) {
        try {
          await cdp.send('DOM.setFileInputFiles', { files: [filePath], nodeId });
          set = true;
          break;
        } catch { /* try the next candidate */ }
      }
      if (!set) {
        fail({ error: 'DOM.setFileInputFiles failed for all file inputs', diag });
      }

      // Wait until an attachment preview appears in the composer. Images show
      // as <img class="gem-attachment-style-img">; documents show as a file
      // chip (UPLOADER-FILE-PREVIEW / file-preview-chip). Accept either.
      const previewSeen = await waitFor(cdp, `(() => {
        const imgs = [...document.querySelectorAll('img.gem-attachment-style-img, rich-textarea img, [class*="attachment"] img')];
        const chips = [...document.querySelectorAll('uploader-file-preview, [class*="file-preview-chip"], [class*="attachment-preview"]')];
        return imgs.length > 0 || chips.length > 0;
      })()`, 15000, 1000);
      if (!previewSeen) {
        fail({ error: 'file did not appear as an attachment in the composer' });
      }
      // The upload dialog stays open with the file in its preview; pressing
      // Escape commits the attachment into the composer (verified: the chip
      // survives and the dialog closes). Without this, sending drops the file.
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(800);
      const dlgStillOpen = await evalJs(cdp, `(() => {
        const d = document.querySelector('[role="dialog"]');
        return d ? d.offsetParent !== null : false;
      })()`).catch(() => false);
      if (dlgStillOpen) {
        // Fallback: click the dialog's close button.
        await evalJs(cdp, `(() => {
          const d = document.querySelector('[role="dialog"]');
          if (!d) return false;
          const c = [...d.querySelectorAll('button')].find((b) => {
            const a = (b.getAttribute('aria-label') || '').toLowerCase();
            return a.includes('close');
          });
          if (c) { c.click(); return true; }
          return false;
        })()`).catch(() => null);
        await sleep(1000);
      }

      // Wait for the attachment to be FULLY ready before typing: large files
      // (e.g. screenshots) keep uploading after the chip appears. The send
      // button becomes enabled only once the attachment is committed, so use
      // it as the primary signal (a stray progress spinner may exist page-wide
      // for unrelated reasons). Then settle a moment so the upload cannot be
      // raced.
      // Wait for the attachment to be FULLY ready before typing: the send
      // button enables as soon as text is present, NOT when the upload is
      // done, so we additionally require the attachment's blob URL to have
      // settled (it changes while the file is still uploading).
      const attachReady = await waitFor(cdp, `(() => {
        const chips = [...document.querySelectorAll('uploader-file-preview, [class*="file-preview-chip"], img.gem-attachment-style-img, gem-media-attachment, [class*="attachment-preview"]')];
        const imgs = [...document.querySelectorAll('img.gem-attachment-style-img')].map((i) => i.src || '');
        const key = imgs.join('|');
        const settled = imgs.length === 0 || (window.__gemLastBlob !== undefined && window.__gemLastBlob === key);
        window.__gemLastBlob = key;
        return chips.length > 0 && settled;
      })()`, 20000, 1000);
      // Extra settling so a just-finished upload cannot be raced.
      await sleep(1500);
      try {
        const dbg = {
          attachReady,
          chips: await evalJs(cdp, `(() => document.querySelectorAll('uploader-file-preview, [class*="file-preview-chip"], img.gem-attachment-style-img').length)`).catch(() => '?'),
          closeBtn: await evalJs(cdp, `(() => [...document.querySelectorAll('button')].some((b) => (b.getAttribute('aria-label') || '').toLowerCase() === 'close attachment'))`).catch(() => '?'),
          filePath,
        };
        writeFileSync('D:\\\\dsp use1\\\\.gemini\\\\vision-debug.json', JSON.stringify(dbg, null, 2));
      } catch {}
      if (!attachReady) {
        fail({ error: 'attachment did not become ready (upload may still be in progress)', diag });
      }
    }

    // 7. Focus the composer and type the prompt.
    const focused = await evalJs(cdp, `(() => {
      const el = document.querySelector('rich-textarea div[contenteditable="true"]')
        || document.querySelector('div[contenteditable="true"]');
      if (!el) return false;
      el.focus();
      return true;
    })()`);
    if (!focused) {
      fail({ error: 'composer focus failed' });
    }
    await cdp.send('Input.insertText', { text: prompt });
    await sleep(600);

    // 8. Send — click the send button if present, else press Enter.
    const sent = await evalJs(cdp, `(() => {
      const els = [...document.querySelectorAll('button')];
      const b = els.find((e) => {
        const a = (e.getAttribute('aria-label') || '').toLowerCase();
        return a === 'send message' || a === 'send';
      });
      if (b) { b.click(); return true; }
      return false;
    })()`).catch(() => false);
    if (!sent) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }

    // 9. Wait for the model response to stop streaming.
    //    Record the pre-send response count so a continued conversation does
    //    not mistake the existing history for the new reply; then wait for the
    //    count to grow (or, in a fresh chat, for any text) and for the text to
    //    stop growing with no "Stop" button.
    const preCount = await evalJs(cdp, `(() => {
      return document.querySelectorAll('.model-response-text, [data-test-id="response-text"]').length;
    })()`).catch(() => 0);
    const start = Date.now();
    let lastLen = -1;
    let stableRounds = 0;
    let text = '';
    let url = '';
    while (Date.now() - start < TIMEOUT_MS) {
      const state = await evalJs(cdp, `(() => {
        const blocks = [...document.querySelectorAll('.model-response-text, [data-test-id="response-text"], .markdown')];
        const count = document.querySelectorAll('.model-response-text, [data-test-id="response-text"]').length;
        const t = blocks.length ? blocks[blocks.length - 1].innerText : '';
        const stop = [...document.querySelectorAll('button')].some((e) => {
          const a = (e.getAttribute('aria-label') || '').toLowerCase();
          return a === 'stop' || a.includes('stop generating');
        });
        return { text: t, count, generating: stop, url: location.href };
      })()`).catch(() => null);
      if (!state) { await sleep(1000); continue; }
      text = (state.text || '').trim();
      url = state.url;
      const len = text.length;
      const isNew = state.count > preCount || preCount === 0;
      if (len > 0 && !state.generating && isNew) {
        if (len === lastLen) {
          stableRounds += 1;
          if (stableRounds >= 2) break;
        } else {
          stableRounds = 0;
        }
      } else {
        stableRounds = 0;
      }
      lastLen = len;
      await sleep(1500);
    }

    if (!text) {
      fail({ error: 'no response text received from Gemini', url });
    }
    out({ ok: true, text, url, model: null });
  } finally {
    cdp.close();
  }
}

// ---- ensure command ----
async function runEnsure() {
  let launched = false;
  if (!(await edgeRunning())) {
    await launchEdge();
    launched = true;
  }
  const ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null);
  out({
    ok: true,
    port: PORT,
    edge: EDGE,
    profile: PROFILE,
    launched,
    browser: ver ? ver.Browser : null,
  });
}

// ---- list chats command ----
async function runListChats() {
  if (!(await edgeRunning())) {
    await launchEdge();
  }
  let tab = await findGeminiTab();
  if (!tab) {
    tab = await createTarget('https://gemini.google.com/');
  }
  if (!tab || !tab.webSocketDebuggerUrl) {
    fail({ error: 'no gemini tab and could not create one' });
  }
  const cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Page.navigate', { url: 'https://gemini.google.com/app' });
    await sleep(2500);

    // Wait until the Recents toggle exists (sidebar rendered).
    await waitFor(cdp, `(() => {
      const b = document.querySelector('button[data-test-id="expandable-section-toggle"][aria-controls="sidenav-section-content-chats"]');
      return !!b;
    })()`, 15000, 1000);

    // Open the "Recents" expandable section so the chat list renders.
    await evalJs(cdp, `(() => {
      const b = document.querySelector('button[data-test-id="expandable-section-toggle"][aria-controls="sidenav-section-content-chats"]');
      if (b && b.getAttribute('aria-expanded') !== 'true') { b.click(); return true; }
      return false;
    })()`).catch(() => null);
    // Wait for links to appear inside the section.
    await waitFor(cdp, `(() => {
      const section = document.querySelector('#sidenav-section-content-chats');
      return section ? section.querySelectorAll('a[href*="/app/"]').length > 0 : false;
    })()`, 15000, 1000);

    // Collect chat links. Prefer the chats section, fall back to all /app/
    // links on the page (dedup, exclude the bare /app and current chat).
    const chats = await evalJs(cdp, `(() => {
      const seen = new Set();
      const out = [];
      const push = (a) => {
        const href = a.getAttribute('href') || '';
        const title = (a.getAttribute('aria-label') || a.innerText || '').trim();
        if (!href || !href.startsWith('/app/') || seen.has(href)) return;
        seen.add(href);
        out.push({ id: href.replace('/app/', ''), title: title.slice(0, 120) });
      };
      const section = document.querySelector('#sidenav-section-content-chats');
      const scope = section && section.querySelectorAll('a[href*="/app/"]').length > 0
        ? section : document;
      for (const a of scope.querySelectorAll('a[href*="/app/"]')) push(a);
      return out.slice(0, 100);
    })()`).catch(() => null);

    if (!Array.isArray(chats) || chats.length === 0) {
      const pageInfo = await evalJs(cdp, `({url: location.href, title: document.title})`).catch(() => null);
      fail({ error: 'no chats found (sidebar may be collapsed)', page: pageInfo });
    }
    out({ ok: true, chats });
  } finally {
    cdp.close();
  }
}

// ---- read chat command ----
async function runReadChat() {
  const chatId = args.chatId;
  if (!chatId) {
    fail({ error: 'chatId is required' });
  }
  if (!(await edgeRunning())) {
    await launchEdge();
  }
  let tab = await findGeminiTab();
  if (!tab) {
    tab = await createTarget('https://gemini.google.com/app/' + chatId);
  }
  if (!tab || !tab.webSocketDebuggerUrl) {
    fail({ error: 'no gemini tab and could not create one' });
  }
  const cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Page.navigate', { url: 'https://gemini.google.com/app/' + chatId });
    await sleep(3000);

    // Wait for the message blocks to render.
    const ready = await waitFor(cdp, `(() => {
      const q = document.querySelectorAll('.query-text').length;
      const m = document.querySelectorAll('.model-response-text').length;
      return q > 0 || m > 0;
    })()`, 25000, 1000);

    const state = await evalJs(cdp, `(() => {
      const users = [...document.querySelectorAll('.query-text')];
      const models = [...document.querySelectorAll('.model-response-text')];
      const clean = (t) => t.replace(/^You said\\s*/i, '').trim();
      return {
        url: location.href,
        title: document.title,
        users: users.map((e) => clean(e.innerText || '')).slice(0, 60),
        models: models.map((e) => (e.innerText || '').trim()).slice(0, 60),
      };
    })()`).catch(() => null);

    if (!ready || !state) {
      fail({ error: 'chat messages did not load', state });
    }
    out({ ok: true, chat: state });
  } finally {
    cdp.close();
  }
}

// ---- screenshot command ----
// Capture the user's screen with a small PowerShell helper (the plugin spawns
// this bridge unconfined, so child PowerShell has full access), then send the
// screenshot through the same vision flow with a default prompt.
function captureScreen(outPath) {
  const psScript = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
    `$bmp.Save('${outPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose(); $bmp.Dispose()',
  ].join('; ');
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-Command', psScript], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function runScreenshot() {
  const outPath = args.outPath || 'D:\\dsp use1\\.gemini\\screen-capture.png';
  console.error('[screenshot] start, outPath=', outPath);

  // The automation Edge window normally sits on top; minimize it before
  // capturing so the user's actual screen is visible, then restore it.
  let cdp = null;
  let tabId = null;
  try {
    if (await edgeRunning()) {
      let tab = await findGeminiTab();
      if (tab && tab.webSocketDebuggerUrl) {
        tabId = tab.id;
        cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
        const win = await cdp.send('Browser.getWindowForTarget', { targetId: tab.id }).catch(() => null);
        if (win && win.windowId) {
          await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'minimized' } }).catch(() => {});
        }
        // Give the OS time to actually hide the window before capturing.
        await sleep(2500);
      }
    }

    const res = await captureScreen(outPath);
    console.error('[screenshot] captured code=', res.code, 'err=', res.stderr.slice(0, 200));
    if (res.code !== 0) {
      fail({ error: 'screenshot failed: ' + res.stderr.slice(0, 500) });
    }
  } finally {
    // Restore the Edge window.
    if (cdp && tabId) {
      try {
        const win = await cdp.send('Browser.getWindowForTarget', { targetId: tabId });
        if (win && win.windowId) {
          await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } });
        }
      } catch {}
      cdp.close();
    }
  }

  // Now run the normal vision flow with the screenshot as the attachment.
  args.filePath = outPath;
  args.prompt = args.prompt || '请详细描述这张屏幕截图的内容，包括所有可见的窗口、文字、界面元素等。';
  try {
    writeFileSync('D:\\\\dsp use1\\\\.gemini\\\\screen-dbg.json', JSON.stringify({ filePath: args.filePath, prompt: args.prompt, rawPrompt: args.prompt }, null, 2));
  } catch {}
  console.error('[screenshot] calling runVision, filePath=', outPath);
  return runVision();
}

async function main() {
  try {
    if (cmd === 'ensure') return await runEnsure();
    if (cmd === 'vision') return await runVision();
    if (cmd === 'chats') return await runListChats();
    if (cmd === 'read') return await runReadChat();
    if (cmd === 'screenshot') return await runScreenshot();
    fail({ error: 'unknown command: ' + cmd });
  } catch (err) {
    fail({ error: String(err && err.message ? err.message : err) });
  }
}

main();
