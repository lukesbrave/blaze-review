# Blaze Review helper. build.mjs embeds this file in plugin.js; the plugin starts it as
# `python3 -I -c <this source> <Working files folder>` through its one declared host process.
#
# - Requests arrive one JSON object per line on stdin; each gets one JSON line on stdout.
# - Jobs are the HyperFrames projects (folders with hyperframes.json) under Working files.
# - Each job is reviewed on a separate local copy in ~/Library/Caches/BlazeReview.
#   Copies work across filesystems; source projects are preserved.
# - Studio runs as this process's child (`hyperframes preview --foreground`) on 127.0.0.1. npx,
#   node and Studio's headless Chrome (its own process group) are stopped as one tree: on stop, on
#   a job switch, when Buzz unloads the plugin (SIGTERM), and at start for any left by a crash.
#   Its log goes beside the copies.
# - The only file written in a real project is review-notes.json, the log of sent notes.
# - Runs on the macOS system Python (3.9) as well as Homebrew's.
import hashlib
import tempfile
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request

ROOT = os.path.realpath(os.path.expanduser(sys.argv[1])) if len(sys.argv) > 1 and sys.argv[1] else ""
STUDIO = json.loads(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else ["npx", "-y", "hyperframes@0.8.188", "preview"]
def cache_for(root):
    return os.path.join(os.path.expanduser("~/Library/Caches/BlazeReview"), hashlib.sha256(root.encode()).hexdigest()[:20])

CACHE = cache_for(ROOT)
MARKER = ".blaze-review-copy"
LEAVE_OUT = ("renders", "snapshots", ".hyperframes", "node_modules")
NOTES = "review-notes.json"
MAX_NOTES_BYTES = 4 << 20
_out = threading.Lock()
studio = {"job": None, "process": None, "port": None, "tree": set()}


def say(message):
    # ASCII-only JSON, so the pipe's encoding never matters.
    line = json.dumps(message, ensure_ascii=True) + "\n"
    with _out:
        sys.stdout.write(line)
        sys.stdout.flush()


def connected():
    return bool(ROOT) and os.path.isdir(ROOT)


def need_drive():
    if not connected():
        raise LookupError("The project folder is unavailable. Connect the drive or download the cloud folder locally.")


def inside(relative):
    """The real path of `relative` under ROOT; refuses anything that leaves it."""
    if not isinstance(relative, str) or not relative or "\0" in relative:
        raise ValueError("Not a job")
    path = os.path.realpath(os.path.join(ROOT, relative.strip("/")))
    if path != ROOT and not path.startswith(ROOT + os.sep):
        raise ValueError("Outside the Working files folder")
    return path


def label_of(relative):
    parts = relative.split("/")
    if len(parts) > 1 and parts[-1] == "hf":
        parts = parts[:-1]
    return parts[0] + (" · " + "/".join(parts[1:]) if len(parts) > 1 else "")


def slug_of(relative):
    return re.sub(r"[^a-z0-9]+", "-", label_of(relative).lower()).strip("-") or "job"


def discover():
    found = []
    for folder, dirs, files in os.walk(ROOT):
        depth = 0 if folder == ROOT else os.path.relpath(folder, ROOT).count(os.sep) + 1
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in LEAVE_OUT and depth < 4)
        if "hyperframes.json" in files and "index.html" in files:
            found.append(os.path.relpath(folder, ROOT))
            dirs[:] = []
    return sorted(found, key=lambda r: (label_of(r).count("·"), label_of(r).lower()))


def job_path(relative):
    path = inside(relative)
    if not os.path.isfile(os.path.join(path, "hyperframes.json")) or not os.path.isfile(os.path.join(path, "index.html")):
        raise LookupError("Not a HyperFrames project")
    return path


def copy_dir(relative):
    return os.path.join(CACHE, slug_of(relative))


def built_at(path):
    # A rebuild rewrites index.html and the compositions; newer than the copy means stale.
    stamps = [os.path.getmtime(os.path.join(path, "index.html"))]
    compositions = os.path.join(path, "compositions")
    if os.path.isdir(compositions):
        stamps += [os.path.getmtime(os.path.join(compositions, n)) for n in os.listdir(compositions) if n.endswith(".html")]
    return max(stamps)


def copy_info(relative):
    marker = os.path.join(copy_dir(relative), MARKER)
    if not os.path.isfile(marker):
        return None
    try:
        with open(marker, encoding="utf-8") as handle:
            info = json.load(handle)
    except (OSError, ValueError):
        return None
    info["stale"] = built_at(job_path(relative)) > info.get("builtAt", 0) + 0.5
    return info




