/* Python runner: Pyodide inside a Web Worker. Messages in: init, run, sql. Out: ready, status, started, result */
var py = null, loadedPkgs = {}, BASE = '';
function post(m) { self.postMessage(m); }
var HELPER = [
"import sys, io, os, json, builtins, shutil, traceback, sqlite3",
"def __prep(files, argv, stdin_text, echo):",
"    d = '/tmp/run'",
"    shutil.rmtree(d, ignore_errors=True)",
"    os.makedirs(d, exist_ok=True)",
"    os.chdir(d)",
"    for k, v in files.items():",
"        with open(k, 'w', encoding='utf8', newline='') as f: f.write(v)",
"    sys.argv = ['main.py'] + list(argv)",
"    lines = stdin_text.split('\\n') if stdin_text else []",
"    if lines and lines[-1] == '': lines.pop()",
"    state = {'i': 0}",
"    def _input(prompt=''):",
"        if echo: sys.stdout.write(str(prompt))",
"        if state['i'] >= len(lines): raise EOFError('EOF when reading a line')",
"        v = lines[state['i']]; state['i'] += 1",
"        return v",
"    builtins.input = _input",
"class __Stdin:",
"    def __init__(self, text): self.t = io.StringIO(text or '')",
"    def read(self, *a): return self.t.read(*a)",
"    def readline(self, *a): return self.t.readline(*a)",
"    def readlines(self): return self.t.readlines()",
"    def __iter__(self): return iter(self.t)",
"def __run(code, files, argv, stdin_text, echo):",
"    out = io.StringIO(); err = io.StringIO()",
"    so, se, si = sys.stdout, sys.stderr, sys.stdin",
"    sys.stdout = out; sys.stderr = err",
"    try:",
"        __prep(files, argv, stdin_text, echo)",
"        sys.stdin = __Stdin(stdin_text)",
"        g = {'__name__': '__main__', '__builtins__': builtins}",
"        try:",
"            exec(compile(code, 'main.py', 'exec'), g)",
"        except SystemExit:",
"            pass",
"        except BaseException:",
"            etype, ev, tb = sys.exc_info()",
"            lines = traceback.format_exception(etype, ev, tb)",
"            keep = [l for l in lines if not ('File \\\"<exec>\\\"' in l or 'File \\\"/lib/python' in l)]",
"            err.write(''.join(keep))",
"    finally:",
"        sys.stdout, sys.stderr, sys.stdin = so, se, si",
"    return json.dumps({'out': out.getvalue(), 'err': err.getvalue()})",
"def __split(sql):",
"    out = []; cur = ''",
"    for line in sql.split('\\n'):",
"        cur += line + '\\n'",
"        if sqlite3.complete_statement(cur):",
"            out.append(cur); cur = ''",
"    rest = '\\n'.join(l for l in cur.split('\\n') if l.strip() and not l.strip().startswith('--')).strip()",
"    if rest: out.append(cur)",
"    return out",
"def __sql(setup, query, check):",
"    con = sqlite3.connect(':memory:')",
"    try:",
"        con.executescript(setup)",
"        last = None",
"        for st in __split(query):",
"            cur = con.execute(st)",
"            if cur.description:",
"                last = ([d[0] for d in cur.description], [list(r) for r in cur.fetchall()])",
"        if check:",
"            cur = con.execute(check)",
"            last = ([d[0] for d in cur.description], [list(r) for r in cur.fetchall()])",
"        if last is None: return json.dumps({'cols': [], 'rows': [], 'none': True})",
"        return json.dumps({'cols': last[0], 'rows': last[1]})",
"    except Exception as e:",
"        return json.dumps({'error': type(e).__name__ + ': ' + str(e)})",
"    finally:",
"        con.close()"
].join('\n');

async function init(cfg) {
  var bases = cfg.bases, lastErr = null;
  for (var i = 0; i < bases.length; i++) {
    try {
      importScripts(bases[i] + 'pyodide.js');
      py = await loadPyodide({ indexURL: bases[i] });
      BASE = bases[i];
      break;
    } catch (e) { lastErr = e; py = null; }
  }
  if (!py) { post({ type: 'initfail', error: String(lastErr && lastErr.message || lastErr) }); return; }
  await py.loadPackage('sqlite3');
  await py.runPythonAsync(HELPER);
  post({ type: 'ready', base: BASE, version: py.version });
}

async function ensurePkgs(list, id) {
  var need = (list || []).filter(function (p) { return !loadedPkgs[p]; });
  if (!need.length) return;
  post({ type: 'status', id: id, text: 'Loading ' + need.join(' + ') + ' (first time only, may take a minute)...' });
  await py.loadPackage(need);
  need.forEach(function (p) { loadedPkgs[p] = 1; });
}

self.onmessage = async function (ev) {
  var m = ev.data;
  try {
    if (m.type === 'init') { await init(m); return; }
    if (!py) { post({ type: 'result', id: m.id, error: 'Runner not ready' }); return; }
    if (m.type === 'run') {
      await ensurePkgs(m.pkgs, m.id);
      post({ type: 'started', id: m.id });
      var fn = py.globals.get('__run'), r;
      var pf = py.toPy(m.files || {}), pa = py.toPy(m.args || []);
      try { r = JSON.parse(fn(m.code, pf, pa, m.stdin || '', !!m.echo)); }
      finally { fn.destroy(); pf.destroy(); pa.destroy(); }
      post({ type: 'result', id: m.id, stdout: r.out, stderr: r.err });
    } else if (m.type === 'sql') {
      post({ type: 'started', id: m.id });
      var f2 = py.globals.get('__sql');
      var res;
      try { res = f2(m.setup, m.query, m.check || ''); } finally { f2.destroy(); }
      post({ type: 'result', id: m.id, sql: JSON.parse(res) });
    }
  } catch (e) {
    post({ type: 'result', id: m.id, stderr: String(e && e.message || e), crash: true });
  }
};
