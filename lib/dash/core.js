// Dashboard core: state polling, routing, header and shared helpers. Views live in their own files and register with F.view().
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const store = { get(k, d) { try { const v = localStorage.getItem('factos.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('factos.' + k, JSON.stringify(v)); } catch {} } };
  const DEF = { build: 12 * 60e3, test: 5 * 60e3, eval: 4 * 60e3 };
  const STAGE = { building: ['build', 0, 60], testing: ['test', 60, 80], evaluating: ['eval', 80, 100] };
  const LABEL = { building: 'Building', testing: 'Testing', evaluating: 'Evaluating', queued: 'Queued', blocked: 'Blocked', waiting: 'Needs you',
    ready: 'Ready', merged: 'Merged', stuck: 'Stuck', paused: 'Paused' };

  let S = null, P = null, sig = '', cur = store.get('project', null), route = { view: 'factory', id: null };
  const views = new Map();

  // ---------- formatting ----------
  const dur = (ms) => { if (!(ms >= 0)) return '—'; const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    return d ? d + 'd ' + (h % 24) + 'h' : h ? h + 'h ' + String(m % 60).padStart(2, '0') + 'm' : m ? m + 'm ' + String(s % 60).padStart(2, '0') + 's' : s + 's'; };
  const ago = (iso) => { const t = Date.parse(iso); return isNaN(t) ? '—' : dur(Date.now() - t).split(' ')[0] + ' ago'; };
  const clock = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); };
  const money = (n) => n ? '$' + n.toFixed(2) : '—';
  const byId = (id) => P && P.features.find((f) => f.id === id);
  // Titles often repeat the id's prefix ("F16-04: SEO …"); the id is shown next to them already.
  // Short form of an id for tight spots: "F10-07-B-store-deletion" → "F10-07-B"; ids without that shape stay whole.
  const shortId = (id) => { const m = /^[A-Z]+\d+(?:-\d+)+(?:-[A-Z])?(?=-|$)/.exec(id || ''); return m ? m[0] : id; };
  const title = (f) => { const m = /^([\w.-]+):\s+(.+)$/.exec(f.title || ''); return m && f.id.startsWith(m[1]) ? m[2] : f.title || ''; };
  // Only touch the DOM when the markup changed, so the 2s poll never swaps a button out from under a click.
  const setHTML = (el, html) => { if (el && el._h !== html) { el.innerHTML = html; el._h = html; } };

  // ---------- model ----------
  function statusOf(f) {
    if (f.status !== 'todo') return f.status;
    return P.waiting.includes(f.id) ? 'waiting' : P.ready.includes(f.id) ? 'queued' : 'blocked';
  }
  function groupOf(f) {
    if (f.group) return f.group;
    const g = P.config && P.config.groupBy, m = g && /^idPrefix:(\d+)$/.exec(g);
    if (m) return f.id.slice(0, +m[1]);
    const i = f.id.indexOf('-');
    return i > 0 ? f.id.slice(0, i) : 'Features';
  }
  // Estimated progress of an in-flight feature from median stage durations; null when it isn't running.
  function progress(f) {
    const st = STAGE[f.status];
    if (!st) return null;
    const [k, lo, hi] = st, med = (P.estimates && P.estimates[k]) || DEF[k];
    const el = Date.now() - Date.parse(P.stageSince[f.id] || f.updatedAt);
    const x = !(el > 0) ? 0 : el < med ? 0.9 * el / med : 0.9 + 0.09 * (1 - Math.exp(-(el - med) / med));
    return { pct: Math.round(lo + (hi - lo) * x), stage: x, elapsed: el, late: el > 2 * med };
  }
  function counts() {
    const c = {};
    for (const f of P.features) { const s = statusOf(f); c[s] = (c[s] || 0) + 1; }
    return c;
  }
  // Open items for "Only you": human tasks (all projects) + ready features in manual-merge projects.
  const youCount = () => S.human.filter((h) => h.status !== 'done').length +
    S.projects.filter((p) => p.merge === 'manual').reduce((n, p) => n + p.features.filter((f) => f.status === 'ready').length, 0);

  // Features in project p held up by the person's open tasks (directly listed in their `unblocks`, not yet merged), paused ones included.
  const heldByYou = (p) => { const open = new Set(); for (const t of p.tasks) if (t.status !== 'done') for (const id of t.unblocks || []) open.add(id);
    return p.features.filter((f) => open.has(f.id) && f.status !== 'merged').length; };

  // ---------- header ----------
  function renderHeader() {
    $('pick-name').textContent = P ? P.name : 'No projects';
    setHTML($('menu'), S.projects.map((p) => {
      const m = p.features.filter((f) => f.status === 'merged').length, a = p.features.filter((f) => STAGE[f.status]).length;
      return '<button role="option" aria-selected="' + (p.path === cur) + '" data-project="' + esc(p.path) + '"><span class="ell"><b>' + esc(p.name) + '</b><small class="ell">' + esc(p.path) +
        '</small></span><span class="muted" style="text-align:right;font-size:12px">' + m + '/' + p.features.length + (a ? '<br>' + a + ' active' : '') + '</span></button>';
    }).join('') || '<div class="empty">No projects under this root.</div>');
    $('you-n').textContent = youCount() || '';
    if (!P) return;
    const fm = P.foreman, busy = P.features.filter((f) => STAGE[f.status]).length, lanes = (P.config && P.config.maxParallel) || 0;
    $('foreman').classList.toggle('on', fm.running);
    $('foreman-t').textContent = fm.running ? 'Factory online' : 'Foreman stopped';
    $('foreman-s').textContent = fm.running ? busy + ' of ' + lanes + ' lanes busy' : 'run ' + document.body.dataset.name + ' start';
    $('foreman').title = $('foreman-t').textContent + ' · ' + $('foreman-s').textContent;
  }

  // ---------- project view (iframe) ----------
  function renderProject() {
    const box = $('project'), dir = P.path.replace(/\/$/, '');
    if (!P.hasProjectView) {
      box.dataset.for = '';
      box.innerHTML = '<div class="blank"><h3>No project view yet</h3><span>This space shows how <b>' + esc(P.name) + '</b> is coming together, drawn your way.</span>' +
        '<span>Add <code>project-view.html</code> next to <code>features.json</code> in this project\'s state folder. It gets every feature on each refresh:</span>' +
        '<pre class="mono">window.addEventListener(\'message\', (e) =&gt; {\n  if (e.data?.type !== \'fact-os-state\') return;\n  // e.data.features: [{ id, title, status, group }]\n  // light up the pieces of your product here\n});</pre></div>';
      return;
    }
    if (box.dataset.for !== dir) {
      box.dataset.for = dir;
      box.innerHTML = '<iframe class="pv" id="pv" sandbox="allow-scripts" title="Project view" src="/project-view?project=' + encodeURIComponent(P.path) + '"></iframe>';
      $('pv').addEventListener('load', postView);
    }
    postView();
  }
  function postView() {
    const f = $('pv');
    if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'fact-os-state', project: P.name,
      features: P.features.map((x) => ({ id: x.id, title: x.title, status: statusOf(x), group: groupOf(x) })) }, '*');
  }
  views.set('project', { render: renderProject });

  // ---------- plumbing ----------
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3200); }
  // POST {project, id, ...extra}; toasts the error, or `ok` when given; then reloads state.
  async function post(url, project, id, ok, extra) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, id, ...extra }) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok || ok) toast(r.ok ? ok : b.error || 'Request failed');
    } catch { toast('Dashboard server is offline'); }
    await load(true);
  }
  function parseRoute() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (h.startsWith('f/')) return { view: 'detail', id: h.slice(2) };
    return { view: ['factory', 'board', 'project', 'you'].includes(h) ? h : 'factory', id: null };
  }
  function render() {
    if (!S) return;
    P = S.projects.find((p) => p.path === cur) || S.projects[0] || null;
    if (P && P.path !== cur) { cur = P.path; store.set('project', cur); }
    renderHeader();
    for (const v of ['factory', 'board', 'project', 'you', 'detail']) $('v-' + v).classList.toggle('on', v === route.view);
    const tab = route.view === 'detail' ? 'factory' : route.view;
    document.querySelectorAll('.tabs a').forEach((a) => a.setAttribute('aria-current', a.dataset.v === tab ? 'page' : 'false'));
    if (route.view !== 'you' && !P) { $('v-' + route.view).firstElementChild.innerHTML = '<div class="blank"><h3>No projects</h3><span>Run <code>' + esc(document.body.dataset.name) + ' init</code> in a repo under this root.</span></div>'; return; }
    if (P && P.error) toast(P.name + ': ' + P.error);
    const v = views.get(route.view);
    if (v) v.render();
  }
  async function load(force) {
    try {
      const txt = await (await fetch('/api/state')).text();
      if (force || txt !== sig) { sig = txt; S = JSON.parse(txt); render(); }
    } catch { $('foreman-t').textContent = 'Dashboard offline'; $('foreman').classList.remove('on'); }
  }
  function closeMenu() { $('menu').classList.remove('open'); $('pick').setAttribute('aria-expanded', 'false'); }

  function boot() {
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.picker')) closeMenu();
      const t = e.target.closest('button,a');
      if (!t) return;
      if (t.id === 'pick') { const o = !$('menu').classList.contains('open'); $('menu').classList.toggle('open', o); t.setAttribute('aria-expanded', String(o)); return; }
      if (t.dataset.project && t.closest('#menu')) { closeMenu(); cur = t.dataset.project; store.set('project', cur); if (route.view === 'detail') location.hash = 'factory'; render(); }
    });
    window.addEventListener('blur', closeMenu); // clicks inside the project view iframe never reach document
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    window.addEventListener('hashchange', () => { route = parseRoute(); window.scrollTo(0, 0); render(); });
    route = parseRoute();
    load(); setInterval(load, 2000);
    setInterval(() => { const v = views.get(route.view); if (S && v && v.tick) v.tick(); }, 1000);
  }

  window.F = {
    get S() { return S; }, get P() { return P; }, get route() { return route; },
    $, esc, store, dur, ago, clock, money, byId, shortId, title, setHTML, statusOf, groupOf, progress, counts, youCount, heldByYou, LABEL, STAGE,
    toast, post, load, render, boot,
    // Register a view: { render() } is called on every state change and route change; optional tick() every second.
    view(name, impl) { views.set(name, impl); },
    // Link to a feature's detail page.
    featureHref: (id) => '#f/' + encodeURIComponent(id),
  };
})();
