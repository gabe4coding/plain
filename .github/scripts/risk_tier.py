#!/usr/bin/env python3
"""Deterministic risk tier of a pull request: HOLD, T2-hard, T2-soft, T1 or T0.

Shadow week: the tier is advisory. The `risk` workflow posts it as a check summary and a
`risk:*` label, and never merges. The rules come from `.github/risk.yml` on the BASE branch,
so a pull request cannot loosen its own rules.

    risk_tier.py --rules RULES.yml --base BASE_SHA --head HEAD_SHA \
        [--title T] [--branch B] [--body-file F] [--automerge off] \
        [--json OUT.json] [--markdown OUT.md]

The core (`classify`) is a pure function of the changed files, the PR text, the base and
head contents of a few manifests, and the Greptile evidence the caller fetched. `collect`
reads the files from git. No network, no LLM. Labels are not an input. A pass needs all
three on the current head: a completed "Greptile Review" success from greptile-apps, the
latest `greptile-apps[bot]` summary of that SHA at confidence 4/5 or 5/5, and no P0 or P1
inline comment from that bot on that SHA. A pass never lowers the tier. Anything else raises
the tier one step, stopping at T2-hard. HOLD stays HOLD.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

TIERS = ["T0", "T1", "T2-soft", "T2-hard", "HOLD"]
LABELS = {"T0": "risk:t0", "T1": "risk:t1", "T2-soft": "risk:t2-soft", "T2-hard": "risk:t2-hard", "HOLD": "risk:hold"}
MEANING = {
    "T0": "merges on green CI (pilot); the reviewer blocks only on a verified bug",
    "T1": "merges after the reviewer passes (pilot)",
    "T2-soft": "Gabe reviews, unless the LLM layer shows the change only tightens (not active yet)",
    "T2-hard": "Gabe reviews; nothing lowers this",
    "HOLD": "never merges",
}

COMMENT_LINE = re.compile(r"^\s*(#(?!!)|//|/\*|\*(?!\*)|\*/|<!--|--\s)")
ASSERTION = re.compile(r"\bassert\w*\b|\bexpect\s*\(|\.toBe\w*\(|\bt\.(is|true|false|throws|deepEqual|equal)\b"
                       r"|\bpytest\.raises\b|\bself\.assert\w+")
# a test that no longer runs: skip, only (the others skip), todo, xit/fit, pytest and unittest skips
SKIPPED = re.compile(r"\b(?:it|test|describe|suite|context)\.(?:skip|only|todo|failing|if|skipIf)\b"
                     r"|\b[xf](?:it|describe|test)\s*\(|\bpytest\.(?:mark\.(?:skip|skipif|xfail)|skip|xfail)\b"
                     r"|\bunittest\.skip|@skip\b")
WORKFLOW_SENSITIVE = re.compile(r"^\s*(on|permissions)\s*:|secrets\.|\bgithub\.token\b|GITHUB_TOKEN|pull_request_target"
                                r"|workflow_run|^\s*(contents|actions|checks|pull-requests|issues|id-token|packages)\s*:\s*write")
# a removed workflow line is a pinned version bump only for these keys (with a new value added)
BUMPABLE = re.compile(r"^uses: |(^|[-_])version$|^[A-Z_]*VERSION$", re.I)
LOCKFILES = ("package-lock.json", "pnpm-lock.yaml", "yarn.lock", "uv.lock", "poetry.lock", "bun.lockb", "Cargo.lock")


# ---------------------------------------------------------------------------- data


@dataclass
class FileChange:
    path: str
    status: str = "M"                     # A added, M modified, D deleted, R renamed
    added: List[str] = field(default_factory=list)
    removed: List[str] = field(default_factory=list)
    old_path: Optional[str] = None
    binary: bool = False


@dataclass
class Change:
    files: List[FileChange]
    title: str = ""
    branch: str = ""
    body: str = ""
    # (path, "base" | "head") -> file text, or None when the file does not exist on that side
    read: Callable[[str, str], Optional[str]] = lambda path, side: None
    automerge: str = ""
    # set when git's file list and its diff do not agree: the files cannot be trusted
    problem: str = ""
    # None: no reviewer signal (a backtest). A list, even empty: judge the Greptile evidence.
    checks: Optional[List[dict]] = None
    # Issue comments and inline review comments. Read only when checks is a list.
    # None or empty means the summary is missing, which is not a pass.
    comments: Optional[List[dict]] = None
    review_comments: Optional[List[dict]] = None
    head_sha: str = ""


@dataclass
class Reason:
    tier: str
    rule: str
    detail: str


# ---------------------------------------------------------------------------- globs


_GLOB_CACHE: Dict[str, "re.Pattern[str]"] = {}


def _glob_regex(pattern: str) -> "re.Pattern[str]":
    if pattern not in _GLOB_CACHE:
        anchored = "/" in pattern.rstrip("/")
        p = pattern[1:] if pattern.startswith("/") else pattern
        out, i = "", 0
        while i < len(p):
            if p.startswith("**/", i):
                out, i = out + "(?:.*/)?", i + 3
            elif p.startswith("**", i):
                out, i = out + ".*", i + 2
            elif p[i] == "*":
                out, i = out + "[^/]*", i + 1
            elif p[i] == "?":
                out, i = out + "[^/]", i + 1
            else:
                out, i = out + re.escape(p[i]), i + 1
        if p.endswith("/"):
            out += ".*"
        # gitignore-like: a pattern without a slash matches the name in any folder
        _GLOB_CACHE[pattern] = re.compile(("^" if anchored else "^(?:.*/)?") + out + "$")
    return _GLOB_CACHE[pattern]


def matches(path: str, patterns) -> bool:
    return any(_glob_regex(p).match(path) for p in patterns or [])


# ---------------------------------------------------------------------------- helpers


def _paths(f: FileChange) -> List[str]:
    return [p for p in (f.path, f.old_path) if p]


def _any_match(f: FileChange, patterns) -> bool:
    return any(matches(p, patterns) for p in _paths(f))


def is_docs(f: FileChange, rules: dict) -> bool:
    return all(matches(p, rules.get("docs")) and not matches(p, rules.get("not_docs")) for p in _paths(f))


def is_test(f: FileChange, rules: dict) -> bool:
    return all(matches(p, rules.get("tests")) and not matches(p, rules.get("not_tests")) for p in _paths(f))


def is_generated(f: FileChange, rules: dict) -> bool:
    return f.path.rsplit("/", 1)[-1] in LOCKFILES or _any_match(f, rules.get("generated"))


def is_code(f: FileChange, rules: dict) -> bool:
    return not (is_docs(f, rules) or is_test(f, rules) or is_generated(f, rules))


def _version(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    try:
        v = json.loads(text).get("version")
    except (ValueError, AttributeError):
        return None
    return str(v) if v is not None else None


def _parts(version: str) -> List[int]:
    nums = re.findall(r"\d+", version)
    return [int(n) for n in nums[:3]] + [0] * (3 - len(nums[:3]))


def breaking_bump(old: str, new: str) -> bool:
    """A major bump, or a minor bump while the major is 0 (0.x minor is breaking by semver)."""
    a, b = _parts(old), _parts(new)
    if a[0] != b[0]:
        return True
    return a[0] == 0 and a[1] != b[1]


def _spec_floor(spec: str) -> Optional[str]:
    m = re.search(r"\d+(?:\.\d+){0,2}", spec or "")
    return m.group(0) if m else None


# ---------------------------------------------------------------------------- forbidden names


_WORD = re.compile(r"[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*")
_CAMEL = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+")


def name_hashes(text: str, max_parts: int = 3) -> set:
    """sha256 of each name a text can spell: a word, or 2-3 adjacent parts of a word split at
    `-`, `_` or a camelCase boundary ("TheBrand", "the-brand", "the_brand_x" all spell
    "thebrand"). Words that a space separates never join."""
    out = set()
    for word in _WORD.findall(text):
        parts = [p.lower() for chunk in re.split(r"[_-]", word) for p in (_CAMEL.findall(chunk) or [chunk])]
        whole = "".join(parts)
        cands = {whole}
        for n in range(1, max_parts + 1):
            for i in range(len(parts) - n + 1):
                cands.add("".join(parts[i:i + n]))
        out.update(hashlib.sha256(c.encode()).hexdigest() for c in cands)
    return out


# ---------------------------------------------------------------------------- dependency rules


def _npm_runtime(text: Optional[str]) -> Dict[str, str]:
    if not text:
        return {}
    try:
        data = json.loads(text)
    except ValueError:
        return {}
    deps: Dict[str, str] = {}
    for key in ("dependencies", "peerDependencies", "optionalDependencies"):
        deps.update({k: str(v) for k, v in (data.get(key) or {}).items()})
    return deps


def _py_runtime(text: Optional[str]) -> Dict[str, str]:
    if not text:
        return {}
    try:
        import tomllib  # Python 3.11+
    except ImportError:  # pragma: no cover - the workflow runs 3.12
        return {}
    try:
        data = tomllib.loads(text)
    except Exception:
        return {}
    out: Dict[str, str] = {}
    for dep in (data.get("project") or {}).get("dependencies") or []:
        m = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)", dep)
        if m:
            out[m.group(1).lower().replace("_", "-")] = dep[m.end():]
    return out


def dependency_reasons(change: Change, rules: dict) -> List[Reason]:
    reasons: List[Reason] = []
    manifests = rules.get("dependency_manifests") or {}
    readers = [(p, _npm_runtime) for p in manifests.get("npm", ["package.json"])]
    readers += [(p, _py_runtime) for p in manifests.get("python", ["pyproject.toml"])]
    changed = {f.path: f for f in change.files}
    for path, parse in readers:
        if path not in changed:
            continue
        old_path = changed[path].old_path or path   # a moved manifest compares with its old place
        before, after = parse(change.read(old_path, "base")), parse(change.read(path, "head"))
        for name, spec in sorted(after.items()):
            if name not in before:
                reasons.append(Reason("T2-hard", "new-runtime-dependency", f"{path}: adds runtime dependency `{name}`"))
                continue
            old, new = _spec_floor(before[name]), _spec_floor(spec)
            if old and new and breaking_bump(old, new):
                reasons.append(Reason("T2-hard", "breaking-dependency-bump", f"{path}: `{name}` {before[name].strip()} -> {spec.strip()}"))
    return reasons


# ---------------------------------------------------------------------------- workflow rules


def _key(line: str) -> str:
    s = line.strip().lstrip("- ").strip()
    if s.startswith("uses:") and "@" in s:
        return s.split("@", 1)[0]
    return s.split(":", 1)[0] if ":" in s else s


def _meaningful(lines: List[str]) -> List[str]:
    return [l for l in lines if l.strip() and not l.strip().startswith("#")]


def workflow_reason(f: FileChange) -> Reason:
    """T2-hard when a workflow edit removes or changes steps, permissions, secrets or triggers;
    T2-soft when it only adds (a new job) or bumps a pinned version."""
    if f.status == "D":
        return Reason("T2-hard", "workflow-weakened", f"deletes workflow `{f.path}`")
    for line in _meaningful(f.added) + _meaningful(f.removed):
        if WORKFLOW_SENSITIVE.search(line):
            return Reason("T2-hard", "workflow-permissions-secrets-triggers", f"`{f.path}`: `{line.strip()[:80]}`")
    added_keys = {_key(l) for l in _meaningful(f.added)}
    for line in _meaningful(f.removed):
        if not (BUMPABLE.search(_key(line)) and _key(line) in added_keys):
            return Reason("T2-hard", "workflow-weakened", f"`{f.path}` removes `{line.strip()[:80]}`")
    return Reason("T2-soft", "workflow-additive", f"`{f.path}`: additive edit or pinned version bump")


# ---------------------------------------------------------------------------- reviewer


REVIEWER_CHECK = "Greptile Review"
REVIEWER_APP = "greptile-apps"
REVIEWER_LOGIN = "greptile-apps[bot]"
# Visible score line. The HTML marker is not the score: a summary can list findings and still pass.
CONFIDENCE = re.compile(r"Confidence Score:\s*(\d+)\s*/\s*5")
# The footer link, not a /commit/ that happens to appear earlier in the body.
REVIEWED_COMMIT = re.compile(r"Last reviewed commit:\s*.*?/commit/([0-9a-fA-F]{40})", re.S)
# Inline badge only. A P2 does not match, and the same image inside a summary does not count.
BLOCKING_BADGE = re.compile(r"""alt\s*=\s*["']P[01]["']""")


def _check_slug(check: dict) -> str:
    slug = check.get("slug")
    if slug:
        return str(slug)
    app = check.get("app")
    if isinstance(app, dict) and app.get("slug"):
        return str(app["slug"])
    return ""


def _reviewer_on_head(check: dict, head_sha: str) -> bool:
    """True for a Greptile Review check from greptile-apps on this exact SHA."""
    if not head_sha or not isinstance(check, dict):
        return False
    return (check.get("name") == REVIEWER_CHECK and _check_slug(check) == REVIEWER_APP
            and str(check.get("head_sha") or "").lower() == head_sha.lower())


def _greptile_bot(comment: dict) -> bool:
    if not isinstance(comment, dict):
        return False
    user = comment.get("user")
    if not isinstance(user, dict):
        return False
    return user.get("login") == REVIEWER_LOGIN and user.get("type") == "Bot"


def _comment_stamp(comment: dict) -> str:
    """Latest means the newest updated_at, then created_at. ISO-8601 sorts as text."""
    return f"{comment.get('updated_at') or comment.get('created_at') or ''}"


def _check_succeeded(checks, head_sha: str) -> bool:
    """Completed Greptile Review from greptile-apps on head_sha with conclusion success."""
    if not head_sha:
        return False
    for check in checks or []:
        if not _reviewer_on_head(check, head_sha):
            continue
        if check.get("status") == "completed" and check.get("conclusion") == "success":
            return True
    return False


def _latest_summary(comments) -> Optional[dict]:
    """The newest issue comment from greptile-apps[bot] that is a Greptile summary."""
    found = [c for c in comments or []
             if _greptile_bot(c) and "<!-- greptile_summary -->" in str(c.get("body") or "")]
    if not found:
        return None
    return max(found, key=_comment_stamp)


def _summary_ok(summary: Optional[dict], head_sha: str) -> bool:
    """The summary last reviewed this SHA and its confidence is 4/5 or 5/5."""
    if summary is None or not head_sha:
        return False
    body = str(summary.get("body") or "")
    score = CONFIDENCE.search(body)
    reviewed = REVIEWED_COMMIT.search(body)
    if not score or not reviewed:
        return False
    return 4 <= int(score.group(1)) <= 5 and reviewed.group(1).lower() == head_sha.lower()


def _blocking_inline(review_comments, head_sha: str) -> bool:
    """A P0 or P1 badge from greptile-apps[bot] whose commit_id is this SHA."""
    if not head_sha:
        return False
    want = head_sha.lower()
    for comment in review_comments or []:
        if not _greptile_bot(comment):
            continue
        if str(comment.get("commit_id") or "").lower() != want:
            continue
        if BLOCKING_BADGE.search(str(comment.get("body") or "")):
            return True
    return False


def reviewer_passed(checks, head_sha: str, comments=None, review_comments=None) -> bool:
    """True only when all three hold on head_sha.

    A completed Greptile Review success from greptile-apps, the latest greptile-apps[bot]
    summary of that SHA at confidence 4/5 or 5/5, and no P0 or P1 inline comment from that
    bot on that SHA. Missing, pending, neutral, a failure, the wrong app, an older SHA, a
    missing or unparseable summary, another author, and a blocking inline comment are not a
    pass. Labels are not read. A summary that merely lists P0 or P1 badges is not an inline
    comment."""
    return (_check_succeeded(checks, head_sha)
            and _summary_ok(_latest_summary(comments), head_sha)
            and not _blocking_inline(review_comments, head_sha))


def _raised(tier: str) -> str:
    """One tier up. The reviewer stops at T2-hard and never produces HOLD."""
    if tier in ("T2-hard", "HOLD"):
        return tier
    return TIERS[TIERS.index(tier) + 1]


# ---------------------------------------------------------------------------- classify


def classify(change: Change, rules: dict) -> dict:
    reasons: List[Reason] = []
    files = change.files
    text_rx = [re.compile(p, re.I) for p in (rules.get("hold") or {}).get("forbidden_text", [])]

    # HOLD: forbidden refs (paths or added lines), comment pruning
    names = {h.lower() for h in (rules.get("hold") or {}).get("forbidden_names_sha256", [])}
    for f in files:
        for rx in text_rx:
            hit = next((p for p in _paths(f) if rx.search(p)), None) or next((l for l in f.added if rx.search(l)), None)
            if hit is not None:
                reasons.append(Reason("HOLD", "forbidden-ref", f"`{f.path}` adds a forbidden reference ({rx.pattern})"))
                break
        else:
            # the names are stored as hashes, so this public repo never spells them out
            if names and any(name_hashes(t) & names for t in [*_paths(f), *f.added]):
                reasons.append(Reason("HOLD", "forbidden-ref", f"`{f.path}` adds a forbidden name"))
    prune = (rules.get("hold") or {}).get("comment_pruning") or {}
    title_rx = prune.get("title_or_branch")
    if title_rx and re.search(title_rx, f"{change.title}\n{change.branch}", re.I):
        reasons.append(Reason("HOLD", "comment-pruning", "title or branch names comment pruning"))
    else:
        code = [f for f in files if is_code(f, rules) and not f.binary]
        removed = [l for f in code for l in f.removed if l.strip()]
        added = [l for f in code for l in f.added if l.strip()]
        comments = [l for l in removed if COMMENT_LINE.match(l)]
        if (len(removed) >= int(prune.get("min_removed_lines", 20)) and len(added) * 2 <= len(removed)
                and len(comments) >= float(prune.get("comment_share", 0.7)) * len(removed)):
            reasons.append(Reason("HOLD", "comment-pruning",
                                  f"{len(comments)} of {len(removed)} removed code lines are comments"))

    # T2-hard
    if change.problem:
        reasons.append(Reason("T2-hard", "unreadable-diff", change.problem))
    # Title and branch only: PR bodies often describe a guard that denies a force push.
    hist = rules.get("history_rewrite_text")
    if hist and re.search(hist, f"{change.title}\n{change.branch}", re.I):
        reasons.append(Reason("T2-hard", "history-rewrite", "the title or branch asks for a history rewrite or force push"))
    for f in files:
        if _any_match(f, rules.get("hard")):
            reasons.append(Reason("T2-hard", "hard-path", f"touches `{f.path}`"))
        elif f.path.startswith(".github/workflows/") or (f.old_path or "").startswith(".github/workflows/"):
            reasons.append(workflow_reason(f))
        elif _any_match(f, rules.get("soft")):
            reasons.append(Reason("T2-soft", "sensitive-path", f"touches `{f.path}`"))
        elif not is_test(f, rules):
            for rule in rules.get("soft_content") or []:
                if not _any_match(f, rule.get("paths") or ["**"]):
                    continue
                rx = re.compile(rule["pattern"], re.I)
                hit = next((l for l in f.added + f.removed if rx.search(l)), None)
                if hit is not None:
                    reasons.append(Reason("T2-soft", "sensitive-code",
                                          f"`{f.path}` changes a line with `{rx.search(hit).group(0)}`"))
                    break
    for path in rules.get("publish_on_version") or []:
        if any(f.path == path for f in files):
            old, new = _version(change.read(path, "base")), _version(change.read(path, "head"))
            if old != new:
                reasons.append(Reason("T2-hard", "publish-version", f"`{path}` version {old} -> {new} publishes a release"))
    for path in rules.get("plugin_manifests") or []:
        if any(f.path == path for f in files):
            old, new = _version(change.read(path, "base")), _version(change.read(path, "head"))
            if old and new and old != new:
                a, b = _parts(old), _parts(new)
                if b[0] != a[0] or b < a:
                    reasons.append(Reason("T2-hard", "plugin-major", f"`{path}` version {old} -> {new}"))
    reasons += dependency_reasons(change, rules)
    limits = rules.get("limits") or {}
    non_test = [f for f in files if not is_test(f, rules) and not is_generated(f, rules)]
    net_deleted = sum(len(f.removed) - len(f.added) for f in non_test)
    if net_deleted > int(limits.get("net_deleted_lines", 1000)):
        reasons.append(Reason("T2-hard", "mass-deletion", f"net {net_deleted} non-test lines deleted"))
    for f in files:
        if f.status == "D" and is_code(f, rules):
            reasons.append(Reason("T2-hard", "deleted-source", f"deletes `{f.path}`"))
    code = [f for f in files if is_code(f, rules)]
    code_lines = sum(len(f.added) + len(f.removed) for f in code)
    if code_lines > int(limits.get("changed_code_lines", 1500)):
        reasons.append(Reason("T2-hard", "size", f"{code_lines} changed code lines"))
    if len(code) > int(limits.get("changed_code_files", 40)):
        reasons.append(Reason("T2-hard", "size", f"{len(code)} changed code files"))

    # T1 / T0
    if all(is_docs(f, rules) or is_test(f, rules) for f in files) and files:
        tests = [f for f in files if is_test(f, rules)]
        lost = sum(1 for f in tests for l in f.removed if ASSERTION.search(l))
        gained = sum(1 for f in tests for l in f.added if ASSERTION.search(l))
        deleted_tests = [f.path for f in tests if f.status == "D"]
        skipped = sum(1 for f in tests for l in f.added if SKIPPED.search(l))
        if deleted_tests:
            reasons.append(Reason("T1", "test-deletion", f"deletes {', '.join(deleted_tests[:3])}"))
        elif lost:
            # any removed assertion: a changed one can be weaker, and the net count cannot tell
            reasons.append(Reason("T1", "assertions-removed", f"removes or changes {lost} assertion lines, adds {gained}"))
        elif skipped:
            reasons.append(Reason("T1", "tests-skipped", f"adds {skipped} skip, only or todo markers"))
        else:
            kind = "docs-only" if not tests else ("test-only" if len(tests) == len(files) else "docs and tests only")
            reasons.append(Reason("T0", kind, f"{len(files)} files"))
    else:
        reasons.append(Reason("T1", "source-change", f"{len(code)} code files, {code_lines} changed lines"))

    if str(change.automerge).strip().lower() == "off":
        reasons.append(Reason("T2-hard", "kill-switch", "repo variable AUTOMERGE=off: every PR goes to Gabe"))

    base = max((r.tier for r in reasons), key=TIERS.index)
    reviewer = "not-checked"
    if change.checks is not None:
        if reviewer_passed(change.checks, change.head_sha, change.comments, change.review_comments):
            reviewer = "passed"
            reasons.append(Reason(base, "reviewer-passed",
                                  "Greptile passed on the current head (check, summary, no P0 or P1); the tier is not lowered"))
        else:
            reviewer = "not-passed"
            up = _raised(base)
            reasons.append(Reason(up, "reviewer-not-passed", "Greptile Review has not passed on the current head"))
    tier = max((r.tier for r in reasons), key=TIERS.index)
    return {
        "tier": tier,
        "label": LABELS[tier],
        "meaning": MEANING[tier],
        "reviewer": reviewer,
        "reasons": [r.__dict__ for r in sorted(reasons, key=lambda r: -TIERS.index(r.tier))],
        "stats": {"files": len(files), "code_files": len(code), "code_lines": code_lines,
                  "added": sum(len(f.added) for f in files), "removed": sum(len(f.removed) for f in files)},
    }


# ---------------------------------------------------------------------------- git


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True, errors="replace").stdout


