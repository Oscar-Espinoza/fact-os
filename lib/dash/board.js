// Board view: in-progress features as parallel cards, everything else as a grouped list. Features are shown by name.
'use strict';
(() => {
  const F = window.F, esc = F.esc;
  const RUN = ['building', 'testing', 'evaluating'];
  const COLOR = { building: '#5fd07a', testing: '#4fd1c5', evaluating: '#5aa9ff', waiting: '#f0b429' };
  const FRAME = { building: '#2e5a3c', testing: '#2a5a58', evaluating: '#2c4a70' };
  // list groups in display order: [key, label, color, collapsed by default]
  const GROUPS = [['stuck', 'Stuck', '#ef5b5b'], ['need', 'Needs you', '#f0b429'], ['queued', 'Queued', '#5aa9ff'], ['blocked', 'Blocked', '#7d8ba0'],
    ['paused', 'Paused', '#8d9ab0', true], ['ready', 'Ready', '#4fd1c5'], ['merged', 'Merged', '#3f9a5a', true]];
  const FILTERS = [['all', 'All'], ['progress', 'In progress'], ['queued', 'Queued'], ['need', 'Needs you'], ['blocked', 'Blocked'], ['stuck', 'Stuck'],
    ['paused', 'Paused'], ['ready', 'Ready'], ['merged', 'Merged']];
  const SEARCH_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>';

  let built = false, filter = F.store.get('board.filter', 'all'), query = '';
  const el = {};

  function build() {
    built = true;
    const root = F.$('board');
    root.innerHTML = '<div class="b-bar"><div class="b-seg" id="b-seg" role="group" aria-label="Filter"></div><div class="b-grow"></div>' +
      '<label class="b-search">' + SEARCH_SVG + '<input id="b-q" type="search" placeholder="Search name, id or #issue" aria-label="Search features" autocomplete="off"></label></div>' +
      '<section class="b-active" id="b-active" hidden></section><section class="b-list" id="b-list" hidden></section><div class="b-empty" id="b-empty" hidden></div>';
    for (const k of ['seg', 'q', 'active', 'list', 'empty']) el[k] = F.$('b-' + k);
    el.q.addEventListener('input', () => { query = el.q.value.trim().toLowerCase(); draw(); });
    root.addEventListener('click', (e) => {
      const seg = e.target.closest('[data-filter]');
      if (seg) { filter = seg.dataset.filter; F.store.set('board.filter', filter); draw(); return; }
      const t = e.target.closest('[data-toggle]');
      if (t) { const o = openMap(); o[t.dataset.toggle] = !isOpen(t.dataset.toggle, o); F.store.set(openKey(), o); draw(); return; }
      if (e.target.closest('[data-retry]')) retryAll();
    });
  }

  const openKey = () => 'board.open.' + F.P.path;
  const openMap = () => Object.assign({}, F.store.get(openKey(), {}));
  const isOpen = (k, o) => k in o ? !!o[k] : !GROUPS.find((g) => g[0] === k)[3];

  const needsYou = (f, s) => s === 'waiting' || (s === 'ready' && F.P.merge === 'manual');
  const groupKey = (f) => { const s = F.statusOf(f); return needsYou(f, s) ? 'need' : s; };

  function matches(f) {
    if (!query) return true;
    const num = /^#?(\d+)$/.exec(query);
    if (f.id.toLowerCase().includes(query.replace(/^#/, '')) || (f.title || '').toLowerCase().includes(query) || F.title(f).toLowerCase().includes(query)) return true;
    return !!num && f.issue != null && String(f.issue).includes(num[1]);
  }

  const byPri = (a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id);
  const byNew = (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

  function issueHtml(f) { return f.issue != null ? '#' + esc(f.issue) : ''; }
  function tries(f) { return 'try ' + Math.max(1, f.attempts || 0) + '/' + ((F.P.config && F.P.config.maxAttempts) || 3); }

  function cardHtml(f) {
    const s = F.statusOf(f), c = COLOR[s], p = F.progress(f) || { pct: 0, stage: 0, elapsed: 0 };
    return '<a class="b-card" href="' + esc(F.featureHref(f.id)) + '" data-id="' + esc(f.id) + '" style="--c:' + c + ';--f:' + FRAME[s] + '">' +
      '<div class="b-card-top"><h3>' + esc(F.title(f)) + '</h3><span class="b-chip">' + esc(F.LABEL[s]) + '</span></div>' +
      '<div class="b-meta mono"><span>' + esc(f.id) + '</span>' + (f.issue != null ? '<span class="b-iss">#' + esc(f.issue) + '</span>' : '<span class="b-none">no issue</span>') +
      '<span>' + tries(f) + '</span></div>' +
      '<div class="b-prog"><div class="b-bar3"><i style="width:' + p.pct + '%"></i></div><span class="b-time mono">' + F.STAGE[f.status][0] + ' · ' + F.dur(p.elapsed) + '</span></div></a>';
  }

  function waitingOn(f, key) {
    const P = F.P;
    if (key === 'blocked') {
      const d = (f.deps || []).filter((id) => { const x = F.byId(id); return !x || x.status !== 'merged'; });
      return d.slice(0, 2).join(', ') + (d.length > 2 ? ' +' + (d.length - 2) : '') || '—';
    }
    if (key === 'need') {
      if (F.statusOf(f) === 'ready') return 'your merge';
      const t = (P.tasks || []).find((x) => x.status === 'open' && (x.unblocks || []).includes(f.id));
      return t ? t.title : 'your input';
    }
    if (key === 'stuck') return ((f.lastFeedback || '').split('\n').find((l) => l.trim()) || '—').trim();
    return '—';
  }

  function rowHtml(f, key, color, rank) {
    const st = key === 'stuck' ? f.attempts + '/' + ((F.P.config && F.P.config.maxAttempts) || 3) + ' tries' : key === 'queued' ? 'P' + rank : key === 'need' ? (F.statusOf(f) === 'ready' ? 'Ready' : 'Needs you') : F.LABEL[key].toLowerCase();
    const w = waitingOn(f, key);
    return '<a class="b-row" href="' + esc(F.featureHref(f.id)) + '" style="--c:' + color + '">' +
      '<span class="b-st"><i></i><span>' + esc(st) + '</span></span><span class="b-name">' + esc(F.title(f)) + '</span><span class="b-id mono">' + esc(f.id) + '</span>' +
      '<span class="b-issue mono' + (f.issue == null ? ' none' : '') + '">' + (f.issue != null ? issueHtml(f) : '—') + '</span>' +
      '<span class="b-wait mono" title="' + esc(w) + '">' + esc(w) + '</span><span class="b-ago mono">' + esc(F.ago(f.updatedAt).replace(' ago', '')) + '</span></a>';
  }

  function draw() {
    if (!built) build();
    const P = F.P, o = openMap();
    const all = P.features, hit = all.filter(matches);
    // counts follow the search, so the chips show what each filter would list
    const cnt = { all: hit.length, progress: 0, queued: 0, need: 0, blocked: 0, stuck: 0, paused: 0, ready: 0, merged: 0 };
    const buckets = {}, active = [];
    for (const f of hit) {
      if (RUN.includes(f.status)) { cnt.progress++; active.push(f); continue; }
      const k = groupKey(f); cnt[k]++; (buckets[k] = buckets[k] || []).push(f);
    }
    if (!FILTERS.some((x) => x[0] === filter)) filter = 'all';
    F.setHTML(el.seg, FILTERS.filter((x) => x[0] !== 'ready' || cnt.ready || filter === 'ready').map(([k, label]) =>
      '<button type="button" data-filter="' + k + '" aria-pressed="' + (filter === k) + '">' + label + ' <span class="mono">' + cnt[k] + '</span></button>').join(''));

    // in progress
    const showCards = (filter === 'all' || filter === 'progress') && active.length;
    active.sort(byPri);
    el.active.hidden = !showCards;
    if (showCards) F.setHTML(el.active, '<div class="b-h"><h2>In progress</h2><span class="mono">' + active.length + ' of ' + ((P.config && P.config.maxParallel) || active.length) +
      ' lanes</span></div><div class="b-grid">' + active.map(cardHtml).join('') + '</div>');

    // list
    const order = P.ready.reduce((m, id, i) => (m[id] = i + 1, m), {});
    let out = '', n = 0;
    if (filter !== 'progress') for (const [k, label, color] of GROUPS) {
      if (filter !== 'all' && filter !== k) continue;
      const fs = buckets[k];
      if (!fs) continue;
      n += fs.length;
      if (k === 'queued') fs.sort((a, b) => (order[a.id] || 1e9) - (order[b.id] || 1e9) || byPri(a, b));
      else if (k === 'stuck' || k === 'merged' || k === 'ready' || k === 'paused') fs.sort(byNew); else fs.sort(byPri);
      const open = isOpen(k, o) || filter === k || !!query;
      const collapsible = filter !== k && !query;
      out += '<div class="b-group" style="--c:' + color + '"><span class="b-gl">' + label + '</span><span class="mono b-gn">' + fs.length + '</span><span class="b-grow"></span>' +
        (k === 'stuck' ? '<button type="button" class="b-tog mono" data-retry="1">Retry all</button>' : '') +
        (collapsible ? '<button type="button" class="b-tog mono" data-toggle="' + k + '" aria-expanded="' + open + '">' + (open ? 'Hide' : 'Show ' + fs.length) + '</button>' : '') + '</div>';
      if (open) out += fs.map((f, i) => rowHtml(f, k, color, k === 'queued' ? (order[f.id] || i + 1) : 0)).join('');
    }
    el.list.hidden = !n;
    if (n) F.setHTML(el.list, '<div class="b-cols mono"><span>STATUS</span><span>NAME</span><span>ID</span><span>ISSUE</span><span>WAITING ON</span><span class="r">UPDATED</span></div>' + out);

    const none = !showCards && !n;
    el.empty.hidden = !none;
    if (none) F.setHTML(el.empty, !all.length ? '<b>No features yet</b><span>Add some with the planner and they will show up here.</span>'
      : query ? '<b>Nothing matches “' + esc(el.q.value.trim()) + '”</b><span>Try a feature name, an id like F12-04, or an issue number.</span>'
      : '<b>Nothing here</b><span>No features are in this state right now.</span>');
  }

  function retryAll() {
    const P = F.P, fs = P.features.filter((f) => f.status === 'stuck' && matches(f));
    if (!fs.length) return;
    Promise.all(fs.map((f) => F.post('/api/feature/retry', P.path, f.id))).then(() => F.toast('Retrying ' + fs.length + ' stuck feature' + (fs.length > 1 ? 's' : '')));
  }

  function tick() {
    if (!built || !F.P) return;
    for (const c of el.active.querySelectorAll('.b-card')) {
      const f = F.byId(c.dataset.id), p = f && F.progress(f);
      if (!p) continue;
      c.querySelector('.b-bar3 i').style.width = p.pct + '%';
      c.querySelector('.b-time').textContent = F.STAGE[f.status][0] + ' · ' + F.dur(p.elapsed);
    }
  }

  F.view('board', { render: draw, tick });
})();
