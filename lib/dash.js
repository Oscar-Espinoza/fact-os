// Dashboard: one page across every project under --root, bound to 127.0.0.1.
import { createServer } from 'node:http';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { paths, load, mutate, log, tailLines } from './state.js';
import { analyze, taskReach } from './ready.js';

const tryJson = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
const isWorktree = (dir) => { try { return statSync(join(dir, '.git')).isFile(); } catch { return false; } };

export function discover(root, maxDepth = 3) {
  const found = [];
  const walk = (dir, depth) => {
    if (existsSync(join(dir, '.shipyard/features.json')) && !isWorktree(dir)) found.push(dir);
    if (depth >= maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(join(dir, e.name), depth + 1);
  };
  walk(resolve(root), 0);
  return found.sort();
}

function projectState(dir) {
  try {
    const { config, features, tasks } = load(dir);
    const a = analyze(features, tasks, config.merge);
    return { path: dir, name: basename(dir), merge: config.merge, branchPrefix: config.branchPrefix, features, tasks,
      ready: a.ready, waiting: a.waiting, activity: tailLines(paths(dir).activity, 20).map(tryJson).filter(Boolean) };
  } catch (e) {
    return { path: dir, name: basename(dir), error: e.message, features: [], tasks: [], ready: [], waiting: [], activity: [] };
  }
}

export function state(root) {
  const projects = discover(root).map(projectState);
  const human = projects.flatMap((p) => p.tasks.filter((t) => t.status === 'open')
    .map((t) => ({ ...t, project: p.path, projectName: p.name, reach: taskReach(t, p.features) })))
    .sort((a, b) => b.reach - a.reach || a.id.localeCompare(b.id));
  return { projects, human };
}

export function startDash({ root = process.cwd(), port = 7420 } = {}) {
  root = resolve(root);
  const server = createServer(async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      const p = server.address().port;
      const hosts = [`127.0.0.1:${p}`, `localhost:${p}`];
      if (req.headers.origin && !hosts.map((h) => `http://${h}`).includes(req.headers.origin)) return send(403, { error: 'foreign origin' });
      if (!hosts.includes(req.headers.host)) return send(403, { error: 'unexpected host' }); // DNS rebinding
      if (req.method === 'GET' && req.url === '/') return send(200, PAGE, 'text/html; charset=utf-8');
      if (req.method === 'GET' && req.url === '/api/state') return send(200, state(root));
      if (req.method !== 'POST' || !['/api/human/done', '/api/feature/merged'].includes(req.url)) return send(404, { error: 'not found' });
      let body = '';
      for await (const c of req) { body += c; if (body.length > 10000) return send(413, { error: 'body too large' }); }
      const { project, id } = tryJson(body) || {};
      if (typeof project !== 'string' || !discover(root).includes(project)) return send(400, { error: 'unknown project' });
      if (typeof id !== 'string') return send(400, { error: 'id must be a string' });
      if (req.url === '/api/human/done') {
        const code = await mutate(project, 'human', (d) => {
          const t = d.tasks.find((x) => x.id === id);
          if (!t) return 404;
          if (t.status !== 'done') Object.assign(t, { status: 'done', doneAt: new Date().toISOString() });
          return 200;
        });
        if (code === 200) log(project, null, 'human-done', id);
        return send(code, code === 200 ? { ok: true } : { error: `unknown human task ${id}` });
      }
      if (load(project).config.merge !== 'manual') return send(409, { error: 'this project merges automatically' });
      const code = await mutate(project, 'features', (d) => {
        const f = d.features.find((x) => x.id === id);
        if (!f) return 404;
        if (f.status !== 'ready') return 409;
        Object.assign(f, { status: 'merged', updatedAt: new Date().toISOString() });
        return 200;
      });
      if (code === 200) log(project, id, 'merged', 'marked merged from the dashboard');
      return send(code, code === 200 ? { ok: true } : { error: code === 404 ? `unknown feature ${id}` : `${id} is not ready` });
    } catch (e) {
      send(500, { error: e.message });
    }
  });
  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(port, '127.0.0.1', () => res({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shipyard</title><style>
:root{--bg:#f7f7f4;--fg:#1c1c1a;--muted:#6b6b66;--card:#fff;--line:#e2e1da;--accent:#2f5dd0;--ok:#2e7d4f;--warn:#a86400;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#9a9993;--card:#1d1d1b;--line:#34332f;--accent:#8aa8ff;--ok:#6cc58f;--warn:#e0a34a;--bad:#f08079}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
header{display:flex;gap:8px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
h1{font-size:16px;margin:0 12px 0 0}h2{font-size:15px;margin:0 0 8px}
h3{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:10px 0 4px}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;padding:4px 10px;cursor:pointer}
button.on{border-color:var(--accent);color:var(--accent)}
main{padding:16px;max-width:1100px;margin:auto}
section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin-bottom:16px}
.f{display:inline-block;border:1px solid var(--line);border-radius:6px;padding:2px 8px;margin:2px}
.b{font-size:11px;color:var(--warn);margin-left:6px}.muted{color:var(--muted);font-weight:normal}
.merged{color:var(--ok)}.stuck{color:var(--bad)}ol{margin:4px 0 10px 20px;padding:0}
pre{font:12px ui-monospace,monospace;color:var(--muted);white-space:pre-wrap;margin:4px 0 0;max-height:240px;overflow:auto}
</style></head><body>
<header><h1>Shipyard</h1><button id="t-agents" class="on">Agents</button><button id="t-you">Only you <span id="n"></span></button>
<span id="err" class="muted"></span></header><main id="main"></main>
<script>
const ORDER=['building','testing','evaluating','todo','ready','stuck','merged'];let view='agents',S=null;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
async function load(){try{S=await(await fetch('/api/state')).json();err.textContent='';render()}catch(e){err.textContent='offline'}}
async function post(u,project,id){const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project,id})});
 if(!r.ok)alert((await r.json()).error);load()}
