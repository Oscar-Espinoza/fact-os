// Observer view: answers, one section at a time, whether anything needs the person, how healthy the factory is, why features fail,
// how each merge conflict ended, what is stuck, what the observer did on its own, and whether the agents are improving.
'use strict';
(() => {
  const { $, esc, setHTML, featureHref, store, LABEL } = F;
  const SECTIONS = [['needs', 'Needs you'], ['health', 'Health'], ['failures', 'Failures'], ['conflicts', 'Merge conflicts'], ['stuck', 'Stuck'], ['actions', 'Observer actions'], ['agents', 'Agents']];
  const CAUSE = { untouched: 'A test the feature does not change', infra: 'Infrastructure (database, disk or memory)', own: 'Its own code or tests', 'conflict-loop': 'Merge conflicts that keep coming back',
    setup: 'Worktree or prepare setup', builder: 'Builder or evaluator run', unknown: 'Unrecognized' };
  const CAUSE_HELP = { untouched: 'The observer sends it back once; if it fails the same way again, a person looks.', infra: 'The observer sends it back once; if it fails the same way again, a person looks.',
    own: 'The builder keeps trying until its attempts run out.', 'conflict-loop': 'Several base refreshes in a row ended in conflicts, so the factory gave up.',
    setup: 'The environment failed before the builder could work.', builder: 'The builder or evaluator run itself failed.', unknown: 'The observer could not tell why.' };
  const cause = (c) => CAUSE[c] || CAUSE.unknown;
  const ACTION = { 'sent back': 'Sent back to the builder', 'left for a person': 'Left for a person', 'none: the foreman retries it': 'No action; the factory retries it automatically',
    'none: no longer stuck': 'No action; it is no longer stuck', 'left for a person: it already failed this way after a retry': 'Left for a person: it already failed the same way after a retry' };
  const action = (a) => ACTION[a] ?? (a || 'Not decided yet');
  const HELP = {
    bounce: 'A feature that passed the evaluator, then was sent back because merging it hit a conflict with newer work.',
    resolver: 'An automatic agent run that finishes a merge conflict for a feature, so the builder does not have to.',
    'prompt version': 'The builder\'s instructions in force for a stretch of time. A new version starts when lessons are curated or the builder\'s model, effort, briefs or prompt notes change.',
    'keep-check': 'After a conflict is resolved, a check that no line either side added was lost. Resolutions that lose lines are rejected.',
    'hot file': 'A file whose merge conflicts keep sending finished features back.',
    'prompt notes': 'Short advice for one model in one role, learned from reviews of its failed runs. The factory adds it to that model\'s prompts, so a change shows up as a new prompt version.' };
  const term = (t) => '<abbr class="o-h" tabindex="0" title="' + esc(HELP[t]) + '">' + esc(t) + '</abbr>';
  const glossary = (ts) => det('gl-' + ts[0], 'What do these words mean?', '<dl>' + ts.map((t) => '<dt>' + esc(t) + '</dt><dd>' + esc(HELP[t]) + '</dd>').join('') + '</dl>');

  let showAll = false;      // show every feature with conflicts, not just the 40 with the most
  let sel = store.get('observerSection', 'needs'), q = '', qRaw = '';
  if (!SECTIONS.some(([k]) => k === sel)) sel = 'needs';
  const open = new Set();   // keys of the <details> the person opened; they stay open through the re-render on every poll

  const link = (id) => '<a class="o-f mono" href="' + esc(featureHref(id)) + '" title="' + esc(id) + '">' + esc(F.shortId(id)) + '</a>';
  const lc = (s) => String(s ?? '').toLowerCase();
  const m = (...xs) => !q || xs.some((x) => lc(x).includes(q));
  const titleOf = (id) => ((F.P && F.P.observer && F.P.observer.titles) || {})[id] || '';
  const fm = (id, ...more) => m(id, titleOf(id), ...more);
  const feat = (id) => link(id) + (titleOf(id) ? ' <span class="o-ft">' + esc(F.title({ id, title: titleOf(id) })) + '</span>' : '');
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');
  const rel = (iso) => { const t = Date.parse(iso); if (isNaN(t)) return '—'; const s = Math.max(0, (Date.now() - t) / 1000);
    return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 172800 ? Math.floor(s / 3600) + ' h ago' : Math.floor(s / 86400) + ' days ago'; };
  const time = (iso) => { const d = new Date(iso); return isNaN(d) ? '—' : '<time datetime="' + esc(iso) + '" title="' + esc(d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' })) + '">' + esc(rel(iso)) + '</time>'; };
  const span = (ms) => { const mn = Math.round(ms / 60e3); return mn < 1 ? 'under a minute' : mn < 60 ? mn + ' min' : mn < 2880 ? Math.floor(mn / 60) + ' h' + (mn % 60 ? ' ' + (mn % 60) + ' min' : '') : Math.round(mn / 1440) + ' days'; };
  const short = (f) => f.split('/').slice(-2).join('/');
  const num = (n, l, h) => '<div class="o-num"' + (h ? ' title="' + esc(h) + '"' : '') + '><b class="mono">' + esc(n) + '</b><span>' + esc(l) + '</span></div>';
  function det(key, summary, body) { return '<details class="o-d" data-k="' + esc(key) + '"' + (open.has(key) ? ' open' : '') + '><summary>' + summary + '</summary>' + body + '</details>'; }
  const none = (s) => '<p class="o-none">' + esc(s) + '</p>';
  const empty = (s) => (q ? '<p class="o-none">No matches for “' + esc(qRaw) + '”.</p>' : none(s));
  const pill = (kind, glyph, word) => '<span class="o-pill ' + kind + '"><i aria-hidden="true">' + glyph + '</i>' + esc(word) + '</span>';
  const OUT = { merged: ['ok', '✓', 'Merged'], resolved: ['info', '✓', 'Resolved'], 'resolved then stuck': ['bad', '✕', 'Resolved, then stuck'], failed: ['bad', '✕', 'Gave up'], 'conflicted again': ['warn', '⟲', 'Conflicted again'], 'still open': ['warn', '…', 'Still open'] };
  const list = (rows) => '<ul class="o-list">' + rows.join('') + '</ul>';
  const files = (fs) => '<ul class="o-files">' + fs.map((f) => '<li><code>' + esc(f) + '</code></li>').join('') + '</ul>';
  const tbl = (head, rows, cls) => '<div class="o-scroll"><table class="o-tbl ' + cls + '"><thead><tr>' + head.map((h) => '<th scope="col">' + h + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  const noSearch = () => (q ? '<p class="o-help">Search does not filter this section.</p>' : '');

  // ---------- sections: each returns { answer, body, n (shown), total } ----------
  // The same alert repeats (once a day per file, and again as the count grows): keep the newest of each, with how often it came.
  function alertGroups(alerts) {
    const g = new Map();
    for (const a of alerts) { const k = a.text.replace(/\s*\(\d+\+?(?: or more)? in 24h\)/, ''), x = g.get(k); if (x) x.n++; else g.set(k, { ...a, n: 1 }); }
    return [...g.values()];
  }
  function needs(o) {
    // Hot-file merge alerts feed the improver and the Merge conflicts section; they are not a person's to-do.
    const groups = alertGroups(o.alerts24h.filter((a) => !/keep sending features that passed evaluation/.test(a.text))), alerts = groups.filter((a) => m(a.text)), stuck = o.stuck.filter((s) => fm(s.id, s.evidence)), props = o.proposals.filter((t) => m(t.id, t.title));
    const rows = [...alerts.map((a) => '<li><span class="o-k">Alert</span><span>' + esc(a.text) + ' <span class="o-ev">' + (a.n > 1 ? 'alerted ' + esc(a.n) + '× · latest ' : '') + time(a.ts) + '</span></span></li>'),
      ...stuck.map((s) => '<li><span class="o-k">Stuck</span><span>' + feat(s.id) + ': ' + esc(cause(s.cause).toLowerCase()) + '.</span></li>'),
      ...props.map((t) => '<li><span class="o-k">Proposal</span><span><a href="#you">' + esc(t.title) + '</a> <span class="o-ev">waiting for you under “Only you”</span></span></li>')];
    const all = groups.length + o.stuck.length + o.proposals.length;
    return { n: rows.length, total: all, body: rows.length ? list(rows) : empty('Nothing needs you.'),
      answer: all ? plural(all, 'thing needs', 'things need') + ' you: ' + [groups.length && plural(groups.length, 'alert'), o.stuck.length && plural(o.stuck.length, 'stuck feature'),
        o.proposals.length && plural(o.proposals.length, 'proposal') + ' from the observer'].filter(Boolean).join(', ') + '.' : 'Nothing needs you right now.' };
  }
  function health(o, P) {
    const merged = (P.stats.mergedAt || []).filter((t) => Date.parse(t) >= Date.now() - 864e5).length, fails = o.causes24h.reduce((n, c) => n + c.n, 0), run = P.foreman.running;
    return { n: 0, total: 0, answer: !run ? 'The foreman is not running, so nothing is being built.' : merged ? 'The factory is moving: ' + merged + ' merged in the last 24 h.' : 'The factory is running, but nothing merged in the last 24 h.',
      body: '<p class="o-status"><i class="o-dot' + (run ? ' on' : '') + '"></i>' + (run ? 'Foreman running' : 'Foreman stopped') + ' · <i class="o-dot' + (o.running ? ' on' : '') + '"></i>' + (o.running ? 'Observer running' : 'Observer not running') +
        ' · updated ' + time(o.updatedAt) + (o.improveAt ? ' · improver last ran ' + time(o.improveAt) : ' · improver has not run yet') + '</p>' +
        '<div class="o-nums" aria-label="Last 24 hours">' + num(merged, 'merged, 24h') + num(fails, 'failed attempts, 24h', 'Attempts that ended failed or stuck.') + num(o.conflicts24h.length, 'merge conflicts, 24h') +
        num(o.sentBack24h, 'sent back by the observer, 24h') + num(o.bounces24h || 0, 'bounces, 24h', HELP.bounce) + '</div>' + noSearch() + glossary(['bounce']) };
  }
  function failures(o) {
    const total = o.causes24h.reduce((n, c) => n + c.n, 0), max = Math.max(1, ...o.causes24h.map((c) => c.n));
    const bars = o.causes24h.filter((c) => m(cause(c.cause))).map((c) => '<li><span class="o-bl">' + esc(cause(c.cause)) + '</span><span class="o-bar"><i style="width:' + Math.round(100 * c.n / max) + '%"></i></span><span class="mono o-bn">' + esc(c.n) + '</span></li>');
    const rec = o.recurring.filter((r) => m(r.test) || r.features.some((f) => fm(f))).map((r) => '<li><code class="o-test">' + esc(r.test) + '</code><span>' + r.features.map(link).join(' ') + '</span></li>');
    const dec = o.decisions.filter((d) => fm(d.feature, d.evidence, action(d.action), ...(d.tests || []))).map((d) => '<tr><td>' + time(d.ts) + '</td><td>' + feat(d.feature) + '</td><td>' + esc(cause(d.cause)) + '</td><td>' + esc(action(d.action)) +
      '</td><td>' + det('dec-' + d.ts + d.feature, 'Evidence', '<p class="o-ev o-pre">' + esc(d.evidence) + '</p>' + ((d.tests || []).length ? files(d.tests) : '')) + '</td></tr>');
    const top = o.causes24h[0], any = bars.length + rec.length + dec.length;
    return { n: any, total, answer: total ? plural(total, 'attempt') + ' failed in the last 24 h' + (top ? '; the most common cause: ' + cause(top.cause).toLowerCase() : '') + '. ' + o.sentBack24h + ' sent back to the builder by the observer.' : 'No failures in the last 24 h.',
      body: !any ? empty('No failures in the last 24 hours.') : (bars.length ? '<h3>Why attempts failed</h3><ul class="o-bars">' + bars.join('') + '</ul>' : '') +
        (rec.length ? '<h3>Tests failing in several features</h3>' + list(rec) : '') + (dec.length ? '<h3>Recent decisions</h3>' + tbl(['When', 'Feature', 'Cause', 'What the observer did', 'Details'], dec, 'o-wide') : '') };
  }
  function conflicts(o) {
    const all = o.conflicts24h, rows = all.filter((c) => fm(c.feature, c.title, ...c.files, c.note)), hot = (o.hotFiles || []).filter((h) => m(h.file));
    const handled = (k) => all.filter((c) => c.resolvedBy === k).length, feats = new Set(all.map((c) => c.feature));
    const merged = new Set(all.filter((c) => c.outcome === 'merged').map((c) => c.feature)), going = [...feats].filter((f) => !merged.has(f) && all.some((c) => c.feature === f && ['resolved', 'still open', 'resolved then stuck'].includes(c.outcome))).length;
    const again = all.filter((c) => c.outcome === 'conflicted again').length, gave = all.filter((c) => c.outcome === 'failed').length;
    const perFile = new Map();
    for (const c of rows) for (const f of c.files) perFile.set(f, (perFile.get(f) || 0) + 1);
    const top = [...perFile].sort((x, y) => y[1] - x[1]).slice(0, 8);
    const byF = new Map();
    for (const c of rows) (byF.get(c.feature) || byF.set(c.feature, []).get(c.feature)).push(c);   // newest first within a feature
    const groups = [...byF].sort((x, y) => y[1].length - x[1].length), shown = showAll || q ? groups : groups.slice(0, 40);
    const stateOf = (c) => { const f = F.byId(c.feature); return f ? LABEL[F.statusOf(f)] || f.status : ''; };
    const item = (c) => {
      const p = OUT[c.outcome], fs = c.files.map(short), more2 = fs.length > 2 ? ' +' + (fs.length - 2) + ' more' : '', live = c.outcome === 'resolved' || c.outcome === 'still open';
      const dur = c.outcome === 'merged' ? 'after ' + span(c.ms) : live ? (stateOf(c) ? 'now ' + stateOf(c) + ' · ' : '') + span(c.ms) + ' since the conflict' : c.outcome === 'resolved then stuck' ? 'stuck ' + span(c.ms) + ' after the conflict' :
        (c.outcome === 'failed' ? 'gave up after ' : 'after ') + span(c.ms);
      const by = c.resolvedBy === 'resolver' ? 'Resolver' : c.resolvedBy === 'builder' ? 'Builder' : c.resolving ? 'Resolver (working…)' : '—';
      return '<li class="o-cf"><div>' + pill(p[0], p[1], p[2]) + ' <span class="o-ev">' + esc(dur) + '</span></div><div class="o-ev">' + time(c.ts) + ' · handled by <b>' + esc(by) + '</b></div>' +
        '<div title="' + esc(c.files.join('\n')) + '">' + det('cf-' + c.feature + c.ts, esc(fs.slice(0, 2).join(', ') + more2),
          files(c.files) + (c.note ? '<p class="o-ev">Note: ' + esc(c.note) + '</p>' : '') + (c.stuckCause ? '<p class="o-ev o-pre">Stuck: ' + esc(c.stuckCause) + '</p>' : '')) + '</div></li>';
    };
    const feature = ([id, cs]) => {
      const done = cs.find((c) => c.outcome === 'merged'), first = cs[cs.length - 1], fc = new Map();
      for (const c of cs) for (const f of c.files) fc.set(f, (fc.get(f) || 0) + 1);
      const worst = [...fc].sort((x, y) => y[1] - x[1])[0], p = OUT[done ? 'merged' : cs[0].outcome], st = done ? '' : stateOf(cs[0]);
      return '<li>' + det('bf-' + id, feat(id) + ' <span class="o-ev">' + plural(cs.length, 'conflict') + '</span> ' + pill(p[0], p[1], p[2]) + (st ? ' <span class="o-ev">now ' + esc(st) + '</span>' : '') +
        (done ? ' <span class="o-ev">merged ' + esc(span(Date.parse(done.outcomeTs) - Date.parse(first.ts))) + ' after the first conflict</span>' : '') + (worst ? ' <span class="o-ev">· most often <code>' + esc(short(worst[0])) + '</code></span>' : ''),
        '<ul class="o-cfs">' + cs.map(item).join('') + '</ul>') + '</li>';
    };
    return { n: rows.length, total: all.length,
      answer: all.length ? plural(all.length, 'merge conflict') + ' in the last 24 h across ' + plural(feats.size, 'feature') + '. ' + merged.size + ' of those features have merged since; ' + going + ' still going. ' + again + (again === 1 ? ' time' : ' times') +
        ' a resolved feature hit a new conflict before it could merge.' + (gave ? ' ' + gave + ' gave up after too many conflicts.' : '') + ' The builder handled ' + handled('builder') + ', the resolver ' + handled('resolver') + '.' : 'No merge conflicts in the last 24 h.',
      body: (top.length ? '<h3>Files that conflict most</h3><p class="o-help">Counted from the conflicts below (' + term('hot file') + ').</p>' + list(top.map(([f, n]) => '<li><code class="o-test" title="' + esc(f) + '">' + esc(f) + '</code><span class="mono">' + esc(n) + '</span></li>')) : '') +
        '<h3>By feature</h3>' + (groups.length ? '<p class="o-help">Most conflicts first. Open one to see each conflict and how it ended.</p><ul class="o-bf">' + shown.map(feature).join('') + '</ul>' +
          (shown.length < groups.length ? '<p class="o-help" style="margin-top:8px">Showing 40 of ' + groups.length + ' features. <button type="button" class="o-more" data-more="1">Show all</button></p>' : '') : empty('No merge conflicts in the last 24 hours.')) +
        (hot.length ? '<h3>Sent back after passing evaluation</h3><p class="o-help">Files whose conflicts sent features that had already passed the evaluator back to the builder (' + term('bounce') + ').</p>' + list(hot.map((h) => '<li><code class="o-test" title="' + esc(h.file) + '">' + esc(h.file) + '</code><span class="mono">' + esc(h.n) + '</span></li>')) : '') +
        glossary(['resolver', 'keep-check', 'hot file', 'bounce']) };
  }
  function stuck(o) {
    const rows = o.stuck.filter((s) => fm(s.id, s.evidence)).map((s) => '<li class="o-card"><div>' + feat(s.id) + ' ' + pill('bad', '✕', 'Stuck') + '</div><p>' + esc(cause(s.cause)) + '. <span class="o-ev">' + esc(CAUSE_HELP[s.cause] || CAUSE_HELP.unknown) + '</span></p>' +
      (s.evidence ? det('st-' + s.id, 'Evidence', '<p class="o-ev o-pre">' + esc(s.evidence) + '</p>') : '') + '</li>');
    return { n: rows.length, total: o.stuck.length, answer: o.stuck.length ? plural(o.stuck.length, 'feature is', 'features are') + ' stuck and not moving by itself.' : 'No feature is stuck.', body: rows.length ? '<ul class="o-cards">' + rows.join('') + '</ul>' : empty('No feature is stuck.') };
  }
  function actions(o) {
    const sent = o.decisions.filter((d) => d.action === 'sent back' && fm(d.feature, d.evidence)), imps = (o.improvements || []).filter((f) => fm(f.id, f.title)), props = o.proposals.filter((t) => m(t.id, t.title));
    const notes = o.agentNotes && m(o.agentNotes) ? o.agentNotes : '', n = sent.length + imps.length + props.length + (notes ? 1 : 0);
    const part = (h, hint, rows) => '<h3>' + h + '</h3><p class="o-help">' + hint + '</p>' + list(rows);
    return { n, total: o.sentBack24h + (o.improvements || []).length + o.proposals.length + (o.agentNotes ? 1 : 0),
      answer: 'The observer sent back ' + plural(o.sentBack24h, 'feature') + ' in the last 24 h, has ' + (o.improvements || []).length + ' improvements queued and ' + plural(o.proposals.length, 'proposal') + ' waiting for you.',
      body: n ? (imps.length ? part('Improvements queued', 'Features the observer added; the factory builds and checks them like any other.', imps.map((f) => '<li><span class="o-k">' + esc(LABEL[f.status] || f.status) + '</span><span>' + link(f.id) + ' ' + esc(f.title) + '</span></li>')) : '') +
        (props.length ? part('Waiting for you', 'Changes outside the repository, which the observer cannot make itself.', props.map((t) => '<li><span class="o-k">Proposal</span><span><a href="#you">' + esc(t.title) + '</a></span></li>')) : '') +
        (sent.length ? part('Sent back to the builder', 'Failures outside the feature (an unrelated test, infrastructure) are retried without costing an attempt.', sent.map((d) => '<li><span class="o-k">' + time(d.ts) + '</span><span>' + feat(d.feature) + ' <span class="o-ev">' + esc(cause(d.cause).toLowerCase()) + '</span></span></li>')) : '') +
        (notes ? '<h3>Agent notes</h3><p class="o-notes">' + esc(notes) + '</p>' : '') : empty('The observer has not acted yet. The improver turns what it sees into features the factory builds and checks like any other.') };
  }
  // The main rates per prompt version as [count, out of, lower is better].
  const RATES = [(e) => [e.built, e.launches - e.setup, 0], (e) => [e.gated, e.built, 0], (e) => [e.passed, e.evaluated, 0], (e) => [e.bounced, e.passed, 1], (e) => [e.merged, e.launches - e.setup, 0]];
  const pc = ([a, b]) => esc(b ? Math.round((100 * a) / b) + '% (' + a + '/' + b + ')' : '–');
  // 1 better, -1 worse, 0 about the same or too few runs to say, against the previous version.
  function verdict(e, prev, i) {
    if (!prev) return 0;
    const [a, b, low] = RATES[i](e), [pa, pb] = RATES[i](prev);
    if (b < 5 || pb < 5 || Math.abs(a / b - pa / pb) < 0.05) return 0;
    return (a / b > pa / pb) !== !!low ? 1 : -1;
  }
  const arrow = (v, e, prev, i) => { if (!v) return ''; const [pa, pb] = RATES[i](prev), w = v > 0 ? 'better' : 'worse';
    return ' <span class="o-tr ' + (v > 0 ? 'good' : 'badr') + '" role="img" aria-label="' + w + ' than the previous version" title="' + w + ' than the previous version (' + Math.round(100 * pa / pb) + '%)">' + (RATES[i](e)[0] / RATES[i](e)[1] > pa / pb ? '▲' : '▼') + ' ' + w + '</span>'; };
  const label = (c) => (/^builder /.test(c) ? (/model=(\S+)/.test(c) ? 'Builder now uses ' + /model=(\S+)/.exec(c)[1] + (/effort=(\S+)/.test(c) ? ', ' + /effort=(\S+)/.exec(c)[1] + ' effort' : '') + (/notes=(\S+)/.test(c) ? ', with prompt notes ' + /notes=(\S+)/.exec(c)[1] : '') + (/profile=(\S+)/.test(c) ? ' (profile ' + /profile=(\S+)/.exec(c)[1] + ')' : '') : 'Builder settings changed') : /^lessons curated /.test(c) ? 'Lessons curated: ' + c.replace(/^lessons curated /, '') : c === 'start of the window' ? 'Start of the 7-day window' : c);
  function agents(o) {
    const eras = o.agents || [], mn = (x) => (x == null ? '–' : Math.round(x)), judged = eras.filter((e) => e.launches - e.setup >= 5), last = judged[judged.length - 1], prev = judged[judged.length - 2], newest = eras[eras.length - 1];
    const tr = eras.map((e, k) => { const p = eras[k - 1], c = label(e.change), cell = (i) => '<td class="mono">' + pc(RATES[i](e)) + arrow(verdict(e, p, i), e, p, i) + '</td>';
      return '<tr><th scope="row"><span class="mono">v' + (k + 1) + '</span> <span class="o-ev">' + time(e.since) + '</span><br><span class="o-chg" title="' + esc(c) + '">' + esc(c.length > 60 ? c.slice(0, 57) + '…' : c) + '</span></th><td class="mono">' + esc(e.launches + (e.setup ? ' (' + e.setup + ' setup failed)' : '')) + '</td>' +
        cell(0) + cell(1) + cell(2) + cell(3) + cell(4) + '<td class="mono">' + esc(e.resolves + ' (' + e.resolvedMerged + ' merged)') + '</td><td class="mono">' + esc(mn(e.buildMin) + ' / ' + mn(e.gateMin) + ' / ' + mn(e.evalMin)) + ' min</td><td class="mono">' + esc('$' + Math.round(e.costBuild) + ' + $' + Math.round(e.costEval)) + '</td></tr>'; });
    let answer = eras.length ? 'Too few builds in any prompt version to judge yet.' : 'No runs in the last 7 days.';
    const pr = o.prompts;
    if (last) {
      const v = RATES.map((_, i) => verdict(last, prev, i)), better = v.filter((x) => x > 0).length, worse = v.filter((x) => x < 0).length;
      answer = (newest !== last ? 'v' + eras.length + ' started ' + rel(newest.since) + '; too few builds to judge yet. ' : '') + 'Latest version with enough builds (v' + (eras.indexOf(last) + 1) + ', since ' + rel(last.since) + '): ' + last.built + ' of ' + (last.launches - last.setup) + ' builds reached the test, ' + last.merged + ' merged.' +
        (prev ? (better || worse ? ' Against the previous version: ' + better + ' rates better, ' + worse + ' worse.' : ' About the same as the previous version.') : '');
    }
    if (pr && pr.reviewed) answer += ' ' + plural(pr.reviewed, 'failed run') + ' reviewed for why it failed (see Prompts by model).';
    const head = ['Version', 'Builds', '<abbr title="Builds that got as far as the test run">Reached test</abbr>', '<abbr title="Of those, how many passed the test gate">Passed gate</abbr>', '<abbr title="Of those, how many passed the evaluator">Passed evaluator</abbr>',
      '<abbr title="Of the ones that passed, how many were sent back by a merge conflict. Lower is better.">Bounced</abbr>', '<abbr title="Builds that merged">Merged</abbr>', '<abbr title="Resolver runs, and how many of those features then merged">Resolver runs</abbr>',
      '<abbr title="Median minutes: build / gate / evaluator">Build / gate / eval</abbr>', '<abbr title="Money spent on builds and on evaluations">Cost</abbr>'];
    return { n: 0, total: 0, answer, body: noSearch() + (tr.length ? tbl(head, tr, 'o-wide o-agents') + '<p class="o-help">Each percentage shows the counts behind it. ▲ better and ▼ worse mark a rate that moved 5 points or more against the previous ' + term('prompt version') +
      ' (each side needs at least 5 runs behind that rate). For bounced, lower is better.</p>' : none('No runs yet.')) + prompts(o) + glossary(['prompt version', 'bounce', 'resolver', 'prompt notes']) };
  }
  // Why runs failed, by model: what the review agent concluded about each failed run, and whether the notes it led to helped.
  const PCAUSE = { 'prompt-missing-info': 'the prompt left something out', 'prompt-ambiguous': 'the prompt could be read two ways', 'prompt-conflict': 'the prompt contradicted itself',
    'model-limitation': 'the model got it wrong despite a clear prompt', environment: 'infrastructure or a flaky test', 'spec-error': 'the feature spec was wrong' };
  const TARGET = { template: 'the role\'s fixed instructions (a task for you)', briefs: 'the project briefs', lessons: 'the lessons' };
  const TREND = { better: 'fewer failures than the version before', worse: 'more failures than the version before', 'about the same': 'about the same as the version before' };
  function prompts(o) {
    const s = o.prompts || { reviewed: 0, invalid: 0, rows: [] };
    const cards = s.rows.map((r) => {
      const sug = r.suggestions.length ? '<p class="o-help">What would have helped most:</p>' + list(r.suggestions.map((x) => '<li><span class="mono">' + (x.n > 1 ? esc(x.n) + '×' : '1×') + '</span><span>' + esc(x.text) + ' <span class="o-ev">(belongs in ' + esc(TARGET[x.target] || x.target) + ')</span></span></li>')) : '';
      const vs = r.versions.filter((v) => v.notes !== '-').length ? '<p class="o-help">Results by notes version:</p>' + list(r.versions.map((v) => { const n = v.ok + v.bad;
        return '<li><span class="o-ev">' + (v.notes === '-' ? 'No notes' : 'Notes <code>' + esc(v.notes) + '</code>') + ' · since ' + time(v.since) + '</span><span>' + esc(v.bad + ' of ' + n + ' passes failed' + (n ? ' (' + Math.round(100 * v.bad / n) + '%)' : '')) +
          (v.trend ? ' · ' + esc(TREND[v.trend] || v.trend) : '') + '</span></li>'; })) : '';
      const nt = r.notes ? det('pn-' + r.model + r.role, 'Notes sent with its prompts (' + term('prompt notes') + ', ' + plural(r.notes.text.split('\n').filter((l) => /^- /.test(l)).length, 'note') + ', ' + esc(r.notes.bytes) + ' bytes)', '<p class="o-notes">' + esc(r.notes.text) + '</p>') : '<p class="o-ev">No notes yet.</p>';
      return '<li class="o-card"><div><b>' + esc(r.model) + '</b> as ' + esc(r.role) + ' <span class="o-ev">' + esc(plural(r.reviewed, 'failed run')) + ' reviewed</span></div>' +
        (r.causes.length ? '<p>' + r.causes.map((c) => esc(PCAUSE[c.cause] || c.cause) + ' <span class="mono">' + esc(c.n) + '</span>').join(' · ') + '</p>' : '') + sug + vs + nt + '</li>'; });
    return '<h3>Prompts by model</h3><p class="o-help">When a run fails, the observer asks an agent whether the prompt or the model was at fault. What it learns about each model becomes notes added to that model\'s prompts.</p>' +
      (s.cost ? '<p class="o-help">Reviews have cost $' + esc(s.cost.toFixed(2)) + ' so far (' + esc(plural(s.runs24h, 'run')) + ' in the last 24 h).</p>' : '') +
      (cards.length ? '<ul class="o-cards">' + cards.join('') + '</ul>' + (s.invalid ? '<p class="o-help">' + esc(plural(s.invalid, 'review')) + ' could not be read and was skipped.</p>' : '') :
        none('No failed runs have been reviewed yet. Reviews need an observer agent (observe --agent) and happen once per failed run.'));
  }
  const BUILD = { needs, health, failures, conflicts, stuck, actions, agents };

  // ---------- shell: built once, so the search box keeps its focus and caret through every re-render ----------
  function shell(root) {
    root.innerHTML = '<div class="o-wrap"><h1>Observer</h1><div class="o-bar2" id="o-bar"><nav class="o-nav" aria-label="Observer sections">' +
      SECTIONS.map(([k, t]) => '<button type="button" data-s="' + k + '">' + esc(t) + '<span class="o-bd"></span></button>').join('') + '</nav>' +
      '<label class="o-search"><span class="o-sr">Search by feature, title or file name</span><input id="o-q" type="search" placeholder="Search feature or file…" autocomplete="off" spellcheck="false"></label></div><div id="o-body"></div></div>';
    root.addEventListener('click', (e) => { if (e.target.closest('[data-more]')) { showAll = true; render(); return; } const b = e.target.closest('button[data-s]'); if (!b) return; sel = b.dataset.s; store.set('observerSection', sel); render(); window.scrollTo(0, 0); });
    root.addEventListener('input', (e) => { if (e.target.id === 'o-q') { qRaw = e.target.value.trim(); q = lc(qRaw); render(); } });
    root.addEventListener('toggle', (e) => { const k = e.target.dataset && e.target.dataset.k; if (k) e.target.open ? open.add(k) : open.delete(k); }, true);
  }

  function render() {
    const root = $('observer'), P = F.P;
    if (!root || !P) return;
    if (!$('o-bar')) shell(root);
    const o = P.observer, body = $('o-body');
    $('o-bar').hidden = !o;
    if (!o) return setHTML(body, '<p class="o-none">The observer is not running for this project. Start it with <code>fact-os observe --watch</code>.</p>');
    const out = {};
    for (const [k] of SECTIONS) out[k] = BUILD[k](o, P);
    root.querySelectorAll('button[data-s]').forEach((b) => {
      const r = out[b.dataset.s], n = q ? r.n : r.total, bd = b.querySelector('.o-bd'), txt = n ? String(n) : '';
      if (b.dataset.s === sel) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      b.classList.toggle('dim', !!q && r.total > 0 && !r.n);
      if (bd.textContent !== txt) bd.textContent = txt;
      b.setAttribute('aria-label', SECTIONS.find(([k]) => k === b.dataset.s)[1] + (txt ? ', ' + txt : ''));
      bd.classList.toggle('hot', b.dataset.s === 'needs');
    });
    const r = out[sel], a = document.activeElement, esc2 = (x) => String(x).replace(/["\\]/g, '\\$&');
    // The body is replaced when its markup changes (every minute at least); put keyboard focus back on the same control.
    const key = a && body.contains(a) ? (a.tagName === 'SUMMARY' ? 'details[data-k="' + esc2(a.parentElement.dataset.k) + '"]>summary' : a.dataset.more ? '[data-more]' : a.getAttribute('href') ? 'a[href="' + esc2(a.getAttribute('href')) + '"]' : '') : '';
    setHTML(body, '<section aria-labelledby="o-h"><h2 id="o-h">' + esc(SECTIONS.find(([k]) => k === sel)[1]) + '</h2><p class="o-answer">' + esc(r.answer) + '</p>' + r.body + '</section>');
    if (key && !body.contains(document.activeElement)) { const n = body.querySelector(key); if (n) n.focus(); }
    const keys = new Set([...body.querySelectorAll('[data-k]')].map((d) => d.dataset.k));
    for (const k of open) if (!keys.has(k)) open.delete(k);
  }
  F.view('observer', { render, tick: render });
})();