def parse_diff(text: str) -> List[FileChange]:
    files: List[FileChange] = []
    cur: Optional[FileChange] = None
    # split at newlines only: str.splitlines() also splits at \x1c, \u2028 and others that a diff line can hold
    for line in text.split("\n"):
        if line.startswith("diff --git "):
            m = re.match(r"diff --git a/(.*) b/(.*)$", line)
            cur = FileChange(path=m.group(2) if m else line.split(" b/", 1)[-1])
            files.append(cur)
        elif cur is None:
            continue
        elif line.startswith("new file mode"):
            cur.status = "A"
        elif line.startswith("deleted file mode"):
            cur.status = "D"
        elif line.startswith("rename from "):
            cur.status, cur.old_path = "R", line[len("rename from "):]
        elif line.startswith("rename to "):
            cur.path = line[len("rename to "):]
        elif line.startswith("Binary files ") or line.startswith("GIT binary patch"):
            cur.binary = True
        elif line.startswith("+++ ") or line.startswith("--- ") or line.startswith("@@"):
            continue
        elif line.startswith("+"):
            cur.added.append(line[1:])
        elif line.startswith("-"):
            cur.removed.append(line[1:])
    return files


def parse_name_status(text: str) -> List[tuple]:
    """(status letter, old path or None, path) of each file in `git diff --name-status -z` output."""
    out, items, i = [], text.split("\0"), 0
    while i < len(items) and items[i]:
        letter = items[i][0]
        if letter in "RC":
            out.append((letter, items[i + 1], items[i + 2]))
            i += 3
        else:
            out.append((letter, None, items[i + 1]))
            i += 2
    return out


