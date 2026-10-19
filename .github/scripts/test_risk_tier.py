"""Tests of .github/scripts/risk_tier.py: the deterministic tier rules.

    uv run --no-project --with pyyaml --with pytest -- python -m pytest -q .github/scripts

Pure: no git, no network (the git part has one test on a temporary repo, marked `git`).
"""

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import risk_tier as rt  # noqa: E402

RULES = rt.load_rules(str(HERE.parent / "risk.yml"))


def f(path, added=(), removed=(), status="M", old_path=None):
    return rt.FileChange(path=path, status=status, added=list(added), removed=list(removed), old_path=old_path)


def tier(*files, title="", branch="", body="", read=None, automerge="", checks=None, head_sha="",
         comments=None, review_comments=None):
    change = rt.Change(files=list(files), title=title, branch=branch, body=body,
                       read=read or (lambda p, s: None), automerge=automerge,
                       checks=checks, head_sha=head_sha, comments=comments, review_comments=review_comments)
    return rt.classify(change, RULES)


HEAD = "a" * 40
PR47 = "5075dbc6918a73c32ed780236d3812bd007318f7"


def greptile(conclusion="success", status="completed", head_sha=HEAD, slug="greptile-apps", name="Greptile Review"):
    return {"name": name, "status": status, "conclusion": conclusion, "head_sha": head_sha, "app": {"slug": slug}}


def summary(score="5/5", head_sha=HEAD, login="greptile-apps[bot]", kind="Bot", updated="2026-10-19T12:00:00Z",
            marker=True):
    """A Greptile summary comment. score is the text after 'Confidence Score:'."""
    body = ""
    if marker:
        body += "<!-- greptile_summary -->\n"
    body += f"Confidence Score: {score}\n"
    body += f'Last reviewed commit: ["x"](https://github.com/o/r/commit/{head_sha})\n'
    return {"user": {"login": login, "type": kind}, "body": body, "created_at": updated, "updated_at": updated}


def inline(badge="P1", commit_id=HEAD, login="greptile-apps[bot]", kind="Bot"):
    body = f'<img alt="{badge}" src="https://greptile-static-assets.s3.amazonaws.com/badges/{badge.lower()}.svg">'
    return {"user": {"login": login, "type": kind}, "body": body, "commit_id": commit_id}


def passed_evidence(score="5/5", head_sha=HEAD):
    """A success check plus a qualifying summary and no inline comments."""
    return [greptile(head_sha=head_sha)], [summary(score, head_sha=head_sha)], []


def manifests(**sides):
    """read() for base/head manifests: manifests(**{"base:path": text, "head:path": text})."""
    table = {tuple(k.split(":", 1)): v for k, v in sides.items()}
    return lambda path, side: table.get((side, path))


# ---------------------------------------------------------------- globs


@pytest.mark.parametrize("path,pattern,ok", [
    ("README.md", "*.md", True),
    ("docs/usage.mdx", "*.mdx", True),
    ("docs/a/b.png", "docs/**", True),
    ("skills/x/SKILL.md", "skills/**", True),
    ("src/kb/redact.py", "src/kb/redact.py", True),
    ("src/kb/redact.py.bak", "src/kb/redact.py", False),
    (".github/workflows/publish-npm.yml", "**/publish*.yml", True),
    ("a/b/gitleaks_fetch.py", "**/gitleaks_fetch.py", True),
    ("gitleaks_fetch.py", "**/gitleaks_fetch.py", True),
    ("tests/version.check.mjs", "tests/*.check.mjs", True),
    ("tests/sub/x.check.mjs", "tests/*.check.mjs", False),
])
def test_glob(path, pattern, ok):
    assert rt.matches(path, [pattern]) is ok


# ---------------------------------------------------------------- T0 / T1


def test_docs_only_is_t0():
    r = tier(f("README.md", ["new line"]), f("docs/usage.mdx", ["x"], ["y"]))
    assert r["tier"] == "T0" and r["label"] == "risk:t0"


def test_test_only_that_adds_assertions_is_t0():
    r = tier(f("tests/test_new.py", ["def test_x():", "    assert 1 == 1"], status="A"))
    assert r["tier"] == "T0"


def test_test_change_that_removes_assertions_is_t1():
    r = tier(f("tests/test_old.py", ["    pass"], ["    assert a == b", "    assert c"]))
    assert r["tier"] == "T1" and r["reasons"][0]["rule"] == "assertions-removed"


def test_deleted_test_file_is_t1():
    assert tier(f("tests/test_old.py", [], ["assert x"], status="D"))["tier"] == "T1"


def test_model_facing_markdown_is_not_docs():
    folder = next(p[:-3] for p in RULES["not_docs"] if p.endswith("/**") and "*" not in p[:-3])
    assert tier(f(f"{folder}/x/SKILL.md", ["new rule"]))["tier"] == "T1"
    assert tier(f("AGENTS.md", ["x"]))["tier"] == "T1"


