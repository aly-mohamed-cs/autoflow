// Injected into every page and frame of the design browser (element picker and recorder).
// Describes elements so the engine can build several ways to find them again, and
// reports clicks / typing back through Playwright bindings.
(() => {
  if (window.__autoflow) return;

  const TEXT_INPUT_TYPES = new Set(['text', 'email', 'search', 'tel', 'url', 'number', 'password', 'date', 'datetime-local', 'month', 'time', 'week', '']);
  let mode = 'off'; // 'off' | 'pick' | 'record'
  let hovered = null;
  let box = null;
  let tag = null;

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));

  function isTextField(el) {
    if (el.tagName === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    return el.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((el.getAttribute('type') || '').toLowerCase());
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    const tagName = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    switch (tagName) {
      case 'button': return 'button';
      case 'a': return el.hasAttribute('href') ? 'link' : null;
      case 'select': return el.multiple ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'img': return el.getAttribute('alt') ? 'img' : null;
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'table': return 'table';
      case 'option': return 'option';
      case 'input':
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        if (TEXT_INPUT_TYPES.has(type) && type !== 'password') return 'textbox';
        return null;
      default:
        return null;
    }
  }

  function labelText(el) {
    if (el.labels && el.labels.length) return clean(el.labels[0].innerText);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(' ').map((id) => document.getElementById(id)?.innerText).filter(Boolean).join(' ');
      if (text) return clean(text);
    }
    return '';
  }

  function accessibleName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const label = labelText(el);
    if (label) return label;
    const tagName = el.tagName;
    if (tagName === 'INPUT') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type)) return clean(el.value);
      if (type === 'image') return clean(el.alt);
      return clean(el.getAttribute('title') || el.getAttribute('placeholder') || '');
    }
    if (tagName === 'IMG') return clean(el.alt);
    if (tagName === 'SELECT' || tagName === 'TEXTAREA') return clean(el.getAttribute('title') || el.getAttribute('placeholder') || '');
    const text = clean(el.innerText);
    if (text && text.length <= 80) return text;
    return clean(el.getAttribute('title') || '');
  }

  const ROLE_NOUN = {
    button: 'button', link: 'link', textbox: 'box', searchbox: 'search box', combobox: 'list', listbox: 'list',
    checkbox: 'checkbox', radio: 'option', heading: 'heading', img: 'image', table: 'table', spinbutton: 'box',
    slider: 'slider', tab: 'tab', menuitem: 'menu item', option: 'option',
  };

  function friendlyName(el, role, name) {
    const noun = ROLE_NOUN[role] || (el.tagName === 'INPUT' && el.type === 'password' ? 'box' : '');
    let base = name || el.getAttribute('name') || el.id || clean(el.innerText).slice(0, 30) || el.tagName.toLowerCase();
    base = base.replace(/[:*]+$/, '').trim();
    if (base.length > 40) base = base.slice(0, 39) + '…';
    if (el.tagName === 'INPUT' && el.type === 'password' && !/password/i.test(base)) base += ' password';
    return noun && !base.toLowerCase().endsWith(noun) ? `${base} ${noun}` : base;
  }

  const looksGenerated = (v) => /\d{3,}|[a-f0-9]{8,}|^(ember|react|ng|mui|css)-?\w*\d/i.test(v);

  function unique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function cssCandidates(el) {
    const out = [];
    const tagName = el.tagName.toLowerCase();
    if (el.id && !looksGenerated(el.id) && unique(`#${cssEscape(el.id)}`)) out.push(`#${cssEscape(el.id)}`);
    const name = el.getAttribute('name');
    if (name && unique(`${tagName}[name="${name}"]`)) out.push(`${tagName}[name="${name}"]`);
    out.push(cssPath(el));
    return [...new Set(out)];
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id && !looksGenerated(node.id)) {
        parts.unshift(`#${cssEscape(node.id)}`);
        if (unique(parts.join(' > '))) return parts.join(' > ');
        parts.shift();
      }
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      const candidate = parts.join(' > ');
      if (unique(candidate)) return candidate;
      node = parent;
    }
    return parts.join(' > ');
  }

  function xpathOf(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.id && !looksGenerated(node.id)) {
        parts.unshift(`//*[@id="${node.id}"]`);
        return parts.join('/');
      }
      let index = 1;
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) index++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
      node = node.parentElement;
    }
    return '/' + parts.join('/');
  }

  /** Climb from the clicked node to the element a person means (the button, not the icon inside it). */
  function meaningful(el) {
    let node = el;
    for (let i = 0; node && i < 4; i++) {
      const role = roleOf(node);
      if (role && role !== 'img') return node;
      if (node.tagName === 'LABEL' && node.control) return node.control;
      node = node.parentElement;
    }
    return el;
  }

  let markCounter = 0;

  function describe(el) {
    // A unique mark lets the engine find this exact element again (for screenshots and checks).
    const mark = String(++markCounter) + '-' + Math.random().toString(36).slice(2, 6);
    el.setAttribute('data-autoflow-mark', mark);
    const role = roleOf(el);
    const name = accessibleName(el);
    const rect = el.getBoundingClientRect();
    const testid = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test') || el.getAttribute('data-qa') || '';
    const text = ['BUTTON', 'A', 'SPAN', 'TD', 'TH', 'LI', 'LABEL', 'DIV', 'P', 'H1', 'H2', 'H3', 'H4'].includes(el.tagName) ? clean(el.innerText) : '';
    const info = {
      mark,
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute('type') || '').toLowerCase(),
      role,
      name,
      label: labelText(el),
      placeholder: el.getAttribute('placeholder') || '',
      testid,
      text: text.length <= 60 ? text : '',
      css: cssCandidates(el),
      xpath: xpathOf(el),
      friendly: friendlyName(el, role, name),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
    if (el.tagName === 'SELECT') {
      info.option = clean(el.selectedOptions[0]?.text || '');
    }
    if (el.type === 'checkbox' || el.type === 'radio') info.checked = el.checked;
    return info;
  }

  // -- highlight overlay (inside this frame) ---------------------------------------

  function ensureOverlay() {
    if (box) return;
    box = document.createElement('div');
    box.setAttribute('data-autoflow-overlay', '');
    Object.assign(box.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: 2147483646, border: '2px solid #4f46e5',
      background: 'rgba(79,70,229,0.12)', borderRadius: '3px', transition: 'all 60ms', display: 'none',
    });
    tag = document.createElement('div');
    tag.setAttribute('data-autoflow-overlay', '');
    Object.assign(tag.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: 2147483647, background: '#4f46e5', color: '#fff',
      font: '12px/1.4 Segoe UI, system-ui, sans-serif', padding: '2px 6px', borderRadius: '3px', display: 'none',
      maxWidth: '320px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    });
    document.documentElement.append(box, tag);
  }

  function highlight(el) {
    ensureOverlay();
    if (!el || mode === 'off') {
      box.style.display = 'none';
      tag.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.x - 2}px`, top: `${r.y - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
    const role = roleOf(el);
    tag.textContent = (mode === 'pick' ? 'Click to pick: ' : '') + friendlyName(el, role, accessibleName(el));
    Object.assign(tag.style, { display: 'block', left: `${Math.max(r.x, 4)}px`, top: `${r.y > 26 ? r.y - 24 : r.bottom + 4}px` });
  }

  const isOverlay = (el) => el && el.hasAttribute && el.hasAttribute('data-autoflow-overlay');

  document.addEventListener('mousemove', (e) => {
    if (mode === 'off') return;
    if (e.ctrlKey && mode === 'pick') {
      hovered = null;
      highlight(null);
      return;
    }
    const el = meaningful(e.target);
    if (el !== hovered && !isOverlay(el)) {
      hovered = el;
      highlight(el);
    }
  }, true);

  const send = (name, payload) => {
    const fn = window[name];
    if (typeof fn === 'function') fn(payload).catch?.(() => {});
  };

  // Picking: swallow the click so the page doesn't react to it.
  for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
    document.addEventListener(type, (e) => {
      if (mode === 'pick' && !e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }

  document.addEventListener('click', (e) => {
    // Holding Ctrl clicks normally, e.g. to sign in before picking.
    if (mode === 'pick' && !e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      const el = meaningful(e.target);
      send('__autoflowPicked', describe(el));
      return;
    }
    if (mode === 'record') {
      // Enter in a text box makes the browser "click" the form's submit button (detail 0).
      // That Enter is already recorded on the typing step, so skip the synthetic click.
      if (e.detail === 0 && Date.now() - lastEnterInField < 500) return;
      const el = meaningful(e.target);
      if (isTextField(el) || el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'OPTION') return;
      if (el.tagName === 'INPUT' && el.type === 'file') return;
      flushTyping(el);
      send('__autoflowRecorded', { action: 'click', target: describe(el) });
    }
  }, true);

  const lastTyped = new WeakMap();
  let lastEnterInField = 0;
  let editing = null; // text field with typing not yet recorded

  document.addEventListener('input', (e) => {
    if (mode === 'record' && isTextField(e.target)) editing = e.target;
  }, true);

  /** Record typing that hasn't been reported yet, so steps keep the order the user acted in. */
  function flushTyping(except) {
    const el = editing;
    if (!el || el === except) return;
    editing = null;
    if (lastTyped.get(el) === el.value) return;
    lastTyped.set(el, el.value);
    send('__autoflowRecorded', { action: 'type', value: el.type === 'password' ? null : el.value, password: el.type === 'password', target: describe(el) });
  }

  document.addEventListener('keydown', (e) => {
    if (mode === 'pick' && e.key === 'Escape') {
      e.preventDefault();
      send('__autoflowPicked', null);
      return;
    }
    if (mode === 'record' && e.key === 'Enter' && isTextField(e.target) && e.target.tagName !== 'TEXTAREA') {
      const el = e.target;
      lastEnterInField = Date.now();
      if (editing === el) editing = null;
      const value = el.type === 'password' ? null : el.value;
      lastTyped.set(el, el.value);
      send('__autoflowRecorded', { action: 'type', value, password: el.type === 'password', press_enter: true, target: describe(el) });
    }
  }, true);

  document.addEventListener('change', (e) => {
    if (mode !== 'record') return;
    const el = e.target;
    flushTyping(el);
    if (el.tagName === 'SELECT') {
      send('__autoflowRecorded', { action: 'select', option: clean(el.selectedOptions[0]?.text || el.value), target: describe(el) });
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      send('__autoflowRecorded', { action: 'check', checked: el.checked, target: describe(el) });
    } else if (el.type === 'file') {
      send('__autoflowRecorded', { action: 'upload', file: el.files?.[0]?.name || '', target: describe(el) });
    } else if (isTextField(el)) {
      if (editing === el) editing = null;
      if (lastTyped.get(el) === el.value) return; // already recorded with Enter
      lastTyped.set(el, el.value);
      send('__autoflowRecorded', { action: 'type', value: el.type === 'password' ? null : el.value, password: el.type === 'password', target: describe(el) });
    }
  }, true);

  window.__autoflow = {
    setMode(next) {
      mode = next;
      hovered = null;
      highlight(null);
      document.documentElement.style.cursor = next === 'pick' ? 'crosshair' : '';
    },
    hideOverlay() {
      highlight(null);
    },
    cssPath,
    describe,
  };
})();
