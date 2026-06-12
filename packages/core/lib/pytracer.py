# CodeSynapt Python runtime tracer (roadmap leg 5, v1).
#
# Invoked by `cs trace run -- python <script> [args...]` as:
#   python pytracer.py <script> [args...]
# with env:
#   CS_PYTRACE_OUT  — file to write observed caller→callee frame pairs (JSONL)
#   CS_PYTRACE_ROOT — project root; only frames under it are recorded
#
# Records caller→callee pairs via sys.setprofile 'call' events (works on every
# supported CPython; sys.monitoring is a later optimization). Lines are chosen
# to land INSIDE the corresponding symbol ranges of the Layer-2 graph:
#   caller line = call-site line (f_back.f_lineno)
#   callee line = function def line (f_code.co_firstlineno)
# Pairs are deduped in-process; the Node CLI posts them to /symbol/observe —
# the SAME classification/merge pipeline the V8 tracer feeds.

import json
import os
import runpy
import sys


def _main():
    out_path = os.environ.get("CS_PYTRACE_OUT")
    root = os.environ.get("CS_PYTRACE_ROOT") or os.getcwd()
    # realpath, not abspath: on macOS the temp/cwd lives under /var which is a
    # symlink to /private/var, and the import system reports module __file__ as
    # the resolved /private/var path. Comparing an abspath root against realpath
    # frame paths dropped those frames (e.g. `-m module` sibling imports). Both
    # sides go through realpath so the prefix test matches.
    root = os.path.realpath(root)
    root_norm = root.replace("\\", "/").rstrip("/") + "/"

    if len(sys.argv) < 2:
        sys.stderr.write("pytracer: missing target script\n")
        sys.exit(2)

    # Resolve how to launch the traced program. Mirrors `python <arg>`:
    #   path     — `python app.py`        -> runpy.run_path
    #   module   — `python -m pkg`        -> runpy.run_module
    # Other interpreter flags (-c, -O, …) aren't representable under tracing, so
    # fail loudly instead of treating the flag as a script path (insp-004: `-m`
    # and bare flags were silently mis-handled as a missing file).
    run_kind = "path"
    target = sys.argv[1]
    if target == "-m":
        if len(sys.argv) < 3:
            sys.stderr.write("pytracer: -m requires a module name\n")
            sys.exit(2)
        run_kind = "module"
        target = sys.argv[2]
        # The traced module sees argv starting at the module name.
        sys.argv = sys.argv[2:]
    elif target.startswith("-"):
        sys.stderr.write(
            "pytracer: unsupported python option '%s' under tracing - pass a script path or '-m module'\n" % target
        )
        sys.exit(2)
    else:
        # The traced program must see its own argv, not ours.
        sys.argv = sys.argv[1:]

    # `python app.py` puts the script's directory on sys.path[0]; runpy does not,
    # so sibling imports (import helper) raise ModuleNotFoundError under tracing
    # even though the program runs fine standalone (insp-004). Replicate it.
    if run_kind == "path":
        script_dir = os.path.dirname(os.path.abspath(target))
        if script_dir and script_dir not in sys.path:
            sys.path.insert(0, script_dir)
    else:
        # `python -m pkg` resolves packages from cwd; make sure it's importable.
        if "" not in sys.path and os.getcwd() not in sys.path:
            sys.path.insert(0, os.getcwd())

    pairs = set()
    rel_cache = {}

    def rel_of(filename):
        r = rel_cache.get(filename)
        if r is not None:
            return r or None
        # '<frozen runpy>', '<string>' … — synthetic frames, never project files.
        if filename.startswith("<"):
            rel_cache[filename] = ""
            return None
        # runpy/import can yield RELATIVE co_filename (e.g. the script passed as
        # 'app.py') — resolve against cwd or everything gets filtered out.
        # realpath to match root (symlinked /var -> /private/var on macOS).
        f = filename if os.path.isabs(filename) else os.path.abspath(filename)
        f = os.path.realpath(f).replace("\\", "/")
        if not f.startswith(root_norm) or "/site-packages/" in f or "/node_modules/" in f:
            rel_cache[filename] = ""
            return None
        rel = f[len(root_norm):]
        rel_cache[filename] = rel
        return rel

    def profiler(frame, event, arg):
        if event != "call":
            return
        code = frame.f_code
        ef = rel_of(code.co_filename)
        if ef is None:
            return
        back = frame.f_back
        if back is None:
            return
        cf = rel_of(back.f_code.co_filename)
        if cf is None:
            return
        pairs.add((cf, back.f_lineno, ef, code.co_firstlineno))

    this_file = os.path.abspath(__file__)
    # Flush in finally so the observed edges survive EVERY exit path: normal
    # return, a crashing program (re-raised for the exit code), AND sys.exit() —
    # the common `sys.exit(main())` / argparse path that previously discarded
    # all runtime truth before it could be written (insp-004).
    try:
        sys.setprofile(profiler)
        try:
            if run_kind == "module":
                runpy.run_module(target, run_name="__main__", alter_sys=True)
            else:
                runpy.run_path(target, run_name="__main__")
        finally:
            sys.setprofile(None)
    finally:
        _flush(out_path, pairs, this_file)


def _flush(out_path, pairs, this_file):
    if not out_path:
        return
    try:
        with open(out_path, "w", encoding="utf-8") as fh:
            for cf, cl, ef, el in pairs:
                # Never report the tracer's own bootstrap frames.
                if this_file.replace("\\", "/").endswith(cf):
                    continue
                fh.write(json.dumps({"cf": cf, "cl": cl, "ef": ef, "el": el}) + "\n")
    except OSError:
        pass


if __name__ == "__main__":
    _main()