def test_source_change_is_t1():
    assert tier(f("src/kb/sync.py", ["x = 1"], ["x = 2"]))["tier"] == "T1"


def test_empty_change_is_t1():
    assert tier()["tier"] == "T1"


def test_ci_check_script_is_not_a_test():
    if "tests/*.check.mjs" not in (RULES.get("not_tests") or []):
        pytest.skip("this repo has no check scripts under tests/")
    assert tier(f("tests/version.check.mjs", ["x"], ["y"]))["tier"] == "T1"


# ---------------------------------------------------------------- plugin versions and dependencies


PLUGIN = next(iter(RULES.get("plugin_manifests") or []), None)
PYPROJECT = next(iter((RULES.get("dependency_manifests") or {}).get("python") or []), None)


@pytest.mark.parametrize("old,new,expected", [
    ("0.2.3", "0.2.4", "T1"),
    ("0.2.3", "0.3.0", "T1"),
    ("0.11.4", "1.0.0", "T2-hard"),
    ("1.4.0", "2.0.0", "T2-hard"),
    ("0.2.3", "0.2.2", "T2-hard"),
])
def test_plugin_version_bumps(old, new, expected):
    if not PLUGIN:
        pytest.skip("this repo has no plugin manifest")
    read = manifests(**{f"base:{PLUGIN}": json.dumps({"version": old}), f"head:{PLUGIN}": json.dumps({"version": new})})
    assert tier(f(PLUGIN, ['"version": "x"'], ['"version": "y"']), read=read)["tier"] == expected


def test_new_runtime_npm_dependency_is_t2_hard():
    read = manifests(**{"base:package.json": json.dumps({"dependencies": {"a": "^1.0.0"}}),
                        "head:package.json": json.dumps({"dependencies": {"a": "^1.0.0", "b": "^2.0.0"}})})
    r = tier(f("package.json", ['"b": "^2.0.0"']), read=read)
    assert r["tier"] == "T2-hard" and r["reasons"][0]["rule"] == "new-runtime-dependency"


@pytest.mark.parametrize("old,new,expected", [
    ("^9.1.0", "^10.0.0", "T2-hard"),
    ("^0.6.2", "^0.7.0", "T2-hard"),
    ("^1.2.0", "^1.3.0", "T1"),
])
def test_runtime_npm_bumps(old, new, expected):
    read = manifests(**{"base:package.json": json.dumps({"dependencies": {"a": old}}),
                        "head:package.json": json.dumps({"dependencies": {"a": new}})})
    assert tier(f("package.json", ["x"], ["y"]), read=read)["tier"] == expected


def test_moved_manifest_compares_with_its_old_place():
    read = manifests(**{"base:old/package.json": json.dumps({"dependencies": {"a": "^1.0.0"}}),
                        "head:package.json": json.dumps({"dependencies": {"a": "^1.0.0"}})})
    r = tier(f("package.json", ["x"], status="R", old_path="old/package.json"), read=read)
    assert not any(x["rule"] == "new-runtime-dependency" for x in r["reasons"])


def test_dev_dependency_is_t1():
    read = manifests(**{"base:package.json": json.dumps({"devDependencies": {}}),
                        "head:package.json": json.dumps({"devDependencies": {"@types/node": "^24.0.0"}})})
    assert tier(f("package.json", ["x"]), read=read)["tier"] == "T1"


def test_new_python_runtime_dependency_is_t2_hard():
    base = '[project]\nname = "x"\ndependencies = ["pyyaml>=6"]\n'
    head = '[project]\nname = "x"\ndependencies = ["pyyaml>=6", "requests>=2"]\n'
    if not PYPROJECT:
        pytest.skip("this repo has no Python manifest")
    read = manifests(**{f"base:{PYPROJECT}": base, f"head:{PYPROJECT}": head})
    assert tier(f(PYPROJECT, ['"requests>=2"']), read=read)["tier"] == "T2-hard"


def test_publish_on_version(monkeypatch):
    monkeypatch.setitem(RULES, "publish_on_version", ["package.json"])
    read = manifests(**{"base:package.json": json.dumps({"version": "3.0.0"}),
                        "head:package.json": json.dumps({"version": "3.1.0"})})
    r = tier(f("package.json", ["x"], ["y"]), read=read)
    assert r["tier"] == "T2-hard" and any(x["rule"] == "publish-version" for x in r["reasons"])


# ---------------------------------------------------------------- T2 paths and workflows


@pytest.mark.parametrize("path", [".github/risk.yml", "LICENSE", ".gitleaks.toml", ".githooks/pre-commit",
                                  ".github/workflows/review.yml", ".github/workflows/risk.yml",
                                  ".github/scripts/risk_tier.py", "CODEOWNERS"])
def test_hard_paths(path):
    assert tier(f(path, ["x"]))["tier"] == "T2-hard"


