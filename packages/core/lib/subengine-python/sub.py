import ast, json, sys, os
import jedi

root = os.path.abspath(sys.argv[1]).replace('\\', '/').rstrip('/')
project = jedi.Project(root)
SKIP = {'node_modules', '.git', '.venv', 'venv', '__pycache__', 'build', 'dist'}

def rel(p):
    p = (p or '').replace('\\', '/')
    return p[len(root) + 1:] if p.startswith(root + '/') else None

out = []
for dp, dirs, files in os.walk(root):
    dirs[:] = [d for d in dirs if d not in SKIP]
    for fn in files:
        if not fn.endswith('.py'):
            continue
        fpath = os.path.join(dp, fn)
        rfile = rel(fpath.replace('\\', '/'))
        if rfile is None:
            continue
        try:
            src = open(fpath, encoding='utf-8').read()
            tree = ast.parse(src)
        except Exception:
            continue
        script = jedi.Script(src, path=fpath, project=project)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            f = node.func
            if isinstance(f, ast.Name):
                line, col = f.lineno, f.col_offset
            elif isinstance(f, ast.Attribute):
                if f.end_col_offset is None:
                    continue
                line, col = f.end_lineno, f.end_col_offset - len(f.attr)
            else:
                continue
            try:
                defs = script.goto(line, col, follow_imports=True, follow_builtin_imports=False)
            except Exception:
                continue
            for d in defs:
                if d.type not in ('function', 'class'):
                    continue
                dpath = rel(str(d.module_path).replace('\\', '/') if d.module_path else '')
                if dpath is None:
                    continue
                out.append('{"callerFile":%s,"callLine":%d,"declName":%s,"declFile":%s,"declLine":%d}' % (
                    json.dumps(rfile), node.lineno, json.dumps(d.name), json.dumps(dpath), d.line or 0))
                break  # first project definition
sys.stdout.write('\n'.join(out))