def collect(base: str, head: str):
    """(changed files, merge base, problem) of head against where it left base.

    The paths come from `--name-status -z`: raw bytes, never quoted, so a name with a quote, a tab,
    a non-ASCII letter or " b/" in it is read whole. The lines come from a diff with `--text`, so a
    `.gitattributes` in the PR cannot turn a file into "Binary files differ" and hide its lines."""
    merge_base = _git("merge-base", base, head).strip()
    opts = ["--no-color", "--no-ext-diff", "--no-textconv", "-M", merge_base, head]
    names = parse_name_status(_git("diff", "--name-status", "-z", *opts))
    files = parse_diff(_git("diff", "--text", "-U0", *opts))
    if len(names) != len(files):
        return files, merge_base, f"git lists {len(names)} changed files and its diff shows {len(files)}"
    for fc, (letter, old, path) in zip(files, names):
        fc.path, fc.old_path = path, old if letter == "R" else None
        fc.status = letter if letter in "ADR" else "M"
    return files, merge_base, ""


def git_reader(base: str, head: str) -> Callable[[str, str], Optional[str]]:
    def read(path: str, side: str) -> Optional[str]:
        try:
            return _git("show", f"{base if side == 'base' else head}:{path}")
        except subprocess.CalledProcessError:
            return None
    return read


