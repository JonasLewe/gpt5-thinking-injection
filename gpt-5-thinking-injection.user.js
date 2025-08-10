// ==UserScript==
// @name         Chat Auto-Reasoning Prompt — Refill + UI (Fill-only new chat, iframe-aware)
// @namespace    https://local.example
// @version      0.12.2
// @description  After every send/assistant reply, pre-fills the composer with PHRASE + 2 blank lines; on a new empty chat it only fills (no auto-send). Includes UI toggle. Shadow DOM and iframe aware.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  const PHRASE = 'Please think extensively before answering!!!';
  const LS_KEY_ENABLED = '__autoReason_enabled';

  const MODE = {
    prefixEveryMessage: true,
    autoPrimeOnNewChat: true,
    refillAfterSend: true,
    autoInsertAfterAssistant: true,
    autoSendAfterAssistant: false,

    assistantStableWindowMs: 700,
    assistantStableMaxWaitMs: 6000,
    guardWhileAssistantStreaming: true,

    debug: false,
    debounceMs: 150,
    primeCooldownMs: 2500,
    afterAssistantDelayMs: 600,
    refillWaitMaxMs: 30000,
    refillPollMs: 120
  };

  const log = (...a) => MODE.debug && console.debug('[auto-reason]', ...a);
  const rIC = window.requestIdleCallback || ((fn) => setTimeout(fn, 1));
  const injectedText = () => `${PHRASE}\n\n`;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ---------- persistent state (UI) ----------
  const state = { enabled: readEnabled() };
  function readEnabled() { const v = localStorage.getItem(LS_KEY_ENABLED); return v === null ? true : v === '1'; }
  function writeEnabled(on) { localStorage.setItem(LS_KEY_ENABLED, on ? '1' : '0'); }

  // ---------- visibility ----------
  function visible(el) {
    if (!el) return false;
    try { if (el.offsetParent !== null) return true; } catch {}
    const r = el.getBoundingClientRect?.();
    return !!r && r.width > 0 && r.height > 0;
  }

  // ---------- roots (docs + shadows + iframes) ----------
  const __docs = new Set();
  const __shadows = new Set();
  const __docObservers = new Map();

  function addDocument(doc) {
    if (!doc || __docs.has(doc)) return;
    __docs.add(doc);

    const mo = new doc.defaultView.MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.removedNodes || []) {
          if (n.nodeType === 1 && n.tagName === 'IFRAME') {
            try {
              const idoc = n.contentDocument;
              const ob = __docObservers.get(idoc);
              if (ob) { ob.disconnect(); __docObservers.delete(idoc); __docs.delete(idoc); }
            } catch {}
          }
        }
        for (const n of m.addedNodes || []) {
          if (n.nodeType !== 1) continue;
          if (n.tagName === 'IFRAME') hookIframe(n);
          harvestShadows(n);
          for (const iframe of n.querySelectorAll?.('iframe') || []) hookIframe(iframe);
        }
      }
    });
    mo.observe(doc.documentElement || doc, { childList: true, subtree: true });
    __docObservers.set(doc, mo);

    for (const iframe of doc.querySelectorAll('iframe')) hookIframe(iframe);
    harvestShadows(doc);
  }
  function hookIframe(iframeEl) {
    try {
      iframeEl.addEventListener('load', () => { try { addDocument(iframeEl.contentDocument); } catch {} }, { once: true, passive: true });
      if (iframeEl.contentDocument) addDocument(iframeEl.contentDocument);
    } catch {}
  }
  function harvestShadows(rootLike) {
    const list = rootLike.querySelectorAll?.('*');
    if (!list) return;
    for (const el of list) {
      const sr = el.shadowRoot;
      if (sr && !__shadows.has(sr)) { __shadows.add(sr); harvestShadows(sr); }
    }
  }
  addDocument(document);
  function allSearchRoots() { return [ ...__docs, ...__shadows ]; }

  // ---------- deep query ----------
  function deepQuerySelector(sel, filter) {
    for (const root of allSearchRoots()) {
      const el = root.querySelector?.(sel);
      if (el && (!filter || filter(el))) return el;
    }
    return null;
  }
  function deepQuerySelectorAll(sel, filter) {
    const out = [];
    for (const root of allSearchRoots()) {
      const list = root.querySelectorAll?.(sel);
      if (!list) continue;
      for (const el of list) if (!filter || filter(el)) out.push(el);
    }
    return out;
  }

  // ---------- composer & sending ----------
  function findComposer() {
    const SELS = [
      'textarea#prompt-textarea',
      'textarea[data-testid*="prompt"], textarea[aria-label], textarea[placeholder], textarea',
      '.ProseMirror[contenteditable="true"]',
      '[data-testid*="composer"] [contenteditable="true"]',
      '[role="textbox"][contenteditable="true"]',
      '[contenteditable]:not([contenteditable="false"])'
    ];
    for (const sel of SELS) {
      const d1 = document.querySelector(sel);
      if (d1 && visible(d1) && !d1.disabled) return { el: d1, kind: d1.tagName === 'TEXTAREA' ? 'textarea' : 'contenteditable' };
      const d2 = deepQuerySelector(sel, el => visible(el) && !el.disabled);
      if (d2) return { el: d2, kind: d2.tagName === 'TEXTAREA' ? 'textarea' : 'contenteditable' };
    }
    return null;
  }
  function closestFormRoot(el) {
    return el.closest?.('form')
        || el.closest?.('[data-testid*="composer"], [aria-label*="composer"], [role="form"]')
        || null;
  }
  function labelMatchesSend(b) {
    const label = (
      (b.getAttribute?.('aria-label') || '') + ' ' +
      (b.getAttribute?.('title') || '') + ' ' +
      (b.textContent || '')
    ).toLowerCase();
    const testid = (b.getAttribute?.('data-testid') || '').toLowerCase();
    const re = /\b(send|senden|absenden|abschicken|envoyer|enviar|envío|enviar mensaje|invia|invio|inviare|enviar mensagem|verzenden|verzend|gönder|wyślij|odeslat|отправить|发送|送信|보내기|gửi|भेजें)\b/;
    return re.test(label) || testid.includes('send');
  }
  function findSendButtonNear(el) {
    const root = closestFormRoot(el) || el.ownerDocument;
    const local = Array.from(root.querySelectorAll?.('button, [role="button"]') || []).filter(visible);
    const good = local.find(labelMatchesSend);
    if (good) return good;
    const deep = deepQuerySelectorAll('button, [role="button"]', visible).find(labelMatchesSend);
    return deep || null;
  }
  function getConversationKey() {
    const m = location.pathname.match(/\/c\/([a-z0-9-]+)/i);
    return m ? m[1] : 'root:' + location.pathname + location.search;
  }
  function composerIsEmpty(comp) {
    if (!comp?.el) return true;
    if (comp.kind === 'textarea') return (comp.el.value ?? '').trim() === '';
    const t = (comp.el.innerText || comp.el.textContent || '');
    return t.replace(/[\u200B-\u200D\uFEFF]/g, '').trim() === '';
  }
  function readComposerText(comp) {
    return (comp.kind === 'textarea') ? (comp.el.value || '') : (comp.el.innerText || comp.el.textContent || '');
  }
  function messageAlreadyPrefixed(text) {
    const norm = (text || '').replace(/^[\u200B-\u200D\uFEFF]+/, '').trimStart();
    return !!norm && norm.startsWith(PHRASE);
  }

  // ---- events/selection helpers ----
  function evt(win, CtorName, type, init) {
    const Ctor = win[CtorName] || window[CtorName];
    try { return new Ctor(type, init || { bubbles: true, cancelable: true }); }
    catch { return new Event(type, { bubbles: true, cancelable: true }); }
  }
  function placeCaretAtEndStably(el) {
    const doc = el.ownerDocument || document;
    const win = doc.defaultView || window;
    const setOnce = () => {
      try {
        if (el.tagName === 'TEXTAREA') {
          const len = el.value.length;
          el.selectionStart = el.selectionEnd = len;
        } else {
          const range = doc.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          const sel = win.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch {}
    };
    setOnce(); win.requestAnimationFrame(setOnce); setTimeout(setOnce, 0); setTimeout(setOnce, 60);
  }
  function clearContentEditable(el) {
    try {
      const doc = el.ownerDocument || document;
      const win = doc.defaultView || window;
      const range = doc.createRange();
      range.selectNodeContents(el);
      const sel = win.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      while (el.firstChild) el.removeChild(el.firstChild);
    } catch {}
  }

  // ---- block helpers for contenteditable ----
  function pickBlockTag(root) {
    const firstTag = root.firstElementChild?.tagName;
    if (firstTag === 'P' || firstTag === 'DIV') return firstTag;
    if (root.classList?.contains('ProseMirror') || root.closest?.('.ProseMirror')) return 'P';
    return 'DIV'; // safe fallback
  }
  function makeTextBlock(doc, tag, text) {
    const el = doc.createElement(tag);
    el.appendChild(doc.createTextNode(text));
    return el;
  }
  function makeEmptyBlock(doc, tag) {
    const el = doc.createElement(tag);
    el.appendChild(doc.createElement('br'));
    return el;
  }
  function isEmptyBlock(node) {
    if (!node || node.nodeType !== 1) return false;
    const txt = (node.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (txt !== '') return false;
    // Accept <p><br></p> or truly empty block
    return node.childElementCount <= 1;
  }

  // ---- injection helpers (add/remove robustly) ----
  function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function prependInjection(comp) {
    if (!comp) return;
    if (comp.kind === 'textarea') {
      const cur = comp.el.value || '';
      comp.el.value = injectedText() + cur;
      comp.el.dispatchEvent(evt(comp.el.ownerDocument?.defaultView || window, 'Event', 'input', { bubbles: true }));
      placeCaretAtEndStably(comp.el);
      return;
    }
    const doc = comp.el.ownerDocument || document;
    const tag = pickBlockTag(comp.el);
    const first = comp.el.firstChild;
    const textBlock = makeTextBlock(doc, tag, PHRASE);
    const emptyBlock = makeEmptyBlock(doc, tag);
    comp.el.insertBefore(emptyBlock, first);
    comp.el.insertBefore(textBlock, emptyBlock);
    try { comp.el.dispatchEvent(evt(doc.defaultView || window, 'InputEvent', 'input', { bubbles: true, cancelable: true, inputType: 'insertText', data: PHRASE+'\n\n' })); }
    catch { comp.el.dispatchEvent(new Event('input', { bubbles: true })); }
  }

  function removeInjection(comp) {
    if (!comp) return;
    const win = comp.el.ownerDocument?.defaultView || window;

    if (comp.kind === 'textarea') {
      const cur = comp.el.value || '';
      const re = new RegExp('^(?:[\\u200B-\\u200D\\uFEFF]|\\s)*' + escapeRegExp(PHRASE) + '(?:\\r?\\n){0,2}');
      const next = cur.replace(re, '');
      if (next !== cur) {
        comp.el.value = next;
        comp.el.dispatchEvent(evt(win, 'Event', 'input', { bubbles: true }));
      }
      return;
    }

    // Contenteditable — remove <p>PHRASE</p> + following empty block if present
    const firstEl = comp.el.firstElementChild;
    const secondEl = firstEl?.nextElementSibling;
    const firstText = (firstEl?.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '');
    const tagOK = firstEl && (firstEl.tagName === 'P' || firstEl.tagName === 'DIV');
    if (tagOK && firstText === PHRASE) {
      try { comp.el.removeChild(firstEl); } catch {}
      if (isEmptyBlock(secondEl)) { try { comp.el.removeChild(secondEl); } catch {} }
      try { comp.el.dispatchEvent(evt(win, 'Event', 'input', { bubbles: true })); } catch {}
      return;
    }

    // Fallback: text-based strip
    const txt = readComposerText(comp) || '';
    const reStart = new RegExp('^(?:[\\u200B-\\u200D\\uFEFF]|\\s)*' + escapeRegExp(PHRASE) + '(?:\\r?\\n){0,2}');
    if (reStart.test(txt)) {
      const stripped = txt.replace(reStart, '');
      clearContentEditable(comp.el);
      const parts = stripped.split(/\r?\n/);
      const doc = comp.el.ownerDocument || document;
      parts.forEach((line, i) => {
        comp.el.appendChild(makeTextBlock(doc, pickBlockTag(comp.el), line));
        if (i < parts.length - 1) comp.el.appendChild(makeEmptyBlock(doc, pickBlockTag(comp.el)));
      });
      try { comp.el.dispatchEvent(evt(win, 'Event', 'input', { bubbles: true })); } catch {}
    }
  }

  function ensureInjectionPresence(comp) {
    if (!comp) return;
    const cur = readComposerText(comp);
    if (!cur || cur.replace(/[\u200B-\u200D\uFEFF]/g,'').trim() === '') {
      setComposerText(comp, injectedText());
      return;
    }
    if (!messageAlreadyPrefixed(cur)) {
      prependInjection(comp);
    }
  }

  function setComposerText(comp, text) {
    const doc = comp.el.ownerDocument || document;
    const win = doc.defaultView || window;
    comp.el.focus({ preventScroll: true });

    if (comp.kind === 'textarea') {
      comp.el.value = text;
      comp.el.dispatchEvent(evt(win, 'Event', 'input', { bubbles: true }));
      placeCaretAtEndStably(comp.el);
      return;
    }

    // contenteditable: build paragraphs/divs instead of <br><br>
    clearContentEditable(comp.el);
    const tag = pickBlockTag(comp.el);
    comp.el.appendChild(makeTextBlock(doc, tag, PHRASE));
    comp.el.appendChild(makeEmptyBlock(doc, tag)); // one blank line after PHRASE
    try { comp.el.dispatchEvent(evt(win, 'InputEvent', 'beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: PHRASE+'\n\n' })); } catch {}
    try { comp.el.dispatchEvent(evt(win, 'InputEvent', 'input', { bubbles: true, cancelable: true, inputType: 'insertText', data: PHRASE+'\n\n' })); }
    catch { comp.el.dispatchEvent(evt(win, 'Event', 'input', { bubbles: true })); }
    placeCaretAtEndStably(comp.el);
  }

  function pressEnter(comp) {
    const doc = comp.el.ownerDocument || document;
    const win = doc.defaultView || window;
    const opts = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' };
    comp.el.dispatchEvent(evt(win, 'KeyboardEvent', 'keydown', opts));
    comp.el.dispatchEvent(evt(win, 'KeyboardEvent', 'keypress', opts));
    comp.el.dispatchEvent(evt(win, 'KeyboardEvent', 'keyup', opts));
  }

  async function sendNow(text) {
    const comp = findComposer() || await new Promise((res, rej) => {
      const t0 = performance.now();
      (function tick(){ const c = findComposer(); if (c) return res(c);
        if (performance.now() - t0 > 20000) return rej(new Error('composer not found')); requestAnimationFrame(tick); })();
    }).catch(() => null);
    if (!comp) return;

    setComposerText(comp, text);

    const doc = comp.el.ownerDocument || document;
    const win = doc.defaultView || window;

    const root = closestFormRoot(comp.el);
    if (root) {
      const form = root.matches?.('form') ? root : root.querySelector?.('form');
      if (form) {
        const ev = evt(win, 'Event', 'submit', { bubbles: true, cancelable: true });
        const ok = form.dispatchEvent(ev);
        if (ok) {
          const btn = findSendButtonNear(comp.el);
          if (btn) btn.click();
          else pressEnter(comp);
        }
        return;
      }
    }
    const btn = findSendButtonNear(comp.el);
    if (btn) btn.click();
    else pressEnter(comp);
  }

  function isConversationEmpty() {
    const sel = '[data-message-author], [data-message-author-role], [data-testid*="assistant"], [data-testid*="message"]';
    if (deepQuerySelector(sel)) return false;
    const anyBubble = deepQuerySelector(`${sel}, article, section`);
    return !anyBubble;
  }

  // ---------- assistant settle + guard ----------
  let lastAssistantSig = null;
  let settleTimer = null;
  let __lastAutoSendAt = 0;
  let __assistantGuardGen = 0;

  function getLastAssistantSignature() {
    const nodes = deepQuerySelectorAll(
      '[data-message-author="assistant"], [data-message-author-role="assistant"], [data-testid*="assistant"]',
      el => visible(el)
    );
    if (!nodes.length) return null;
    const last = nodes[nodes.length - 1];
    const id = last.getAttribute?.('data-message-id') || last.id || '';
    const len = (last.innerText || last.textContent || '').length;
    return `${id}:${len}`;
  }

  async function waitForAssistantStable(startSig) {
    const tStart = Date.now();
    let stableSince = Date.now();
    let prev = startSig ?? getLastAssistantSignature();

    while (Date.now() - tStart < MODE.assistantStableMaxWaitMs) {
      await sleep(Math.max(100, MODE.refillPollMs));
      const cur = getLastAssistantSignature();
      if (cur === prev && cur !== null) {
        if (Date.now() - stableSince >= MODE.assistantStableWindowMs) return true;
      } else {
        prev = cur;
        stableSince = Date.now();
      }
    }
    return false;
  }

  function startAssistantGuard() {
    if (!MODE.guardWhileAssistantStreaming) return;
    const my = ++__assistantGuardGen;
    (async function run(){
      while (my === __assistantGuardGen && state.enabled) {
        const comp = findComposer();
        if (comp && composerIsEmpty(comp)) {
          setComposerText(comp, injectedText());
        }
        await sleep(MODE.refillPollMs);
      }
    })();
  }
  function stopAssistantGuard() { __assistantGuardGen++; }

  function onPossibleAssistantChange() {
    if (!state.enabled || !MODE.autoInsertAfterAssistant) return;
    const sig = getLastAssistantSignature();
    if (!sig || sig === lastAssistantSig) return;
    lastAssistantSig = sig;

    startAssistantGuard();

    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(async () => {
      const stable = await waitForAssistantStable(sig);
      stopAssistantGuard();

      const comp = findComposer();
      if (!comp) return;
      if (!composerIsEmpty(comp)) return;

      if (MODE.autoSendAfterAssistant) {
        const now = Date.now();
        if (now - __lastAutoSendAt > 5000) { __lastAutoSendAt = now; sendNow(injectedText()); }
        else { setComposerText(comp, injectedText()); }
      } else {
        setComposerText(comp, injectedText());
      }
    }, MODE.afterAssistantDelayMs);
  }

  // ---------- state & bindings ----------
  let lastConvKey = null;
  let primedThisConv = false;
  let lastPrimeAt = 0;
  let bound = { root: null, unbind: null, compEl: null };
  let moDebounceTimer = null;

  function unbindSendHook() {
    if (bound.unbind) { try { bound.unbind(); } catch {} }
    bound = { root: null, unbind: null, compEl: null };
  }

  let __refillGeneration = 0;
  function scheduleRefillAfterSend() {
    if (!state.enabled || !MODE.refillAfterSend) return;
    const token = ++__refillGeneration;
    const start = Date.now();
    (function poll() {
      if (token !== __refillGeneration) return;
      const comp = findComposer();
      if (!comp) {
        if (Date.now() - start < MODE.refillWaitMaxMs) setTimeout(poll, MODE.refillPollMs);
        return;
      }
      if (composerIsEmpty(comp)) { setComposerText(comp, injectedText()); return; }
      if (Date.now() - start < MODE.refillWaitMaxMs) setTimeout(poll, MODE.refillPollMs);
    })();
  }

  function bindInterceptors() {
    const comp = findComposer();
    if (!comp) return;

    const root = closestFormRoot(comp.el) || comp.el.ownerDocument;
    const already = (bound.root === root && bound.compEl === comp.el);

    if (!state.enabled) {
      if (already) unbindSendHook();
      return;
    }
    if (already) return;

    unbindSendHook();

    const form = root.matches?.('form') ? root : root.querySelector?.('form');
    const btn = findSendButtonNear(comp.el);

    const injectPrefix = () => {
      if (!MODE.prefixEveryMessage) return;
      const cur = readComposerText(comp);
      if (!messageAlreadyPrefixed(cur)) {
        const joined = cur ? `${PHRASE}\n\n${cur}` : injectedText();
        if (comp.kind === 'textarea') {
          comp.el.value = joined;
          comp.el.dispatchEvent(evt(root.defaultView || window, 'Event', 'input', { bubbles: true }));
          placeCaretAtEndStably(comp.el);
        } else {
          prependInjection(comp);
        }
      }
    };

    const submitHandler = () => { injectPrefix(); scheduleRefillAfterSend(); };
    const clickHandler = () => { injectPrefix(); scheduleRefillAfterSend(); };
    const keydownHandler = (e) => {
      if (e.defaultPrevented) return;
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      if (e.ctrlKey || e.metaKey) return;
      injectPrefix(); scheduleRefillAfterSend();
    };

    if (form) {
      form.addEventListener('submit', submitHandler, true);
    } else if (btn) {
      btn.addEventListener('click', clickHandler, true);
    } else {
      comp.el.addEventListener('keydown', keydownHandler, true);
    }

    bound = {
      root, compEl: comp.el,
      unbind() {
        if (form) form.removeEventListener('submit', submitHandler, true);
        else if (btn) btn.removeEventListener('click', clickHandler, true);
        else comp.el.removeEventListener('keydown', keydownHandler, true);
      }
    };
    log('bound send hook', { hasForm: !!form, hasBtn: !!btn && !form, fallbackKeydown: !form && !btn });
  }

  async function maybePrime() {
    if (!state.enabled || !MODE.autoPrimeOnNewChat || primedThisConv) return;
    const now = Date.now();
    if (now - lastPrimeAt < MODE.primeCooldownMs) return;

    const comp = findComposer();
    if (!comp) return;

    if (composerIsEmpty(comp) && isConversationEmpty()) {
      log('auto-prime fill-only');
      primedThisConv = true;
      lastPrimeAt = now;
      setComposerText(comp, injectedText());
    }
  }

  function onRouteOrDomChanged() {
    if (moDebounceTimer) clearTimeout(moDebounceTimer);
    moDebounceTimer = setTimeout(() => {
      const key = getConversationKey();
      if (key !== lastConvKey) {
        log('route/conv changed', lastConvKey, '->', key);
        unbindSendHook();
        lastConvKey = key;
        primedThisConv = false;
        lastAssistantSig = null;
        stopAssistantGuard();
        rIC(maybePrime);
      }
      rIC(bindInterceptors);
      rIC(onPossibleAssistantChange);
    }, MODE.debounceMs);
  }

  // ---------- global observers ----------
  const mo = new MutationObserver(onRouteOrDomChanged);
  mo.observe(document.documentElement, { childList: true, subtree: true });
  const _ps = history.pushState, _rs = history.replaceState;
  history.pushState = function(...a){ const r=_ps.apply(this,a); onRouteOrDomChanged(); return r; };
  history.replaceState = function(...a){ const r=_rs.apply(this,a); onRouteOrDomChanged(); return r; };
  window.addEventListener('popstate', onRouteOrDomChanged);
  setInterval(() => rIC(onRouteOrDomChanged), 1500);

  // ---------- Mini UI ----------
  function buildUI() {
    const doc = document;
    const css = `
      .ar-ui-wrap{position:fixed; top:50%; right:12px; transform:translateY(-50%);
        z-index:2147483647; font:12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Arial;
        color:#111; user-select:none}
      .ar-card{background:rgba(255,255,255,.92); backdrop-filter:saturate(120%) blur(6px);
        border:1px solid rgba(0,0,0,.08); border-radius:12px; box-shadow:0 6px 24px rgba(0,0,0,.12);
        padding:10px 12px; display:flex; align-items:center; gap:8px}
      .ar-btn{cursor:pointer; border:none; border-radius:999px; padding:6px 10px;
        background:#111; color:#fff; font-weight:600}
      .ar-btn.off{background:#9aa0a6; color:#fff}
      .ar-dot{width:10px; height:10px; border-radius:999px; background:#10b981}
      .ar-dot.off{background:#ef4444}
      .ar-label{opacity:.85; max-width:180px}
    `;
    const style = doc.createElement('style'); style.textContent = css; doc.head.appendChild(style);

    const wrap = doc.createElement('div'); wrap.className = 'ar-ui-wrap'; wrap.setAttribute('aria-live', 'polite');
    const card = doc.createElement('div'); card.className = 'ar-card';
    const dot = doc.createElement('div'); dot.className = 'ar-dot';
    const btn = doc.createElement('button'); btn.className = 'ar-btn'; btn.type = 'button';
    const label = doc.createElement('div'); label.className = 'ar-label';

    card.appendChild(dot); card.appendChild(btn); card.appendChild(label);
    wrap.appendChild(card); document.body.appendChild(wrap);

    function refresh() {
      btn.textContent = state.enabled ? 'GPT-5 Thinking: ON' : 'GPT-5 Thinking: OFF';
      label.textContent = state.enabled ? 'Prompt injection active' : 'Prompt injection inactive';
      btn.classList.toggle('off', !state.enabled);
      dot.classList.toggle('off', !state.enabled);
    }
    btn.addEventListener('click', () => setEnabled(!state.enabled));
    window.addEventListener('keydown', (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key.toLowerCase() === 'r')) {
        e.preventDefault();
        setEnabled(!state.enabled);
      }
    }, true);

    refresh();
    return { refresh };
  }
  const ui = buildUI();

  function removeInjectionWithRetries() {
    const shots = [0, 'raf', 50, 150];
    for (const s of shots) {
      if (s === 'raf') requestAnimationFrame(() => { const c = findComposer(); if (c) removeInjection(c); });
      else setTimeout(() => { const c = findComposer(); if (c) removeInjection(c); }, s);
    }
  }

  function setEnabled(on) {
    state.enabled = !!on;
    writeEnabled(state.enabled);
    ui.refresh?.();

    __refillGeneration++;
    stopAssistantGuard();

    if (!state.enabled) {
      removeInjectionWithRetries();
      unbindSendHook();
      return;
    }

    const bindAttempts = 8;
    for (let i = 0; i < bindAttempts; i++) setTimeout(() => { bindInterceptors(); maybePrime(); }, i * 100);
    setTimeout(() => {
      const comp = findComposer();
      if (!comp) return;
      ensureInjectionPresence(comp);
    }, 150);
  }

  // Debug API
  if (MODE.debug) {
    window.__autoReason = {
      setEnabled,
      sendNow,
      scan: () => ({ composer: !!findComposer(), key: getConversationKey(), enabled: state.enabled }),
      state: () => ({ lastConvKey, primedThisConv, lastAssistantSig, bound: !!(bound.root), docs: __docs.size, shadows: __shadows.size }),
      MODE
    };
    log('debug API at window.__autoReason');
  }

  // Cleanup
  window.addEventListener('beforeunload', () => {
    try { mo.disconnect(); } catch {}
    for (const [doc, ob] of __docObservers) { try { ob.disconnect(); } catch {} }
    __docObservers.clear();
    stopAssistantGuard();
    unbindSendHook();
  });

  // Init
  onRouteOrDomChanged();
  rIC(maybePrime);
})();
