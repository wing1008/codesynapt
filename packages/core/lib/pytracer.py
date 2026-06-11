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
    root = os.path.abspath(root)
    root_norm = root.replace("\\", "/").rstrip("/") + "/"

    if len(sys.argv) < 2:
        sys.stderr.write("pytracer: missing target script\n")
        sys.exit(2)
    target = sys.argv[1]
    # The traced program must see its own argv, not ours.
    sys.argv = sys.argv[1:]

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
        f = filename if os.path.isabs(filename) else os.path.abspath(filename)
        f = f.replace("\\", "/")
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
    try:
        sys.setprofile(profiler)
        try:
            runpy.run_path(target, run_name="__main__")
        finally:
            sys.setprofile(None)
    except SystemExit:
        raise
    except BaseException:
        # The traced program crashed — still flush what was observed (runtime
        # truth up to the crash is valid data), then re-raise for the exit code.
        _flush(out_path, pairs, this_file)
        raise
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