def test_soft_paths():
    soft = RULES.get("soft") or []
    if not soft:
        pytest.skip("this repo lists no sensitive files")
    path = soft[0].replace("**/", "").replace("/**", "/x")
    assert tier(f(path, ["x"]))["tier"] == "T2-soft"


def test_soft_content(monkeypatch):
    monkeypatch.setitem(RULES, "soft_content", [{"paths": ["src/**"], "pattern": "secret|redact"}])
    r = tier(f("src/x/page.ts", ["  return redactAll(text)"], ["  return text"]))
    assert r["tier"] == "T2-soft" and r["reasons"][0]["rule"] == "sensitive-code"
    assert tier(f("src/x/page.ts", ["  return a + b"]))["tier"] == "T1"
    assert tier(f("lib/x.ts", ["secret"]))["tier"] == "T1"   # outside the paths
    monkeypatch.setitem(RULES, "soft_content", [{"pattern": "redact"}])
    assert tier(f("tests/test_x.py", ["    assert redact(x)"]))["tier"] == "T0"   # tests never match


def test_additive_workflow_edit_is_t2_soft():
    r = tier(f(".github/workflows/test.yml", ["  lint:", "    runs-on: ubuntu-latest", "      - run: make lint"]))
    assert r["tier"] == "T2-soft"


def test_pinned_version_bump_is_t2_soft():
    r = tier(f(".github/workflows/test.yml", ["      - uses: actions/checkout@v5"], ["      - uses: actions/checkout@v4"]))
    assert r["tier"] == "T2-soft"


def test_removed_step_is_t2_hard():
    r = tier(f(".github/workflows/test.yml", [], ["      - run: node tests/version.check.mjs"]))
    assert r["tier"] == "T2-hard" and r["reasons"][0]["rule"] == "workflow-weakened"


def test_changed_run_command_is_t2_hard():
    r = tier(f(".github/workflows/test.yml", ["      - run: echo ok"], ["      - run: scripts/test --all"]))
    assert r["tier"] == "T2-hard"


@pytest.mark.parametrize("line", ["permissions:", "  contents: write", "    env: { T: ${{ secrets.X }} }",
                                  "  pull_request_target:", "on:"])
def test_workflow_permissions_secrets_triggers_are_t2_hard(line):
    assert tier(f(".github/workflows/test.yml", [line]))["tier"] == "T2-hard"


def test_deleted_workflow_is_t2_hard():
    assert tier(f(".github/workflows/test.yml", [], ["x"], status="D"))["tier"] == "T2-hard"


def test_mass_deletion_and_deleted_source():
    r = tier(f("src/big.py", [], ["x = 1"] * 1200, status="D"))
    rules = {x["rule"] for x in r["reasons"]}
    assert r["tier"] == "T2-hard" and {"mass-deletion", "deleted-source"} <= rules


def test_size_limits():
    many = [f(f"src/m{i}.py", ["x"]) for i in range(41)]
    assert tier(*many)["tier"] == "T2-hard"
    assert tier(f("src/a.py", ["x"] * 1501))["tier"] == "T2-hard"
    assert tier(f("uv.lock", ["x"] * 5000), f("src/a.py", ["y"]))["tier"] == "T1"   # lockfiles do not count


def test_history_rewrite_request():
    assert tier(f("src/a.py", ["x"]), title="Rewrite history to drop a file")["tier"] == "T2-hard"
    assert tier(f("src/a.py", ["x"]), branch="fix/force-push-main")["tier"] == "T2-hard"
    assert tier(f("src/a.py", ["x"]), body="/verify: a force push was denied.")["tier"] == "T1"


def test_kill_switch_raises_everything():
    r = tier(f("README.md", ["x"]), automerge="off")
    assert r["tier"] == "T2-hard" and any(x["rule"] == "kill-switch" for x in r["reasons"])
    assert tier(f("README.md", ["x"]), automerge="on")["tier"] == "T0"


# ---------------------------------------------------------------- HOLD


def test_forbidden_name_is_hold(monkeypatch):
    # A made-up name: the real ones are hashes in risk.yml, so this public repo never spells them.
    monkeypatch.setitem(RULES, "hold", {**RULES["hold"], "forbidden_names_sha256": [hashlib.sha256(b"acmebrand").hexdigest()]})
    assert tier(f("README.md", ["Install the AcmeBrand plugin"]))["tier"] == "HOLD"
    assert tier(f("README.md", ["see acme-brand_tools"]))["tier"] == "HOLD"
    assert tier(f("plugins/acmebrand-x/plugin.json", ["{}"], status="A"))["tier"] == "HOLD"
    assert tier(f("cfg.yaml", ["checkout: ~/Repositories/acmebrand/app"]))["tier"] == "HOLD"
    assert tier(f("src/a.py", [], ["# AcmeBrand"]))["tier"] == "T1"   # removing a mention is fine
    assert tier(f("src/a.py", ["# the acme brand"]))["tier"] != "HOLD"   # words a space separates do not join
    assert tier(f("src/a.py", ["# acmebrandnew"]))["tier"] != "HOLD"