def clone(source, destination):
    # Copy data rather than symlinks so Studio edits cannot reach original assets.
    # copy2 works on external and network filesystems as well as APFS.
    shutil.copytree(source, destination, symlinks=False,
                    ignore=shutil.ignore_patterns(*LEAVE_OUT, ".cache", ".git"))


def remove_copy(path):
    # Only ever a folder this helper made: under the cache, with its marker.
    real = os.path.realpath(path)
    if not real.startswith(os.path.realpath(CACHE) + os.sep) or not os.path.isfile(os.path.join(real, MARKER)):
        raise ValueError("Refusing to remove a folder that is not a review copy")
    shutil.rmtree(real)


def make_copy(relative):
    source = job_path(relative)
    destination = copy_dir(relative)
    os.makedirs(CACHE, exist_ok=True)
    if os.path.exists(destination):
        remove_copy(destination)
    built = built_at(source)
    temporary = tempfile.mkdtemp(prefix=".copy-", dir=CACHE)
    os.rmdir(temporary)
    try:
        clone(source, temporary)
        with open(os.path.join(temporary, MARKER), "w") as marker:
            marker.write("{}")
        os.rename(temporary, destination)
    except Exception:
        if os.path.isdir(temporary):
            shutil.rmtree(temporary)
        raise
    for name in LEAVE_OUT:
        extra = os.path.join(destination, name)
        if os.path.isdir(extra) and not os.path.islink(extra):
            shutil.rmtree(extra)
    info = {"source": source, "job": relative, "copiedAt": time.time(), "builtAt": built}
    with open(os.path.join(destination, MARKER), "w", encoding="utf-8") as handle:
        json.dump(info, handle)
    info["stale"] = False
    return info


def free_port():
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


