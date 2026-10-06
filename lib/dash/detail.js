// Feature detail view (#f/<id>): one readable column. The header says what the feature is for and what is happening now;
// a needs-you banner appears only when a person must act; "What needs fixing" holds the current problem; the journey lists
// the current try's real steps; earlier tries, the spec, agent activity, logs and details sit behind folds.
// The text comes from the server's story (lib/story.ts); without one (older API, an error) a minimal header and the folds remain.
'use strict';
(() => {
  const { esc, $, dur, clock, dayTime, money, title } = F;
  const A = (n) => '/assets/' + n + '.png';
  const FLIGHT = ['building', 'testing', 'evaluating'];
  const ICON = { Bash: 'd-a1', Edit: 'd-a5', Write: 'd-a5', MultiEdit: 'd-a5', NotebookEdit: 'd-a5', Read: 'd-a3', Grep: 'd-a3', Glob: 'd-a3', Task: 'd-a4', Agent: 'd-a4' };
  // Step state → [css class, icon, word]
  const STEP = { done: ['ok', '✓', 'Done'], running: ['run', '●', 'Running'], 'needs-changes': ['chg', '!', 'Needs changes'], failed: ['bad', '✗', 'Failed'],
    interrupted: ['off', '◌', 'Interrupted'], reused: ['off', '↺', 'Reused'], info: ['info', '·', ''] };
  // Try outcome → [css class, mark]
  const OUT = { merged: ['ok', '✓'], ready: ['ok', '✓'], failed: ['bad', '✗'], stuck: ['bad', '✗'], held: ['hold', '◌'], stopped: ['off', '◌'], interrupted: ['off', '◌'], running: ['run', '●'] };
  const ROLE = { build: 'Build', resolve: 'Combine', eval: 'Review', diagnose: 'Diagnosis' };
  // Fallback pill tone from the feature status when there is no story.
  const STATUS_TONE = { building: 'run', testing: 'run', evaluating: 'run', ready: 'ok', merged: 'ok', queued: 'queue', waiting: 'hold', stuck: 'bad', paused: 'idle', blocked: 'idle' };
  const FOLDS = ['f-spec', 'f-act', 'f-logs', 'f-det'];

  let built = false, key = '', data = null, fetchedAt = 0, seq = 0, sig = '', pick = '', fetchFailed = false;
  // Spec-fix request in flight (proposal id, or 'undo') and the last error to show inline ({k, msg}).
  let sfxBusy = '', sfxErr = null;
  // Open <details> (by data-k), kept across re-renders; the fold keys also survive a change of feature.
  const open = new Set();

  // ---------- helpers ----------
  const when = (iso) => { const d = new Date(iso); if (isNaN(d)) return ''; return d.toDateString() === new Date().toDateString() ? clock(iso).slice(0, 5) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
  const since = (iso) => iso && !isNaN(Date.parse(iso)) ? '<span data-since="' + esc(iso) + '"></span>' : '';
  const model = (m) => (m && m.model ? m.model + (m.effort ? ' · ' + m.effort : '') : '—');
  // A <details> whose open state is remembered under `k`.
  const det = (k, cls, summary, body) => '<details class="' + cls + '" data-k="' + esc(k) + '"' + (open.has(k) ? ' open' : '') + '><summary data-k="' + esc(k) + '">' + summary + '</summary>' + body + '</details>';
  const branchOf = (f, P) => f.branch || (P.branchPrefix || '') + f.id;

  // ---------- header ----------
  function actions(f) {
    const ic = { pause: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>',
      play: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5l12 7-12 7z"/></svg>',
      retry: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5"/></svg>' };
    const b = (act, label, icon, cls) => '<button class="d-b' + (cls ? ' ' + cls : '') + '" data-act="' + act + '" data-k="act-' + act + '">' + (icon || '') + label + '</button>';
    let pri = '';
    const rest = [];
    if (f.status === 'stuck') { pri = b('retry', 'Retry with fresh tries', ic.retry, 'pri'); rest.push(b('pause', 'Pause', ic.pause)); }
    else if (f.status === 'paused') pri = b('resume', 'Resume', ic.play, 'pri');
    else if (f.status === 'todo') pri = b('pause', 'Pause', ic.pause);
    rest.push(b('copy', 'Copy branch'));
    return '<div class="d-acts">' + pri + det('act-menu', 'd-more', 'Actions', '<div class="d-menu">' + rest.join('') + '</div>') + '</div>';
  }

  function header(f, P, story0) {
    // A story built from another status (the project poll is newer) or a failed fetch is history, not the current state.
    const changed = story0 && (story0.version ? story0.version !== f.status + '|' + (f.attempts || 0) : story0.status !== f.status);
    const stale = fetchFailed || changed, story = changed ? null : story0;
    const maxA = (P.config && P.config.maxAttempts) || 3, flight = FLIGHT.includes(f.status), cur = story && story.current;
    const tone = story ? story.state.tone : STATUS_TONE[F.statusOf(f)] || 'idle', word = story ? story.state.word : F.LABEL[F.statusOf(f)] || f.status;
    const issue = f.issue ? (P.repoUrl ? '<a class="lnk" href="' + esc(P.repoUrl + '/issues/' + f.issue) + '" target="_blank" rel="noopener">#' + f.issue + '</a>' : '#' + f.issue) : '';
    const meta = [];
    if (story && story.nextTry) meta.push('<span><b>Try ' + story.nextTry + '</b> of ' + maxA + ' next</span>');
    else if (cur) meta.push('<span><b>Try ' + cur.n + '</b> of ' + maxA + '</span>');
    else if (F.attemptNumber(f)) meta.push('<span><b>Try ' + F.attemptNumber(f) + '</b> of ' + maxA + '</span>');
    if (flight && P.stageSince && P.stageSince[f.id]) meta.push('<span>this step ' + since(P.stageSince[f.id]) + '</span>');
    else if (cur && cur.start && cur.end && (f.status === 'merged' || f.status === 'ready')) meta.push('<span>' + dur(Date.parse(cur.end) - Date.parse(cur.start)) + ' total</span>');
    if (f.costUsd) meta.push('<span>reported cost ' + money(f.costUsd) + '</span>');
    const lines = [];
    if (story && story.state.why) lines.push('<p><span class="lbl">' + (tone === 'ok' ? 'Result' : 'Why') + '</span>' + esc(story.state.why) + '</p>');
    if (story && story.state.next) lines.push('<p><span class="lbl">Next</span>' + esc(story.state.next) + '</p>');
    if (stale) lines.push('<p class="d-stale" role="status">' + (fetchFailed ? 'Could not load the latest details; what is below may be out of date.' : 'Updating: the feature just changed state; the details below are from before.') + '</p>');
    return '<div class="d-card d-head"><img class="d-task" src="' + A('d-task') + '" alt="" width="52" height="52"><div class="d-hb">' +
      '<h1>' + esc(story ? story.title : title(f)) + '</h1>' + (story && story.goal ? '<p class="d-goal">' + esc(story.goal) + '</p>' : '') +
      '<div class="d-id"><span>' + esc(f.id) + '</span>' + issue + '</div></div>' +
      '<div class="d-pillbox"><span class="d-pill t-' + tone + '"><i></i>' + esc(word) + '</span></div>' +
      (lines.length || meta.length ? '<div class="d-now"><div class="d-lines">' + lines.join('') + '</div><div class="d-meta">' + meta.join('') + '</div></div>' : '') +
      actions(f) + '</div>';
  }

  // ---------- needs you ----------
  function needsYou(f, P, story) {
    if (!story || !story.needsYou) return '';
    const manual = f.status === 'ready' && P.merge === 'manual';
    const tasks = (P.tasks || []).filter((t) => t.status === 'open' && (t.unblocks || []).includes(f.id));
    return '<div class="d-card d-you" role="status"><img src="' + A('d-p-you') + '" alt="" width="26" height="26"><div><span class="d-yh">Needs you</span>' +
      '<p class="d-yw">' + esc(story.needsYou.what) + '</p><p class="d-yy">' + esc(story.needsYou.why) + '</p>' + planConflicts(story.needsYou) +
      (manual ? '<p class="d-yy">Merge the reviewed commit into the base branch yourself, then mark it merged to release what depends on it. Marking it merged does not merge anything.</p>' +
        '<button class="d-b pri" data-act="merged" data-k="act-merged">Mark merged</button>' : '') +
      (tasks.length ? '<a class="lnk" href="#you">Open in Only you →</a>' : '') + '</div></div>';
  }

  // A planner spec-conflict hold: every conflict with its severity tag (lib/plan.ts), then the proposed revised spec and how to apply it.
  function planConflicts(n) {
    if (!n.conflicts || !n.conflicts.length) return '';
    const items = n.conflicts.map((c) => {
      const m = /^\[(protected\??|spec-only)\]\s*/.exec(c), sev = m ? m[1] : '', body = m ? c.slice(m[0].length) : c;
      const [text, ...res] = body.split('\nResolution: ');
      return '<li>' + (sev ? '<span class="d-tag' + (sev === 'spec-only' ? '' : ' d-sxu') + '">' + esc(sev === 'protected?' ? 'protected (untagged)' : sev) + '</span> ' : '') + esc(text) +
        (res.length ? '<br><span class="dim">Resolution: ' + esc(res.join('\nResolution: ')) + '</span>' : '') + '</li>';
    }).join('');
    return '<p class="d-yy"><b>Conflicts (' + n.conflicts.length + ')</b></p><ol class="d-yy">' + items + '</ol>' +
      (n.revised ? '<p class="d-yy"><b>Proposed revised spec</b></p><pre class="d-yy" style="white-space:pre-wrap">' + esc(n.revised) + '</pre>' +
        (n.apply ? '<p class="d-yy">Every conflict is spec-only: apply it with <code>' + esc(n.apply) + '</code> (fresh tries; the planner checks it again first).</p>'
          : '<p class="d-yy">A conflict is protected: edit the spec yourself (the revised spec is a starting point), or release the hold.</p>') : '');
  }

  // ---------- spec fix ----------
  // A drafted correction to one requirement (lib/specfix.ts), the person's Apply / Dismiss, and the fixes applied so far (the
  // latest may be undone). Errors from the server stay inline under the buttons until the next click.
  const targetName = (t) => t === 'description' ? 'The description' : 'Acceptance check ' + t;
  const stamp = (iso) => { const w = when(iso); return w && new Date(iso).toDateString() !== new Date().toDateString() ? w + ' ' + clock(iso).slice(0, 5) : w; };
  function checkedBy(v) {
    if (!v || !v.provider || v.provider === 'none') return '<p class="d-sxv"><span class="d-lbl">Second check</span>Not verified' + (v && v.reason ? ': ' + esc(v.reason) : '') + '.</p>';
    const who = v.provider === 'codex' ? 'Codex' : v.provider;
    const said = v.agree === true ? '<b class="ok">agrees</b>' + (v.reason ? '<span class="dim">: ' + esc(v.reason) + '</span>' : '')
      : v.agree === false ? '<b class="no">disagrees</b>: ' + esc(v.reason) : '<b class="un">not verified</b>' + (v.reason ? '<span class="dim">: ' + esc(v.reason) + '</span>' : '');
    return '<p class="d-sxv"><span class="d-lbl">Checked by ' + esc(who) + '</span>' + said + '</p>';
  }
  function specFix(story) {
    if (!story) return '';
    const p = story.specFix, fixes = (story.fixes || []).slice().reverse();
    let h = '';
    if (p && p.status === 'proposed') {
      const ev = p.evidence || [];
      const gate = p.protectedBy ? '<p class="d-sxg"><b>Needs your approval:</b> ' + esc(p.protectedBy) + '</p>'
        : p.autoBlocked ? '<p class="d-sxg"><b>Not applied automatically:</b> ' + esc(p.autoBlocked) + '</p>' : '';
      const busy = sfxBusy === p.id, err = sfxErr && sfxErr.k === p.id ? '<p class="d-sxe" role="alert">' + esc(sfxErr.msg) + '</p>' : '';
      h += '<div class="d-card d-sx"><h3>Proposed spec fix</h3><p class="d-lead">' + esc(targetName(p.target)) + '</p>' +
        '<div class="d-sxd"><div class="d-sxo"><span class="d-lbl">Old</span><del>' + esc(p.old) + '</del></div>' +
        '<div class="d-sxn"><span class="d-lbl">New</span><ins>' + esc(p.new) + '</ins></div></div>' +
        (p.why ? '<p><span class="d-lbl">Why</span>' + esc(p.why) + '</p>' : '') +
        (ev.length ? det('sx-ev', 'd-more', 'Evidence (' + ev.length + ')', '<div class="d-reasons">' + ev.map((e) => '<div class="d-sxq"><q>' + esc(e.quote) + '</q><span class="d-tag">from ' + esc(e.source) + '</span></div>').join('') + '</div>') : '') +
        checkedBy(p.verifier) + gate +
        (p.mode ? '<p class="d-sxh">' + (p.mode === 'auto' ? 'Spec fixes are on Auto: fixes Claude and Codex both agree on apply by themselves; this one waits for you.' : 'Spec fixes are on Manual: you apply each fix. Switch it in <a href="#settings">Settings</a>.') + '</p>' : '') +
        '<div class="d-sxa"><button class="d-b pri" data-act="sfx-apply" data-fix="' + esc(p.id) + '" data-k="sfx-apply"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Working…' : 'Apply') + '</button>' +
        '<button class="d-b" data-act="sfx-dismiss" data-fix="' + esc(p.id) + '" data-k="sfx-dismiss"' + (busy ? ' disabled' : '') + '>Dismiss</button>' +
        '<span class="d-sxh">Apply changes the spec and starts the feature again with fresh tries. Dismiss leaves the spec as it is for you to edit.</span></div>' + err + '</div>';
    } else if (p && p.status === 'none') {
      h += '<div class="d-card d-sx d-sxnone"><h3>Spec fix</h3><p>No spec fix could be drafted' + (p.reason ? ': ' + esc(p.reason.replace(/\.$/, '')) : '') + '. Edit the spec yourself, or release the hold.</p></div>';
    }
    if (fixes.length) {
      const busy = sfxBusy === 'undo', err = sfxErr && sfxErr.k === 'undo' ? '<p class="d-sxe" role="alert">' + esc(sfxErr.msg) + '</p>' : '';
      h += '<div class="d-card d-sxl"><h3>Spec changes</h3>' + fixes.map((r) => '<div class="d-sxr' + (r.undone ? ' undone' : '') + '">' +
        '<div class="d-sxrh"><b>' + (r.by === 'auto' ? 'Spec fixed automatically' : 'Spec fixed by you') + '</b><span class="d-tag">' + esc(stamp(r.ts)) + ' · ' + esc(targetName(r.target).replace(/^\w/, (c) => c.toLowerCase())) + '</span>' +
        (r.undone ? '<span class="d-tag d-sxu">Undone ' + esc(stamp(r.undone)) + '</span>' : '') + '</div>' +
        '<div class="d-sxd"><div class="d-sxo"><del>' + esc(r.old) + '</del></div><div class="d-sxar" aria-hidden="true">→</div><div class="d-sxn"><ins>' + esc(r.new) + '</ins></div></div>' +
        (r.why ? '<p class="d-sxw">' + esc(r.why) + '</p>' : '') +
        (r.drafter || r.verifier ? '<p class="d-sxw">Drafted by ' + esc(r.drafter && r.drafter.model || 'the observer') + '; ' + esc(!r.verifier ? 'not checked' : r.verifier.agree === true ? 'checked by ' + (r.verifier.model || 'Codex') + ': agrees' : r.verifier.agree === false ? 'checked by ' + (r.verifier.model || 'Codex') + ': disagreed' : 'not verified') + '.</p>' : '') +
        (r.undoable ? '<div class="d-sxa"><button class="d-b" data-act="sfx-undo" data-k="sfx-undo" data-fix="' + esc(r.id) + '"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Working…' : 'Undo') + '</button>' +
          '<span class="d-sxh">Puts the earlier text back and starts the feature again with fresh tries.</span></div>' + err : '') + '</div>').join('') + '</div>';
    }
    return h;
  }

  // ---------- what needs fixing ----------
  function reasons(k, list) {
    return '<div class="d-reasons">' + list.map((r, i) => '<div class="d-r"><b>' + esc(r.title) + '</b>' +
      (r.detail && r.detail !== r.title ? det(k + '-' + i, 'd-more d-sm', 'details', '<pre>' + esc(r.detail) + '</pre>') : '') + handled(r) + '</div>').join('') + '</div>';
  }
  // How a review fix answered this finding (the builder's own claim; the next review checks it). Undefined: no fix answered yet.
  function handled(r) {
    if (r.handled === undefined) return '';
    const h = r.handled;
    return '<p class="d-hd"><span class="d-lbl">How it was handled</span>' + (h
      ? '<span class="d-hs ' + esc(h.status) + '">' + esc(h.status) + '</span>' + esc(h.how) + (h.where ? ' <code>' + esc(h.where) + '</code>' : '')
      : '<span class="dim">no answer recorded</span>') + '</p>';
  }
  function problems(story) {
    if (!story) return '';
    const { active, earlier } = story.problems;
    const old = earlier.length ? det('p-earlier', 'd-more', 'Earlier problems (' + earlier.length + ')',
      '<div class="d-old">' + earlier.map((p) => '<div class="d-oldr"><span>' + esc(p.text) + '</span><span class="d-tag">' + esc(dayTime(p.when)) + '</span></div>').join('') + '</div>') : '';
    if (!active && !old) return '';
    if (!active) return '<div class="d-card d-quiet">' + old + '</div>';
    return '<div class="d-card d-fix"><h3>What needs fixing</h3><p class="d-lead">' + esc(active.title) + '</p>' +
      (active.reasons.length ? det('p-active', 'd-more', 'Why (' + active.reasons.length + ')', reasons('p-r', active.reasons)) : '') +
      (story.state.next ? '<p class="d-nx">' + esc(story.state.next) + '</p>' : '') + old + '</div>';
  }

  // ---------- journey ----------
  // Build / Test / Review / Merge from the steps. A fix belongs to the stage whose failure it repairs (the last failed or
  // rejected test or review before it), else to Build.
  function overview(steps) {
    const by = { build: [], test: [], review: [], merge: [] };
    let repairing = 'build';
    for (const s of steps) {
      if (s.kind === 'test' || s.kind === 'review') { by[s.kind].push(s); repairing = s.state === 'failed' || s.state === 'needs-changes' ? s.kind : 'build'; }
      else if (s.kind === 'fix') by[repairing].push(s);
      else if (['build', 'reused', 'resolve', 'save'].includes(s.kind)) by.build.push(s);
      else if (s.kind === 'merge') by.merge.push(s);
    }
    const stage = (name, list) => {
      const last = list[list.length - 1];
      if (!last) return ['', ''];
      if (name === 'merge') return last.state === 'done' ? ['ok', ''] : last.state === 'failed' ? ['bad', 'failed'] : ['', ''];
      if (last.kind === 'fix' && name !== 'build') return last.state === 'running' ? ['cur', 'repairing'] : ['', ''];
      if (last.state === 'running') return ['cur', ''];
      if (last.state === 'done' || last.state === 'reused') return ['ok', ''];
      if (last.state === 'failed') return ['bad', name === 'review' ? 'rejected' : 'failed'];
      if (last.state === 'needs-changes') return ['bad', 'needs changes'];
      return ['', ''];
    };
    return '<div class="d-ov">' + [['build', 'Build', 'd-try-robot'], ['test', 'Test', 'd-p-flask'], ['review', 'Review', 'd-p-insp'], ['merge', 'Merge', 'ev-deploy']].map(([k, label, icon], i) => {
      const [cls, extra] = stage(k, by[k]);
      return (i ? '<span class="d-arrow" aria-hidden="true">→</span>' : '') + '<span class="d-stage ' + cls + '"><img src="' + A(icon) + '" alt="" width="20" height="20">' + label + (extra ? ' · ' + extra : '') + '</span>';
    }).join('') + '</div>';
  }
  // When the step started (date and time, in the viewer's timezone), then how long it ran or has been running.
  function stepTime(s) {
    const at = s.start || s.end, d = at ? '<time datetime="' + esc(at) + '">' + esc(dayTime(at)) + '</time>' : '';
    const ms = s.start && s.end ? Date.parse(s.end) - Date.parse(s.start) : 0;
    const len = s.state === 'running' ? since(s.start) : ms > 0 ? esc(dur(ms)) : '';
    return d + (d && len ? '<span class="d-tl"> · ' + len + '</span>' : len);
  }
  function steps(k, list, extra) {
    return '<div class="d-rows">' + list.map((s, i) => {
      const [cls, ic, word] = STEP[s.state] || STEP.info;
      return '<div class="d-row ' + cls + '"><span class="d-ic" aria-hidden="true">' + ic + '</span><span class="d-st">' + esc(s.label) +
        (word ? '<span class="d-sr"> (' + word + ')</span>' : '') + '</span><div class="d-what">' + esc(s.text) +
        (s.who ? '<span class="d-who">' + esc(s.who) + '</span>' : '') + (s.note ? '<span class="d-note">' + esc(s.note) + '</span>' : '') +
        (s.reasons && s.reasons.length ? det(k + '-s' + i, 'd-more', 'Why (' + s.reasons.length + ')', reasons(k + '-s' + i + 'r', s.reasons)) : '') +
        (s.said ? det(k + '-w' + i, 'd-more', 'What the agent said', '<pre class="d-said">' + esc(s.said) + '</pre>') : '') +
        '</div><span class="d-t">' + stepTime(s) + '</span></div>';
    }).join('') + (extra || '') + '</div>';
  }
  function journey(f, story) {
    if (!story) return data ? '' : '<div class="d-card"><span class="dim">Loading…</span></div>';
    const t = story.current;
    if (!t) return '<div class="d-card"><div class="d-jh"><h3>What happened</h3></div><p class="dim d-em">No try has started yet.</p></div>';
    const range = t.start ? dayTime(t.start) + (t.end ? ' → ' + dayTime(t.end) : '') : '';
    const pending = t.outcome === 'running' && story.state.next ? '<div class="d-row pend"><span class="d-ic" aria-hidden="true">○</span><span class="d-st">Next</span><div class="d-what">' + esc(story.state.next) + '</div><span class="d-t"></span></div>' : '';
    return '<div class="d-card"><div class="d-jh"><h3>What happened on try ' + t.n + '</h3>' + (range ? '<span class="d-tag">' + (t.end ? '' : 'started ') + esc(range) + '</span>' : '') + '</div>' +
      overview(t.steps) + steps('c', t.steps, pending) + '</div>';
  }

  // ---------- earlier tries ----------
  function tryRow(k, t) {
    const [cls, mark] = OUT[t.outcome] || OUT.interrupted;
    return det(k, 'd-tryrow', '<span class="d-tn ' + cls + '">Try ' + t.n + ' ' + mark + '</span><span class="d-ts">' + esc(t.summary || 'No summary recorded.') + '</span><span class="d-tag">' + esc(dayTime(t.end || t.start)) + '</span>',
      t.steps.length ? steps(k, t.steps) : '<p class="dim d-em">No steps recorded.</p>');
  }
  function earlier(story) {
    if (!story) return '';
    let h = '';
    if (story.earlier.length) h += det('earlier', 'd-card d-arch', (story.earlier.length === 1 ? '1 earlier try' : story.earlier.length + ' earlier tries') + ' in this cycle', story.earlier.map((t) => tryRow('e-' + t.n, t)).join(''));
    story.archive.forEach((a, i) => { h += det('arch-' + i, 'd-card d-arch', esc(a.label), a.tries.map((t) => tryRow('a' + i + '-' + t.n, t)).join('')); });
    return h;
  }

  // ---------- folds ----------
  function spec(f) {
    const acc = f.acceptance || [];
    return det('f-spec', 'd-fold', 'Spec', '<div class="d-body">' + (f.description ? '<p class="d-desc">' + esc(f.description) + '</p>' : '<p class="dim">No description.</p>') +
      (acc.length ? '<h4>Acceptance criteria</h4><ol class="d-acc">' + acc.map((a) => '<li>' + esc(a) + '</li>').join('') + '</ol>' : '<p class="dim">No acceptance criteria listed.</p>') + '</div>');
  }
  function activity(f) {
    const rows = ((data && data.activity) || []).slice().reverse().slice(0, 40);
    const live = FLIGHT.includes(f.status) ? ' <span class="d-live"><i></i>live</span>' : '';
    const body = !data ? '<p class="dim">Loading…</p>' : !rows.length ? '<p class="dim">No agent actions recorded yet.</p>' :
      '<div class="d-list">' + rows.map((a) => '<div class="d-ar"><span class="d-tm">' + clock(a.ts) + '</span><img src="' + A(ICON[a.tool] || 'd-a6') + '" alt="" width="18" height="18"><span class="d-al"><span>' + esc(a.tool) + '</span> <span class="d-mono dim">' +
        esc((a.summary || '').replace(new RegExp('^' + String(a.tool).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+'), '')) + '</span></span></div>').join('') + '</div>';
    return det('f-act', 'd-fold', 'Agent activity' + live, '<div class="d-body"><p class="dim d-hint">Tool calls from the agents, newest first.</p>' + body + '</div>');
  }
  const runKey = (r) => r.tag + '|' + r.role;
  function runOutput(r) {
    let h = '<div class="d-run"><div class="d-rh">Run ' + esc(r.tag) + ' · ' + esc(ROLE[r.role] || r.role) + (r.role === 'eval' ? (r.pass ? ' · passed' : ' · rejected') : '') +
      (r.at ? ' <span class="d-tag">' + esc(when(r.at)) + ' ' + esc(clock(r.at).slice(0, 5)) + '</span>' : '') + '</div>';
    if (r.error) h += '<pre>' + esc(r.error) + '</pre>';
    if (r.findings && r.findings.length) {
      const fs = r.findings.filter((x) => !x.ok).concat(r.findings.filter((x) => x.ok));
      h += '<div class="d-fds">' + fs.map((x) => '<div class="d-fd ' + (x.ok ? 'ok' : 'no') + '"><b aria-label="' + (x.ok ? 'passed' : 'failed') + '">' + (x.ok ? '✓' : '✗') + '</b><span>' + esc(x.check) + (x.evidence ? ' <em>' + esc(x.evidence) + '</em>' : '') + '</span></div>').join('') + '</div>';
    }
    if (r.role !== 'eval' && r.summary) h += '<pre>' + esc(r.summary) + '</pre>';
    if (r.text) h += det('raw-' + runKey(r), 'd-more', 'Original agent output', '<pre>' + esc(r.text) + '</pre>');
    return h + '</div>';
  }
  function logs() {
    const runs = (data && data.runs) || [];
    let body;
    if (!data) body = '<p class="dim">Loading…</p>';
    else if (!runs.length) body = '<p class="dim">No run output saved for this feature.</p>';
    else {
      const sel = runs.find((r) => runKey(r) === pick);
      body = '<p class="dim d-hint">Pick a run to see its output.</p><div class="d-runs" role="group" aria-label="Runs">' + runs.slice().reverse().map((r) => {
        const k = runKey(r), on = k === pick;
        return '<button class="d-chip' + (on ? ' on' : '') + (r.role === 'eval' ? r.pass ? ' pass' : ' fail' : '') + '" data-run="' + esc(k) + '" data-k="run-' + esc(k) + '" aria-pressed="' + on + '">' +
          esc(ROLE[r.role] || r.role) + ' ' + esc(r.tag) + (r.role === 'eval' ? (r.pass ? ' ✓' : ' ✗') : '') + '</button>';
      }).join('') + '</div>' + (sel ? runOutput(sel) : '');
    }
    return det('f-logs', 'd-fold', 'Logs', '<div class="d-body">' + body + '</div>');
  }
  function details(f, P) {
    const cfg = P.config || {}, row = (k, v) => '<div class="d-kv"><span>' + k + '</span><span>' + v + '</span></div>';
    const deps = (f.deps || []).map((id) => { const ok = (F.byId(id) || {}).status === 'merged'; return '<a class="' + (ok ? 'ok' : 'no') + '" href="' + F.featureHref(id) + '" title="' + (ok ? 'merged' : 'not merged yet') + '">' + esc(id) + (ok ? ' ✓' : '') + '</a>'; });
    const runs = (data && data.runs) || [], unpriced = runs.some((r) => r.unpriced);
    return det('f-det', 'd-fold', 'Details', '<div class="d-body">' +
      row('Feature id', '<span class="d-mono">' + esc(f.id) + '</span>') +
      row('Branch', '<span class="d-mono">' + esc(branchOf(f, P)) + '</span>') +
      row('Commit', f.sha ? '<span class="d-mono">' + esc(f.sha.slice(0, 7)) + '</span>' : '<span class="dim">—</span>') +
      row('Models', esc(model(cfg.builder)) + ' <span class="dim">builder</span><br>' + esc(model(cfg.evaluator)) + ' <span class="dim">evaluator</span>') +
      row('Depends on', deps.length ? '<span class="d-deps">' + deps.join('') + '</span>' : '<span class="dim">None</span>') +
      row('Priority', esc(f.priority)) + row('Group', esc(F.groupOf(f))) + (f.surface ? row('Surface', esc(f.surface)) : '') +
      row('Reported cost', esc(money(f.costUsd)) + (unpriced ? ' <span class="dim">(some Codex runs report no USD)</span>' : '')) +
      row('Project', esc(P.name)) + '</div>');
  }

  // ---------- plumbing ----------
  const PARTS = ['d-crumb', 'd-head', 'd-you', 'd-sfx', 'd-fixes', 'd-journey', 'd-earlier', 'd-folds'];
  const SKEL = '<div class="d-wrap"><nav class="d-crumb" id="d-crumb" aria-label="Breadcrumb"></nav><section id="d-head" aria-label="Feature"></section><section id="d-you"></section><section id="d-sfx" aria-label="Spec fix"></section>' +
    '<section id="d-fixes"></section><section id="d-journey" aria-label="Current try"></section><section id="d-earlier"></section><section class="d-folds" id="d-folds"></section></div>';

  function build() {
    const el = $('detail');
    el.innerHTML = SKEL; delete el._h; built = true;
    if (!el._wired) {
      el._wired = true;
      el.addEventListener('click', onClick);
      // toggle does not bubble: listen in the capture phase.
      el.addEventListener('toggle', (e) => { const k = e.target && e.target.dataset && e.target.dataset.k; if (k) { if (e.target.open) open.add(k); else open.delete(k); } }, true);
    }
    PARTS.forEach((i) => { const n = $(i); if (n) delete n._h; });
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
    fetch('/api/feature?project=' + encodeURIComponent(P.path) + '&id=' + encodeURIComponent(id)).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then((d) => {
      if (mine !== seq || k !== key || F.route.view !== 'detail') return; // stale
      data = d; fetchFailed = false; paint();
    }).catch(() => { if (mine !== seq || k !== key) return; fetchFailed = true; paint(); }); // never show old detail as current
  }

  function timers() {
    const el = $('detail');
    if (el && el.querySelectorAll) el.querySelectorAll('[data-since]').forEach((e) => { e.textContent = dur(Date.now() - Date.parse(e.dataset.since)); });
  }
  function paint() {
    const P = F.P, id = F.route.id, f = P && F.byId(id);
    if (!f) { notFound(id); return; }
    if (!built || !$('d-head')) build();
    const story = (data && data.story) || null;
    // Keep keyboard focus on the same control when its markup is replaced.
    const a = document.activeElement, fk = a && a.dataset && a.dataset.k && $('detail').contains && $('detail').contains(a) ? a.dataset.k : null;
    F.setHTML($('d-crumb'), '<a href="#factory">Factory</a><span aria-hidden="true">/</span><span class="cur">' + esc(story ? story.title : title(f)) + '</span>');
    F.setHTML($('d-head'), header(f, P, story));
    F.setHTML($('d-you'), needsYou(f, P, story));
    F.setHTML($('d-sfx'), specFix(story));
    F.setHTML($('d-fixes'), problems(story));
    F.setHTML($('d-journey'), journey(f, story));
    F.setHTML($('d-earlier'), earlier(story));
    F.setHTML($('d-folds'), spec(f) + activity(f) + logs() + details(f, P));
    timers();
    if (fk && document.activeElement !== a) {
      const n = $('detail').querySelector && $('detail').querySelector('[data-k="' + fk.replace(/["\\]/g, '\\$&') + '"]');
      if (n && n.focus) n.focus({ preventScroll: true });
    }
  }

  function render() {
    const P = F.P, id = F.route.id, f = P && F.byId(id);
    const k = P ? P.path + '|' + id : '', s = f ? f.status + '|' + f.attempts + '|' + f.updatedAt : '';
    if (k !== key) { key = k; data = null; sig = ''; pick = ''; sfxErr = null; seq++; for (const o of [...open]) if (!FOLDS.includes(o)) open.delete(o); }
    paint();
    if (f && s !== sig) { sig = s; load(); }
  }
  function tick() {
    const P = F.P, f = P && F.byId(F.route.id);
    if (!f) return;
    const every = FLIGHT.includes(f.status) ? 5000 : 30000;
    if (Date.now() - fetchedAt >= every) load();
    timers();
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
    // Record a <details> toggle right away too, so a re-render before the toggle event cannot undo it.
    const sum = e.target.closest('summary'), d = sum && sum.parentNode;
    if (d && d.dataset && d.dataset.k && !e.defaultPrevented) { if (d.open) open.delete(d.dataset.k); else open.add(d.dataset.k); }
    const b = e.target.closest('button');
    if (!b) return;
    const P = F.P, f = P && F.byId(F.route.id);
    if (!f) return;
    if (b.dataset.run) { pick = pick === b.dataset.run ? '' : b.dataset.run; open.add('f-logs'); paint(); return; }
    const act = b.dataset.act;
    if (act === 'copy') copy(branchOf(f, P));
    else if (act === 'pause') F.post('/api/feature/pause', P.path, f.id, 'Paused');
    else if (act === 'resume') F.post('/api/feature/resume', P.path, f.id, 'Resumed');
    else if (act === 'retry') F.post('/api/feature/retry', P.path, f.id, 'Retrying with fresh tries');
    else if (act === 'merged') F.post('/api/feature/merged', P.path, f.id, 'Marked merged');
    else if (act === 'sfx-apply') specFixPost('apply', P.path, f.id, b.dataset.fix, f.status === 'paused' ? 'Spec fix applied; the feature stays paused until you resume it' : 'Spec fix applied: it starts again with fresh tries');
    else if (act === 'sfx-dismiss') specFixPost('dismiss', P.path, f.id, b.dataset.fix, 'Spec fix dismissed');
    else if (act === 'sfx-undo') specFixPost('undo', P.path, f.id, b.dataset.fix, f.status === 'paused' ? 'Spec fix undone: the earlier text is back (still paused)' : 'Spec fix undone: the earlier text is back');
  }
  // POST /api/spec-fix/<what>; a server error is shown under the buttons, success reloads the page state and this story.
  async function specFixPost(what, project, id, fix, ok) {
    if (sfxBusy) return;
    const k = what === 'undo' ? 'undo' : fix, at = key;
    sfxBusy = k; sfxErr = null; paint();
    try {
      const r = await fetch('/api/spec-fix/' + what, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, id, fix }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) sfxErr = { k, msg: 'Could not ' + what + ' it: ' + String(body.error || 'request failed (HTTP ' + r.status + ')').replace(/^[^:]+: /, '') + '.' };
      else F.toast(ok);
    } catch { sfxErr = { k, msg: 'Could not reach the dashboard server.' }; }
    sfxBusy = '';
    if (at !== key) return;
    if (!sfxErr) { await F.load(true); load(); } else paint();
  }

  F.view('detail', { render, tick });
})();