def test_rules_hold_the_names_as_hashes_only():
    hashes = RULES["hold"]["forbidden_names_sha256"]
    assert hashes and all(re.fullmatch(r"[0-9a-f]{64}", h) for h in hashes)


def test_comment_pruning_by_title_is_hold():
    assert tier(f("src/a.py", ["x"]), title="Prune redundant comments")["tier"] == "HOLD"
    assert tier(f("src/a.py", ["x"]), branch="claude/remove-obvious-comments")["tier"] == "HOLD"


def test_comment_pruning_by_diff_is_hold():
    removed = [f"    # comment {i}" for i in range(30)] + ["x = 1"]
    assert tier(f("src/a.py", ["x = 2"], removed))["tier"] == "HOLD"


def test_doc_edits_are_not_comment_pruning():
    removed = [f"# Heading {i}" for i in range(30)]
    assert tier(f("docs/a.mdx", [], removed))["tier"] == "T0"


# ---------------------------------------------------------------- the rules file and git


def test_parse_diff():
    diff = "\n".join([
        "diff --git a/a.py b/a.py", "index 1..2 100644", "--- a/a.py", "+++ b/a.py", "@@ -1 +1 @@", "-old", "+new",
        "diff --git a/n.md b/n.md", "new file mode 100644", "--- /dev/null", "+++ b/n.md", "@@ -0,0 +1 @@", "+hi",
        "diff --git a/d.py b/d.py", "deleted file mode 100644", "--- a/d.py", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
        "diff --git a/o.py b/r.py", "similarity index 90%", "rename from o.py", "rename to r.py",
        "diff --git a/i.png b/i.png", "Binary files a/i.png and b/i.png differ",
    ])
    files = {x.path: x for x in rt.parse_diff(diff)}
    assert files["a.py"].added == ["new"] and files["a.py"].removed == ["old"]
    assert files["n.md"].status == "A" and files["d.py"].status == "D"
    assert files["r.py"].status == "R" and files["r.py"].old_path == "o.py"
    assert files["i.png"].binary


def test_markdown_escapes_pipes():
    r = tier(f("LICENSE|x", ["x"], status="A"), f("LICENSE", ["x"]))
    r["reasons"][0]["detail"] = "a|b"
    assert "a\\|b" in rt.markdown(r) and "| a|b |" not in rt.markdown(r)


def test_cli_on_a_git_repo(tmp_path):
    def git(*args):
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=tmp_path, check=True,
                       capture_output=True)
    env_rules = tmp_path / "rules.yml"
    env_rules.write_text((HERE.parent / "risk.yml").read_text(encoding="utf-8"), encoding="utf-8")
    git("init", "-q", "-b", "main")
    (tmp_path / "README.md").write_text("a\n")
    git("add", "."); git("commit", "-qm", "base")
    git("checkout", "-qb", "pr")
    (tmp_path / "README.md").write_text("a\nb\n")
    git("commit", "-qam", "docs")
    cwd = os.getcwd()
    os.chdir(tmp_path)
    try:
        out = tmp_path / "out.json"
        assert rt.main(["--rules", str(env_rules), "--base", "main", "--head", "pr", "--json", str(out)]) == 0
    finally:
        os.chdir(cwd)
    assert json.loads(out.read_text())["tier"] == "T0"


# ---------------------------------------------------------------- ways around the tier


def _pr_repo(tmp_path, base_files, pr_files, rules_text=None):
    """A repo with `base_files` on main and `pr_files` changed on branch pr; the tier of pr."""
    def git(*args):
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=tmp_path, check=True,
                       capture_output=True)

    def write(files):
        for name, text in files.items():
            p = tmp_path / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8")

    rules = tmp_path.parent / f"{tmp_path.name}-rules.yml"
    rules.write_text(rules_text or (HERE.parent / "risk.yml").read_text(encoding="utf-8"), encoding="utf-8")
    git("init", "-q", "-b", "main")
    write(base_files)
    git("add", "-A"); git("commit", "-qm", "base")
    git("checkout", "-qb", "pr")
    write(pr_files)
    git("add", "-A"); git("commit", "-qm", "pr")
    cwd = os.getcwd()
    os.chdir(tmp_path)
    try:
        out = tmp_path.parent / f"{tmp_path.name}-out.json"
        assert rt.main(["--rules", str(rules), "--base", "main", "--head", "pr", "--json", str(out)]) == 0
    finally:
        os.chdir(cwd)
    return json.loads(out.read_text())


@pytest.mark.parametrize("name", [".github/workflows/ré.yml", '.github/workflows/a"b.yml',
                                  ".github/workflows/a\tb.yml"])