def load_rules(path: str) -> dict:
    import yaml  # PyYAML: the workflow installs it with uv
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def markdown(result: dict, header: str = "") -> str:
    lines = [f"### risk: {result['tier']} (`{result['label']}`)", "", f"{result['meaning']}.", ""]
    reviewer = result.get("reviewer") or ""
    if reviewer and reviewer != "not-checked":
        lines += [f"Reviewer: {reviewer}. A pass never lowers the tier.", ""]
    if header:
        lines += [header, ""]
    lines += ["| Tier | Rule | Detail |", "| --- | --- | --- |"]
    for r in result["reasons"][:30]:
        detail = r["detail"].replace("|", "\\|")
        lines.append(f"| {r['tier']} | {r['rule']} | {detail} |")
    s = result["stats"]
    lines += ["", f"{s['files']} files, {s['code_files']} code files, +{s['added']}/-{s['removed']} lines.",
              "", "Shadow week: advisory only. Nothing merges on this tier yet."]
    return "\n".join(lines) + "\n"


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--rules", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--head", default="HEAD")
    ap.add_argument("--title", default="")
    ap.add_argument("--branch", default="")
    ap.add_argument("--body-file")
    ap.add_argument("--automerge", default="")
    ap.add_argument("--json")
    ap.add_argument("--markdown")
    ap.add_argument("--note", default="", help="extra line for the markdown summary")
    ap.add_argument("--pr-json", help="JSON file with title, branch, and body; overrides those flags")
    ap.add_argument("--checks-file", help="JSON list of check runs. Omit to leave the reviewer out of the tier")
    ap.add_argument("--comments-file", help="JSON list of issue comments. With --checks-file, omit means no summary")
    ap.add_argument("--review-comments-file", help="JSON list of inline review comments. With --checks-file, omit means none")
    a = ap.parse_args(argv)
    title, branch = a.title, a.branch
    body = open(a.body_file, encoding="utf-8", errors="replace").read() if a.body_file else ""
    if a.pr_json:
        meta = json.load(open(a.pr_json, encoding="utf-8"))
        title, branch, body = meta.get("title") or "", meta.get("branch") or "", meta.get("body") or ""
    def load_list(path: Optional[str], what: str):
        if not path:
            return []
        rows = json.load(open(path, encoding="utf-8"))
        if not isinstance(rows, list):
            print(f"{what} file must be a JSON list", file=sys.stderr)
            return None
        return rows

    checks = None
    comments = None
    review_comments = None
    if a.checks_file:
        checks = load_list(a.checks_file, "checks")
        comments = load_list(a.comments_file, "comments")
        review_comments = load_list(a.review_comments_file, "review comments")
        if checks is None or comments is None or review_comments is None:
            return 2
    files, merge_base, problem = collect(a.base, a.head)
    change = Change(files=files, title=title, branch=branch, body=body,
                    read=git_reader(merge_base, a.head), automerge=a.automerge, problem=problem,
                    checks=checks, comments=comments, review_comments=review_comments, head_sha=a.head)
    result = classify(change, load_rules(a.rules))
    if a.json:
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump(result, fh, indent=2)
    md = markdown(result, a.note)
    if a.markdown:
        with open(a.markdown, "w", encoding="utf-8") as fh:
            fh.write(md)
    print(json.dumps({"tier": result["tier"], "label": result["label"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