def processes():
    """{pid: (ppid, command)} for every process, from ps."""
    listing = subprocess.run(["/bin/ps", "-A", "-o", "pid=,ppid=,command="], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
    table = {}
    for line in listing.stdout.decode("utf-8", "replace").splitlines():
        parts = line.split(None, 2)
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            table[int(parts[0])] = (int(parts[1]), parts[2] if len(parts) > 2 else "")
    return table


def descendants(roots, table):
    children = {}
    for pid, (parent, _command) in table.items():
        children.setdefault(parent, []).append(pid)
    found, queue = set(), list(roots)
    while queue:
        pid = queue.pop()
        if pid in found:
            continue
        found.add(pid)
        queue.extend(children.get(pid, []))
    return found


def ours(table):
    # Studio servers on a review copy: only this plugin starts those.
    return {pid for pid, (_parent, command) in table.items() if "hyperframes" in command and " preview " in command and CACHE in command}


def track():
    process = studio["process"]
    if process and process.poll() is None:
        studio["tree"] |= descendants([process.pid], processes())


def kill_tree(pids, process=None):
    pids = {pid for pid in pids if pid != os.getpid()}
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid in pids:
            try:
                os.kill(pid, sig)
            except (ProcessLookupError, PermissionError):
                pass
        deadline = time.time() + 4
        while pids and time.time() < deadline:
            if process:
                process.poll()
            alive = set()
            for pid in pids:
                try:
                    os.kill(pid, 0)
                    alive.add(pid)
                except (ProcessLookupError, PermissionError):
                    pass
            pids = alive
            time.sleep(0.1)
        if not pids:
            return


def stop_studio():
    process = studio["process"]
    tree = set(studio["tree"])
    studio.update(job=None, process=None, port=None, tree=set())
    table = processes()
    roots = ([process.pid] if process else []) + sorted(ours(table))
    kill_tree(tree | descendants(roots, table), process)
    if process:
        process.poll()


def project_listed(port, project):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/projects" % port, timeout=2) as response:
            return project in response.read().decode("utf-8", "replace")
    except (OSError, ValueError):
        return False


def start_studio(relative):
    if studio["job"] == relative and studio["process"] and studio["process"].poll() is None:
        return studio["port"]
    stop_studio()
    folder = copy_dir(relative)
    port = free_port()
    log = open(os.path.join(CACHE, slug_of(relative) + ".studio.log"), "ab")
    command = STUDIO + ["--foreground", "--no-open", "--force-new", "--port", str(port), folder]
    try:
        process = subprocess.Popen(command, cwd=folder, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
    except OSError as error:
        raise LookupError("Could not start HyperFrames Studio (%s). Is Node installed?" % error.strerror)
    finally:
        log.close()
    studio.update(job=relative, process=process, port=port)
    deadline = time.time() + 120
    while time.time() < deadline:
        if process.poll() is not None:
            stop_studio()
            raise LookupError("HyperFrames Studio stopped while starting; see %s" % os.path.join(CACHE, slug_of(relative) + ".studio.log"))
        if project_listed(port, os.path.basename(folder)):
            track()
            return port
        time.sleep(0.4)
    stop_studio()
    raise LookupError("HyperFrames Studio did not start within two minutes")


def opened(relative, info):
    port = start_studio(relative)
    project = os.path.basename(copy_dir(relative))
    return {"job": relative, "label": label_of(relative), "url": "http://127.0.0.1:%d/#project/%s" % (port, project),
            "copy": info, "source": job_path(relative), "copyPath": copy_dir(relative)}


def op_status(_request):
    running = studio["process"] is not None and studio["process"].poll() is None
    return {"root": ROOT, "connected": connected(), "studio": studio["job"] if running else None}


def op_jobs(_request):
    need_drive()
    jobs = []
    for relative in discover():
        jobs.append({"job": relative, "label": label_of(relative), "copy": copy_info(relative)})
    return {"jobs": jobs}


def op_open(request):
    need_drive()
    relative = request.get("job") or ""
    job_path(relative)
    info = copy_info(relative) or make_copy(relative)
    return opened(relative, info)


def op_refresh(request):
    need_drive()
    relative = request.get("job") or ""
    job_path(relative)
    if studio["job"] == relative:
        stop_studio()
    return opened(relative, make_copy(relative))


def op_check(request):
    track()
    need_drive()
    relative = request.get("job") or ""
    job_path(relative)
    return {"copy": copy_info(relative)}


def op_stop(_request):
    stop_studio()
    return {"stopped": True}


def op_log(request):
    need_drive()
    relative = request.get("job") or ""
    path = os.path.join(job_path(relative), NOTES)
    entry = request.get("entry")
    if not isinstance(entry, dict):
        raise ValueError("A note must be a JSON object")
    log = {"format": "bravebrand.blaze-review/2", "job": label_of(relative), "project": job_path(relative), "notes": []}
    if os.path.exists(path):
        if os.path.getsize(path) > MAX_NOTES_BYTES:
            raise ValueError("review-notes.json is too large")
        with open(path, encoding="utf-8") as handle:
            existing = json.load(handle)
        if not isinstance(existing, dict) or not isinstance(existing.get("notes"), list):
            raise ValueError("review-notes.json is not in the Blaze Review format, so it is left untouched")
        log = existing
    log["notes"].append(entry)
    data = (json.dumps(log, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    temporary = path + ".tmp"
    try:
        with open(temporary, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)
    return {"saved": path, "count": len(log["notes"])}


def op_configure(request):
    global ROOT, CACHE
    value = request.get("root")
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        raise ValueError("Enter a local project folder path")
    path = os.path.realpath(os.path.expanduser(value))
    if not os.path.isdir(path):
        raise ValueError("Folder not found. Connect the drive or download the cloud folder locally.")
    stop_studio()
    ROOT = path
    CACHE = cache_for(ROOT)
    return op_status({})


OPERATIONS = {"configure": op_configure, "status": op_status, "jobs": op_jobs, "open": op_open, "refresh": op_refresh, "check": op_check, "stop": op_stop, "log": op_log}


def main():
    signal.signal(signal.SIGTERM, lambda _signum, _frame: (stop_studio(), os._exit(0)))
    stop_studio()  # anything a crashed run left behind
    say({"ready": True, "root": ROOT, "connected": connected(), "python": sys.version.split()[0]})
    try:
        for raw in sys.stdin.buffer:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                request = json.loads(line)
                ident = request.get("id")
            except (ValueError, AttributeError):
                say({"id": None, "ok": False, "error": "Not a JSON request"})
                continue
            operation = OPERATIONS.get(request.get("op"))
            if not operation:
                say({"id": ident, "ok": False, "error": "Unknown request"})
                continue
            try:
                result = operation(request)
                result.update({"id": ident, "ok": True})
                say(result)
            except (ValueError, LookupError, OSError) as error:
                say({"id": ident, "ok": False, "error": str(error)})
    finally:
        stop_studio()
    return 0


if __name__ == "__main__":
    sys.exit(main())