def test_a_workflow_with_a_quoted_name_is_still_a_workflow(tmp_path, name):
    # git quotes such a path in the diff header ("a/...") and the parser lost it, so it was T1
    r = _pr_repo(tmp_path, {"README.md": "a\n"},
                 {name: "on: pull_request_target\njobs: {}\n"})
    assert r["tier"] == "T2-hard"


def test_a_path_with_space_b_slash_is_read_whole(tmp_path):
    # "diff --git a/scripts/x b/docs/y.md b/scripts/x b/docs/y.md" read as docs/y.md, so it was T0.
    # The real path is under scripts/, which this repo does not count as docs; the tail is.
    r = _pr_repo(tmp_path, {"README.md": "a\n"}, {"scripts/x b/docs/y.md": "rules\n"})
    assert r["tier"] == "T1"


def test_gitattributes_cannot_hide_added_lines(tmp_path):
    # `-diff` made git print "Binary files differ", so the HOLD scan saw no added line
    rules = (HERE.parent / "risk.yml").read_text(encoding="utf-8").replace(
        "forbidden_text: []", 'forbidden_text: ["vendorx"]')
    r = _pr_repo(tmp_path, {"hooks/gate.ts": "a\n"},
                 {".gitattributes": "*.ts -diff\n", "hooks/gate.ts": "a\ninstall vendorx\n"}, rules)
    assert r["tier"] == "HOLD"


def test_a_changed_assertion_is_t1():
    # one assertion out, one weaker one in: the net count was 0, so it was T0
    r = tier(f("tests/gate.test.ts", ["  expect(true).toBe(true)"], ["  expect(deny(cmd)).toBe(true)"]))
    assert r["tier"] == "T1" and r["reasons"][0]["rule"] == "assertions-removed"


@pytest.mark.parametrize("line", ["test.skip('denies', () => {", "describe.only('gate', () => {",
                                  "  it.todo('denies')", "@pytest.mark.skip", "xit('denies', () => {"])
def test_a_skipped_test_is_t1(line):
    r = tier(f("tests/gate.test.ts", [line, "  expect(1).toBe(1)"]))
    assert r["tier"] == "T1" and r["reasons"][0]["rule"] == "tests-skipped"


def test_a_diff_that_git_lists_otherwise_is_t2_hard():
    change = rt.Change(files=[f("README.md", ["x"])], problem="git lists 2 changed files and its diff shows 1")
    r = rt.classify(change, RULES)
    assert r["tier"] == "T2-hard" and r["reasons"][0]["rule"] == "unreadable-diff"


def test_parse_name_status_reads_raw_paths():
    out = rt.parse_name_status("M\0a b/c.md\0R087\0old.py\0new.py\0A\0ré\t.yml\0")
    assert out == [("M", None, "a b/c.md"), ("R", "old.py", "new.py"), ("A", None, "ré\t.yml")]


def test_parse_diff_splits_on_newline_only():
    diff = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-old\n+keep\u2028me\n"
    files = rt.parse_diff(diff)
    assert files[0].added == ["keep\u2028me"]


# ---------------------------------------------------------------- reviewer signal and config


@pytest.mark.parametrize("path", ["greptile.json", "dir/greptile.json", ".greptile/config.json",
                                  ".greptile/a/b.json", ".coderabbit.yaml", ".coderabbit.yml",
                                  "nested/.coderabbit.yml"])
def test_reviewer_config_is_t2_hard(path):
    assert tier(f(path, ["x"]))["tier"] == "T2-hard"


def _soft_path():
    soft = RULES.get("soft") or []
    if not soft:
        pytest.skip("this repo lists no sensitive files")
    return soft[0].replace("**/", "").replace("/**", "/x")


def test_passing_greptile_check_does_not_lower_the_tier():
    checks, comments, reviews = passed_evidence()
    assert rt.reviewer_passed(checks, HEAD, comments, reviews) is True
    assert tier(f("README.md", ["x"]), checks=checks, head_sha=HEAD, comments=comments, review_comments=reviews)["tier"] == "T0"
    assert tier(f("src/a.py", ["x"]), checks=checks, head_sha=HEAD, comments=comments, review_comments=reviews)["tier"] == "T1"
    assert tier(f(_soft_path(), ["x"]), checks=checks, head_sha=HEAD, comments=comments, review_comments=reviews)["tier"] == "T2-soft"
    hard = tier(f(".github/risk.yml", ["x"]), checks=checks, head_sha=HEAD, comments=comments, review_comments=reviews)
    assert hard["tier"] == "T2-hard" and hard["reviewer"] == "passed"
    held = tier(f("src/a.py", ["x"]), title="Prune redundant comments", checks=checks, head_sha=HEAD,
                comments=comments, review_comments=reviews)
    assert held["tier"] == "HOLD"


