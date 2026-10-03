// Only-you view: the person's own to-do board (To do / Doing / Waiting / Done) with a detail panel.
'use strict';
(() => {
  const { $, esc, store, setHTML, post, featureHref } = F;
  const COLS = [['todo', 'To do', '#72b4ff'], ['doing', 'Doing', '#3ddc7a'], ['waiting', 'Waiting', '#b99cff'], ['done', 'Done', '#6b778a']];
  const KIND = { blocking: ['Blocking', '#ff7b7b'], mockable: ['Mockable', '#f5b73b'], merge: ['Merge', '#72b4ff'] };
  const KINDS = [['any', 'Any kind'], ['blocking', 'Blocking'], ['mockable', 'Mockable'], ['merge', 'Merges']];
  const DONE_SHOWN = 10;

  let kind = store.get('yk', 'any'), all = store.get('yall', true), tab = store.get('ytab', 'todo');
  let sel, open = false, askWait = false, waitVal = '', showAllDone = false, ready = false;
  if (!KINDS.some((k) => k[0] === kind)) kind = 'any';
  if (!COLS.some((c) => c[0] === tab)) tab = 'todo';

  const humanTitle = (t) => String(t || '').replace(/\s*\([^()]*\)\s*$/, '');
  const age = (iso) => { const ms = Date.now() - Date.parse(iso); if (!(ms >= 0)) return ''; const m = Math.floor(ms / 6e4), h = Math.floor(m / 60), d = Math.floor(h / 24);
    return d ? d + 'd' : h ? h + 'h' : m ? m + 'm' : 'just now'; };
  const stale = (iso) => Date.now() - Date.parse(iso) > 864e5;

  // Number of not-yet-merged features that (transitively) depend on feature `id`.
  function reachOf(p, id) {
    const seen = new Set(), stack = [id];
    while (stack.length) { const x = stack.pop(); for (const f of p.features) if (f.deps && f.deps.includes(x) && !seen.has(f.id)) { seen.add(f.id); stack.push(f.id); } }
    return [...seen].filter((i) => { const f = p.features.find((y) => y.id === i); return f && f.status !== 'merged'; }).length;
  }

  function items() {
    const S = F.S, P = F.P, out = [];
    for (const h of S.human) {
      const steps = h.steps || [], checked = h.checked || [], done = h.status === 'done';
      out.push({ key: h.project + '|' + h.id, kind: h.mockable ? 'mockable' : 'blocking', h, id: h.id, project: h.project, projectName: h.projectName, title: humanTitle(h.title),
        steps, n: steps.length, d: done ? steps.length : checked.filter((k) => k < steps.length).length, checked, reach: h.reach || 0,
        col: done ? 'done' : h.waitingOn ? 'waiting' : h.startedAt || checked.length ? 'doing' : 'todo',
        waitOn: h.waitingOn, waitSince: h.waitingSince, at: h.doneAt, unblocks: h.unblocks || [] });
    }
    for (const p of S.projects) if (p.merge === 'manual') for (const f of p.features) if (f.status === 'ready')
      out.push({ key: p.path + '|merge|' + f.id, kind: 'merge', f, id: f.id, project: p.path, projectName: p.name, title: 'Merge: ' + F.title(f), steps: [], n: 0, d: 0, checked: [],
        reach: reachOf(p, f.id), col: 'todo', unblocks: [] });
    return out.filter((i) => all || !P || i.project === P.path);
  }

  const ckey = (col) => (a, b) => col === 'done' ? Date.parse(b.at || 0) - Date.parse(a.at || 0) || 0 : b.reach - a.reach || a.id.localeCompare(b.id);
  const pct = (i) => (i.n ? Math.round(100 * i.d / i.n) : 0) + '%';

  function card(i) {
    const on = i.key === sel, [kl, kc] = KIND[i.kind], w = i.col === 'waiting';
    const wa = w && i.waitSince ? age(i.waitSince) : '';
    const steps = i.n ? i.d + '/' + i.n : '';
    return '<button class="y-card' + (on ? ' on' : '') + (i.col === 'done' ? ' done' : '') + '" data-k="' + esc(i.key) + '" aria-pressed="' + on + '">' +
      '<span class="y-t">' + esc(i.title) + '</span>' +
      '<span class="y-id mono">' + esc(i.id) + ' · ' + esc(i.projectName) + '</span>' +
      '<span class="y-pid mono">' + esc(i.id) + ' · ' + kl.toLowerCase() + ' · ↳' + i.reach + '</span>' +
      (w ? '<span class="y-wait"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#93a1b5" stroke-width="2.4" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' +
        '<span class="y-wo">' + esc(i.waitOn) + '</span><span class="mono y-wa' + (i.waitSince && stale(i.waitSince) ? ' old' : '') + '">' + wa + '</span></span>' +
        '<span class="y-pwait">Waiting on ' + esc(i.waitOn) + (wa ? ' · ' + wa : '') + '</span>' : '') +
      '<span class="y-foot"><span class="y-kind"><i style="background:' + kc + '"></i>' + kl + '</span><span class="y-sp"></span>' +
      (i.n ? '<span class="y-bar"><i style="width:' + pct(i) + '"></i></span><span class="mono">' + steps + '</span>' : '') +
      '<span class="mono" title="Features this unblocks">↳ ' + i.reach + '</span></span>' +
      (i.n ? '<span class="y-pbar"><span><i style="width:' + pct(i) + '"></i></span><span class="mono">' + steps + '</span></span>' : '') +
      '</button>';
  }

  function column(key, label, color, list, multi) {
    let hint = '', hc = '';
    if (key === 'doing') { hint = list.length > 1 ? 'focus on one' : 'one at a time'; hc = list.length > 1 ? ' warn' : ''; }
    if (key === 'waiting') hint = 'on someone else';
    let body = '', shown = list;
    if (key === 'done' && !showAllDone && list.length > DONE_SHOWN) shown = list.slice(0, DONE_SHOWN);
    body = shown.map(card).join('');
    if (key === 'done' && list.length > DONE_SHOWN) body += '<button class="y-more" data-more="1">' + (showAllDone ? 'Show latest ' + DONE_SHOWN : 'Show all ' + list.length) + '</button>';
    if (!list.length) body = '<p class="y-none">' + (multi ? 'No tasks match.' : 'Nothing here.') + '</p>';
    return '<section class="y-col" data-col="' + key + '" aria-label="' + label + '"><div class="y-ch"><i style="background:' + color + '"></i><h2>' + label + '</h2><span class="mono y-n">' + list.length +
      '</span><span class="y-sp"></span><span class="y-hint' + hc + '">' + hint + '</span></div><div class="y-list">' + body + '</div></section>';
  }

  function seg(list, cur, attr, label) {
    return '<div role="group" aria-label="' + label + '" class="y-seg">' + list.map(([k, l]) => '<button data-' + attr + '="' + k + '" aria-pressed="' + (k === cur) + '">' + l + '</button>').join('') + '</div>';
  }

  function detail(i) {
    const [kl] = KIND[i.kind], [cl, cc] = COLS.find((c) => c[0] === i.col).slice(1);
    const a = 'data-p="' + esc(i.project) + '" data-id="' + esc(i.id) + '"';
    const btn = (act, label, primary) => '<button class="y-btn' + (primary ? ' primary' : '') + '" data-act="' + act + '" ' + a + '>' + label + '</button>';
    let acts = '';
    if (i.kind === 'merge') acts = btn('merged', 'Mark merged', true);
    else if (i.col === 'todo') acts = btn('start', 'Start', true) + btn('done', 'Mark done');
    else if (i.col === 'doing') acts = btn('done', 'Mark done', true) + '<button class="y-btn" data-askwait="1" aria-expanded="' + askWait + '">Waiting on someone</button>';
    else if (i.col === 'waiting') acts = btn('unwait', 'Got a reply, resume', true) + btn('done', 'Mark done');
    else acts = btn('reopen', 'Reopen');
    return '<div class="y-dh"><button class="y-back" data-back="1"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>Back</button>' +
      '<span class="y-st"><i style="background:' + cc + '"></i>' + cl + '</span><span class="mono y-did">' + esc(i.id) + '</span><span class="y-sp"></span>' +
      '<button class="y-x" data-close="1" aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>' +
      '<div class="y-dt"><h2>' + esc(i.title) + '</h2><span>' + esc(i.projectName) + ' · ' + kl + ' · unblocks ' + i.reach + ' feature' + (i.reach === 1 ? '' : 's') + '</span></div>' +
      (i.col === 'waiting' ? '<div class="y-wbox"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#b99cff" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' +
        '<div><span>' + esc(i.waitOn) + '</span><span class="y-wd">Waiting ' + (i.waitSince ? age(i.waitSince) : '') + '</span></div></div>' : '') +
      (i.n ? '<div class="y-prog"><div><i style="width:' + pct(i) + '"></i></div><span>' + i.d + ' of ' + i.n + ' steps</span></div>' : '') +
      (i.kind === 'merge' ? '<p>Merge the evaluated commit into the base branch, then mark it merged. Dependents wait for this acknowledgment.</p>' : '') +
      '<div class="y-acts">' + acts + '</div>';
  }
  function rest(i) {
    const P = F.P, here = P && P.path === i.project, chips = i.unblocks.map((id) => { const f = here && P.features.find((x) => x.id === id);
      return f ? '<a class="y-chip mono" href="' + featureHref(id) + '" title="' + esc(F.title(f)) + '">' + esc(id) + '</a>' : '<span class="y-chip mono">' + esc(id) + '</span>'; }).join('');
    const more = Math.max(0, i.reach - i.unblocks.length);
    const a = 'data-p="' + esc(i.project) + '" data-id="' + esc(i.id) + '"';
    return (i.n ? '<ol class="y-steps">' + i.steps.map((s, k) => { const on = i.col === 'done' || i.checked.includes(k);
      return '<li><input type="checkbox" data-step="' + k + '" ' + a + (on ? ' checked' : '') + ' aria-label="Step ' + (k + 1) + '"><span class="' + (on ? 'on' : '') + '">' + esc(s) + '</span></li>'; }).join('') + '</ol>' : '') +
      (i.kind === 'merge' ? '<div class="y-sec"><h3>Feature</h3><p>' + esc(i.f.description || F.title(i.f)) + '</p>' + (i.f.branch ? '<p class="mono y-dim">' + esc(i.f.branch) + '</p>' : '') + '</div>' : '') +
      (chips || more ? '<div class="y-sec"><h3>Unblocks</h3><div class="y-chips">' + chips + '</div>' + (more ? '<p class="y-dim">and ' + more + ' more further down the chain</p>' : '') + '</div>' : '');
  }

  function waitForm(i) {
    if (!askWait || !i || i.col !== 'doing' || i.kind === 'merge') return '';
    return '<label class="y-wl">Who are you waiting on?<span class="y-wr"><input id="ywho" maxlength="200" placeholder="e.g. Mercado Pago partner support" autocomplete="off"><button class="y-btn primary" data-save="1">Save</button></span></label>';
  }

  function skeleton() {
    $('you').innerHTML = '<div class="y-bar"><div class="y-ttl"><h1>Only you</h1><span id="ysum"></span></div><div class="y-sp"></div><div id="yk"></div><div id="ysc"></div>' +
      '<label class="y-search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7d8ba0" stroke-width="2.4" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>' +
      '<input id="yq" type="search" placeholder="Search tasks" aria-label="Search tasks"></label></div>' +
      '<div class="y-main"><div class="y-body"><div class="y-tabs" role="tablist" id="ytabs"></div><div class="y-cols" id="ycols"></div></div>' +
      '<aside class="y-det" id="ydet" aria-label="Task detail"><div id="yd-top"></div><div id="yd-wait"></div><div id="yd-rest"></div></aside></div>';
    const root = $('you');
    $('yq').addEventListener('input', render);
    root.addEventListener('click', (e) => {
      const t = e.target.closest('button'); if (!t) return;
      const d = t.dataset;
      if (d.k) { if (sel !== d.k) { askWait = false; waitVal = ''; } sel = d.k; open = true; return render(); }
      if (d.tab) { tab = d.tab; store.set('ytab', tab); return render(); }
      if (d.yk) { kind = d.yk; store.set('yk', kind); return render(); }
      if (d.ysc) { all = d.ysc === '0'; store.set('yall', all); return render(); }
      if (d.more) { showAllDone = !showAllDone; return render(); }
      if (d.back) { open = false; return render(); }
      if (d.close) { sel = null; open = false; askWait = false; return render(); }
      if (d.askwait) { askWait = !askWait; render(); if (askWait) { const el = $('ywho'); if (el) el.focus(); } return; }
      if (d.save) return saveWait();
      if (d.act) {
        askWait = false; waitVal = '';
        if (d.act === 'merged') return post('/api/feature/merged', d.p, d.id, 'Marked merged');
        return post('/api/human/' + d.act, d.p, d.id, { start: 'Started', done: 'Marked done', reopen: 'Reopened', unwait: 'Resumed' }[d.act]);
      }
    });
    root.addEventListener('change', (e) => { const t = e.target; if (t.dataset && t.dataset.step != null) post('/api/human/step', t.dataset.p, t.dataset.id, '', { step: +t.dataset.step, on: t.checked }); });
    root.addEventListener('input', (e) => { if (e.target.id === 'ywho') waitVal = e.target.value; });
    root.addEventListener('keydown', (e) => {
      if (e.target.id === 'ywho' && e.key === 'Enter') { e.preventDefault(); saveWait(); }
      const tb = e.target.closest && e.target.closest('[role=tab]');
      if (tb && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        const i = COLS.findIndex((c) => c[0] === tab), n = COLS[(i + (e.key === 'ArrowRight' ? 1 : COLS.length - 1)) % COLS.length][0];
        tab = n; store.set('ytab', tab); render(); const nt = $('ytabs').querySelector('[data-tab="' + n + '"]'); if (nt) nt.focus();
      }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open && F.route.view === 'you') { open = false; render(); } });
  }
  function saveWait() {
    const it = current(), who = waitVal.trim();
    if (!it) return;
    if (!who) { F.toast('Say who you are waiting on'); const el = $('ywho'); if (el) el.focus(); return; }
    askWait = false; waitVal = '';
    post('/api/human/wait', it.project, it.id, 'Waiting on ' + who, { who }).then(render);
    render();
  }
  let vis = [];
  const current = () => vis.find((i) => i.key === sel);

  function render() {
    const root = $('you');
    if (!root) return;
    if (!ready) { skeleton(); ready = true; }
    const P = F.P, everything = items(), q = $('yq').value.trim().toLowerCase();
    const scoped = everything.filter((i) => kind === 'any' || i.kind === kind);
    const open_ = scoped.filter((i) => i.col !== 'done');
    const waitN = (all ? F.S.projects : P ? [P] : []).reduce((n, p) => n + F.heldByYou(p), 0);
    setHTML($('ysum'), scoped.length ? (scoped.length - open_.length) + ' of ' + scoped.length + ' done · ' + waitN + ' feature' + (waitN === 1 ? '' : 's') + ' waiting on you' : 'Nothing needs you right now');
    setHTML($('yk'), seg(KINDS, kind, 'yk', 'Kind'));
    setHTML($('ysc'), seg([['1', 'This project'], ['0', 'All projects']], all ? '0' : '1', 'ysc', 'Scope'));
    vis = scoped.filter((i) => !q || (i.title + ' ' + i.id + ' ' + i.projectName).toLowerCase().includes(q));
    // sel: undefined = pick a default, null = the person closed the panel, else a key (re-pick if that task is gone).
    if (sel === undefined || (sel && !everything.some((i) => i.key === sel))) {
      const first = COLS.map((c) => vis.filter((i) => i.col === c[0]).sort(ckey(c[0]))[0]).find(Boolean); sel = first ? first.key : null;
    }
    const it = current();
    if (!it) open = false;
    setHTML($('ytabs'), COLS.map(([k, l, c]) => '<button role="tab" id="ytab-' + k + '" data-tab="' + k + '" aria-selected="' + (k === tab) + '" style="--tc:' + c + '"><span>' + l +
      '</span><span class="mono">' + vis.filter((i) => i.col === k).length + '</span></button>').join(''));
    const cols = $('ycols'); cols.dataset.tab = tab;
    setHTML(cols, COLS.map(([k, l, c]) => column(k, l, c, vis.filter((i) => i.col === k).sort(ckey(k)), !!q || kind !== 'any')).join(''));
    root.classList.toggle('open', open);
    if (!everything.length) setHTML(cols, '<div class="y-empty">Nothing needs you right now. Accounts, keys and manual merges show up here when the factory needs them.</div>');
    $('ydet').classList.toggle('empty', !it);
    if (it) { setHTML($('yd-top'), detail(it)); setHTML($('yd-rest'), rest(it)); }
    else { setHTML($('yd-top'), '<p class="y-none">Select a task to see what to do.</p>'); setHTML($('yd-rest'), ''); }
    const w = $('yd-wait'); setHTML(w, waitForm(it));
    const inp = w.querySelector('input');
    if (inp && inp.dataset.init !== '1') { inp.dataset.init = '1'; inp.value = waitVal; }
  }
  F.view('you', { render, tick: render });
})();
