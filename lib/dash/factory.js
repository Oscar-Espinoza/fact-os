// factory view: KPI strip, the pixel-art floor with live bays, and the bottom panels.
'use strict';
(() => {
  const { esc, setHTML } = F;
  const CX = [166, 358, 551, 741, 930, 1120, 1312, 1505];
  const LAMPS = [[193, '5.3s'], [403, '7.1s'], [1117, '6.2s'], [1329, '8.4s']];
  const ST = {
    build1: { status: 'BUILDING', color: '#5fe08a', bar: '#3ddc7a' },
    build2: { status: 'BUILDING', color: '#5fe08a', bar: '#3ddc7a' },
    build3: { status: 'BUILDING', color: '#5fe08a', bar: '#3ddc7a' },
    eval: { status: 'TESTING', color: '#5fe08a', bar: '#3ddc7a' },
    merge: { status: 'EVALUATING', color: '#72b4ff', bar: '#4f9bff' },
    you: { status: 'NEEDS YOU', color: '#f5b73b', bar: '#3ddc7a', glow: 'rgba(245,183,59,.16)' },
    stuck: { status: 'STUCK', color: '#ff6b6b', bar: '#ff6b6b', glow: 'rgba(255,90,90,.24)' },
    idle: { status: 'IDLE', color: '#c9d3e0', bar: '#3ddc7a' },
  };
  // Sprite regions inside each bay image, animated as a copy over the original.
  const MOVES = {
    build1: [['bob', 28, 146, 30, 52], ['work', 100, 126, 62, 48]],
    build2: [['work', 28, 150, 40, 40], ['work', 108, 126, 54, 52]],
    build3: [['bob', 38, 146, 30, 52], ['flicker', 78, 148, 54, 34]],
    eval: [['bob', 30, 142, 34, 54], ['work', 116, 126, 38, 50], ['flicker', 70, 150, 44, 30]],
    merge: [['bob', 34, 148, 30, 50], ['work', 72, 132, 50, 44], ['flicker', 124, 136, 22, 48]],
    you: [['bob', 46, 148, 30, 50], ['blink', 92, 136, 32, 32]],
    stuck: [['blink', 84, 136, 34, 32]],
    idle: [],
  };
  const EVI = { launch: 'cycle', testing: 'play', evaluating: 'deploy', failed: 'alert', stuck: 'alert', merged: 'box', lesson: 'check', refreshed: 'cycle', paused: 'alert', resumed: 'play' };
  const DEF = { build: 12 * 60e3, test: 5 * 60e3, eval: 4 * 60e3 };
  const CLOCK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  const HOUR = 3600e3, DAY = 24 * HOUR;

  const bayOf = new Map();   // feature id -> slot, stable across polls
  let projectKey = null, built = false, lastScale = 0;
  let els = {};

  const maxTries = () => (F.P.config && F.P.config.maxAttempts) || '?';
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const stamps = () => ((F.P.stats && F.P.stats.mergedAt) || []).map(Date.parse).filter((t) => !isNaN(t));
  const signed = (n, d) => (n < 0 ? '−' : '+') + Math.abs(+n.toFixed(d));

  function skeleton() {
    const root = F.$('factory');
    root.innerHTML =
      '<div class="fx">' +
      '<div class="fx-paused" id="fx-paused" role="status"></div>' +
      '<div class="fx-kpis" id="fx-kpis"></div>' +
      '<div class="fx-wrap" id="fx-wrap"><div class="fx-scaler" id="fx-scaler"><section class="fx-floor" id="fx-floor" aria-label="Factory floor">' +
      LAMPS.map(([x, d]) => '<div class="fx-lamp" style="left:' + x + 'px;animation-duration:' + d + '"></div>').join('') +
      '<div class="fx-sign pix" id="fx-sign"></div>' +
      CX.map((cx, i) => '<div class="fx-slot" id="fx-slot' + i + '" style="left:' + (cx - 92) + 'px"></div>').join('') +
      '<div class="fx-belt"></div></section></div></div>' +
      '<div class="fx-bottom">' +
      '<section class="panel"><div class="fx-h"><img src="/assets/h-activity.png" alt=""><h3>RECENT ACTIVITY</h3></div><div id="fx-events"></div></section>' +
      '<section class="panel"><div class="fx-h"><img src="/assets/h-queue.png" alt=""><h3>UP NEXT</h3><div class="sp"></div><span class="pillx" id="fx-qn"></span></div><div id="fx-queue"></div></section>' +
      '<section class="panel"><div class="fx-h"><img src="/assets/h-output.png" alt=""><h3>TODAY’S OUTPUT</h3></div><div id="fx-output"></div></section>' +
      '<section class="panel"><div class="fx-h"><img src="/assets/h-actions.png" alt=""><h3>ACTIONS</h3></div><div class="fx-act" id="fx-actions"></div></section>' +
      '</div></div>';
    els = { paused: F.$('fx-paused'), kpis: F.$('fx-kpis'), wrap: F.$('fx-wrap'), scaler: F.$('fx-scaler'), floor: F.$('fx-floor'), sign: F.$('fx-sign'),
      events: F.$('fx-events'), queue: F.$('fx-queue'), qn: F.$('fx-qn'), output: F.$('fx-output'), actions: F.$('fx-actions'),
      slots: CX.map((_, i) => F.$('fx-slot' + i)) };
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-retry]');
      if (b) retryStuck();
      const c = e.target.closest('[data-control]');
      if (c) c.dataset.control === 'resume' ? F.control.resume() : c.dataset.control === 'pause' ? F.control.pause() : F.control.lanes(null);
    });
    if (window.ResizeObserver) new ResizeObserver(fit).observe(els.wrap); else window.addEventListener('resize', fit);
    built = true;
  }

  // The floor art is fixed size: scale it to the available width, never above 1, and scroll on phones instead of shrinking past ~0.45.
  function fit() {
    const w = els.wrap.clientWidth;
    if (!w) return;
    const s = Math.min(1, w < 700 ? Math.max(w / 1672, 0.45) : w / 1672);
    if (s === lastScale) return;
    lastScale = s;
    els.floor.style.transform = 'scale(' + s + ')';
    els.scaler.style.width = Math.round(1672 * s) + 'px';
    els.scaler.style.height = Math.round(450 * s) + 'px';
  }

  async function retryStuck() {
    const P = F.P, ids = P.features.filter((f) => f.status === 'stuck').map((f) => f.id);
    for (let i = 0; i < ids.length; i++) await F.post('/api/feature/retry', P.path, ids[i], i === ids.length - 1 ? 'Retrying ' + ids.length + ' stuck' : '');
  }

  // ---------- model ----------
  const needsYouIds = () => {
    const P = F.P;
    const ids = P.waiting.slice();
    if (P.merge === 'manual') for (const f of P.features) if (f.status === 'ready') ids.push(f.id);
    return ids.filter((id) => F.byId(id));
  };
  const remainingMs = (f, pr) => {
    const P = F.P, e = P.estimates || {}, m = (k) => e[k] || DEF[k], k = F.STAGE[f.status][0];
    const later = k === 'build' ? m('test') + m('eval') : k === 'test' ? m('eval') : 0;
    return Math.max(0, m(k) - pr.elapsed) + later;
  };
  const leftText = (ms) => {
    const min = Math.ceil(ms / 60e3);
    return min <= 0 ? '<1m left' : min >= 60 ? '~' + Math.floor(min / 60) + 'h ' + (min % 60) + 'm left' : '~' + min + 'm left';
  };
  // Values that change every second; also filled right after each render.
  function volatile(f, kind) {
    const P = F.P;
    if (kind === 'run') {
      const pr = F.progress(f);
      return { pct: pr.pct, time: pr.late ? 'running late' : leftText(remainingMs(f, pr)), tries: 'try ' + (f.attempts + 1) + '/' + maxTries() };
    }
    if (kind === 'stuck') {
      const since = Date.parse((P.stageSince && P.stageSince[f.id]) || f.updatedAt);
      return { pct: 0, time: F.dur(Date.now() - since), tries: 'try ' + f.attempts + '/' + maxTries() };
    }
    if (kind === 'ready') return { pct: 100, time: 'ready to merge', tries: '' };
    const ts = (P.tasks || []).filter((t) => (t.unblocks || []).includes(f.id));
    const open = ts.find((t) => t.status !== 'done');
    return { pct: ts.length ? Math.round(100 * ts.filter((t) => t.status === 'done').length / ts.length) : 0,
      time: 'waiting ' + F.dur(Date.now() - Date.parse(f.updatedAt)).split(' ')[0], tries: open ? open.id : '' };
  }

  function assignSlots(n) {
    const P = F.P, inflight = P.features.filter((f) => F.STAGE[f.status]);
    const stuck = P.features.filter((f) => f.status === 'stuck');
    const you = needsYouIds().map(F.byId);
    const chosen = [];
    const flight = new Map(inflight.map((f) => [f.id, 'run']));
    for (const f of inflight) chosen.push([f, 'run']);
    // Free lanes: stuck first, then needs-you.
    const room = Math.max(0, n - inflight.length);
    for (const f of stuck.slice(0, room)) chosen.push([f, 'stuck']);
    const room2 = Math.max(0, room - Math.min(room, stuck.length));
    for (const f of you.filter((f) => !flight.has(f.id) && f.status !== 'stuck').slice(0, room2)) chosen.push([f, f.status === 'ready' ? 'ready' : 'you']);
    const keep = new Set(chosen.map(([f]) => f.id));
    for (const id of [...bayOf.keys()]) if (!keep.has(id) || bayOf.get(id) >= n) bayOf.delete(id);
    const used = new Set(bayOf.values());
    for (const [f] of chosen) if (!bayOf.has(f.id)) { let i = 0; while (used.has(i)) i++; bayOf.set(f.id, i); used.add(i); }
    return chosen;
  }

  function variantOf(f, kind, i) {
    if (kind === 'run') return f.status === 'building' ? 'build' + (i % 3 + 1) : f.status === 'testing' ? 'eval' : 'merge';
    return kind === 'stuck' ? 'stuck' : 'you';
  }

  function bayHTML(i, v, f, kind, off) {
    const s = ST[v], num = '0' + (i + 1);
    const chip = '<div class="fx-chip pix" style="color:' + s.color + '"><i></i>' + (off ? 'OFF' : s.status) + '</div>';
    let head = '<div class="fx-alarm' + (s.glow ? ' on' : '') + '"></div><span class="fx-num pix">' + num + '</span>' + chip;
    if (!f) {
      return '<div class="fx-bay bay-idle" style="--glow:transparent">' + head +
        (off ? '' : '<div class="fx-idle1">Ready for work</div><div class="fx-idle2">Picks up the next queued feature</div>') + '</div>';
    }
    const meta = F.shortId(f.id) + (f.issue ? ' · #' + f.issue : '');
    const timeColor = kind === 'stuck' ? '#ff6b6b' : kind === 'you' || kind === 'ready' ? '#f5b73b' : '#c3cdda';
    const sprites = MOVES[v].map(([a, x, y, w, h]) =>
      '<div class="spr bay-' + v + ' ' + a + '" style="left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;background-position:-' + x + 'px -' + y + 'px"></div>').join('');
    return '<a class="fx-bay bay-' + v + '" href="' + esc(F.featureHref(f.id)) + '" title="' + esc(f.id + ' — ' + f.title) + '" data-fid="' + esc(f.id) + '" data-kind="' + kind +
      '" style="--glow:' + (s.glow || 'transparent') + '">' + head +
      '<div class="fx-info"><span class="fx-name">' + esc(F.title(f)) + '</span><span class="fx-meta mono">' + esc(meta) + '</span></div>' + sprites +
      '<div class="fx-prog"><div class="t"><i data-bar style="background:' + s.bar + '"></i></div><span class="p mono" data-pct></span></div>' +
      '<div class="fx-time" style="color:' + timeColor + '"><span class="ic">' + CLOCK + '</span><span class="tm" data-time></span><span class="sp"></span><span class="tr mono" data-tries></span></div></a>';
  }

  function tick() {
    if (!built || !F.P) return;
    for (const a of els.floor.querySelectorAll('[data-fid]')) {
      const f = F.byId(a.dataset.fid);
      if (!f) continue;
      const v = volatile(f, a.dataset.kind);
      a.querySelector('[data-bar]').style.width = v.pct + '%';
      a.querySelector('[data-pct]').textContent = v.pct + '%';
      const tm = a.querySelector('[data-time]'), late = v.time === 'running late';
      tm.textContent = v.time; tm.parentNode.classList.toggle('late', late);
      a.querySelector('[data-tries]').textContent = v.tries;
    }
  }

  // ---------- sections ----------
  function renderKpis() {
    const P = F.P, fs = P.features, now = Date.now(), st = P.stats, ts = stamps();
    const merged = fs.filter((f) => f.status === 'merged').length, paused = fs.filter((f) => f.status === 'paused').length;
    const stuck = fs.filter((f) => f.status === 'stuck').length;
    const G = '#3ddc7a', M = '#93a1b5', A = '#f5b73b', R = '#ff7b7b';
    let tp = '—', tpSub = '—', tpCol = M, today = '—', costV = '—', costSub = '—', costCol = M;
    if (st) {
      const a = ts.filter((t) => now - t <= DAY).length, b = ts.filter((t) => now - t > DAY && now - t <= 2 * DAY).length;
      tp = +(a / 24).toFixed(1) + ' / hour';
      const d = (a - b) / 24;
      tpSub = Math.abs(d) < 0.05 ? 'same as yesterday' : signed(d, 1) + ' vs yesterday';
      tpCol = Math.abs(d) < 0.05 ? M : d > 0 ? G : R;
      today = '+' + ts.filter((t) => t >= startOfToday()).length + ' today';
      costV = F.money(st.costToday);
      if (st.costYesterday > 0) {
        const p = Math.round(100 * (st.costToday - st.costYesterday) / st.costYesterday);
        costSub = (p === 0 ? 'same' : signed(p, 0) + '%') + ' vs yesterday'; costCol = p <= 0 ? G : A;
      } else costSub = 'no spend yesterday';
    }
    const k = [['total', 'TOTAL WORK', fs.length, merged + ' merged · ' + paused + ' paused', M],
      ['throughput', 'THROUGHPUT', tp, tpSub, tpCol],
      ['stuck', 'STUCK', stuck, 'hit the retry limit', M],
      ['you', 'NEEDS YOU', F.youCount(), 'holding up ' + F.heldByYou(P) + ' features', A],
      ['shipped', 'SHIPPED', merged, today, st ? G : M],
      ['cost', 'COST (TODAY)', costV, costSub, costCol]];
    setHTML(els.kpis, k.map(([ic, l, v, s, c]) => '<div class="panel fx-kpi"><img src="/assets/kpi-' + ic + '.png" alt=""><div><span class="l">' + l +
      '</span><span class="v">' + esc(v) + '</span><span class="s" style="color:' + c + '">' + esc(s) + '</span></div></div>').join(''));
  }

  function renderFloor() {
    const P = F.P, lanes = Math.max(1, Math.min(8, F.lanesAllowed() || 1));
    const inflight = P.features.filter((f) => F.STAGE[f.status]).length;
    const n = Math.min(8, Math.max(lanes, inflight));
    const chosen = assignSlots(n), at = new Map([...bayOf].map(([id, i]) => [i, id]));
    const kinds = new Map(chosen.map(([f, k]) => [f.id, k]));
    for (let i = 0; i < 8; i++) {
      const id = at.get(i), f = id && F.byId(id), kind = f && kinds.get(id);
      const v = f ? variantOf(f, kind, i) : 'idle';
      setHTML(els.slots[i], bayHTML(i, v, f, kind, i >= n));
      els.slots[i].classList.toggle('off', i >= n);
    }
    setHTML(els.sign, n + ' LANES  ·  ' + inflight + ' BUSY  ·  ' + needsYouIds().length + ' NEEDS YOU');
  }

  // Paused (or lanes 0): say so above everything, with the way back.
  function renderPaused() {
    const c = F.P.control, n = F.P.inFlight || 0, held = c && (c.paused || c.effective === 0);
    els.paused.classList.toggle('on', !!(held || (c && c.invalid)));
    if (c && c.invalid) return F.setHTML(els.paused, '<span class="ic warn" aria-hidden="true">!</span><span class="tx"><b>Invalid control file,</b> ' + esc(c.invalid) +
      '. The foreman keeps its last good setting, or holds all new work if it started with this file.</span><button class="btn" type="button" data-control="pause">Rewrite it as paused</button>');
    F.setHTML(els.paused, !held ? '' : '<span class="ic" aria-hidden="true"></span><span class="tx"><b>' + (c.paused ? 'Paused' : 'Lanes set to 0') +
      ':</b> no new features start. ' + (n ? n + ' still running will finish.' : 'Nothing is running.') + '</span>' +
      (c.paused ? '<button class="btn primary" type="button" data-control="resume">Resume</button>'
        : '<button class="btn" type="button" data-control="default">Use the default ' + c.configMax + ' lanes</button>'));
  }

  function renderEvents() {
    const P = F.P;
    const list = P.events.filter((e) => EVI[e.event]).slice().sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 6);
    const what = (e) => ({ launch: 'build started', testing: 'tests running', evaluating: 'evaluation started', failed: 'try failed', stuck: 'stuck after ' + maxTries() + ' tries',
      merged: 'merged into main', lesson: 'lesson recorded', refreshed: 'branch refreshed from main', paused: 'paused', resumed: 'resumed' })[e.event];
    setHTML(els.events, list.map((e) => {
      const f = F.byId(e.feature), nm = f ? F.title(f) : e.feature || '';
      return '<div class="fx-ev"><span class="t mono">' + esc(F.clock(e.ts)) + '</span><img src="/assets/ev-' + EVI[e.event] + '.png" alt="">' +
        '<span class="n">' + (f ? '<a href="' + esc(F.featureHref(f.id)) + '" title="' + esc(f.id) + '">' + esc(nm) + '</a>' : esc(nm)) + '</span><span class="w">' + esc(what(e)) + '</span></div>';
    }).join('') || '<div class="fx-empty">Nothing has happened yet.</div>');
  }

  function renderQueue() {
    const P = F.P, q = P.ready.map(F.byId).filter(Boolean);
    els.qn.textContent = P.ready.length + ' queued';
    setHTML(els.queue, q.slice(0, 3).map((f) => {
      const p = f.priority, lab = p <= 1 ? ['High', '#ff7b7b'] : p <= 3 ? ['Medium', '#f5b73b'] : ['Low', '#72b4ff'];
      return '<a class="fx-q" href="' + esc(F.featureHref(f.id)) + '"><img src="/assets/q-doc.png" alt=""><span><span class="n">' + esc(F.title(f)) +
        '</span><span class="m mono">' + esc(F.shortId(f.id) + (f.issue ? ' · #' + f.issue : '')) + '</span></span><span class="pr" style="color:' + lab[1] + '">' + lab[0] + '</span></a>';
    }).join('') || '<div class="fx-empty">Nothing queued.</div>');
  }

  function renderOutput() {
    const ts = stamps(), now = Date.now(), t0 = startOfToday();
    const today = ts.filter((t) => t >= t0).length, yest = ts.filter((t) => t >= t0 - DAY && t < t0).length;
    const bins = Array(12).fill(0);
    for (const t of ts) { const age = now - t; if (age >= 0 && age < DAY) bins[11 - Math.floor(age / (2 * HOUR))]++; }
    const mx = Math.max(1, ...bins);
    const bars = bins.map((n, i) => '<i style="height:' + (6 + Math.round(64 * n / mx)) + 'px;background:' + (i >= 10 ? '#3ddc7a' : '#1f8f4c') + '"></i>').join('');
    const d = today - yest, vs = d === 0 ? 'same as yesterday' : signed(d, 0) + ' vs yesterday';
    setHTML(els.output, '<div class="fx-out"><div><div class="big"><b>' + (F.P.stats ? today : '—') + '</b><span>merged</span></div><div class="fx-bars">' + bars +
      '</div><div class="fx-axis mono"><span>−24h</span><span>−16h</span><span>−8h</span><span>now</span></div></div><img src="/assets/mascot.png" alt="Keep shipping"></div>' +
      '<span class="fx-vs" style="color:' + (d < 0 ? '#ff7b7b' : d === 0 ? '#93a1b5' : '#3ddc7a') + '">' + (F.P.stats ? vs : '') + '</span>');
  }

  function renderActions() {
    const stuck = F.P.features.filter((f) => f.status === 'stuck').length, you = F.youCount();
    setHTML(els.actions, '<a class="fx-btn pri" href="#you">Open Only you <span class="mono">' + you + ' waiting</span></a>' +
      (stuck ? '<button class="fx-btn" data-retry>Retry ' + stuck + ' stuck</button>' : '') +
      '<a class="fx-btn" href="#board">Open board</a><a class="fx-btn" href="#project">Project view</a>');
  }

  function render() {
    if (!built) skeleton();
    const P = F.P;
    if (P.path !== projectKey) { projectKey = P.path; bayOf.clear(); }
    renderPaused(); renderKpis(); renderFloor(); renderEvents(); renderQueue(); renderOutput(); renderActions();
    fit(); tick();
  }

  F.view('factory', { render, tick });
})();