def test_not_passed_raises_exactly_one_step():
    missing = []
    assert tier(f("README.md", ["x"]), checks=missing, head_sha=HEAD)["tier"] == "T1"
    assert tier(f("src/a.py", ["x"]), checks=missing, head_sha=HEAD)["tier"] == "T2-soft"
    assert tier(f(_soft_path(), ["x"]), checks=missing, head_sha=HEAD)["tier"] == "T2-hard"
    assert tier(f(".github/risk.yml", ["x"]), checks=missing, head_sha=HEAD)["tier"] == "T2-hard"
    held = tier(f("src/a.py", ["x"]), title="Prune redundant comments", checks=missing, head_sha=HEAD)
    assert held["tier"] == "HOLD"


@pytest.mark.parametrize("conclusion", ["neutral", "failure", "cancelled", "timed_out", "action_required",
                                        "startup_failure", "stale"])
def test_non_success_conclusion_is_not_passed_and_raises(conclusion):
    checks = [greptile(conclusion=conclusion)]
    assert rt.reviewer_passed(checks, HEAD) is False
    docs = tier(f("README.md", ["x"]), checks=checks, head_sha=HEAD)
    assert docs["tier"] == "T1" and docs["reasons"][0]["rule"] == "reviewer-not-passed"
    assert docs["reviewer"] == "not-passed"


def test_missing_greptile_check_raises():
    assert rt.reviewer_passed([], HEAD) is False
    r = tier(f("README.md", ["x"]), checks=[], head_sha=HEAD)
    assert r["tier"] == "T1" and r["reviewer"] == "not-passed"


@pytest.mark.parametrize("status", ["queued", "in_progress", "pending"])
def test_pending_greptile_check_raises(status):
    checks = [greptile(status=status, conclusion=None)]
    assert rt.reviewer_passed(checks, HEAD) is False
    assert tier(f("README.md", ["x"]), checks=checks, head_sha=HEAD)["tier"] == "T1"
    # a success conclusion that has not completed is still not a pass
    unfinished = [greptile(status="in_progress", conclusion="success")]
    assert rt.reviewer_passed(unfinished, HEAD) is False
    assert tier(f("README.md", ["x"]), checks=unfinished, head_sha=HEAD)["tier"] == "T1"


def test_greptile_check_from_the_wrong_app_raises():
    checks = [greptile(slug="someone-else")]
    assert rt.reviewer_passed(checks, HEAD) is False
    assert tier(f("README.md", ["x"]), checks=checks, head_sha=HEAD)["tier"] == "T1"


def test_greptile_check_on_an_old_sha_raises():
    old = "b" * 40
    assert rt.reviewer_passed([greptile(head_sha=old)], HEAD) is False
    assert tier(f("README.md", ["x"]), checks=[greptile(head_sha=old)], head_sha=HEAD)["tier"] == "T1"
    assert tier(f("README.md", ["x"]), checks=[greptile(conclusion="failure", head_sha=old)], head_sha=HEAD)["tier"] == "T1"
    # a success on this head is a pass even if an older commit failed, once the summary qualifies
    checks, comments, reviews = passed_evidence()
    assert rt.reviewer_passed([greptile(conclusion="failure", head_sha=old), *checks], HEAD, comments, reviews) is True
    assert tier(f("README.md", ["x"]), checks=[greptile(head_sha=old), *checks], head_sha=HEAD,
                comments=comments, review_comments=reviews)["tier"] == "T0"
    # the same success without a summary is not a pass
    assert rt.reviewer_passed([greptile(conclusion="failure", head_sha=old), greptile()], HEAD) is False
    # a success on an older commit does not cover a failure on this head
    current_fail = [greptile(head_sha=old), greptile(conclusion="failure")]
    assert rt.reviewer_passed(current_fail, HEAD) is False
    assert tier(f("README.md", ["x"]), checks=current_fail, head_sha=HEAD)["tier"] == "T1"


def test_a_comment_or_label_is_not_the_reviewer_signal():
    checks = [{"name": "Greptile Review", "body": "LGTM", "labels": ["risk:t0"],
               "head_sha": HEAD, "app": {"slug": "greptile-apps"}}]
    assert rt.reviewer_passed(checks, HEAD) is False
    assert tier(f("README.md", ["x"]), checks=checks, head_sha=HEAD)["tier"] == "T1"


def _pr47():
    comments = json.loads((HERE / "fixtures" / "greptile-pr-47-summary.json").read_text(encoding="utf-8"))
    reviews = json.loads((HERE / "fixtures" / "greptile-pr-47-inline.json").read_text(encoding="utf-8"))
    return comments, reviews


def test_real_pr_47_fixtures_keep_the_blocking_evidence():
    comments, reviews = _pr47()
    body = next(c["body"] for c in comments if c["user"]["login"] == "greptile-apps[bot]")
    assert "<!-- greptile_summary -->" in body
    assert "Confidence Score: 0/5" in body
    assert PR47 in body
    assert body.count('alt="P1"') == 3
    on_head = [c for c in reviews if c["commit_id"] == PR47 and 'alt="P1"' in c["body"]]
    assert len(on_head) == 3
    assert any('alt="P2"' in c["body"] and c["commit_id"] != PR47 for c in reviews)