function agents(){return S.projects.map(p=>{const g={};for(const f of p.features)(g[f.status]??=[]).push(f);
 return '<section><h2>'+esc(p.name)+' <span class="muted">'+esc(p.path)+' · merge '+esc(p.merge)+(p.error?' · '+esc(p.error):'')+'</span></h2>'+
 ORDER.filter(s=>g[s]).map(s=>'<h3>'+s+' ('+g[s].length+')</h3>'+g[s].map(f=>'<span class="f '+s+'" title="'+esc(f.lastFeedback||f.title)+'">'+esc(f.id)+
 (f.onMock?'<span class="b">onMock</span>':'')+(p.waiting.includes(f.id)?'<span class="b">waiting on you</span>':'')+
 (f.attempts?' <span class="muted">×'+f.attempts+'</span>':'')+'</span>').join('')).join('')+
 '<h3>activity</h3><pre>'+(esc(p.activity.map(a=>String(a.ts).slice(11,19)+' '+(a.feature||'-')+' '+a.summary).join('\\n'))||'none')+'</pre></section>'}).join('')
 ||'<p class="muted">No projects with .shipyard/features.json under this root.</p>'}
function you(){const t=S.human.map(h=>'<section><h2>'+esc(h.title)+' <span class="muted">'+esc(h.projectName)+' · unblocks '+h.reach+'</span></h2><ol>'+
 (h.steps||[]).map(s=>'<li>'+esc(s)+'</li>').join('')+'</ol><button data-u="/api/human/done" data-p="'+esc(h.project)+'" data-i="'+esc(h.id)+'">I did my part</button></section>');
 const r=S.projects.filter(p=>p.merge==='manual').flatMap(p=>p.features.filter(f=>f.status==='ready').map(f=>'<section><h2>Review and merge '+esc(f.id)+
 ' <span class="muted">'+esc(p.name)+' · '+esc(f.branch||p.branchPrefix+f.id)+'</span></h2><p>'+esc(f.title)+'</p><button data-u="/api/feature/merged" data-p="'+
 esc(p.path)+'" data-i="'+esc(f.id)+'">Mark done</button></section>'));
 n.textContent=t.length+r.length?'('+(t.length+r.length)+')':'';return [...t,...r].join('')||'<p class="muted">Nothing needs you right now.</p>'}
function render(){const y=you();main.innerHTML=view==='agents'?agents():y}
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.u)return post(b.dataset.u,b.dataset.p,b.dataset.i);
 view=b.id==='t-you'?'you':'agents';document.querySelectorAll('header button').forEach(x=>x.classList.toggle('on',x===b));render()});
load();setInterval(load,2000);
</script></body></html>`;
