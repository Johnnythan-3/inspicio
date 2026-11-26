// The saving overlay with its progress bar, used by Film and Shot on.
// Cut from public/app.js on 2026-11-26, when Inspicio went back to metadata only.
// These lines sat inside the app's one big function, so they do not run alone: to bring
// the tool back, paste them into app.js again (archived/shared/app.before.js shows where).

// ---- app.js lines 1949-2182 ----
  /* ---------- Saving: a dimmed screen with what is being added and a predicted progress bar ---------- */

  // Each step's name, what it adds, and about how long it takes per megapixel (ms) on a 10-core
  // Mac. Each full save teaches the page this device's speed (SPEED_KEY), so the bar's pace fits.
  const SAVE_STEPS = {
    prepare: ['Loading the photo', 'Reading its pixels at full size.', 12],
    reading: ['Reading the sensor data', 'The RAW file’s own light, before any of the camera’s processing.', 40],
    exposing: ['Exposing the film', 'The light lands on Portra’s three colour layers.', 3],
    halation: ['Adding halation', 'The red glow around bright lights, from light bouncing off the film base.', 24],
    sharpness: ['Scattering light', 'Light spreads a little in the emulsion: the soft edges of real film.', 54],
    curves: ['Developing the negative', 'Kodak’s measured curves turn the light into density.', 4],
    couplers: ['Adding couplers', 'The developer’s chemistry: crisper edges and purer colours.', 10],
    grain: ['Adding grain', 'Grain that follows the density, like clumps of real silver.', 24],
    printing: ['Printing', 'On Kodak Endura paper, the way a Noritsu lab prints.', 14],
    card: ['Drawing the card', 'The photo and its lines at full size.', 25],
    encoding: ['Saving the JPEG', 'Compressing it, on this device.', 30],
  };
  const SPEED_KEY = 'inspicio.speed';
  let saveSpeed = (() => {
    try {
      const v = Number(localStorage.getItem(SPEED_KEY));
      if (v > 0.2 && v < 10) return v;
    } catch { /* storage blocked; guess */ }
    const cores = navigator.hardwareConcurrency || 4;
    return cores >= 7 ? 1 : cores >= 4 ? 1.8 : 3;
  })();

  // Waits until the browser has painted (or a moment, in a hidden tab), so the overlay shows
  // before work that blocks the page.
  const painted = () => new Promise((resolve) => {
    let done = false;
    const go = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 80);
  });
  // The overlay's entrance takes about 0.3 s; heavy work waits most of it out so it stays smooth.
  const settled = () => painted().then(() => new Promise((resolve) => setTimeout(resolve, 220)));

  // A progress bar's fill driven through `steps` at their predicted pace (SAVE_STEPS, plus `base` ms
  // each). One animation from empty to full that never restarts: each step only changes its speed,
  // aiming to reach the step's end when the step is predicted to finish, and a step that runs long
  // slows it to a crawl before the next step's place. So it never jumps or goes back, and since it
  // runs on the compositor it keeps moving while the page is busy.
  function barController({ fill, steps, megapixels, base = 120 }) {
    const durations = steps.map((k) => SAVE_STEPS[k][2] * megapixels * saveSpeed + base);
    const total = durations.reduce((a, b) => a + b, 0);
    const starts = [];
    let sum = 0;
    for (const d of durations) { starts.push(sum / total); sum += d; }
    const anim = reduceMotion.matches ? null
      : fill.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: total, easing: 'linear', fill: 'forwards' });
    let rate = 1;
    let index = -1;
    let done = false;
    const at = () => (anim ? Math.min(1, (anim.currentTime || 0) / total) : 0);
    const setRate = (r) => {
      if (!anim) return;
      rate = Math.min(12, Math.max(0.02, r));
      if (anim.updatePlaybackRate) anim.updatePlaybackRate(rate);
      else anim.playbackRate = rate;
    };
    const stepEnd = () => (index + 1 < steps.length ? starts[index + 1] : 1);
    const watch = setInterval(() => {
      if (!anim || done || index < 0) return;
      const room = stepEnd() - 0.008 - at();
      if (room <= 0) setRate(0.02);
      else if (room < 0.02 && rate > 0.1) setRate(rate / 2);
    }, 120);
    return {
      starts,
      total,
      // Returns the step's index, or -1 if it isn't ahead of the current one.
      step(name) {
        const i = steps.indexOf(name);
        if (done || i <= index) return -1;
        index = i;
        if (!anim) { fill.style.setProperty('--p', String(starts[i])); return i; }
        const target = starts[i] + (stepEnd() - starts[i]) * 0.95;
        setRate(((target - at()) * total) / durations[i]);
        return i;
      },
      finish(ms = 300) {
        done = true;
        clearInterval(watch);
        fill.style.setProperty('--p', '1');
        setRate(((1 - at()) * total) / ms);
      },
      stop() {
        done = true;
        clearInterval(watch);
        anim?.pause();
      },
    };
  }

  // The overlay. The bar is one animation from empty to full that never restarts: each step only
  // changes its speed (aiming to reach the step's end when the step is predicted to finish), and a
  // step that runs long slows it to a crawl before the next notch. So it never jumps or goes back,
  // and since it runs on the compositor it keeps moving while the page is busy.
  function saveProgress({ eyebrow, steps, megapixels, learn }) {
    const durations = steps.map((k) => SAVE_STEPS[k][2] * megapixels * saveSpeed + 120);
    const total = durations.reduce((a, b) => a + b, 0);
    const starts = [];
    let sum = 0;
    for (const d of durations) { starts.push(sum / total); sum += d; }

    const label = el('strong', { class: 'save-step', 'aria-live': 'polite' }, '');
    const detail = el('p', { class: 'save-detail' }, '');
    const fill = el('div', { class: 'save-fill' });
    const ticks = starts.slice(1).map((x) => el('span', { class: 'save-tick', vars: { '--x': String(x) } }));
    const bar = el('div', { class: 'save-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
      'aria-valuenow': '0', 'aria-label': 'Progress' }, fill, ...ticks);
    const actions = el('div', { class: 'save-actions' });
    const card = el('div', { class: 'save-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': eyebrow, tabindex: '-1' },
      el('p', { class: 'save-eyebrow' }, eyebrow), label, detail, bar, actions);
    const root = el('div', { class: 'save-overlay' }, card);
    const opener = document.activeElement;
    document.body.append(root);
    card.focus({ preventScroll: true });

    const t0 = performance.now();
    let index = -1;
    let closed = false;
    let cancel = null;

    const ctl = barController({ fill, steps, megapixels });

    // Step names change at most every 450 ms, so a burst of quick steps doesn't flicker; the
    // latest one shows when its turn comes.
    let textAt = 0;
    let textTimer = 0;
    const showText = (title, sub) => {
      label.textContent = title;
      detail.textContent = sub;
      textAt = performance.now();
      if (!reduceMotion.matches) {
        for (const n of [label, detail]) n.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
      }
    };
    const text = (title, sub, now) => {
      clearTimeout(textTimer);
      const wait = now ? 0 : 450 - (performance.now() - textAt);
      if (wait <= 0) showText(title, sub);
      else textTimer = setTimeout(() => showText(title, sub), wait);
    };
    const setActions = (...nodes) => actions.replaceChildren(...nodes.filter(Boolean));
    const button = (labelText, primary, onClick) => {
      const b = el('button', { class: `map-link${primary ? ' wipe-save' : ''}`, type: 'button' }, labelText);
      b.addEventListener('click', onClick);
      return b;
    };

    const close = () => {
      if (closed) return;
      closed = true;
      ctl.stop();
      clearTimeout(textTimer);
      document.removeEventListener('keydown', onKey, true);
      root.classList.add('is-closing');
      setTimeout(() => root.remove(), reduceMotion.matches ? 0 : 200);
      if (opener && opener.isConnected) opener.focus?.({ preventScroll: true });
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (cancel) cancel();
      else if (index === Infinity) close();
    };
    document.addEventListener('keydown', onKey, true);

    const api = {
      step(name) {
        if (closed) return;
        const i = ctl.step(name);
        if (i < 0) return;
        index = i;
        const [title, sub] = SAVE_STEPS[name];
        text(title, sub);
        bar.setAttribute('aria-valuenow', String(Math.round(starts[i] * 100)));
      },
      cancellable(fn) {
        cancel = fn ? () => { cancel = null; fn(); } : null;
        setActions(cancel && button('Cancel', false, () => cancel && cancel()));
      },
      // The work is done: learn this device's speed, then fill the bar.
      finished() {
        if (learn) {
          const ratio = (performance.now() - t0) / total;
          if (ratio > 0.1 && ratio < 10) {
            saveSpeed = Math.min(8, Math.max(0.25, 0.6 * saveSpeed + 0.4 * saveSpeed * ratio));
            try { localStorage.setItem(SPEED_KEY, saveSpeed.toFixed(3)); } catch { /* fine */ }
          }
        }
        index = Infinity;
        cancel = null;
        bar.setAttribute('aria-valuenow', '100');
        ctl.finish();
      },
      done(sub) {
        api.finished();
        text('Saved', sub, true);
        setActions();
        setTimeout(close, reduceMotion.matches ? 1600 : 1100);
      },
      // On a phone or tablet: the share sheet, where Save Image puts the photo in Photos.
      ready(file, url, sub) {
        api.finished();
        text('Ready', `${sub}. Save Image in the share sheet puts it in Photos.`, true);
        const download = el('a', { class: 'map-link', href: url, download: file.name }, 'Download');
        setActions(
          button('Close', false, close),
          download,
          button('Save to Photos', true, () => {
            navigator.share({ files: [file] }).then(close, (err) => {
              if (err && err.name === 'AbortError') return;
              detail.textContent = 'The share sheet didn’t open. Use Download instead.';
            });
          }),
        );
        actions.classList.add('is-ready');
        actions.lastChild.focus({ preventScroll: true });
      },
      fail(message) {
        index = Infinity;
        cancel = null;
        ctl.stop();
        text('Couldn’t save', message, true);
        setActions(button('Close', true, close));
      },
      close,
    };
    return api;
  }


// ---- app.js lines 2198-2209 ----
  // Hands a saved image over: the share sheet on a phone or tablet, otherwise a download.
  function deliver(progress, blob, url, name, sub) {
    const file = shareableFile(blob, name);
    if (file) progress.ready(file, url, sub);
    else {
      downloadUrl(url, name);
      progress.done(sub);
    }
  }

  const toJpeg = (canvas, quality) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