def test_real_pr_47_success_check_is_not_a_pass():
    """claude-code-mode#47 @5075dbc: the check concluded success, the summary was 0/5, and three P1s landed."""
    comments, reviews = _pr47()
    checks = [greptile(head_sha=PR47)]
    assert rt.reviewer_passed(checks, PR47, comments, reviews) is False
    docs = tier(f("README.md", ["x"]), checks=checks, head_sha=PR47, comments=comments, review_comments=reviews)
    assert docs["tier"] == "T1" and docs["reviewer"] == "not-passed"


def test_a_five_of_five_summary_that_lists_badges_passes_without_inline_comments():
    comments, _reviews = _pr47()
    copied = json.loads(json.dumps(comments))
    for comment in copied:
        if comment["user"]["login"] == "greptile-apps[bot]":
            comment["body"] = comment["body"].replace("Confidence Score: 0/5", "Confidence Score: 5/5")
    checks = [greptile(head_sha=PR47)]
    assert rt.reviewer_passed(checks, PR47, copied, []) is True
    assert tier(f("README.md", ["x"]), checks=checks, head_sha=PR47, comments=copied, review_comments=[])["tier"] == "T0"


@pytest.mark.parametrize("score", ["4/5", "5/5"])
def test_high_confidence_without_blocking_comments_passes(score):
    checks, comments, reviews = passed_evidence(score)
    assert rt.reviewer_passed(checks, HEAD, comments, reviews) is True
    assert tier(f("README.md", ["x"]), checks=checks, head_sha=HEAD, comments=comments, review_comments=reviews)["tier"] == "T0"
    hard = tier(f(".github/risk.yml", ["x"]), checks=checks, head_sha=HEAD, comments=comments, review_comments=reviews)
    assert hard["tier"] == "T2-hard"
    held = tier(f("src/a.py", ["x"]), title="Prune redundant comments", checks=checks, head_sha=HEAD,
                comments=comments, review_comments=reviews)
    assert held["tier"] == "HOLD"


def test_score_three_raises():
    checks, comments, reviews = passed_evidence("3/5")
    assert rt.reviewer_passed(checks, HEAD, comments, reviews) is False
    docs = tier(f("README.md", ["x"]), checks=checks, head_sha=HEAD, comments=comments, review_comments=reviews)
    assert docs["tier"] == "T1" and docs["reviewer"] == "not-passed"


def test_summary_on_an_old_sha_raises():
    checks = [greptile()]
    comments = [summary(head_sha="b" * 40)]
    assert rt.reviewer_passed(checks, HEAD, comments, []) is False
    assert tier(f("README.md", ["x"]), checks=checks, head_sha=HEAD, comments=comments, review_comments=[])["tier"] == "T1"


def test_no_summary_raises():
    checks = [greptile()]
    assert rt.reviewer_passed(checks, HEAD, [], []) is False
    assert rt.reviewer_passed(checks, HEAD) is False
    assert tier(f("README.md", ["x"]), checks=checks, head_sha=HEAD, comments=[], review_comments=[])["tier"] == "T1"


@pytest.mark.parametrize("score", ["high", "4/4", "6/5", ""])
def test_unparseable_score_raises(score):
    checks = [greptile()]
    comments = [summary(score)]
    assert rt.reviewer_passed(checks, HEAD, comments, []) is False
    bare = [summary("5/5", marker=False)]
    assert rt.reviewer_passed(checks, HEAD, bare, []) is False
    assert tier(f("README.md", ["x"]), checks=checks, head_sha=HEAD, comments=comments)["tier"] == "T1"


def test_p0_inline_on_the_head_blocks_a_five():
    checks, comments, _reviews = passed_evidence()
    reviews = [inline("P0")]
    assert rt.reviewer_passed(checks, HEAD, comments, reviews) is False
    docs = tier(f("README.md", ["x"]), checks=checks, head_sha=HEAD, comments=comments, review_comments=reviews)
    assert docs["tier"] == "T1" and docs["reviewer"] == "not-passed"


def test_p1_on_an_old_commit_does_not_block():
    checks, comments, _reviews = passed_evidence()
    reviews = [inline("P1", commit_id="b" * 40)]
    assert rt.reviewer_passed(checks, HEAD, comments, reviews) is True
    assert tier(f("README.md", ["x"]), checks=checks, head_sha=HEAD, comments=comments, review_comments=reviews)["tier"] == "T0"


def test_p2_on_the_head_does_not_block():
    checks, comments, _reviews = passed_evidence()
    assert rt.reviewer_passed(checks, HEAD, comments, [inline("P2")]) is True


def test_the_latest_summary_wins():
    checks = [greptile()]
    older = summary("0/5", updated="2026-10-19T10:00:00Z")
    newer = summary("5/5", updated="2026-10-19T12:00:00Z")
    assert rt.reviewer_passed(checks, HEAD, [older, newer], []) is True
    rolled_back = summary("0/5", updated="2026-10-19T13:00:00Z")
    assert rt.reviewer_passed(checks, HEAD, [newer, rolled_back], []) is False


