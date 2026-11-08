/* Inspicio display settings: look (Mellow or Pixel), theme (Auto, Light, Dark) and motion (Full or
   Calm). Loaded in <head> on every page so the choice applies before anything is drawn, then adds
   the settings button to the bottom right corner. The choice is kept in this browser only
   (localStorage 'inspicio.prefs'); nothing about a photo is ever stored. */
'use strict';

(() => {
  const KEY = 'inspicio.prefs';
  const OPTIONS = {
    look: [['mellow', 'Mellow'], ['pixel', 'Pixel']],
    theme: [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']],
    motion: [['full', 'Full'], ['calm', 'Calm']],
  };
  const LABELS = { look: 'Look', theme: 'Theme', motion: 'Motion' };
  const root = document.documentElement;
  const listeners = new Set();

  let prefs = { look: 'pixel', theme: 'auto', motion: 'full' };
  // A first visit (nothing saved yet, and storage works so the answer can be kept) asks which look.
  let firstVisit = false;
  try {
    const raw = localStorage.getItem(KEY);
    firstVisit = raw === null;
    const saved = JSON.parse(raw || '{}');
    for (const k of Object.keys(OPTIONS)) {
      if (OPTIONS[k].some(([v]) => v === saved[k])) prefs[k] = saved[k];
    }
  } catch { /* storage blocked: defaults */ }

  function apply() {
    root.dataset.look = prefs.look;
    root.dataset.motion = prefs.motion;
    if (prefs.theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = prefs.theme;
  }
  apply();

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  window.inspicioPrefs = {
    get: (k) => prefs[k],
    isDark: () => (prefs.theme === 'auto' ? darkQuery.matches : prefs.theme === 'dark'),
    onChange: (fn) => listeners.add(fn),
  };

  const notify = (k, v) => { for (const fn of listeners) fn(k, v); };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* not kept */ } };

  function set(k, v) {
    if (prefs[k] === v) return;
    prefs = { ...prefs, [k]: v };
    save();
    apply();
    notify(k, v);
  }

  // While the look changes, the page's colors glide to the new ones (styles.css registers the
  // color tokens so they can be animated) instead of jumping.
  let shiftTimer = 0;
  function shiftColors() {
    root.classList.add('look-shifting');
    clearTimeout(shiftTimer);
    shiftTimer = setTimeout(() => root.classList.remove('look-shifting'), 900);
  }

  /* ---------- The settings button and its panel ---------- */

  const NS = 'http://www.w3.org/2000/svg';
  function gearIcon() {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M4 7h9M17 7h3M4 17h3M11 17h9');
    const knobA = document.createElementNS(NS, 'circle');
    knobA.setAttribute('cx', '15');
    knobA.setAttribute('cy', '7');
    knobA.setAttribute('r', '2.2');
    const knobB = document.createElementNS(NS, 'circle');
    knobB.setAttribute('cx', '9');
    knobB.setAttribute('cy', '17');
    knobB.setAttribute('r', '2.2');
    for (const n of [path, knobA, knobB]) svg.append(n);
    return svg;
  }

  function build() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'prefs-btn';
    button.setAttribute('aria-label', 'Display settings');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'prefs-panel');
    button.append(gearIcon());

    const panel = document.createElement('div');
    panel.className = 'prefs-panel';
    panel.id = 'prefs-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Display settings');
    panel.hidden = true;

    const title = document.createElement('p');
    title.className = 'prefs-title';
    title.textContent = 'Display';
    panel.append(title);

    for (const k of Object.keys(OPTIONS)) {
      const row = document.createElement('div');
      row.className = 'prefs-row';
      const label = document.createElement('span');
      label.className = 'prefs-label';
      label.id = `prefs-${k}`;
      label.textContent = LABELS[k];
      const group = document.createElement('div');
      group.className = 'prefs-seg';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-labelledby', label.id);
      for (const [v, text] of OPTIONS[k]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.value = v;
        b.textContent = text;
        b.setAttribute('aria-pressed', String(prefs[k] === v));
        b.addEventListener('click', () => {
          if (k === 'look' || k === 'theme') shiftColors();
          set(k, v);
          for (const other of group.children) other.setAttribute('aria-pressed', String(other === b));
        });
        group.append(b);
      }
      row.append(label, group);
      panel.append(row);
    }

    // Closing plays the opening motion backwards, then hides the panel.
    let isOpen = false;
    let closeTimer = 0;
    const open = (on) => {
      isOpen = on;
      button.setAttribute('aria-expanded', String(on));
      clearTimeout(closeTimer);
      if (on) {
        panel.classList.remove('is-closing');
        panel.hidden = false;
        panel.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
      } else {
        panel.classList.add('is-closing');
        const hide = () => { if (!isOpen) { panel.hidden = true; panel.classList.remove('is-closing'); } };
        panel.addEventListener('animationend', hide, { once: true });
        closeTimer = setTimeout(hide, 400);
      }
    };
    button.addEventListener('click', () => open(!isOpen));
    document.addEventListener('pointerdown', (e) => {
      if (isOpen && !panel.contains(e.target) && !button.contains(e.target)) open(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen) {
        open(false);
        button.focus();
      }
    });

    document.body.append(panel, button);
  }

  /* ---------- First visit: which look? ---------- */

  // On the main page only. Each choice shows at once on the blurred page behind; Continue keeps it.
  const LOOKS = [
    ['pixel', 'Original', 'Pixel details and square corners'],
    ['mellow', 'Mellow', 'Soft, quiet and rounded'],
  ];

  function welcome() {
    const box = document.createElement('div');
    box.className = 'welcome';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'welcome-title');

    const card = document.createElement('div');
    card.className = 'welcome-card';
    const eyebrow = document.createElement('p');
    eyebrow.className = 'welcome-eyebrow';
    eyebrow.textContent = 'Welcome to Inspicio';
    const title = document.createElement('h2');
    title.className = 'welcome-title';
    title.id = 'welcome-title';
    title.textContent = 'Which look would you like?';
    const sub = document.createElement('p');
    sub.className = 'welcome-sub';
    sub.textContent = 'You can change it any time with the button in the corner.';

    const options = document.createElement('div');
    options.className = 'welcome-options';
    options.setAttribute('role', 'group');
    options.setAttribute('aria-label', 'Look');
    let chosen = prefs.look;
    for (const [v, name, desc] of LOOKS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'welcome-option';
      b.dataset.value = v;
      b.setAttribute('aria-pressed', String(v === chosen));
      const swatch = document.createElement('span');
      swatch.className = `welcome-swatch swatch-${v}`;
      swatch.setAttribute('aria-hidden', 'true');
      const aa = document.createElement('span');
      aa.textContent = 'Aa';
      swatch.append(aa);
      const n = document.createElement('span');
      n.className = 'welcome-name';
      n.textContent = name;
      const d = document.createElement('span');
      d.className = 'welcome-desc';
      d.textContent = desc;
      b.append(swatch, n, d);
      b.addEventListener('click', () => {
        if (chosen === v) return;
        chosen = v;
        for (const o of options.children) o.setAttribute('aria-pressed', String(o === b));
        shiftColors();
        root.dataset.look = v;
        notify('look', v);
      });
      options.append(b);
    }

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'map-link wipe-save welcome-go';
    go.textContent = 'Continue';

    card.append(eyebrow, title, sub, options, go);
    box.append(card);

    const others = [...document.body.children];
    for (const el of others) el.inert = true;
    document.body.append(box);
    options.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });

    const close = () => {
      prefs = { ...prefs, look: chosen };
      save();
      apply();
      for (const b of document.querySelectorAll('#prefs-panel [aria-labelledby="prefs-look"] button')) {
        b.setAttribute('aria-pressed', String(b.dataset.value === chosen));
      }
      for (const el of others) el.inert = false;
      box.classList.add('is-closing');
      setTimeout(() => box.remove(), 400);
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    go.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
  }

  function start() {
    build();
    if (firstVisit && document.getElementById('app')) welcome();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
