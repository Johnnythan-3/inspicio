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

  let prefs = { look: 'mellow', theme: 'auto', motion: 'full' };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
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

  function set(k, v) {
    if (prefs[k] === v) return;
    prefs = { ...prefs, [k]: v };
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* not kept */ }
    apply();
    for (const fn of listeners) fn(k, v);
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
          set(k, v);
          for (const other of group.children) other.setAttribute('aria-pressed', String(other === b));
        });
        group.append(b);
      }
      row.append(label, group);
      panel.append(row);
    }

    const open = (on) => {
      panel.hidden = !on;
      button.setAttribute('aria-expanded', String(on));
      if (on) panel.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
    };
    button.addEventListener('click', () => open(panel.hidden));
    document.addEventListener('pointerdown', (e) => {
      if (!panel.hidden && !panel.contains(e.target) && !button.contains(e.target)) open(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) {
        open(false);
        button.focus();
      }
    });

    document.body.append(panel, button);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
