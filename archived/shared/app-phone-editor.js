// The phone photo editor used by Film and Shot on.
// Cut from public/app.js on 2026-11-26, when Inspicio went back to metadata only.
// These lines sat inside the app's one big function, so they do not run alone: to bring
// the tool back, paste them into app.js again (archived/shared/app.before.js shows where).

// ---- app.js lines 2796-3148 ----
  /* ---------- Film on phones: a photo editor ---------- */

  // On narrow screens Film works like a phone photo editor: the photo stays put and fills the
  // screen, and a row of square tool buttons sits under it. Exposure, Brightness and Frame each
  // show their control in one fixed-height strip above the row (so the photo never resizes),
  // Original is held to compare, and Save develops at full size.
  const TOOL_ICONS = {
    exposure: ['....#....', '.#.....#.', '...###...', '..#####..', '#.#####.#', '..#####..', '...###...', '.#.....#.', '....#....'],
    brightness: ['..#####..', '.#..####.', '#...#####', '#...#####', '#...#####', '#...#####', '#...#####', '.#..####.', '..#####..'],
    highlights: ['..#####..', '.#######.', '#########', '#########', '#.......#', '#.......#', '#.......#', '.#.....#.', '..#####..'],
    shadows: ['..#####..', '.#.....#.', '#.......#', '#.......#', '#.......#', '#########', '#########', '.#######.', '..#####..'],
    frame: ['#########', '#.......#', '#.#####.#', '#.#####.#', '#.#####.#', '#.#####.#', '#.#####.#', '#.......#', '#########'],
    original: ['.........', '..#####..', '.#.....#.', '#...#...#', '#..###..#', '#...#...#', '.#.....#.', '..#####..', '.........'],
    save: ['....#....', '....#....', '....#....', '..#.#.#..', '...###...', '....#....', '.........', '#.......#', '#########'],
    style: ['#########', '#####...#', '#####...#', '#####...#', '#####...#', '#####...#', '#####...#', '#####...#', '#########'],
    font: ['...###...', '..#...#..', '.#.....#.', '.#.....#.', '.#######.', '.#.....#.', '.#.....#.', '.#.....#.', '.........'],
    shape: ['..#......', '..#......', '#######..', '..#...#..', '..#...#..', '..#...#..', '..#######', '......#..', '......#..'],
    text: ['#########', '.........', '#######..', '.........', '#########', '.........', '#####....', '.........', '.........'],
  };

  function pixelIcon(rows) {
    const ns = 'http://www.w3.org/2000/svg';
    const w = rows[0].length;
    const h = rows.length;
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', String(w * 2));
    svg.setAttribute('height', String(h * 2));
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    let d = '';
    rows.forEach((row, y) => {
      for (let x = 0; x < w;) {
        if (row[x] !== '#') { x++; continue; }
        const x0 = x;
        while (row[x] === '#') x++;
        d += `M${x0} ${y}h${x - x0}v1H${x0}z`;
      }
    });
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
    return svg;
  }

  const toolButton = (iconKey, label) => el('button', { class: 'tool', type: 'button' },
    pixelIcon(TOOL_ICONS[iconKey]), el('span', null, label));

  // The editor's frame, shared by Film and Shot on: the tool's name and value, one fixed-height
  // strip that shows the active tool's control, and the row of square buttons. `panes` maps each
  // tool to { tool (button label), label, icon, node, value(), disabled?() }; `extras` are more
  // buttons after the tools (hold to compare, save). `owner` remembers the active tool.
  function editorShell(owner, panes, extras) {
    const name = el('span', { class: 'editor-name' });
    const value = el('span', { class: 'editor-value' });
    const head = el('p', { class: 'editor-head', 'aria-live': 'polite' }, name, value);
    const controls = el('div', { class: 'editor-controls' }, Object.values(panes).map((p) => p.node));
    const tools = el('div', { class: 'editor-tools', role: 'toolbar', 'aria-label': 'Tools' });
    const keys = Object.keys(panes);
    let active = panes[owner.editorTool] ? owner.editorTool : keys[0];
    const buttons = {};
    function show() {
      if (panes[active].disabled?.()) active = keys.find((k) => !panes[k].disabled?.());
      const p = panes[active];
      name.textContent = p.label;
      value.textContent = p.value();
      for (const k of keys) {
        panes[k].node.hidden = k !== active;
        buttons[k].setAttribute('aria-pressed', String(k === active));
        buttons[k].disabled = Boolean(panes[k].disabled?.());
      }
      // Option rows measure their fill once they can be seen.
      requestAnimationFrame(() => { for (const g of p.node.querySelectorAll('.seg')) placeFill(g, true); });
    }
    for (const k of keys) {
      const b = toolButton(panes[k].icon, panes[k].tool);
      b.dataset.tool = k;
      b.addEventListener('click', () => { active = k; owner.editorTool = k; show(); });
      buttons[k] = b;
      tools.append(b);
    }
    tools.append(...extras);
    return { root: el('div', { class: 'tool-editor' }, head, controls, tools), show };
  }

  // The editor's slider. The thumb glides with the finger (no steps) while the value moves in tidy
  // `quantum` steps. The box around the slider takes the touches, so the press area is bigger than
  // the slider: a touch on the thumb drags it, a touch beside it brings the thumb there, and two
  // quick taps put the value back to `reset()`. `get`/`set` read and write the value, `done` runs
  // when the finger lifts. --p (0 to 1) fills the track up to the thumb (styles.css).
  const SLIDE_THUMB = 28; // px: --thumb in styles.css
  function slideBox(cls, { min, max, quantum, label, get, set, reset, done }) {
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: 'any', 'aria-label': label });
    const box = el('div', { class: `${cls} editor-slide` }, input);
    const snap = (v) => Number((Math.round(Math.min(max, Math.max(min, v)) / quantum) * quantum).toFixed(4));
    const paint = () => input.style.setProperty('--p', String((Number(input.value) - min) / (max - min)));
    const sync = () => { input.value = String(get()); paint(); };
    const put = (v) => {
      input.value = String(v);
      paint();
      const tidy = snap(Number(input.value));
      if (tidy !== get()) set(tidy);
    };
    const travel = () => {
      const r = input.getBoundingClientRect();
      return { left: r.left + SLIDE_THUMB / 2, width: Math.max(1, r.width - SLIDE_THUMB) };
    };
    let grab = null;
    let lastTap = null;
    const drag = (e) => {
      if (!grab || e.pointerId !== grab.id) return;
      if (Math.abs(e.clientX - grab.x) > 6) grab.moved = true;
      const t = travel();
      const ratio = Math.min(1, Math.max(0, (e.clientX - grab.offset - t.left) / t.width));
      put(min + ratio * (max - min));
    };
    box.addEventListener('pointerdown', (e) => {
      if (input.disabled || grab || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const t = travel();
      const thumb = t.left + ((Number(input.value) - min) / (max - min)) * t.width;
      const onThumb = Math.abs(e.clientX - thumb) <= SLIDE_THUMB / 2 + 10;
      grab = { id: e.pointerId, x: e.clientX, offset: onThumb ? e.clientX - thumb : 0, moved: false };
      try { box.setPointerCapture(e.pointerId); } catch { /* the drag still works inside the box */ }
      e.preventDefault();
      input.focus({ preventScroll: true });
      if (!onThumb) drag(e);
    });
    box.addEventListener('pointermove', drag);
    const drop = (e) => {
      if (!grab || e.pointerId !== grab.id) return;
      const tap = !grab.moved && e.type === 'pointerup';
      const twice = tap && lastTap && e.timeStamp - lastTap.at < 400 && Math.abs(e.clientX - lastTap.x) < 30;
      lastTap = tap && !twice ? { at: e.timeStamp, x: e.clientX } : null;
      grab = null;
      if (twice && reset) put(reset());
      done?.();
    };
    box.addEventListener('pointerup', drop);
    box.addEventListener('pointercancel', drop);
    // Keys and screen readers move the slider itself.
    input.addEventListener('keydown', (e) => {
      const dir = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      put(snap(get() + dir * quantum));
      done?.();
    });
    input.addEventListener('input', () => put(Number(input.value)));
    sync();
    return { box, input, sync };
  }

  function buildFilmEditor(f, meta) {
    f.meta = meta;
    f.sourceNode = null;
    let shell = null;
    const refresh = () => shell?.show();

    // `syncs`: puts the sliders back in step when the app moves a value itself.
    const syncs = [];
    const range = (key, min, max, quantum, label) => {
      const slide = slideBox('editor-pane editor-ruler', {
        min, max, quantum, label,
        get: () => f[key],
        set: (v) => { f[key] = v; refresh(); filmPreview(); },
        reset: () => f.rest[key],
      });
      syncs.push(slide.sync);
      return slide.box;
    };
    f.syncSliders = () => { syncs.forEach((sync) => sync()); refresh(); };

    // Frame: on/off and colour in one row, the width under it.
    const toggle = el('button', { class: 'editor-switch', type: 'button', role: 'switch', 'aria-checked': String(filmPrefs.frame) },
      el('span', { class: 'switch', 'aria-hidden': 'true' }, el('span', { class: 'switch-knob' })), 'Frame');
    const colors = el('div', { class: 'seg', role: 'group', 'aria-label': 'Frame colour' },
      Object.keys(FRAME_COLORS).map((v) => el('button', {
        type: 'button', 'data-value': v, 'aria-pressed': String(filmPrefs.frameColor === v),
      }, v === 'white' ? 'White' : 'Black')));
    const size = slideBox('editor-frame-size', {
      min: 1, max: 20, quantum: 0.1, label: 'Frame size',
      get: () => filmPrefs.frameSize,
      set: (v) => { filmPrefs.frameSize = v; filmApplyFrame(f); refresh(); },
      reset: () => 5,
      done: saveFilmPrefs,
    });
    const frameState = () => {
      toggle.setAttribute('aria-checked', String(filmPrefs.frame));
      colors.classList.toggle('is-off', !filmPrefs.frame);
      size.input.disabled = !filmPrefs.frame;
    };
    const frameChanged = () => {
      frameState();
      saveFilmPrefs();
      filmApplyFrame(f);
      refresh();
    };
    toggle.addEventListener('click', () => {
      filmPrefs.frame = !filmPrefs.frame;
      frameChanged();
    });
    colors.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      filmPrefs.frameColor = b.dataset.value;
      filmPrefs.frame = true;
      for (const other of colors.children) other.setAttribute('aria-pressed', String(other === b));
      placeFill(colors);
      frameChanged();
    });
    frameState();
    trackFill(colors);

    // Original: shows the photo as it came for as long as it is held.
    // Six buttons share the row, so each label is six letters at most.
    const hold = toolButton('original', 'Before');
    hold.classList.add('film-compare');
    hold.setAttribute('aria-label', 'Hold to see the original');
    const compare = (on) => {
      f.stage?.classList.toggle('show-original', on);
      document.documentElement.classList.toggle('is-comparing', on);
      hold.classList.toggle('is-held', on);
    };
    hold.addEventListener('pointerdown', () => compare(true));
    hold.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    hold.addEventListener('contextmenu', (e) => e.preventDefault());
    for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) hold.addEventListener(type, () => compare(false));
    hold.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') compare(true); });
    hold.addEventListener('keyup', () => compare(false));

    const note = el('p', { class: 'visually-hidden', role: 'status' });
    f.note = note;
    const save = toolButton('save', 'Save');
    save.classList.add('tool-save');
    save.addEventListener('click', () => saveFilm(save, note));

    shell = editorShell(f, {
      exposure: { tool: 'Expose', label: 'Exposure', icon: 'exposure', value: () => fmtStops(f.exposure),
        node: range('exposure', -2, 3, 0.05, 'Exposure') },
      brightness: { tool: 'Bright', label: 'Brightness', icon: 'brightness', value: () => fmtStops(f.brightness),
        node: range('brightness', -1.5, 1.5, 0.05, 'Brightness') },
      highlights: { tool: 'Highs', label: 'Highlights', icon: 'highlights', value: () => fmtStops(f.highlights),
        node: range('highlights', -FILM_HIGHLIGHTS_MAX, FILM_HIGHLIGHTS_MAX, 0.1, 'Highlights') },
      shadows: { tool: 'Shadow', label: 'Shadows', icon: 'shadows', value: () => fmtStops(f.shadows),
        node: range('shadows', -FILM_HIGHLIGHTS_MAX, FILM_HIGHLIGHTS_MAX, 0.1, 'Shadows') },
      frame: { tool: 'Frame', label: 'Frame', icon: 'frame', value: () => (filmPrefs.frame ? `${filmPrefs.frameSize}%` : 'Off'),
        node: el('div', { class: 'editor-pane editor-stack' }, el('div', { class: 'editor-frame-row' }, toggle, colors), size.box) },
    }, [hold, save]);
    shell.show();
    return [shell.root, note];
  }

  function buildCardEditor(file, meta) {
    const stampy = () => cardPrefs.style !== 'pixel' && Boolean(CARD_FONTS[cardPrefs.font].glow);
    const autoSmall = () => {
      if (!card.smallEdited) card.small = stampy() ? card.stampSmall : card.plainSmall;
    };
    if (card?.file !== file) card = { file, smallEdited: false, ...cardDefaults(meta) };
    autoSmall();
    let shell = null;
    const refresh = () => shell?.show();

    // Text: pick a line, edit it in the one field.
    const LINES = [['title', 'Title', 'Camera'], ['details', 'Settings', '35 mm   f/1.8   1/250 s   ISO 100'], ['small', 'Small line', 'Lens, place or date']];
    let line = card.editorLine || 'title';
    const input = el('input', { type: 'text', maxlength: '80', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Line text' });
    const lineRow = el('div', { class: 'seg', role: 'group', 'aria-label': 'Line' },
      LINES.map(([key, label]) => el('button', { type: 'button', 'data-value': key, 'aria-pressed': String(key === line) },
        key === 'small' ? 'Small' : label)));
    const showLine = () => {
      const [, label, placeholder] = LINES.find(([key]) => key === line);
      input.value = card[line];
      input.placeholder = placeholder;
      input.setAttribute('aria-label', label);
    };
    lineRow.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      line = b.dataset.value;
      card.editorLine = line;
      for (const other of lineRow.children) other.setAttribute('aria-pressed', String(other === b));
      placeFill(lineRow);
      showLine();
      refresh();
    });
    input.addEventListener('input', () => {
      card[line] = input.value;
      if (line === 'small') card.smallEdited = true;
      drawPreview();
    });
    showLine();
    trackFill(lineRow);

    const seg = (key, options, cls) => {
      const box = el('div', { class: `seg${cls ? ` ${cls}` : ''}`, role: 'group', 'aria-label': key },
        options.map(([value, text]) => el('button', {
          type: 'button', 'data-value': value, 'aria-pressed': String(cardPrefs[key] === value),
        }, text)));
      box.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        cardPrefs[key] = b.dataset.value;
        for (const other of box.children) other.setAttribute('aria-pressed', String(other === b));
        placeFill(box);
        saveCardPrefs();
        autoSmall();
        showLine();
        drawPreview();
        refresh();
      });
      trackFill(box);
      return box;
    };
    const label = (key, options) => () => options.find(([v]) => v === cardPrefs[key])?.[1] || '';
    const STYLES = [['light', 'Light'], ['dark', 'Dark'], ['pixel', 'Pixel']];
    const FONTS = Object.entries(CARD_FONTS).map(([value, f]) => [value, f.label]);
    const SHAPES = [['original', 'Original'], ['square', 'Square'], ['portrait', '4:5']];

    const note = el('p', { class: 'visually-hidden', role: 'status' });
    const save = toolButton('save', 'Save');
    save.classList.add('tool-save');
    save.addEventListener('click', () => saveCard(save, note));

    shell = editorShell(card, {
      style: { tool: 'Style', label: 'Style', icon: 'style', value: label('style', STYLES),
        node: el('div', { class: 'editor-pane' }, seg('style', STYLES)) },
      font: { tool: 'Font', label: 'Font', icon: 'font', value: label('font', FONTS), disabled: () => cardPrefs.style === 'pixel',
        node: el('div', { class: 'editor-pane' }, seg('font', FONTS, 'seg-fonts')) },
      shape: { tool: 'Shape', label: 'Shape', icon: 'shape', value: label('shape', SHAPES),
        node: el('div', { class: 'editor-pane' }, seg('shape', SHAPES)) },
      text: { tool: 'Text', label: 'Text', icon: 'text', value: () => LINES.find(([key]) => key === line)[1],
        node: el('div', { class: 'editor-pane editor-stack' }, lineRow, input) },
    }, [save]);
    shell.show();
    return [shell.root, note];
  }

  // Phones get the editor in Film and Shot on; the class switches the page to its fixed, no-scroll layout.
  const editorWanted = () => Boolean(narrowLayout.matches && current?.img.ok && (mode === 'film' || mode === 'shot-on'));
  const syncEditor = () => {
    const on = editorWanted();
    viewerView.classList.toggle('is-editor', on);
    // The settings button (prefs.js) floats over the page's corner; in the editor that corner is
    // the photo or the tools, so the button sits in the top bar, left of the bar's own buttons.
    const gear = document.querySelector('.prefs-btn');
    const bar = document.querySelector('.topbar-right');
    if (gear && bar && (gear.parentNode === bar) !== on) {
      if (on) bar.prepend(gear);
      else document.body.append(gear);
    }
  };

