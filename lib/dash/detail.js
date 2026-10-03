// Feature detail view (#f/<id>): summary, the line with "you are here", attempts, history, activity, needs-you, problems.
'use strict';
(() => {
  const { esc, $, dur, ago, clock, money, title } = F;
  const A = (n) => '/assets/' + n + '.png';
  const DEF = { build: 12 * 60e3, test: 5 * 60e3, eval: 4 * 60e3 };
  const FLIGHT = ['building', 'testing', 'evaluating'];
  const STAGES = ['build', 'test', 'eval'];
  const TONE = { // status card / marker colours: [bg, border, text, led]
    building: ['#0f2419', '#1f5a37', '#5fe08a', '#3ddc7a'], testing: ['#2a2110', '#5e4718', '#f5b73b', '#f5b73b'], evaluating: ['#1e1a33', '#4a3d80', '#b99cff', '#b99cff'],
    ready: ['#0f2419', '#1f5a37', '#5fe08a', '#3ddc7a'], merged: ['#0f2419', '#1f5a37', '#5fe08a', '#3ddc7a'], stuck: ['#2a1418', '#6a2a30', '#ff7b7b', '#ff6b6b'],
    paused: ['#111925', '#263346', '#b4c0d0', '#6b778a'], queued: ['#111925', '#263346', '#72b4ff', '#72b4ff'], blocked: ['#111925', '#263346', '#b4c0d0', '#6b778a'],
    waiting: ['#1e1a33', '#4a3d80', '#b99cff', '#b99cff'],
  };
  // Stations on the line art: [centre x, dim box x, dim box width]
  const ST = { intake: [101, 33, 138], queue: [295, 238, 116], build: [604, 435, 340], test: [930, 864, 134], inspect: [1087, 1034, 108], problems: [1222, 1170, 104], you: [1368, 1318, 102], shipped: [1532, 1476, 114] };
  const ORDER = ['intake', 'queue', 'build', 'test', 'inspect', 'problems', 'you', 'shipped'];
  const BAYS = [[452, 88, 494], [559, 89, 604], [672, 88, 714]]; // interior x, width, LED centre x
  const LAMPS = [[217, '5.3s'], [410, '7.1s'], [540, '6.2s'], [650, '8.4s'], [865, '5.9s'], [1025, '7.7s']];
  const ICON = { Bash: 'd-a1', Edit: 'd-a5', Write: 'd-a5', MultiEdit: 'd-a5', NotebookEdit: 'd-a5', Read: 'd-a3', Grep: 'd-a3', Glob: 'd-a3', Task: 'd-a4', Agent: 'd-a4' };

  let built = false, key = '', data = null, fetchedAt = 0, seq = 0, sig = '', openLog = 0, accOpen = false, scale = 1, ro = null;

  // ---------- helpers ----------
  const firstLine = (s) => String(s || '').split('\n')[0];
  const lines = (s, n) => String(s || '').split('\n').slice(0, n).join('\n');
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const plural = (n, w) => n + ' ' + (n === 1 ? w : w.endsWith('y') ? w.slice(0, -1) + 'ies' : w + 's');
  const minutes = (ms) => { const m = Math.max(1, Math.round(ms / 60e3)); return '~' + (m < 60 ? m + ' min' : Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'); };
  const when = (iso) => { const d = new Date(iso); if (isNaN(d)) return ''; const c = clock(iso).slice(0, 5); return d.toDateString() === new Date().toDateString() ? c : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
  const model = (m) => (m && m.model ? m.model + (m.effort ? ' · ' + m.effort : '') : '—');
  const failStage = (detail) => /^(FAILED|Evaluator:|CHEATING|BLOCKING)/.test(detail || '') ? 'eval' : /merge conflict|mergeHook|committing the merge/.test(detail || '') ? 'merge' : /test command|gate/i.test(detail || '') ? 'test' : 'build';
  const FAILTXT = { eval: 'Failed evaluation', test: 'Failed at test bench', merge: 'Failed at merge', build: 'Failed while building', unknown: 'Failed (record unavailable)' };
  const stageWord = (f, P) => STAGES.includes(f) ? f : 'build';

  // Everything the sections need, derived from the feature, project and fetched history.
  function model_(f, P) {
    const s = F.statusOf(f), log = (data && data.log) || [], act = (data && data.activity) || [], runs = (data && data.runs) || [];
    const maxA = (P.config && P.config.maxAttempts) || 3, n = F.attemptNumber(f);
    const fails = log.filter((e) => e.event === 'failed' || e.event === 'stuck');
    // Human/observer retries reset the counter while historical evidence remains.
    // Associate only the failures still represented by the current counter.
    const boundary = log.findLastIndex((e) => e.attemptsReset === true || e.event === 'retrying' || e.event === 'observer-retry' || e.event === 'resumed' && e.attemptsReset === undefined);
    const ends = log.slice(boundary + 1).filter((e) => (e.event === 'failed' || e.event === 'stuck') && !F.uncountedStop(e));
    const currentFails = new Map(), count = f.attempts || 0;
    // Explicit numbers remain useful when history is truncated. Ambiguous duplicate
    // numbers and incomplete legacy histories stay unassociated.
    for (const e of ends) {
      const stop = F.stopInfo(e);
      if (stop && stop.counted && stop.attempt <= count && ends.filter((x) => F.stopInfo(x)?.attempt === stop.attempt).length === 1)
        currentFails.set(stop.attempt, e);
    }
    if (ends.length === count && ends.every((e, i) => !F.stopInfo(e) || F.stopInfo(e).attempt === i + 1))
      ends.forEach((e, i) => currentFails.set(i + 1, e));
    const stop = F.currentStop(f), stopped = !!stop && !stop.counted;
    const currentStopEvent = stopped ? log.slice(boundary + 1).filter((e) => e.event === 'stuck' && F.uncountedStop(e) &&
      (!F.stopInfo(e) || F.stopInfo(e).attempt === n)).pop() : null;
    const launches = log.filter((e) => e.event === 'launch');
    const runOf = (i, role) => runs.filter((r) => r.n === i && r.role === role).pop();
    const flight = FLIGHT.includes(s);
    const tries = [];
    for (let i = 1; i <= Math.max(maxA, n); i++) {
      const t = { n: i, runs: runs.filter((r) => r.n === i), build: runOf(i, 'build'), eval: runOf(i, 'eval'), fail: currentFails.get(i) || null,
        stop: i === n && stopped ? currentStopEvent || { detail: f.lastFeedback || '' } : null };
      if (i > n) t.state = 'notstarted';
      else if (i < n) t.state = 'failed';
      else t.state = flight ? { building: 'building', testing: 'testing', evaluating: 'evaluating' }[s] : s === 'ready' || s === 'merged' ? 'passed' : stopped ? 'stopped' : 'failed';
      if (t.state === 'failed') t.stage = t.fail ? failStage(t.fail.detail) : 'unknown';
      tries.push(t);
    }
    const cur = tries[n - 1] || null;
    const lastLaunch = launches.length ? launches[launches.length - 1].ts : null;
    const since = P.stageSince[f.id] || lastLaunch || f.updatedAt;
    const deps = (f.deps || []).map((id) => ({ id, ok: (F.byId(id) || {}).status === 'merged' }));
    const tasks = P.tasks.filter((t) => t.status === 'open' && (t.unblocks || []).includes(f.id));
    const manualReady = s === 'ready' && P.merge === 'manual';
    const merged = log.filter((e) => e.event === 'merged').pop();
    return { f, P, s, log, act, runs, maxA, n, tries, cur, fails, launches, flight, stopped, since, deps, tasks, manualReady, merged, hasRuns: !!(data && data.runs) };
  }

  // ---------- summary ----------
  function statusCard(m) {
    const { f, s, n, P } = m, tone = TONE[s], since = m.since;
    let a = F.LABEL[s], b = '', c = '';
    if (m.flight) { b = 'Attempt ' + n + ' is ' + { building: 'running', testing: 'testing', evaluating: 'being inspected' }[s]; c = 'Since ' + ago(since); }
    else if (s === 'stuck') { b = m.stopped ? 'Stuck on try ' + n : 'Stuck after ' + plural(n, 'try'); c = 'Updated ' + ago(f.updatedAt); }
    else if (s === 'merged') { b = 'Merged ' + ago(m.merged ? m.merged.ts : f.updatedAt); c = n ? 'On try ' + n : ''; }
    else if (s === 'ready') { b = m.manualReady ? 'Waiting for you to merge' : 'Merging on its own'; c = 'Passed on try ' + n; }
    else if (s === 'paused') { b = 'Paused by you'; c = f.pausedAt ? ago(f.pausedAt) : ''; }
    else if (s === 'queued') { b = 'Waiting for a free lane'; c = 'Priority ' + f.priority; }
    else if (s === 'blocked') { const w = m.deps.filter((d) => !d.ok).length; b = 'Waiting on ' + plural(w, 'dependency').replace('dependencys', 'dependencies'); c = ''; }
    else if (s === 'waiting') { b = 'A human task blocks it'; c = m.tasks.length ? plural(m.tasks.length, 'task') + ' for you' : ''; }
    const led = m.flight ? ' d-blink' : '';
    return '<div class="d-card d-status" style="background:' + tone[0] + ';border-color:' + tone[1] + '"><span class="d-st-h" style="color:' + tone[2] + '"><i class="d-led' + led + '" style="background:' + tone[3] + ';box-shadow:0 0 8px ' + tone[3] + '"></i>' +
      esc(a) + '</span><span class="d-st-b">' + esc(b) + '</span>' + (c ? '<span class="d-st-c">' + esc(c) + '</span>' : '') + '</div>';
  }
  function estimate(m) {
    if (!m.flight) return null;
    const est = m.P.estimates || {}, i = STAGES.indexOf(F.STAGE[m.s][0]);
    let left = 0;
    STAGES.forEach((k, j) => { const med = est[k] || DEF[k]; if (j === i) left += Math.max(med * 0.1, med - (Date.now() - Date.parse(m.since))); else if (j > i) left += med; });
    return minutes(left);
  }
  function stats(m) {
    const { f, n, P } = m, ok = m.deps.filter((d) => d.ok).length, builds = m.runs.filter((r) => r.role === 'build').length, evals = m.runs.filter((r) => r.role === 'eval').length;
    const prev = m.tries[n - 2] || (m.cur && m.cur.state === 'failed' ? m.cur : null);
    let aSub = 'not started', aCol = '#93a1b5';
    if (n) {
      const last = m.cur;
      if (m.s === 'merged' || m.s === 'ready') { aSub = 'passed on try ' + n; aCol = '#3ddc7a'; }
      else if (last.state === 'stopped') { aSub = 'stopped without using a retry'; aCol = '#f5b73b'; }
      else if (last.state === 'failed') { aSub = 'try ' + n + ' ' + FAILTXT[last.stage].replace('Failed at ', 'failed at ').replace('Failed ', 'failed ').replace('test bench', 'tests'); aCol = '#f5b73b'; }
      else if (prev && prev !== last) { aSub = 'try ' + prev.n + ' ' + FAILTXT[prev.stage].replace('Failed at ', 'failed at ').replace('Failed ', 'failed ').replace('test bench', 'tests'); aCol = '#f5b73b'; }
      else { aSub = 'first try'; }
    }
    const est = estimate(m);
    return [
      ['d-s-gear', 'ATTEMPT', n + ' / ' + m.maxA, aSub, aCol],
      ['d-s-doc', 'DEPENDS ON', ok + ' / ' + m.deps.length, !m.deps.length ? 'no dependencies' : ok === m.deps.length ? 'all merged' : plural(m.deps.length - ok, 'still open'), ok === m.deps.length ? '#3ddc7a' : '#f5b73b'],
      ['d-s-alert', 'COST SO FAR', money(f.costUsd), m.hasRuns ? plural(builds, 'build') + ' · ' + plural(evals, 'evaluation') : ' ', '#93a1b5'],
      ['d-s-cal', 'EST. DONE', est || '—', est ? 'rough, from past run times' : ' ', '#93a1b5'],
    ].map(([i, l, v, sub, col]) => '<div class="d-card d-stat"><img src="' + A(i) + '" alt="" width="36" height="36"><div><span class="d-sl">' + l + '</span><span class="d-sv">' + esc(v) + '</span><span class="d-ss" style="color:' + col + '">' + esc(sub) + '</span></div></div>').join('');
  }
  function buttons(m) {
    const { f, s } = m, out = [];
    const ic = { pause: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>',
      play: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5l12 7-12 7z"/></svg>',
      retry: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5"/></svg>' };
    if (f.status === 'todo' || f.status === 'stuck') out.push('<button class="d-b" data-act="pause">' + ic.pause + 'Pause</button>');
    if (f.status === 'paused') out.push('<button class="d-b pri" data-act="resume">' + ic.play + 'Resume</button>');
    if (f.status === 'stuck') out.push('<button class="d-b pri" data-act="retry">' + ic.retry + 'Retry with fresh attempts</button>');
    out.push('<button class="d-b sec" data-act="copy">Copy branch</button>');
    return out.join('');
  }
  function summary(m) {
    const { f, P } = m, issue = f.issue ? (P.repoUrl ? '<a class="d-iss" href="' + esc(P.repoUrl + '/issues/' + f.issue) + '" target="_blank" rel="noopener">#' + f.issue + '</a>' : '<span class="d-iss">#' + f.issue + '</span>') : '';
    return '<div class="d-card d-id"><img src="' + A('d-task') + '" alt="" width="58" height="58"><div class="d-idb"><h1>' + esc(title(f)) + '</h1><div class="d-ids mono"><span class="ell">' + esc(f.id) + '</span>' + issue + '</div>' +
      '<div class="d-tags"><span class="d-tg grp">' + esc(F.groupOf(f)) + '</span>' + (f.surface ? '<span class="d-tg">' + esc(f.surface) + '</span>' : '') + '<span class="d-tg">priority ' + esc(f.priority) + '</span></div></div></div>' +
      statusCard(m) + stats(m) + '<div class="d-btns">' + buttons(m) + '</div>';
  }

  // ---------- the line ----------
  function line(m) {
    const { s, n, P } = m, stuckNow = s === 'stuck';
    let st = 'intake', word = 'BLOCKED';
    if (s === 'queued') { st = 'queue'; word = 'QUEUED'; }
    else if (s === 'paused') { st = 'queue'; word = 'PAUSED'; }
    else if (s === 'building') { st = 'build'; word = 'TRY ' + Math.max(1, n); }
    else if (s === 'testing') { st = 'test'; word = 'TESTING'; }
    else if (s === 'evaluating') { st = 'inspect'; word = 'INSPECTING'; }
    else if (stuckNow) { st = 'problems'; word = 'STUCK'; }
    else if (s === 'waiting' || m.manualReady) { st = 'you'; word = 'NEEDS YOU'; }
    else if (s === 'ready') { st = 'shipped'; word = 'READY'; }
    else if (s === 'merged') { st = 'shipped'; word = 'SHIPPED'; }
    const cx = ST[st][0], tone = TONE[s][2], bd = TONE[s][2];
    let h = LAMPS.map(([x, d]) => '<i class="d-lamp" style="left:' + x + 'px;animation-duration:' + d + '"></i>').join('');
    ORDER.forEach((k, i) => { if (i > ORDER.indexOf(st)) h += '<i class="d-dim" style="left:' + ST[k][1] + 'px;width:' + ST[k][2] + 'px"></i>'; });
    BAYS.forEach(([x, w, lx], i) => {
      const t = i === 2 ? m.tries[Math.max(2, n - 1)] || m.tries[2] : m.tries[i];
      const bay = t && t.n <= Math.max(n, 0) ? t : null;
      let led = '<i class="d-bled off" style="left:' + (lx - 7) + 'px"></i>';
      if (bay && (bay.state === 'failed' || bay.state === 'stopped')) led = '<i class="d-bled red" style="left:' + (lx - 7) + 'px"></i><i class="d-tint" style="left:' + x + 'px;width:' + w + 'px"></i>';
      else if (bay) led = '<i class="d-bled grn' + (bay.state === 'building' ? ' d-blink' : '') + '" style="left:' + (lx - 7) + 'px"></i>';
      h += led;
    });
    h += '<div class="d-here" style="left:' + (cx - 85) + 'px"><span class="pix" style="color:' + tone + ';border-color:' + bd + '">' + (s === 'paused' ? '' : 'THIS FEATURE · ') + word + '</span></div><div class="d-belt"></div>';
    return h;
  }

  // ---------- panels ----------
  const panelHead = (icon, name, badge, right, w) => '<div class="d-ph"><img src="' + A(icon) + '" alt="" width="' + (w || 22) + '" height="22"><h3>' + name + '</h3>' + (badge ? '<span class="d-bd mono">' + badge + '</span>' : '') + (right ? '<span class="d-pr">' + right + '</span>' : '') + '</div>';

  function details(m) {
    const { f, P } = m, cfg = P.config || {};
    const row = (k, v, cls) => '<div class="d-kv"><span>' + k + '</span><span class="' + (cls || '') + '">' + v + '</span></div>';
    const acc = f.acceptance || [];
    const deps = m.deps.length ? m.deps.map((d) => '<a class="' + (d.ok ? 'ok' : 'no') + '" href="' + F.featureHref(d.id) + '" title="' + (d.ok ? 'merged' : 'not merged yet') + '">' + esc(d.id) + (d.ok ? ' ✓' : '') + '</a>').join(' ') : '<span class="dim">None</span>';
    const issue = f.issue ? (P.repoUrl ? '<a class="lnk" href="' + esc(P.repoUrl + '/issues/' + f.issue) + '" target="_blank" rel="noopener">#' + f.issue + '</a>' : '#' + f.issue) : '<span class="dim">Not linked</span>';
    return panelHead('d-p-list', 'FEATURE DETAILS', '', '', 24) +
      row('Name', esc(title(f))) + row('Description', f.description ? esc(f.description) : '<span class="dim">No description</span>', 'soft') +
      row('Acceptance', acc.length ? '<button class="d-lk" data-act="acc" aria-expanded="' + accOpen + '">' + plural(acc.length, 'criterion').replace('criterions', 'criteria') + (accOpen ? ' ▴' : ' ▾') + '</button>' +
        (accOpen ? '<ol class="d-acc">' + acc.map((a) => '<li>' + esc(a) + '</li>').join('') + '</ol>' : '') : '<span class="dim">None listed</span>', 'soft') +
      row('Project', esc(P.name)) + row('Depends on', deps, 'mono deps') + row('Branch', esc(f.branch || (P.branchPrefix || '') + f.id), 'mono') +
      row('Last commit', f.sha ? esc(f.sha.slice(0, 7)) : '<span class="dim">—</span>', 'mono') + row('GitHub issue', issue) +
      row('Models', esc(model(cfg.builder)) + ' <span class="dim">builder</span><br>' + esc(model(cfg.evaluator)) + ' <span class="dim">evaluator</span>', 'soft') + row('Updated', esc(ago(f.updatedAt)));
  }

  const TRY_STATE = { failed: null, stopped: ['Stopped', '#f5b73b'], building: ['Building', '#3ddc7a'], testing: ['Testing', '#f5b73b'], evaluating: ['Evaluating', '#b99cff'], passed: ['Passed', '#3ddc7a'], notstarted: ['Not started', '#6b778a'] };
  function tryCard(m, t) {
    const [txt, col] = t.state === 'failed' ? [FAILTXT[t.stage], '#ff7b7b'] : TRY_STATE[t.state];
    const live = t.state === 'building' || t.state === 'testing' || t.state === 'evaluating';
    const rows = [];
    const b = t.build, e = t.eval, ms = t.runs.reduce((n, r) => n + (r.ms || 0), 0), cost = t.runs.reduce((n, r) => n + (r.cost || 0), 0);
    if (t.state !== 'notstarted') {
      if (live) {
        const others = m.runs.filter((r) => r.n !== t.n).reduce((a, r) => a + (r.cost || 0), 0);
        const last = m.act[m.act.length - 1];
        rows.push(['Running', '<span data-since="' + esc(m.since) + '">' + dur(Date.now() - Date.parse(m.since)) + '</span>'],
          ['Cost', m.f.costUsd ? money(Math.max(0, m.f.costUsd - others)) : '—'], ['Last step', last ? esc(cut(last.summary || last.tool, 14)) : '—']);
      } else rows.push(['Duration', ms ? dur(ms) : '—'], ['Cost', cost ? money(cost) : '—'], ['Turns', b && b.turns != null ? String(b.turns) : '—']);
    }
    const art = t.state === 'notstarted' ? '<div class="d-idle">Only if try ' + (t.n - 1) + ' fails</div>' :
      '<img src="' + A(live ? 'd-card-arm' : t.state === 'failed' ? 'd-card-robot' : 'd-card-robot') + '" alt="" width="88" height="58" style="opacity:' + (t.state === 'failed' ? '.45' : '1') + '">';
    const hasLog = t.runs.length || t.fail || t.stop;
    return '<div class="d-try"><span class="d-tt">Try ' + t.n + '</span><span class="d-ts" style="color:' + col + '"><i style="background:' + col + '"></i>' + txt + '</span>' + art +
      rows.map(([k, v]) => '<div class="d-tr"><span>' + k + '</span><span class="mono">' + v + '</span></div>').join('') + '<span class="d-fill"></span>' +
      (hasLog ? '<button class="d-b log" data-log="' + t.n + '" aria-expanded="' + (openLog === t.n) + '">' + (openLog === t.n ? 'Hide log ↑' : 'View log →') + '</button>' : '') + '</div>';
  }
  function logPanel(m) {
    const t = m.tries[openLog - 1];
    if (!t) return '';
    let h = '<div class="d-lg"><div class="d-lgh">Try ' + t.n + ' recorded runs</div><div class="dim">Retained runs include refreshes and earlier retry cycles with this try number.</div>';
    for (const r of t.runs) {
      h += '<div class="d-lgs">Run ' + esc(r.tag || r.n) + ' · ' + { build: 'Builder', resolve: 'Resolver', eval: 'Evaluator verdict' }[r.role] + (r.role === 'eval' ? (r.pass ? ' · passed' : ' · rejected') : '') + '</div>';
      if (r.error) h += '<pre>' + esc(r.error) + '</pre>';
      if (r.findings) h += r.findings.map((x) => '<div class="d-fd ' + (x.ok ? 'ok' : 'no') + '"><b>' + (x.ok ? '✓' : '✗') + '</b><span>' + esc(x.check) + (x.evidence ? ' <em>' + esc(x.evidence) + '</em>' : '') + '</span></div>').join('');
      if (r.role !== 'eval' && r.summary) h += '<pre>' + esc(r.summary) + '</pre>';
      if (r.text) h += '<details><summary>Original agent output</summary><pre>' + esc(r.text) + '</pre></details>';
    }
    if (t.fail) h += '<div class="d-lgs">Why it failed</div><pre>' + esc(lines(t.fail.detail, 14)) + '</pre>';
    if (t.stop) h += '<div class="d-lgs">Why it stopped</div><pre>' + esc(lines(t.stop.detail, 14)) + '</pre>';
    if (!t.runs.length && !t.fail && !t.stop) h += '<div class="dim">No log saved for this try.</div>';
    return h + '</div>';
  }
  function attempts(m) {
    const total = m.tries.length, start = total > 3 ? Math.max(0, Math.min(m.n - 2, total - 3)) : 0, shown = m.tries.slice(start, start + 3);
    const right = m.s === 'stuck' ? m.stopped ? 'stopped without using a retry' : 'stuck after ' + plural(m.f.attempts || 0, 'failed try') : total > 3 ? 'tries ' + (start + 1) + '–' + (start + shown.length) + ' shown · +' + (total - shown.length) + ' more' : '';
    return panelHead('d-p-gear', 'ATTEMPTS', m.n + ' / ' + m.maxA, esc(right)) + '<div class="d-tries">' + shown.map((t) => tryCard(m, t)).join('') + '</div>' + logPanel(m);
  }

  const EV = { launch: ['#72b4ff'], failed: ['#ff7b7b'], stuck: ['#ff7b7b'], refreshed: ['#f5b73b'], lesson: ['#b99cff'], merged: ['#3ddc7a'], testing: ['#f5b73b'], evaluating: ['#b99cff'], interrupted: ['#f5b73b'] };
  function history(m) {
    const total = m.launches.length, numbered = total <= Math.max(m.maxA, m.n);
    let k = 0;
    const rows = m.log.map((e) => {
      let what = e.event, det = firstLine(e.detail);
      const col = (EV[e.event] || ['#6b778a'])[0];
      if (e.event === 'launch') { k++; what = numbered ? 'Started try ' + k : 'Started a try'; det = k > 1 ? 'with the last failure as feedback' : ''; }
      else if (e.event === 'refreshed') { const c = /(?:^|, )conflicts in: /.test(det); what = c ? (det.startsWith('before build, ') ? 'Dependency import needs resolution' : 'Merge conflict resolved') : 'Branch refreshed from main'; det = c ? det.split('conflicts in: ')[1] : det; }
      else if (e.event === 'failed') { what = { test: 'Test bench failed', eval: 'Inspection failed', merge: 'Merge failed', build: 'Try failed' }[failStage(e.detail)]; det = det.replace(/^(FAILED|Evaluator:)\s*/, ''); }
      else if (e.event === 'stuck') { what = 'Marked stuck'; det = det.replace(/^(FAILED|Evaluator:)\s*/, ''); }
      else if (e.event === 'lesson') what = 'Lesson saved';
      else if (e.event === 'merged') { what = 'Merged'; }
      else if (e.event === 'testing') what = 'Test bench started';
      else if (e.event === 'evaluating') what = 'Inspection started';
      else if (e.event === 'interrupted') what = 'Interrupted';
      else if (e.event === 'post-merge') what = 'Post-merge check';
      else what = e.event.replace(/^./, (c) => c.toUpperCase()).replace(/-/g, ' ');
      return { col, what, det, ts: e.ts };
    }).reverse().slice(0, 40);
    const next = { building: 'Next: test bench', testing: 'Next: inspection', evaluating: m.P.merge === 'manual' ? 'Next: waits for your merge' : 'Next: merge' }[m.s];
    let h = panelHead('d-p-hist', 'HISTORY', '', '');
    if (!data) return h + '<div class="dim d-em">Loading…</div>';
    h += '<div class="d-list">';
    if (next) h += '<div class="d-hr"><i style="background:#6b778a"></i><span class="w">' + next + '</span><span class="dim"></span><span></span></div>';
    h += rows.map((r) => '<div class="d-hr"><i style="background:' + r.col + '"></i><span class="w">' + esc(r.what) + '</span><span class="dim ell" title="' + esc(r.det) + '">' + esc(r.det) + '</span><span class="t mono" title="' + esc(new Date(r.ts).toLocaleString()) + '">' + when(r.ts) + '</span></div>').join('');
    return h + (rows.length || next ? '' : '<div class="dim d-em">No events yet.</div>') + '</div>';
  }

  function benches(m) {
    const { s, n, tries } = m, lastFail = m.cur && m.cur.state === 'failed' ? m.cur : null;
    const evalRun = m.cur && m.cur.eval;
    const el = '<span data-since="' + esc(m.since) + '">' + dur(Date.now() - Date.parse(m.since)) + '</span>';
    let t, i;
    if (s === 'testing') t = ['Running', '#f5b73b', 'Try ' + n + ' is running the project gate.', el, 1];
    else if (s === 'evaluating' || s === 'ready' || s === 'merged') t = ['Passed', '#3ddc7a', 'The project gate passed on try ' + n + '.', '', 1];
    else if (s === 'stuck' && lastFail && lastFail.stage === 'test') t = ['Failed', '#ff7b7b', cut(firstLine(lastFail.fail && lastFail.fail.detail), 110), '', 1];
    else if (m.stopped) t = ['Stopped', '#f5b73b', 'See retained runs for any earlier test results.', '', 0];
    else if (s === 'stuck' || s === 'paused') t = ['Not reached', '#6b778a', s === 'stuck' ? 'No current test result recorded.' : 'Paused before the gate.', '', 0];
    else t = ['Waiting', '#6b778a', 'Runs the project gate once try ' + Math.max(1, n || 1) + ' commits.', '', 0];
    const crit = (m.f.acceptance || []).length;
    if (s === 'evaluating') i = ['Running', '#b99cff', 'The evaluator is checking the ' + plural(crit, 'acceptance criterion').replace('criterions', 'criteria') + '.', el, 1];
    else if ((s === 'ready' || s === 'merged') && evalRun && evalRun.pass === false) i = ['Verdict rejected', '#ff7b7b', evalRun.error || 'The saved evaluator verdict did not pass validation.', '', 1];
    else if (s === 'ready' || s === 'merged') i = ['Passed', '#3ddc7a', evalRun && evalRun.findings ? evalRun.findings.filter((x) => x.ok).length + ' of ' + evalRun.findings.length + ' checks passed.' : 'The evaluator passed it.', '', 1];
    else if (s === 'stuck' && lastFail && lastFail.stage === 'eval') i = ['Failed', '#ff7b7b', cut(firstLine(lastFail.fail && lastFail.fail.detail).replace(/^FAILED /, ''), 110), '', 1];
    else if (m.stopped) i = ['Stopped', '#f5b73b', 'See retained runs for any earlier evaluator verdicts.', '', 0];
    else if (s === 'stuck' || s === 'paused') i = ['Not reached', '#6b778a', s === 'stuck' ? 'No current evaluator result recorded.' : 'Paused before inspection.', '', 0];
    else i = ['Waiting', '#6b778a', 'The evaluator checks the ' + plural(crit, 'acceptance criterion').replace('criterions', 'criteria') + '.', '', 0];
    return [['d-p-flask', 'TEST BENCH', t], ['d-p-insp', 'INSPECTION', i]].map(([ic, name, [st, col, note, extra, on]]) =>
      '<section class="d-panel d-bench' + (on ? '' : ' idle') + '"><div class="d-ph"><img src="' + A(ic) + '" alt="" width="22" height="22"><h3>' + name + '</h3></div><span class="d-bs" style="color:' + (on ? col : '#93a1b5') + '"><i style="background:' + col + '"></i>' + st +
      (extra ? ' <span class="mono d-bx">' + extra + '</span>' : '') + '</span><span class="d-bn">' + esc(note) + '</span></section>').join('');
  }

  function live(m) {
    const rows = m.act.slice().reverse().slice(0, 14);
    let h = '<div class="d-ph"><img src="' + A('d-p-live') + '" alt="" width="24" height="22"><h3>LIVE ACTIVITY</h3><span class="d-pr">' +
      (m.flight ? '<span class="d-lv"><i class="d-blink"></i>Live</span>' : '') + '</span></div>';
    if (!data) return h + '<div class="dim d-em">Loading…</div>';
    if (!rows.length) return h + '<div class="dim d-em">No agent actions recorded yet.</div>';
    return h + '<div class="d-list">' + rows.map((a) => '<div class="d-ar"><span class="t mono">' + clock(a.ts) + '</span><img src="' + A(ICON[a.tool] || 'd-a6') + '" alt="" width="20" height="20"><span class="ell"><span>' + esc(a.tool) + '</span> <span class="mono dim">' + esc((a.summary || '').replace(new RegExp('^' + a.tool + '\\s+'), '')) + '</span></span></div>').join('') + '</div>';
  }

  function needsYou(m) {
    const count = m.tasks.length + (m.manualReady ? 1 : 0);
    let h = panelHead('d-p-you', 'NEEDS YOU', String(count), '');
    if (!count) return h + '<div class="d-ok"><img src="' + A('d-ok-big') + '" alt="" width="40" height="40"><div><span class="g">Nothing needed from you</span><span class="dim">' + (m.s === 'merged' ? 'This feature is merged.' : m.P.merge === 'manual' ? 'No human task blocks this feature.' : 'No human task blocks this feature, and it merges on its own.') + '</span></div></div>';
    h += m.tasks.map((t) => '<div class="d-need"><img src="' + A('d-you-small') + '" alt="" width="28" height="28"><div><span class="n">' + esc(t.title) + '</span><span class="dim">' + (t.waitingOn ? 'Waiting on ' + esc(t.waitingOn) : t.mockable ? 'Built on a mock meanwhile' : 'Blocks this feature') + '</span><a class="lnk" href="#you">Open in Only you →</a></div></div>').join('');
    if (m.manualReady) h += '<div class="d-need"><img src="' + A('d-you-small') + '" alt="" width="28" height="28"><div><span class="n">Review and merge</span><span class="dim">Merge the evaluated commit into the base branch, then mark it merged to release dependents.</span><button class="d-b pri sm" data-act="merged">Mark merged</button></div></div>';
    return h;
  }

  function problems(m) {
    const fails = m.tries.filter((t) => t.state === 'failed' && (t.fail || t.n === m.n)).slice().reverse(), lessons = m.log.filter((e) => e.event === 'lesson').reverse().slice(0, 4);
    const fb = m.f.lastFeedback && !m.log.some((e) => (e.event === 'failed' || e.event === 'stuck') && e.detail === m.f.lastFeedback);
    const count = m.fails.length + (fb ? 1 : 0);
    let h = panelHead('d-p-prob', 'PROBLEMS', count ? String(count) : '', '', 24).replace('d-bd mono', 'd-bd red mono');
    if (!count && !lessons.length) return h + '<div class="d-ok"><img src="' + A('d-ok-big') + '" alt="" width="40" height="40"><div><span class="g">No problems found</span><span class="dim">Nothing has failed on this feature.</span></div></div>';
    h += m.fails.slice().reverse().map((e) => {
      if (F.uncountedStop(e)) { const t = m.tries.find((t) => t.stop === e); return '<div class="d-pb"><span class="w">' + (t ? 'Try ' + t.n + ' stopped' : 'A recorded try stopped') + ' without using a retry</span><span class="mono">' + esc(lines(e.detail, 6)) + '</span></div>'; }
      const st = failStage(e.detail), ti = m.tries.find((t) => t.fail === e);
      const what = { test: 'failed the test bench', eval: 'failed inspection', merge: 'failed to merge', build: 'failed while building' }[st];
      return '<div class="d-pb"><span class="w">' + (e.event === 'stuck' ? 'Stuck: ' : '') + (ti ? 'Try ' + ti.n + ' ' : 'A try ') + what + '</span><span class="mono">' + esc(lines(e.detail, 6)) + '</span></div>';
    }).join('');
    if (fb) h += '<div class="d-pb"><span class="w">' + (m.s === 'stuck' ? 'Why it is stuck' : 'Feedback for the next try') + '</span><span class="mono">' + esc(lines(m.f.lastFeedback, 6)) + '</span></div>';
    if (lessons.length) h += '<div class="d-ls"><span class="lh">LESSON SAVED</span>' + lessons.map((e) => '<span>' + esc(e.detail) + '</span>').join('') + '</div>';
    return h;
  }

  // ---------- plumbing ----------
  const SKEL = '<div class="d-crumb" id="d-crumb"></div><div class="d-sum" id="d-sum"></div>' +
    '<div class="d-linebox" id="d-linebox"><div class="d-lsz" id="d-lsz"><section class="d-line" id="d-line" aria-label="Where this feature is on the line"></section></div></div>' +
    '<div class="d-cols"><section class="d-panel d-details" id="d-details"></section>' +
    '<div class="d-col"><section class="d-panel" id="d-attempts"></section><section class="d-panel d-hist" id="d-history"></section></div>' +
    '<div class="d-col"><div class="d-two" id="d-benches"></div><section class="d-panel d-live" id="d-live"></section></div>' +
    '<div class="d-col"><section class="d-panel" id="d-you"></section><section class="d-panel" id="d-prob"></section></div></div>';

  function fit() {
    const box = $('d-linebox'), sz = $('d-lsz');
    if (!box || !sz) return;
    const s = Math.min(1, Math.max(0.45, box.clientWidth / 1672));
    if (s !== scale || !sz.style.getPropertyValue('--s')) { scale = s; sz.style.setProperty('--s', s); }
  }
  function build() {
    const el = $('detail');
    el.innerHTML = SKEL; delete el._h; built = true;
    if (ro) ro.disconnect();
    if (window.ResizeObserver) { ro = new ResizeObserver(fit); ro.observe($('d-linebox')); }
    if (!el._wired) { el._wired = true; el.addEventListener('click', onClick); }
    ['d-crumb', 'd-sum', 'd-line', 'd-details', 'd-attempts', 'd-history', 'd-benches', 'd-live', 'd-you', 'd-prob'].forEach((i) => delete $(i)._h);
  }
  function notFound(id) {
    built = false;
    F.setHTML($('detail'), '<div class="d-nf"><h3>Feature not found</h3><span>There is no feature <code>' + esc(id) + '</code> in this project.</span><a class="d-b pri" href="#factory">Back to the Factory</a></div>');
  }

  function load() {
    const P = F.P, id = F.route.id;
    if (!P || !id) return;
    const k = P.path + '|' + id, mine = ++seq;
    fetchedAt = Date.now();
    fetch('/api/feature?project=' + encodeURIComponent(P.path) + '&id=' + encodeURIComponent(id)).then((r) => r.json()).then((d) => {
      if (mine !== seq || k !== key || F.route.view !== 'detail') return; // stale
      data = d; paint();
    }).catch(() => {});
  }

  function paint() {
    const P = F.P, id = F.route.id, f = P && F.byId(id);
    if (!f) { notFound(id); return; }
    if (!built || !$('d-sum')) build();
    const m = model_(f, P);
    F.setHTML($('d-crumb'), '<a href="#factory">Factory</a><span>/</span><span class="cur">' + esc(title(f)) + '</span>');
    F.setHTML($('d-sum'), summary(m));
    F.setHTML($('d-line'), line(m));
    F.setHTML($('d-details'), details(m));
    F.setHTML($('d-attempts'), attempts(m));
    F.setHTML($('d-history'), history(m));
    F.setHTML($('d-benches'), benches(m));
    F.setHTML($('d-live'), live(m));
    F.setHTML($('d-you'), needsYou(m));
    F.setHTML($('d-prob'), problems(m));
    fit();
  }

  function render() {
    const P = F.P, id = F.route.id, f = P && F.byId(id);
    const k = P ? P.path + '|' + id : '', s = f ? f.status + '|' + f.attempts + '|' + f.updatedAt : '';
    if (k !== key) { key = k; data = null; sig = ''; openLog = 0; accOpen = false; seq++; }
    paint();
    if (f && s !== sig) { sig = s; load(); }
  }
  function tick() {
    const P = F.P, f = P && F.byId(F.route.id);
    if (!f) return;
    const every = FLIGHT.includes(f.status) ? 5000 : 30000;
    if (Date.now() - fetchedAt >= every) load();
    document.querySelectorAll('#detail [data-since]').forEach((e) => { e.textContent = dur(Date.now() - Date.parse(e.dataset.since)); });
  }

  function copy(text) {
    const done = () => F.toast('Branch name copied');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallback(text, done));
    else fallback(text, done);
  }
  function fallback(text, done) {
    const t = document.createElement('textarea'); t.value = text; t.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); done(); } catch { F.toast('Could not copy'); } t.remove();
  }
  function onClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    const P = F.P, f = P && F.byId(F.route.id);
    if (!f) return;
    if (b.dataset.log) { const n = +b.dataset.log; openLog = openLog === n ? 0 : n; paint(); return; }
    const act = b.dataset.act;
    if (act === 'acc') { accOpen = !accOpen; paint(); }
    else if (act === 'copy') copy(f.branch || (P.branchPrefix || '') + f.id);
    else if (act === 'pause') F.post('/api/feature/pause', P.path, f.id, 'Paused');
    else if (act === 'resume') F.post('/api/feature/resume', P.path, f.id, 'Resumed');
    else if (act === 'retry') F.post('/api/feature/retry', P.path, f.id, 'Retrying with fresh attempts');
    else if (act === 'merged') F.post('/api/feature/merged', P.path, f.id, 'Marked merged');
  }

  F.view('detail', { render, tick });
})();