def test_the_right_text_from_another_author_is_not_a_pass():
    checks = [greptile()]
    for comment in (summary(login="gabe-bots[bot]"), summary(kind="User")):
        assert rt.reviewer_passed(checks, HEAD, [comment], []) is False
        assert tier(f("README.md", ["x"]), checks=checks, head_sha=HEAD, comments=[comment])["tier"] == "T1"
    # the same author's text is a pass, and another author's P0 does not block it
    good = [summary()]
    reviews = [inline("P0", login="gabe-bots[bot]"), inline("P1", kind="User")]
    assert rt.reviewer_passed(checks, HEAD, good, reviews) is True


def test_a_failed_check_with_a_good_comment_is_not_a_pass():
    _checks, comments, reviews = passed_evidence()
    checks = [greptile(conclusion="failure")]
    assert rt.reviewer_passed(checks, HEAD, comments, reviews) is False
    docs = tier(f("README.md", ["x"]), checks=checks, head_sha=HEAD, comments=comments, review_comments=reviews)
    assert docs["tier"] == "T1" and docs["reviewer"] == "not-passed"


def test_a_short_sha_in_the_summary_does_not_match():
    checks = [greptile()]
    comments = [summary(head_sha=HEAD[:7])]
    assert rt.reviewer_passed(checks, HEAD, comments, []) is False


def test_cli_applies_a_checks_file(tmp_path):
    def git(*args):
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=tmp_path, check=True,
                       capture_output=True)
    rules = tmp_path.parent / f"{tmp_path.name}-rules.yml"
    rules.write_text((HERE.parent / "risk.yml").read_text(encoding="utf-8"), encoding="utf-8")
    git("init", "-q", "-b", "main")
    (tmp_path / "README.md").write_text("a\n")
    git("add", "-A"); git("commit", "-qm", "base")
    git("checkout", "-qb", "pr")
    (tmp_path / "README.md").write_text("a\nb\n")
    git("commit", "-qam", "docs")
    head = subprocess.run(["git", "rev-parse", "pr"], cwd=tmp_path, check=True, capture_output=True, text=True).stdout.strip()
    checks = tmp_path.parent / f"{tmp_path.name}-checks.json"
    checks.write_text(json.dumps([greptile(conclusion="failure", head_sha=head)]), encoding="utf-8")
    good_checks = tmp_path.parent / f"{tmp_path.name}-good-checks.json"
    good_checks.write_text(json.dumps([greptile(head_sha=head)]), encoding="utf-8")
    comments = tmp_path.parent / f"{tmp_path.name}-comments.json"
    comments.write_text(json.dumps([summary(head_sha=head)]), encoding="utf-8")
    reviews = tmp_path.parent / f"{tmp_path.name}-reviews.json"
    reviews.write_text(json.dumps([inline("P0", commit_id=head)]), encoding="utf-8")
    meta = tmp_path.parent / f"{tmp_path.name}-pr.json"
    meta.write_text(json.dumps({"title": "docs", "branch": "pr", "body": ""}), encoding="utf-8")
    cwd = os.getcwd()
    os.chdir(tmp_path)
    try:
        out = tmp_path.parent / f"{tmp_path.name}-out.json"
        assert rt.main(["--rules", str(rules), "--base", "main", "--head", head, "--pr-json", str(meta),
                        "--checks-file", str(checks), "--json", str(out)]) == 0
        failed = json.loads(out.read_text())
        assert rt.main(["--rules", str(rules), "--base", "main", "--head", head, "--pr-json", str(meta),
                        "--checks-file", str(good_checks), "--comments-file", str(comments),
                        "--review-comments-file", str(reviews), "--json", str(out)]) == 0
        blocked = json.loads(out.read_text())
        reviews.write_text("[]", encoding="utf-8")
        assert rt.main(["--rules", str(rules), "--base", "main", "--head", head, "--pr-json", str(meta),
                        "--checks-file", str(good_checks), "--comments-file", str(comments),
                        "--review-comments-file", str(reviews), "--json", str(out)]) == 0
        clean = json.loads(out.read_text())
    finally:
        os.chdir(cwd)
    assert failed["tier"] == "T1" and failed["reviewer"] == "not-passed"
    assert blocked["tier"] == "T1" and blocked["reviewer"] == "not-passed"
    assert clean["tier"] == "T0" and clean["reviewer"] == "passed"


def test_pull_request_target_workflows_do_not_reference_secrets():
    workflows = HERE.parent / "workflows"
    assert not (workflows / "review.yml").exists()
    for path in workflows.glob("*.yml"):
        text = path.read_text(encoding="utf-8")
        if "pull_request_target" in text:
            assert "secrets." not in text, path.name
