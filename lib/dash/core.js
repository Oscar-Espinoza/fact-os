// Dashboard core: state polling, routing, sidebar, settings controls and shared helpers. Views live in their own files and register with F.view().
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
  // A date and time in the viewer's own timezone: 'today 11:47 AM', 'yesterday 9:05 PM', else 'Oct 3, 11:47 AM' (the year
  // too when it is not this year's). `now` is for tests.
  const dayTime = (iso, now) => {
    const d = new Date(iso); if (isNaN(d)) return '';
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), n = now ? new Date(now) : new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(), diff = Math.round((day(d) - day(n)) / 864e5);
    if (diff === 0) return 'today ' + t;
    if (diff === -1) return 'yesterday ' + t;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== n.getFullYear() ? { year: 'numeric' } : {}) }) + ', ' + t;
  };
  const money = (n) => n ? '$' + n.toFixed(2) : '—';
  const byId = (id) => P && P.features.find((f) => f.id === id);
  // Titles often repeat the id's prefix ("F16-04: SEO …"); the id is shown next to them already.
  // Short form of an id for tight spots: "F10-07-B-store-deletion" → "F10-07-B"; ids without that shape stay whole.
  const shortId = (id) => { const m = /^[A-Z]+\d+(?:-\d+)+(?:-[A-Z])?(?=-|$)/.exec(id || ''); return m ? m[0] : id; };
  const title = (f) => { const m = /^([\w.-]+):\s+(.+)$/.exec(f.title || ''); return m && f.id.startsWith(m[1]) ? m[2] : f.title || ''; };
  // Only touch the DOM when the markup changed, so the 2s poll never swaps a button out from under a click.
  const setHTML = (el, html) => { if (el && el._h !== html) { el.innerHTML = html; el._h = html; } };

  // ---------- model ----------
  // attempts counts failures, not uncounted refresh/recovery stops. Metadata is
  // authoritative; legacy recognition is limited to the two exact foreman reasons.
  const stopInfo = (x) => x.stop && Number.isInteger(x.stop.attempt) && x.stop.attempt > 0 && typeof x.stop.counted === 'boolean' ? x.stop : null;
  const legacyStop = (text) => /^merge conflict with \S+: too many base refreshes \(\d+\)$/.test(text || '') || /^previous child still running \(pid \d+\)$/.test(text || '');
  const uncountedStop = (e) => { const stop = stopInfo(e); return stop ? !stop.counted : legacyStop(e.detail); };
  function currentStop(f) {
    if (!['stuck', 'paused', 'todo'].includes(f.status)) return null;
    const stop = stopInfo(f), count = f.attempts || 0;
    if (stop && stop.attempt === count + (stop.counted ? 0 : 1)) return stop;
    return f.status === 'stuck' && legacyStop(f.lastFeedback) ? { attempt: count + 1, counted: false } : null;
  }
  const attemptNumber = (f) => { const stop = currentStop(f); return stop ? stop.attempt :
    (f.attempts || 0) + (STAGE[f.status] || f.status === 'ready' || f.status === 'merged' ? 1 : 0); };
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
  // A drafted spec fix is waiting for a person's Apply or Dismiss (lib/specfix.ts).
  const specFixWaiting = (f) => !!(f && f.specFix && f.specFix.status === 'proposed');
  // Open items for "Only you": human tasks (all projects), ready features in manual-merge projects, and spec fixes waiting for a decision.
  const youCount = () => S.human.filter((h) => h.status !== 'done').length +
    S.projects.filter((p) => p.merge === 'manual').reduce((n, p) => n + p.features.filter((f) => f.status === 'ready').length, 0) +
    S.projects.reduce((n, p) => n + p.features.filter(specFixWaiting).length, 0);

  // Features in project p held up by the person's open tasks (directly listed in their `unblocks`, not yet merged), paused ones included.
  const heldByYou = (p) => { const open = new Set(); for (const t of p.tasks) if (t.status !== 'done') for (const id of t.unblocks || []) open.add(id);
    return p.features.filter((f) => open.has(f.id) && f.status !== 'merged').length; };

  // ---------- controls (control.json: pause new work, lanes) ----------
  // Lanes a person allows: their own number, else the config's (paused or not).
  const lanesAllowed = () => !P ? 0 : P.control ? (P.control.maxParallel ?? P.control.configMax) : (P.config && P.config.maxParallel) || 0;
  const later = () => (P.foreman.running ? '' : ' The foreman applies it when it starts.');
  const PAUSE_IC = '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="1.5" width="3" height="9" rx=".5"/><rect x="7" y="1.5" width="3" height="9" rx=".5"/></svg>';
  const PLAY_IC = '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.5v9l7.5-4.5z"/></svg>';
  function renderControls() {
    const c = P && !P.error && P.control, box = $('ctl');
    box.hidden = !c;
    $('ctl-none').hidden = !!c;
    $('set-proj').textContent = P ? P.name : '—';
    $('foreman').classList.toggle('paused', !!(c && c.paused));
    // The paused chip (sidebar and narrow top bar) shows whenever new work is paused, so it's visible from every view.
    for (const id of ['side', 'mbar']) $(id).classList.toggle('is-paused', !!(c && c.paused));
    if (!c) { $('ctl-invalid').hidden = true; return; }
    const allowed = lanesAllowed(), running = P.inFlight || 0, def = c.maxParallel != null && c.maxParallel !== c.configMax;
    box.classList.toggle('paused', c.paused);
    box.classList.toggle('invalid', !!c.invalid);
    // An invalid control.json: say so instead of showing the defaults (the foreman keeps its last good control, or holds new
    // work); any control action rewrites the file.
    setHTML($('lanes-t'), c.invalid ? '<span class="warn">Invalid file</span>'
      : '<b>' + running + '</b> of <b>' + allowed + '</b><span class="lanes-w"> lanes</span>' + (def ? '<small> (default ' + c.configMax + ')</small>' : ''));
    const said = c.invalid ? 'Invalid control file, ' + c.invalid + '. The foreman keeps its last good setting, or holds all new work if it started with this file. Any control here rewrites it.'
      : running + ' running of ' + allowed + ' lanes allowed' + (def ? ', config default ' + c.configMax : c.maxParallel == null ? ' (config default)' : '') + (c.paused ? '; paused' : '');
    $('lanes-t').title = said;
    $('lanes-g').setAttribute('aria-label', 'Lanes: ' + said);
    $('lanes-dn').disabled = allowed <= 0;
    $('lanes-up').disabled = allowed >= 32;
    $('lanes-def').hidden = !def || !!c.invalid;
    $('lanes-def').textContent = 'Use default (' + c.configMax + ')';
    $('ctl-invalid').hidden = !c.invalid;
    $('ctl-invalid').textContent = c.invalid ? 'The control file is invalid (' + c.invalid + '). The foreman keeps its last good settings, or holds all new work if it started with this file. Any control here rewrites it.' : '';
    $('pz-d').textContent = c.paused ? 'Paused: no new features start; running ones finish. Resume to start new features again.' : 'Running. Pause new work: running features finish, no new ones start.';
    $('pz-t').textContent = c.paused ? 'Resume' : 'Pause new work';
    setHTML($('pz-ic'), c.paused ? PLAY_IC : PAUSE_IC);
    $('pz').setAttribute('aria-label', c.paused ? 'Resume new work' : 'Pause new work: running features finish, no new ones start');
    $('pz').title = c.paused ? 'Resume: start new features again' : 'Pause new work: running features finish, no new ones start';
    renderMode(c);
    renderSpecFixes(c);
  }
  // Spec-fix mode (control.json `specFixes`, absent = manual): Manual | Auto.
  const SFX_SAID = { manual: 'Manual: you apply each proposed spec fix yourself.',
    auto: 'Auto: Claude and Codex apply spec fixes they both agree on; risky changes still wait for you.' };
  function renderSpecFixes(c) {
    const m = c.specFixes === 'auto' ? 'auto' : 'manual';
    $('sfx').querySelectorAll('[data-sfx]').forEach((b) => {
      b.setAttribute('aria-pressed', String(!c.invalid && b.dataset.sfx === m));
      b.disabled = !!c.invalid;
      b.title = c.invalid ? 'Unknown: the control file is invalid, ' + c.invalid + '.' : SFX_SAID[b.dataset.sfx];
    });
    $('sfx').title = c.invalid ? '' : 'Spec fixes: ' + SFX_SAID[m];
    $('sfx-d').textContent = c.invalid ? 'Unknown: the control file is invalid.' : SFX_SAID[m];
  }
  function setSpecFixes(m) {
    const c = P.control;
    if (c.invalid || (c.specFixes === 'auto' ? 'auto' : 'manual') === m) return;
    c.specFixes = m; render();
    return controlPost('/api/control/spec-fixes', { specFixes: m }, 'Spec fixes: ' + SFX_SAID[m]);
  }
  // Model profile (control.json `profile`): "Mode: Opus" / "Mode: Fable + Sonnet"; a click switches to the next profile. The
  // tooltip lists what each role runs with under the active one.
  const profileOf = (c) => (c.profiles || []).find((p) => p.name === (c.profile || 'opus'));
  const roleLine = (c) => (r) => r.role + ': ' + (r.model || 'default model') + ', ' + (r.effort || 'default effort') + (r.effortHigh ? ', ' + r.effortHigh + ' when risky' : '') +
    (!c.observerAgent && (r.role === 'observer' || r.role === 'curator') ? ' (observe --agent)' : '');
  function nextProfile(c) { const ps = c.profiles || [], i = ps.findIndex((p) => p.name === (c.profile || 'opus')); return ps.length > 1 ? ps[(i + 1) % ps.length] : null; }
  function renderMode(c) {
    const b = $('mode'), p = profileOf(c), next = nextProfile(c);
    b.hidden = !(c.profiles && c.profiles.length);
    $('set-mode').hidden = b.hidden;
    if (b.hidden) return;
    $('mode-t').textContent = c.invalid ? '?' : p ? p.label : c.profile;
    b.classList.toggle('alt', !!c.profile && !c.invalid);
    // An invalid control.json: the mode is unknown (the foreman keeps its last good one), so switching is off; pause, lanes or
    // the CLI rewrite the file.
    b.disabled = !next || !!c.invalid;
    const said = c.invalid ? 'Mode unknown: the control file is invalid, ' + c.invalid + '. The foreman keeps its last good mode. Fix the file, or rewrite it with pause, the lanes or ' + document.body.dataset.name + ' profile.'
      : 'Mode: ' + (p ? p.label : c.profile) + ' (applies to new launches; running features keep theirs)\n' + (p ? p.roles.map(roleLine(c)).join('\n') : '');
    b.title = said + (next && !c.invalid ? '\nClick to switch to ' + next.label + '.' : '');
    b.setAttribute('aria-label', said.replace(/\n/g, '; ') + (next && !c.invalid ? '. Activate to switch to ' + next.label : ''));
    $('mode-next').textContent = next && !c.invalid ? 'Click to switch to ' + next.label : '';
    setHTML($('mode-roles'), c.invalid || !p ? '' : p.roles.map((r) => { const l = roleLine(c)(r), i = l.indexOf(':'); return '<li><b>' + esc(l.slice(0, i)) + '</b>' + esc(l.slice(i)) + '</li>'; }).join(''));
  }
  function setProfile(p) {
    const c = P.control, running = P.inFlight || 0;
    if (c.invalid) return; // never shown as the defaults: the file must be fixed or rewritten first
    c.profile = p.name === 'opus' ? null : p.name; c.roles = p.roles; render();
    return controlPost('/api/control/profile', { profile: c.profile }, 'Mode: ' + p.label + ' for new launches' + (running ? '; ' + running + ' running keep theirs' : '') + '.' + later());
  }
  // Control POSTs run one after another; while any is queued or in flight, polls are not applied, so each click counts from the
  // optimistic state of the clicks before it. The state is reloaded once the queue drains.
  let ctlBusy = 0, ctlChain = Promise.resolve();
  function controlPost(url, body, ok) {
    const project = P.path;
    ctlBusy++;
    ctlChain = ctlChain.then(async () => {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, ...body }) });
        const b = await r.json().catch(() => ({}));
        toast(r.ok ? ok : b.error || 'Request failed');
      } catch { toast('Dashboard server is offline'); }
    }).finally(() => { if (--ctlBusy === 0) load(true); });
    return ctlChain;
  }
  // Set the lanes (null = the config default).
  function setLanes(n) {
    const c = P.control, value = n == null || n === c.configMax ? null : Math.max(0, Math.min(32, n)), next = value ?? c.configMax, running = P.inFlight || 0;
    if (value === c.maxParallel && !c.invalid) return;
    c.maxParallel = value; c.effective = c.paused ? 0 : next; delete c.invalid; render();
    const msg = next === 0 ? 'Lanes set to 0: no new features start' + (running ? '; ' + running + ' running will finish' : '')
      : running > next ? running + ' running will finish; no new ones start until fewer than ' + next + ' are running'
      : (value === null ? 'Lanes back to the default (' + next + ')' : 'Lanes set to ' + next) + (c.paused ? '; still paused' : '');
    return controlPost('/api/control/lanes', { maxParallel: value }, msg + '.' + later());
  }
  function togglePause() {
    const c = P.control, running = P.inFlight || 0, allowed = lanesAllowed();
    c.paused = !c.paused; c.effective = c.paused ? 0 : allowed; delete c.invalid; render();
    if (c.paused) return controlPost('/api/control/pause', {}, 'Paused: no new features start. ' + (running ? running + ' still running will finish.' : 'Nothing is running.') + later());
    return controlPost('/api/control/resume', {}, (allowed ? 'Resumed: up to ' + allowed + ' features in flight.' : 'Resumed, but lanes are 0: add a lane to start work.') + later());
  }

  // ---------- sidebar: picker, foreman status, Only-you count ----------
  function renderHeader() {
    $('pick-name').textContent = P ? P.name : 'No projects';
    setHTML($('menu'), S.projects.map((p) => {
      const m = p.features.filter((f) => f.status === 'merged').length, a = p.features.filter((f) => STAGE[f.status]).length;
      return '<button role="option" aria-selected="' + (p.path === cur) + '" data-project="' + esc(p.path) + '"><span class="ell"><b>' + esc(p.name) + '</b><small class="ell">' + esc(p.path) +
        '</small></span><span class="muted" style="text-align:right;font-size:12px">' + m + '/' + p.features.length + (a ? '<br>' + a + ' active' : '') + '</span></button>';
    }).join('') || '<div class="empty">No projects under this root.</div>');
    $('you-n').textContent = youCount() || '';
    renderControls();
    if (!P) return;
    const fm = P.foreman, busy = P.features.filter((f) => STAGE[f.status]).length, lanes = lanesAllowed(), paused = !!(P.control && P.control.paused);
    $('foreman').classList.toggle('on', fm.running);
    const hold = P.setupHold;
    $('setup-resume').hidden = !hold;
    $('set-setup').hidden = !hold;
    if (hold) $('setup-d').textContent = 'Setup kept failing since ' + ago(hold.since) + ' (' + (hold.features || []).join(', ') + '): ' + hold.reason + '. No new work starts. Fix the environment, then release the hold.';
    $('foreman-t').textContent = hold ? 'Setup failing: no new work' : fm.running ? (paused ? 'Factory paused' : 'Factory online') : 'Foreman stopped';
    // The lanes control next to it shows running/allowed; without it (no control state) keep the count here.
    $('foreman-s').textContent = hold ? 'since ' + ago(hold.since) + ' (' + (hold.features || []).join(', ') + '): ' + hold.reason : !fm.running ? 'run ' + document.body.dataset.name + ' start' : paused ? 'no new work starts' : P.control ? '' : busy + ' of ' + lanes + ' lanes busy';
    $('foreman').title = $('foreman-t').textContent + ' · ' + $('foreman-s').textContent;
    syncMini();
  }
  // The narrow top bar's status dot mirrors the sidebar's.
  function syncMini() {
    const f = $('foreman'), m = $('m-status');
    m.className = 'status mini' + (f.classList.contains('on') ? ' on' : '') + (f.classList.contains('paused') ? ' paused' : '');
    const t = $('foreman-t').textContent + ($('foreman-s').textContent ? ' · ' + $('foreman-s').textContent : '');
    m.title = t; m.setAttribute('aria-label', t);
  }

  // ---------- sidebar: collapse to an icon rail (remembered), a drawer on narrow screens ----------
  const narrow = window.matchMedia('(max-width:900px)');
  const root = document.documentElement;
  function setRail(min) {
    root.classList.toggle('side-min', min); store.set('sideMin', min);
    syncSide();
  }
  function setDrawer(open, focus) {
    root.classList.toggle('side-open', open);
    $('scrim').hidden = !open;
    $('side-open').setAttribute('aria-expanded', String(open));
    syncSide();
    if (open) { const a = document.querySelector('.tabs a[aria-current=page]') || document.querySelector('.tabs a'); if (a) a.focus(); }
    else if (focus) $('side-open').focus();
  }
  function syncSide() {
    const side = $('side');
    if (narrow.matches) side.inert = !root.classList.contains('side-open'); // a closed drawer is off screen: keep it out of the tab order
    else {
      // The edge handle (hidden on narrow screens, where the top bar's menu button opens the drawer).
      const t = $('side-tog'), min = root.classList.contains('side-min'), l = min ? 'Expand sidebar' : 'Collapse sidebar';
      t.setAttribute('aria-expanded', String(!min)); t.setAttribute('aria-label', l); t.title = l;
      side.inert = false;
    }
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
  views.set('settings', { render() {} }); // its controls are drawn by renderControls on every render

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
    return { view: ['factory', 'board', 'observer', 'project', 'you', 'settings'].includes(h) ? h : 'factory', id: null };
  }
  function render() {
    if (!S) return;
    P = S.projects.find((p) => p.path === cur) || S.projects[0] || null;
    if (P && P.path !== cur) { cur = P.path; store.set('project', cur); }
    renderHeader();
    for (const v of ['factory', 'board', 'observer', 'project', 'you', 'detail', 'settings']) $('v-' + v).classList.toggle('on', v === route.view);
    const tab = route.view === 'detail' ? 'factory' : route.view;
    document.querySelectorAll('.tabs a, .side-set').forEach((a) => a.setAttribute('aria-current', a.dataset.v === tab ? 'page' : 'false'));
    // Settings keeps its own markup and shows "no controls" itself.
    if (route.view !== 'you' && route.view !== 'settings' && !P) { $('v-' + route.view).firstElementChild.innerHTML = '<div class="blank"><h3>No projects</h3><span>Run <code>' + esc(document.body.dataset.name) + ' init</code> in a repo under this root.</span></div>'; return; }
    if (P && P.error) toast(P.name + ': ' + P.error);
    const v = views.get(route.view);
    if (v) v.render();
  }
  async function load(force) {
    try {
      if (ctlBusy) return; // a control change is on its way: keep its optimistic state until the queue drains
      const txt = await (await fetch('/api/state')).text();
      if (ctlBusy) return;
      if (force || txt !== sig) { sig = txt; S = JSON.parse(txt); render(); }
    } catch { $('foreman-t').textContent = 'Dashboard offline'; $('foreman').classList.remove('on'); syncMini(); }
  }
  function closeMenu() { $('menu').classList.remove('open'); $('pick').setAttribute('aria-expanded', 'false'); }

  function boot() {
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.picker')) closeMenu();
      const t = e.target.closest('button,a');
      if (!t) return;
      if (t.id === 'side-tog') { setRail(!root.classList.contains('side-min')); return; }
      if (t.id === 'side-open') { setDrawer(true); return; }
      if (t.tagName === 'A' && root.classList.contains('side-open') && t.closest('#side')) setDrawer(false); // same-hash links don't fire hashchange
      if (P && P.control && t.id === 'lanes-def') { setLanes(null); return; }
      if (P && P.control && (t.id === 'lanes-dn' || t.id === 'lanes-up')) { setLanes(lanesAllowed() + (t.id === 'lanes-up' ? 1 : -1)); return; }
      if (P && P.control && t.id === 'pz') { togglePause(); return; }
      if (P && t.id === 'setup-resume') { post('/api/setup/resume', P.path, undefined, 'Setup hold released: new work can start'); return; }
      if (P && P.control && t.dataset.sfx && t.closest('#sfx')) { setSpecFixes(t.dataset.sfx); return; }
      if (P && P.control && t.id === 'mode') { const n = nextProfile(P.control); if (n) setProfile(n); return; }
      if (t.id === 'pick') { const o = !$('menu').classList.contains('open'); $('menu').classList.toggle('open', o); t.setAttribute('aria-expanded', String(o)); return; }
      if (t.dataset.project && t.closest('#menu')) { closeMenu(); cur = t.dataset.project; store.set('project', cur); if (route.view === 'detail') location.hash = 'factory'; render(); }
    });
    window.addEventListener('blur', closeMenu); // clicks inside the project view iframe never reach document
    $('scrim').addEventListener('click', () => setDrawer(false));
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if ($('menu').classList.contains('open')) { closeMenu(); $('pick').focus(); return; }
      if (root.classList.contains('side-open')) setDrawer(false, true);
    });
    narrow.addEventListener('change', () => { if (!narrow.matches) setDrawer(false); else syncSide(); });
    syncSide();
    window.addEventListener('hashchange', () => { route = parseRoute(); window.scrollTo(0, 0); if (root.classList.contains('side-open')) setDrawer(false); render(); });
    // The views' ids match their hashes, so the browser scrolls to them on a fresh load, which would hide the narrow top bar.
    window.addEventListener('load', () => window.scrollTo(0, 0));
    route = parseRoute();
    load(); setInterval(load, 2000);
    setInterval(() => { const v = views.get(route.view); if (S && v && v.tick) v.tick(); }, 1000);
  }

  window.F = {
    get S() { return S; }, get P() { return P; }, get route() { return route; },
    $, esc, store, dur, ago, clock, dayTime, money, byId, shortId, title, setHTML, attemptNumber, stopInfo, currentStop, uncountedStop, statusOf, groupOf, progress, specFixWaiting, counts, youCount, heldByYou, LABEL, STAGE,
    toast, post, load, render, boot, lanesAllowed,
    control: { lanes: setLanes, toggle: togglePause, profile: (name) => { const p = P && P.control && (P.control.profiles || []).find((x) => x.name === name); return p && setProfile(p); }, resume: () => P && P.control && P.control.paused && togglePause(),
      pause: () => P && P.control && !P.control.paused && togglePause(), specFixes: (m) => P && P.control && setSpecFixes(m) },
    // Register a view: { render() } is called on every state change and route change; optional tick() every second.
    view(name, impl) { views.set(name, impl); },
    // Link to a feature's detail page.
    featureHref: (id) => '#f/' + encodeURIComponent(id),
  };
})();
