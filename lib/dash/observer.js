// Observer view: what the observer loop saw in the last day, what it did about it, and what still needs the person.
'use strict';
(() => {
  const { $, esc, setHTML, ago, featureHref } = F;
  const CAUSE = { untouched: 'A test the feature does not change', infra: 'Infrastructure', own: 'Its own code or tests', 'conflict-loop': 'Merge conflicts that keep coming back',
    setup: 'Worktree or prepare setup', builder: 'Builder or evaluator run', unknown: 'Unrecognized' };
  const cause = (c) => CAUSE[c] || CAUSE.unknown;
  const link = (id) => '<a class="o-f mono" href="' + featureHref(id) + '">' + esc(id) + '</a>';
  const when = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const sec = (title, body, empty) => '<section class="o-sec"><h2>' + title + '</h2>' + (body || '<p class="o-none">' + empty + '</p>') + '</section>';

  function render() {
    const root = $('observer'), P = F.P;
    if (!root || !P) return;
    const o = P.observer;
    if (!o) return setHTML(root, '<div class="o-wrap"><h1>Observer</h1><p class="o-none">The observer is not running for this project. Start it with <code>fact-os observe --watch</code>.</p></div>');
    const needs = o.alerts24h.map((a) => '<li><span class="o-t mono">' + esc(when(a.ts)) + '</span><span>' + esc(a.text) + '</span></li>').join('') +
      o.stuck.map((s) => '<li><span class="o-t mono">stuck</span><span>' + link(s.id) + ' is stuck: ' + esc(cause(s.cause).toLowerCase()) + (s.evidence ? ' <i class="o-ev">(' + esc(s.evidence) + ')</i>' : '') + '</span></li>').join('') +
      o.proposals.map((t) => '<li><span class="o-t mono">proposal</span><span><a href="#you">' + esc(t.title) + '</a> <i class="o-ev mono">' + esc(t.id) + '</i></span></li>').join('');
    const failures = o.causes24h.reduce((n, c) => n + c.n, 0), max = Math.max(1, ...o.causes24h.map((c) => c.n));
    const num = (n, l) => '<div class="o-num"><b class="mono">' + n + '</b><span>' + l + '</span></div>';
    const bars = o.causes24h.map((c) => '<li><span class="o-bl">' + esc(cause(c.cause)) + '</span><span class="o-bar"><i style="width:' + Math.round(100 * c.n / max) + '%"></i></span><span class="mono o-bn">' + c.n + '</span></li>').join('');
    const rec = o.recurring.map((r) => '<li><code class="o-test">' + esc(r.test) + '</code><span>' + r.features.map(link).join(' ') + '</span></li>').join('');
    const hot = (o.hotFiles || []).map((h) => '<li><code class="o-test">' + esc(h.file) + '</code><span class="mono">' + h.n + '</span></li>').join('');
    const fixes = o.fixes.map((f) => '<li><span class="o-t mono">' + esc(when(f.ts)) + '</span><span><code>' + esc(String(f.commit).slice(0, 8)) + '</code> ' + esc(f.summary) + '</span></li>').join('');
    const dec = o.decisions.map((d) => '<tr><td class="mono o-t">' + esc(when(d.ts)) + '</td><td>' + link(d.feature) + '</td><td>' + esc(cause(d.cause)) + '</td><td class="o-ev">' + esc(d.evidence) + '</td><td>' + esc(d.action) + '</td></tr>').join('');
    setHTML(root, '<div class="o-wrap"><h1>Observer</h1>' +
      '<p class="o-status"><i class="o-dot' + (o.running ? ' on' : '') + '"></i>' + (o.running ? 'Observer running' : 'Observer not running') + ' · updated ' + esc(ago(o.updatedAt)) +
      (o.agentAt ? ' · agent last ran ' + esc(ago(o.agentAt)) : '') + '</p>' +
      sec('Needs you', needs && '<ul class="o-list">' + needs + '</ul>', 'Nothing needs you.') +
      '<div class="o-nums" aria-label="Last 24 hours">' + num(failures, 'failures, 24h') + num(o.sentBack24h, 'sent back by the observer') + num(o.fixes.length, 'fixes merged') + num(o.bounces24h || 0, 'passed, then sent back by a merge conflict') + '</div>' +
      sec('Why features failed (24h)', bars && '<ul class="o-bars">' + bars + '</ul>', 'No failures in the last 24 hours.') +
      sec('Files whose merge conflicts send finished features back (24h)', hot && '<ul class="o-list">' + hot + '</ul>', 'None.') +
      sec('Tests failing in several features', rec && '<ul class="o-list">' + rec + '</ul>', 'None.') +
      sec('Fixes merged', fixes && '<ul class="o-list">' + fixes + '</ul>', 'No fixes merged yet.') +
      (o.agentNotes ? sec('Agent notes', '<p class="o-notes">' + esc(o.agentNotes) + '</p>', '') : '') +
      sec('Recent decisions', dec && '<div class="o-scroll"><table class="o-tbl"><tbody>' + dec + '</tbody></table></div>', 'No decisions yet.') + '</div>');
  }
  F.view('observer', { render, tick: render });
})();
