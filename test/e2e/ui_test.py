#!/usr/bin/env python3
"""Revspan UI test (Playwright for Python, no pytest), against the real server wired to the fake Bitbucket.

Normal launch (after "npx --no-install vite build"):
    node test/e2e/run-against-fake.ts

run-against-fake.ts starts the fake Bitbucket and the server, then runs this script with:
    REVSPAN_BASE_URL    URL of the Revspan server (required).
    REVSPAN_CALLS_URL   Log of the writes received by the fake Bitbucket (GET -> JSON array).
    REVSPAN_PR          Main PR, "workspace/repo/id" (acme/demo-repo/42).
    REVSPAN_FAKE_PRS    JSON of the fake Bitbucket's PRs: main, long, rebaseOnly, mine, neverReviewed, others, purged.
    REVSPAN_FAKE_EMAIL, REVSPAN_FAKE_TOKEN   Credentials of the fake Bitbucket (token put back after deletion).
Options:
    REVSPAN_SHOTS_DIR   Screenshots folder (default: <tmp>/revspan-shots).
    REVSPAN_FIXED_TIME  Frozen browser time (ISO).
    REVSPAN_HEADED=1    Visible browser.

A single server for the whole script: each check sees the writes of the previous ones (order matters).
Exits with a non-zero code if a check fails.
"""
import json
import os
import re
import sys
import tempfile
import time
import traceback
import urllib.request

from playwright.sync_api import expect, sync_playwright

BASE = os.environ.get('REVSPAN_BASE_URL', '').rstrip('/')
CALLS_URL = os.environ.get('REVSPAN_CALLS_URL')
MAIN_PR = os.environ.get('REVSPAN_PR', 'acme/demo-repo/42')
FAKE_PRS = json.loads(os.environ.get('REVSPAN_FAKE_PRS', '{}'))
FAKE_TOKEN = os.environ.get('REVSPAN_FAKE_TOKEN', '')
SHOTS = os.environ.get('REVSPAN_SHOTS_DIR') or os.path.join(tempfile.gettempdir(), 'revspan-shots')
CHROMIUM_ARGS = ['--use-mock-keychain', '--password-store=basic']
MINUS = '−'

results = []


def log(msg):
    print(msg, flush=True)


def check(name):
    """Decorator: runs a check, logs PASS/FAIL, continues on failure (with a screenshot)."""
    def wrap(fn):
        def run(page):
            try:
                fn(page)
                results.append((name, True))
                log(f'PASS  {name}')
            except Exception as error:  # noqa: BLE001 — on veut tout journaliser
                results.append((name, False))
                log(f'FAIL  {name}\n      {str(error).splitlines()[0] if str(error) else repr(error)}')
                if os.environ.get('REVSPAN_DEBUG'):
                    traceback.print_exc()
                try:
                    os.makedirs(SHOTS, exist_ok=True)
                    slug = re.sub(r'[^\w-]+', '_', name)[:60]
                    page.screenshot(path=os.path.join(SHOTS, f'FAIL-{slug}.png'))
                except Exception:  # noqa: BLE001
                    pass
        return run
    return wrap


def http_json(url):
    with urllib.request.urlopen(url, timeout=60) as res:
        return json.loads(res.read().decode() or 'null')


def api(path):
    return http_json(f'{BASE}/api{path}')


def pr_api(ref):
    ws, repo, pid = ref.split('/')
    return f'/pr/{ws}/{repo}/{pid}'


def fake_ref(key):
    ws, repo, _ = MAIN_PR.split('/')
    return f'{ws}/{repo}/{FAKE_PRS[key]}'


def url(hash_part=''):
    return f'{BASE}/#/{hash_part}'


# ---------------------------------------------------------------------------
# Log of the writes of the fake Bitbucket (Bitbucket 2.0 API format)
# ---------------------------------------------------------------------------

class Calls:
    def __init__(self, calls_url):
        self.url = calls_url
        self.mark = 0

    def all(self):
        return http_json(self.url) if self.url else []

    def start(self):
        self.mark = len(self.all())

    def wait(self, predicate, desc, timeout=8.0):
        if not self.url:
            log(f'      (call log missing: "{desc}" not checked)')
            return None
        deadline = time.time() + timeout
        seen = []
        while time.time() < deadline:
            seen = self.all()[self.mark:]
            for call in seen:
                if predicate(call):
                    return call
            time.sleep(0.1)
        raise AssertionError(f'expected call missing: {desc}; received: {json.dumps(seen, ensure_ascii=False)[:600]}')


calls = Calls(CALLS_URL)


def body_of(call):
    return call.get('body') or {}


def is_post_comment(call):
    return call['method'] == 'POST' and call['path'].endswith('/comments')


def comment_raw(call):
    return (body_of(call).get('content') or {}).get('raw')


def comment_parent(call):
    return (body_of(call).get('parent') or {}).get('id')


# ---------------------------------------------------------------------------
# Expectations
# ---------------------------------------------------------------------------

def expected_default(n, lr):
    if lr is not None and 1 <= lr < n:
        return lr, n
    if lr is not None and lr >= n and n > 1:
        return n - 1, n
    return 0, n


def readout_bold(frm, to):
    if frm == 0:
        return f'v{to} complète'
    if to - frm == 1:
        return f'Changements de v{to}'
    return f'Changements de v{frm + 1} à v{to}'


def readout(page):
    return page.locator('.rv-readout')


def wait_pr_ready(page):
    expect(page.locator('.rv-track .rv-v')).not_to_have_count(0, timeout=20000)
    expect(page.locator('.rv-tabs')).to_be_visible()
    page.wait_for_function('() => !document.querySelector(".rv-body.loading") && !document.querySelector(".rv-loading")', timeout=20000)


def open_pr(page, ref, query=''):
    page.goto(url(f'pr/{ref}{query}'))
    wait_pr_ready(page)


def current_selection(page):
    h = page.evaluate('location.hash')
    q = h.split('?', 1)[1] if '?' in h else ''
    params = dict(p.split('=', 1) for p in q.split('&') if '=' in p)
    return int(params.get('from', -1)), int(params.get('to', -1))


def expect_selection(page, frm, to):
    expect(page).to_have_url(re.compile(f'[?&]from={frm}&to={to}$'))


def wait_api(predicate, desc, timeout=8.0):
    deadline = time.time() + timeout
    while not predicate():
        if time.time() > deadline:
            raise AssertionError(f'expected server state missing: {desc}')
        time.sleep(0.1)


# ---------------------------------------------------------------------------
# Screenshots (before the writes)
# ---------------------------------------------------------------------------

def screenshots(browser, fixed_time):
    os.makedirs(SHOTS, exist_ok=True)
    targets = [('home', ''), ('pr', f'pr/{MAIN_PR}')]
    if FAKE_PRS:
        targets += [('pr-long', f'pr/{fake_ref("long")}'), ('pr-fast', f'pr/{fake_ref("rebaseOnly")}')]
    targets.append(('settings', 'settings'))
    for scheme in ('light', 'dark'):
        for width in (1440, 1024):
            context = browser.new_context(viewport={'width': width, 'height': 900}, color_scheme=scheme, locale='fr-FR', timezone_id='Europe/Paris')
            page = context.new_page()
            if fixed_time:
                page.clock.set_fixed_time(fixed_time)
            for name, hash_part in targets:
                page.goto(url(hash_part))
                if name.startswith('pr'):
                    wait_pr_ready(page)
                    page.wait_for_timeout(300)
                else:
                    page.wait_for_timeout(800)
                page.screenshot(path=os.path.join(SHOTS, f'{name}-{scheme}-{width}.png'))
                if name != 'pr':
                    continue
                page.evaluate('() => { const f = document.querySelector(".rv-diff .rv-file:not(.folded)") || document.querySelector(".rv-diff .rv-file");'
                              ' if (f) window.scrollTo(0, f.getBoundingClientRect().top + scrollY - parseInt(getComputedStyle(document.documentElement).getPropertyValue("--tl-h")) + 60); }')
                page.wait_for_timeout(200)
                page.screenshot(path=os.path.join(SHOTS, f'pr-scrolled-{scheme}-{width}.png'))
                page.evaluate('window.scrollTo(0, 0)')
                page.click('.rv-tab[data-tab="discussions"]')
                page.wait_for_timeout(200)
                page.screenshot(path=os.path.join(SHOTS, f'pr-discussions-{scheme}-{width}.png'), full_page=True)
                page.click('.rv-tab[data-tab="versions"]')
                page.wait_for_timeout(200)
                page.screenshot(path=os.path.join(SHOTS, f'pr-versions-{scheme}-{width}.png'))
                page.click('.rv-tab[data-tab="diff"]')
                page.locator('.rv-seg button[data-seg="split"]').click()
                page.wait_for_timeout(200)
                page.screenshot(path=os.path.join(SHOTS, f'pr-split-{scheme}-{width}.png'), full_page=True)
                page.locator('.rv-seg button[data-seg="unified"]').click()
            context.close()
    log(f'      screenshots in {SHOTS}')


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

def run_checks(page):
    data = api(pr_api(MAIN_PR))
    n = len(data['versions'])
    lr = data['review']['lastReviewed']
    me = data['me'] or {}
    exp_from, exp_to = expected_default(n, lr)
    by_id = {t['id']: t for t in data['threads']}
    # my inline thread, still open
    my_thread = next((t for t in data['threads'] if t['path'] and not t['resolved'] and t['comments'][0]['mine']), None)

    @check('home: groups and cards (before opening the PRs)')
    def home(page):
        page.goto(url(''))
        expect(page.locator('.rv-list').first).to_be_visible(timeout=20000)
        card = page.locator(f'.rv-row[data-pr="{MAIN_PR}"]')
        expect(card).to_contain_text(data['pr']['title'])
        if FAKE_PRS:
            expect(page.locator('section[data-group="to-do"]')).to_contain_text(data['pr']['title'])
            expect(card).to_contain_text(f'+{n - lr} versions')
            expect(card).to_contain_text('💬 2 nouveaux')
            expect(page.locator(f'section[data-group="mine"] .rv-row[data-pr="{fake_ref("mine")}"]')).to_contain_text('toi')
            others = page.locator('details[data-group="others"]')
            assert not others.evaluate('d => d.open'), '"Autres PR ouvertes" must be collapsed when the user is known'
            others.locator('summary').click()
            light = others.locator(f'.rv-row[data-pr="{fake_ref("others")}"]')
            expect(light.locator('.rv-nb')).to_have_text('pas encore relue')  # versionsCount null : pas de nombre
    home(page)

    @check('opening the PR from the home page, default range')
    def open_main(page):
        page.locator(f'.rv-row[data-pr="{MAIN_PR}"]').click()
        wait_pr_ready(page)
        expect(page.locator('.rv-track .rv-v:not(.base)')).to_have_count(n)
        expect(readout(page)).to_contain_text(readout_bold(exp_from, exp_to))
        assert current_selection(page) == (exp_from, exp_to), page.evaluate('location.hash')
        if FAKE_PRS:
            expect(readout(page)).to_have_text('Changements de v3 à v6 · par rapport à v2 · code modifié en v5 · 2 rebases')
            expect(page.locator('.rv-v[data-i="3"] .rv-dl')).to_have_text('rebase seul')
            expect(page.locator('.rv-v[data-i="5"] .rv-dl')).to_have_text(f'+1 {MINUS}1')
            expect(page.locator('.rv-v[data-i="6"]')).to_have_class(re.compile(r'\bnew\b'))
            expect(page.locator('.rv-seen')).to_have_count(1)
            expect(page.locator('.rv-appr')).to_contain_text('Yann Bernard · sur v6')
            expect(page.locator('.rv-appr')).to_contain_text('○ toi')
            expect(page.locator('.rv-banner[data-banner="since"]')).to_contain_text('Depuis ta relecture de v2')
            expect(page.locator('.rv-banner')).to_contain_text('4 versions, dont 1 touche du code')
            expect(page.locator('.rv-banner')).to_contain_text('message du commit modifié')
            expect(page.locator('.rv-preset.on[data-preset="since"]')).to_be_visible()
    open_main(page)

    @check('click on a version = what it changed')
    def click_version(page):
        page.click('.rv-v[data-i="4"]')
        expect(readout(page)).to_have_text('Changements de v4 · par rapport à v3 · aucun changement de code')
        assert current_selection(page) == (3, 4)
    click_version(page)

    @check('Shift+click: extend, then move the closest bound')
    def shift_click(page):
        page.click(f'.rv-v[data-i="{n}"]', modifiers=['Shift'])
        expect(readout(page)).to_contain_text(f'Changements de v4 à v{n} · par rapport à v3')
        page.click('.rv-v[data-i="2"]')
        page.click('.rv-v[data-i="6"]', modifiers=['Shift'])
        expect(readout(page)).to_contain_text('Changements de v2 à v6 · par rapport à v1')
        page.click('.rv-v[data-i="3"]', modifiers=['Shift'])  # 3-1 <= 6-3: "from" is closer -> from = 2
        expect(readout(page)).to_contain_text('Changements de v3 à v6 · par rapport à v2')
        page.click('.rv-v[data-i="5"]', modifiers=['Shift'])  # 5-2 > 6-5: "to" is closer -> to = 5
        expect(readout(page)).to_contain_text('Changements de v3 à v5 · par rapport à v2')
        assert current_selection(page) == (2, 5)
    shift_click(page)

    @check('"All vs master" preset')
    def all_vs_master(page):
        page.click('.rv-preset[data-preset="all"]')
        cmp = api(f'{pr_api(MAIN_PR)}/compare?from=0&to={n}&context=3')
        stats = cmp['stats']
        expect(readout(page)).to_have_text(f'v{n} complète · par rapport à sa base sur master · {stats["files"]} fichiers, +{stats["added"]} {MINUS}{stats["removed"]}')
        expect(page.locator('.rv-preset.on[data-preset="all"]')).to_be_visible()
        expect(page.locator('.rv-diff .rv-file')).to_have_count(len(cmp['files']))
    all_vs_master(page)

    @check('hide rebase-only and deps: keeps the reviewed version and the bounds')
    def hide_no_code(page):
        page.click('.rv-preset[data-preset="last"]')  # v5 → v6
        page.check('#hide-no-code')
        for i in (lr, n - 1, n):
            expect(page.locator(f'.rv-v[data-i="{i}"]')).to_be_visible()
        expect(page.locator('.rv-v[data-i="3"]')).to_have_count(0)  # rebase seul
        expect(page.locator('.rv-v[data-i="4"]')).to_have_count(0)  # deps
        tick = page.locator('.rv-tick')
        expect(tick).to_have_text('⋯2')
        tick.click()  # click = show everything again
        expect(page.locator('#hide-no-code')).not_to_be_checked()
        expect(page.locator('.rv-v[data-i="3"]')).to_be_visible()
    hide_no_code(page)

    # From here on: default range (since my review).
    open_pr(page, MAIN_PR, f'?from={exp_from}&to={exp_to}')
    cmp = api(f'{pr_api(MAIN_PR)}/compare?from={exp_from}&to={exp_to}&context=3')
    thread_sel = f'.rv-diff .rv-th[data-thread="{my_thread["id"]}"]' if my_thread else '.rv-diff .rv-th:not([data-resolved])'
    code_file = next(f for f in cmp['files'] if f['category'] == 'code')

    @check('diff: files, placed thread (modified line), hunk header, hidden master files')
    def diff_view(page):
        expect(page.locator('.rv-diff .rv-file')).to_have_count(len(cmp['files']))
        assert my_thread, 'no open thread of mine in the PR'
        placement = next(p for f in cmp['files'] for p in f['threads'] if p['threadId'] == my_thread['id'])
        expect(page.locator(thread_sel)).to_contain_text(my_thread['comments'][0]['raw'])
        expect(page.locator(thread_sel)).to_contain_text(f'Posté sur v{my_thread["version"]} · ligne {my_thread["anchor"]["to"]}')
        if placement['moved']:
            expect(page.locator(f'{thread_sel} .rv-moved')).to_have_text('ligne modifiée depuis')
        previous = page.evaluate(f'() => document.querySelector(\'{thread_sel}\').previousElementSibling.dataset.n')
        assert previous == str(placement['line']), f'the thread should follow line {placement["line"]}, follows {previous}'
        header = code_file['hunks'][0]['header']
        block = page.locator(f'.rv-file[data-path="{code_file["path"]}"]')
        if header:
            expect(block.locator('.rv-hunk .hh').first).to_have_text(header)
        resolved = [p['threadId'] for f in cmp['files'] for p in f['threads'] if by_id[p['threadId']]['resolved']]
        for tid in resolved:
            expect(page.locator(f'.rv-diff .rv-th[data-thread="{tid}"]')).to_have_count(0)  # resolved ones hidden by default
        if cmp['masterOnly']:
            expect(page.locator('.rv-masked')).to_contain_text(f'{len(cmp["masterOnly"])} fichiers modifiés uniquement par master sont masqués')
        if cmp['messageChanged']:
            expect(page.locator('.rv-msgdiff')).to_contain_text('Message du commit modifié')
        expect(page.locator('.rv-prog')).to_contain_text(f'0 / {len(cmp["files"])} vus')
    diff_view(page)

    @check('"whole file" context then 3 lines')
    def full_context(page):
        before = page.locator('.rv-diff .rv-l').count()
        page.locator('.rv-seg button[data-seg="full"]').click()
        page.wait_for_function(f'() => !document.querySelector(".rv-body.loading") && document.querySelectorAll(".rv-diff .rv-l").length > {before}', timeout=10000)
        page.locator('.rv-seg button[data-seg="3"]').click()
        page.wait_for_function(f'() => !document.querySelector(".rv-body.loading") && document.querySelectorAll(".rv-diff .rv-l").length === {before}', timeout=10000)
    full_context(page)

    @check('inline comment (+ button, Cmd/Ctrl+Enter)')
    def inline_comment(page):
        line_no = next(ln['n'] for h in code_file['hunks'] for ln in h['lines'] if ln['t'] == ' ' and ln['n'] is not None)
        row = page.locator(f'.rv-file[data-path="{code_file["path"]}"] .rv-l[data-n="{line_no}"]').first
        row.hover()
        calls.start()
        row.locator('.rv-plus').click()
        composer = page.locator('.rv-comp textarea')
        expect(composer).to_be_focused()
        composer.fill('Commentaire de test en ligne')
        composer.press('ControlOrMeta+Enter')
        call = calls.wait(lambda c: is_post_comment(c) and (body_of(c).get('inline') or {}).get('to') == line_no, f'POST comments inline {code_file["path"]}:{line_no}')
        assert call is None or comment_raw(call) == 'Commentaire de test en ligne', call
        expect(page.locator('.rv-diff .rv-th', has_text='Commentaire de test en ligne')).to_be_visible(timeout=10000)
        expect(page.locator('.rv-comp')).to_have_count(0)
    inline_comment(page)

    @check('reply to a thread, then delete my reply')
    def reply_and_delete(page):
        assert my_thread, 'no open thread of mine'
        page.locator(f'{thread_sel} .rv-th-f textarea').fill('Merci, c\'est bon pour moi.')
        calls.start()
        page.locator(f'{thread_sel} [data-action="send-reply"]').click()
        calls.wait(lambda c: is_post_comment(c) and comment_parent(c) == my_thread['id'], f'POST comments parent={my_thread["id"]}')
        mine = page.locator(f'{thread_sel} .rv-cm', has_text='Merci, c\'est bon pour moi.')
        expect(mine).to_have_count(1, timeout=10000)
        cid = int(mine.get_attribute('data-comment'))
        calls.start()
        mine.locator('[data-action="delete"]').click()  # confirm() accepted by the dialog handler
        calls.wait(lambda c: c['method'] == 'DELETE' and c['path'].endswith(f'/comments/{cid}'), f'DELETE comments/{cid}')
        expect(page.locator(f'{thread_sel} .rv-cm', has_text='Merci, c\'est bon pour moi.')).to_have_count(0, timeout=10000)
    reply_and_delete(page)

    @check('comment on a deleted line (general comment with quote)')
    def deleted_line(page):
        target = next(((f['path'], ln['o'], ln['text']) for f in cmp['files'] for h in f['hunks'] for ln in h['lines'] if ln['t'] == '-'), None)
        assert target, 'no deleted line in the diff'
        path, old_no, code = target
        block = page.locator(f'.rv-file[data-path="{path}"]')
        row = block.locator(f'.rv-l.r[data-o="{old_no}"]').first
        row.hover()
        row.locator('.rv-plus').click()
        composer = page.locator('.rv-comp.old textarea')
        expect(composer).to_be_focused()
        composer.fill('Pourquoi supprimer cette ligne ?')
        calls.start()
        composer.press('ControlOrMeta+Enter')
        frm_label = 'master' if exp_from == 0 else f'v{exp_from}'
        expected_raw = f'`{path}` — ligne supprimée ({frm_label} → v{exp_to}) :\n```\n{code}\n```\nPourquoi supprimer cette ligne ?'
        calls.wait(lambda c: is_post_comment(c) and comment_raw(c) == expected_raw and not body_of(c).get('inline') and comment_parent(c) is None,
                   'POST general comment with quote')
        expect(page.locator('.rv-comp')).to_have_count(0, timeout=10000)
    deleted_line(page)

    @check('resolve a thread')
    def resolve(page):
        assert my_thread, 'no open thread of mine'
        calls.start()
        page.locator(f'{thread_sel} [data-action="resolve"]').click()
        calls.wait(lambda c: c['method'] == 'POST' and c['path'].endswith(f'/comments/{my_thread["id"]}/resolve'), f'POST comments/{my_thread["id"]}/resolve')
        expect(page.locator(thread_sel)).to_have_count(0, timeout=10000)
        page.check('#show-resolved')
        expect(page.locator(f'{thread_sel} .rv-th-bar')).to_contain_text('Fil résolu')
        page.uncheck('#show-resolved')
    resolve(page)

    @check('mark a file "Seen" (server local state)')
    def viewed(page):
        block = page.locator(f'.rv-file[data-path="{code_file["path"]}"]')
        block.locator('input[data-action="viewed"]').check()
        expect(block).to_have_class(re.compile(r'\bfolded\b'))
        expect(page.locator(f'.rv-f[data-path="{code_file["path"]}"] .ck.seen')).to_be_visible()
        expect(page.locator('.rv-prog')).to_contain_text(f'1 / {len(cmp["files"])} vus')
        wait_api(lambda: api(pr_api(MAIN_PR))['review']['viewed'].get(code_file['path']) == code_file['contentHash'], 'review.viewed updated')
    viewed(page)

    @check('request changes (toggle)')
    def request_changes(page):
        calls.start()
        page.click('[data-action="request-changes"]')
        calls.wait(lambda c: c['method'] == 'POST' and c['path'].endswith('/request-changes'), 'POST request-changes')
        expect(page.locator('[data-action="request-changes"]')).to_have_text('Modifs demandées ✕', timeout=10000)
        calls.start()
        page.click('[data-action="request-changes"]')
        calls.wait(lambda c: c['method'] == 'DELETE' and c['path'].endswith('/request-changes'), 'DELETE request-changes')
        expect(page.locator('[data-action="request-changes"]')).to_have_text('Demander des modifs', timeout=10000)
    request_changes(page)

    @check('approve')
    def approve(page):
        button = page.locator('[data-action="approve"]')
        expect(button).to_have_text(re.compile(f'Approuver v{n}$'))
        calls.start()
        button.click()
        calls.wait(lambda c: c['method'] == 'POST' and c['path'].endswith('/approve'), 'POST approve')
        expect(page.locator('[data-action="unapprove"]')).to_have_text('Retirer l\'approbation', timeout=10000)
        expect(page.locator('.rv-appr')).to_contain_text(f'toi · sur v{n}')
        expect(page.locator('.rv-banner')).to_contain_text(f'Tu es à jour : v{n} relue')
    approve(page)

    @check('Discussions tab: general comment, groups, "View in diff", sanitized HTML')
    def discussions(page):
        page.click('.rv-tab[data-tab="discussions"]')
        page.fill('.rv-disc .rv-comp textarea', 'Commentaire général de test')
        calls.start()
        page.click('[data-action="send-general"]')
        calls.wait(lambda c: is_post_comment(c) and comment_raw(c) == 'Commentaire général de test' and comment_parent(c) is None and not body_of(c).get('inline'),
                   'POST general comment')
        expect(page.locator('.rv-ditem', has_text='Commentaire général de test')).to_be_visible(timeout=10000)
        expect(page.locator('.rv-dgrp[data-group="open"]')).to_contain_text('Ouverts')
        expect(page.locator('details[data-group="resolved"] summary')).to_contain_text('Résolus')
        # comment HTML (the fake Bitbucket serves one with <img onerror>): nothing executable in the DOM
        out = page.evaluate('''() => {
            const bad = [];
            const roots = [...document.querySelectorAll('.rv-html')];
            for (const root of roots) {
                for (const el of root.querySelectorAll('*')) {
                    for (const attr of el.attributes) {
                        if (/^on/i.test(attr.name) || attr.name === 'style') bad.push(`${el.tagName}[${attr.name}]`);
                    }
                    if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'FORM', 'INPUT'].includes(el.tagName.toUpperCase())) bad.push(el.tagName);
                    const href = el.getAttribute('href');
                    if (el.tagName === 'A' && href !== null && (!/^(https?:|mailto:)/.test(href) || el.getAttribute('target') !== '_blank' || !/noopener/.test(el.getAttribute('rel') || ''))) bad.push(`A[${href}]`);
                    if (el.tagName === 'IMG' && !/^https:/.test(el.getAttribute('src') || '')) bad.push(`IMG[${el.getAttribute('src')}]`);
                }
            }
            return { count: roots.length, bad };
        }''')
        assert out['count'] > 0, 'no comment rendered'
        assert not out['bad'], f'unsanitized HTML: {out["bad"]}'
        shown = page.locator('.rv-ditem:visible [data-action="show-in-diff"]').first
        tid = shown.evaluate('b => b.closest(".rv-ditem").dataset.thread')
        shown.click()
        expect(page.locator('.rv-tab.on[data-tab="diff"]')).to_be_visible()
        expect(page.locator(f'.rv-diff .rv-th[data-thread="{tid}"]')).to_be_visible()
    discussions(page)

    @check('Versions tab: click on a row')
    def versions_tab(page):
        page.click('.rv-tab[data-tab="versions"]')
        expect(page.locator('.rv-tbl tbody tr')).to_have_count(n)
        relu = api(pr_api(MAIN_PR))['review']['lastReviewed']
        expect(page.locator(f'.rv-tbl tbody tr[data-v="{relu}"]')).to_contain_text('✓ relu')
        expect(page.locator('.rv-tbl tbody tr[data-v="3"]')).to_have_class(re.compile(r'\bdim\b'))
        page.click('.rv-tbl tbody tr[data-v="4"]')
        expect(readout(page)).to_contain_text('Changements de v4')
        page.click('.rv-tab[data-tab="diff"]')
    versions_tab(page)

    @check('keyboard shortcuts ([ ] n j k ?)')
    def keyboard(page):
        page.locator('body').click(position={'x': 5, 'y': 5})
        _, to = current_selection(page)
        page.keyboard.press(']')
        expect(readout(page)).to_contain_text(readout_bold(to, to + 1))
        page.keyboard.press('[')
        expect(readout(page)).to_contain_text(readout_bold(to - 1, to))
        open_pr(page, MAIN_PR, f'?from={exp_from}&to={exp_to}')
        page.check('#show-resolved')
        page.keyboard.press('n')
        expect(page.locator('.rv-diff .rv-th.flash')).to_have_count(1)
        page.uncheck('#show-resolved')
        count = page.locator('.rv-diff .rv-file').count()
        cur = int(page.locator('.rv-f.cur').get_attribute('data-idx'))
        page.keyboard.press('j')
        expect(page.locator('.rv-f.cur')).to_have_attribute('data-idx', str(min(cur + 1, count - 1)))
        page.keyboard.press('k')
        expect(page.locator('.rv-f.cur')).to_have_attribute('data-idx', str(max(min(cur + 1, count - 1) - 1, 0)))
        page.keyboard.press('?')
        expect(page.locator('.rv-overlay')).to_be_visible()
        page.keyboard.press('Escape')
        expect(page.locator('.rv-overlay')).to_have_count(0)
        # AZERTY on Windows: AltGr (Ctrl + Alt) + 5 gives [
        _, to = current_selection(page)
        page.keyboard.press('Control+Alt+[')
        expect(readout(page)).to_contain_text(readout_bold(to - 2, to - 1))
    keyboard(page)

    @check('file list with the keyboard: Space and Enter open the file, even when seen')
    def file_list_keys(page):
        block = page.locator(f'.rv-file[data-path="{code_file["path"]}"]')
        row = page.locator(f'.rv-f[data-path="{code_file["path"]}"]')
        folded = re.compile(r'\bfolded\b')
        for key in (' ', 'Enter'):
            open_pr(page, MAIN_PR, f'?from={exp_from}&to={exp_to}')
            page.reload()  # fresh page: file seen earlier, hence collapsed
            wait_pr_ready(page)
            expect(block).to_have_class(folded)
            row.focus()
            page.keyboard.press(key)
            expect(block).not_to_have_class(folded)
            expect(page.locator('.rv-f.cur')).to_have_attribute('data-idx', row.get_attribute('data-idx'))
    file_list_keys(page)

    @check('shortcuts help: focus trapped in the box, returned to the button on close')
    def shortcuts_focus(page):
        opener = page.locator('.rv-nav button[aria-label="Raccourcis clavier"]')
        opener.click()
        overlay = page.locator('.rv-overlay')
        expect(overlay).to_be_visible()
        expect(overlay.locator('button', has_text='Fermer')).to_be_focused()
        inside = '() => !!document.activeElement && !!document.activeElement.closest(".rv-overlay")'
        try:
            for key in ('Tab', 'Tab', 'Shift+Tab'):
                page.keyboard.press(key)
                assert page.evaluate(inside), f'focus left the box after {key}'
            page.keyboard.press('Escape')
            expect(overlay).to_have_count(0)
            expect(opener).to_be_focused()
        finally:
            if overlay.count():
                overlay.locator('button', has_text='Fermer').click()  # do not block the following checks
    shortcuts_focus(page)

    @check('pasting a Bitbucket URL in the top bar')
    def url_paste(page):
        ws, repo, pid = MAIN_PR.split('/')
        page.goto(url(''))
        page.fill('.rv-nav .rv-url', f'https://bitbucket.org/{ws}/{repo}/pull-requests/{pid}/diff')
        page.press('.rv-nav .rv-url', 'Enter')
        expect(page).to_have_url(re.compile(f'#/pr/{ws}/{repo}/{pid}'))
        wait_pr_ready(page)
    url_paste(page)

    if FAKE_PRS:
        @check('long PR: automatic folding, stale approval, unfolding')
        def long_pr(page):
            ref = fake_ref('long')
            info = api(pr_api(ref))
            total, relu = len(info['versions']), info['review']['lastReviewed']
            open_pr(page, ref)
            fold = page.locator('.rv-fold button')
            expect(fold).to_have_count(1)
            expect(fold).to_contain_text('⋯ v1 → v22 · juin → août')
            expect(fold).to_contain_text('22 avec du code · 3 rebases')
            assert page.locator('.rv-track .rv-v:not(.base)').count() == 12
            expect(readout(page)).to_contain_text(f'Changements de v{relu + 1} à v{total} · par rapport à v{relu}')
            expect(page.locator('.rv-appr .stale')).to_contain_text(f'toi · sur v{relu} · périmée (code modifié en v{relu + 1}')
            expect(page.locator('[data-action="approve"]')).to_have_text(f'✓ Réapprouver v{total}')
            fold.click()
            expect(page.locator('.rv-track .rv-v:not(.base)')).to_have_count(total)
        long_pr(page)

        @check('only rebases since my review: home group and quick re-approval')
        def fast_path(page):
            ref = fake_ref('rebaseOnly')
            open_pr(page, ref)  # computes the summary: the card shows "rebase only"
            banner = page.locator('.rv-banner[data-banner="fast"]')
            expect(banner).to_contain_text('Depuis ta relecture de v1 : seulement des rebases, aucun changement de l\'auteur')
            expect(page.locator('.rv-empty')).to_contain_text('Aucun changement de l\'auteur entre v1 et v2')
            page.goto(url(''))
            # Designated reviewer whose approval Bitbucket removed: still "To do"
            card = page.locator(f'section[data-group="to-do"] .rv-row[data-pr="{ref}"]')
            expect(card).to_contain_text('rebase seul', timeout=20000)
            card.click()
            wait_pr_ready(page)
            calls.start()
            page.click('[data-action="reapprove"]')
            calls.wait(lambda c: c['method'] == 'POST' and c['path'].endswith(f'/pullrequests/{FAKE_PRS["rebaseOnly"]}/approve'), 'POST approve (re-approval)')
            expect(page.locator('.rv-banner')).to_contain_text('Tu es à jour : v2 relue', timeout=10000)
        fast_path(page)

        @check('my PR: no approve button')
        def mine(page):
            open_pr(page, fake_ref('mine'))
            expect(page.locator('.rv-head .own')).to_have_text('Ta PR')
            expect(page.locator('[data-action="approve"]')).to_have_count(0)
            expect(page.locator('[data-action="request-changes"]')).to_have_count(0)
        mine(page)

        @check('never reviewed: "First review" then "Mark vN as reviewed"')
        def never_reviewed(page):
            ref = fake_ref('neverReviewed')
            total = len(api(pr_api(ref))['versions'])
            open_pr(page, ref)
            expect(readout(page)).to_contain_text(f'v{total} complète')
            banner = page.locator('.rv-banner[data-banner="first"]')
            expect(banner).to_contain_text(f'Première relecture : {total} versions depuis le')
            banner.locator('[data-action="mark-reviewed"]').click()
            expect(page.locator('.rv-banner')).to_contain_text(f'Tu es à jour : v{total} relue', timeout=10000)
            expect(page.locator('.rv-seen')).to_have_count(1)
            wait_api(lambda: api(pr_api(ref))['review']['lastReviewed'] == total, 'lastReviewed advanced (local mark)')
        never_reviewed(page)

        @check('version erased by Bitbucket: page loaded, v1 unavailable and not clickable, range from master')
        def purged(page):
            open_pr(page, fake_ref('purged'))
            gone = page.locator('.rv-v[data-i="1"]')
            expect(gone).to_have_class(re.compile(r'\bgone\b'))
            expect(gone).to_have_attribute('aria-disabled', 'true')
            expect(gone.locator('.rv-dl')).to_have_text('indisponible')
            assert 'Bitbucket a effacé ce commit' in (gone.get_attribute('title') or '')
            # My review dates from v1 (unavailable): the default range starts from master.
            assert current_selection(page) == (0, 3), page.evaluate('location.hash')
            gone.click(force=True)  # aria-disabled: Playwright refuses the ordinary click, a user can click
            assert current_selection(page) == (0, 3), 'a click on an unavailable version must change nothing'
            page.click('.rv-v[data-i="2"]')
            assert current_selection(page) == (0, 2), page.evaluate('location.hash')
            expect(page.locator('.rv-v[data-i="2"]')).to_have_attribute('title', re.compile('changements comptés depuis la base'))
        purged(page)

        @check('erased version, Versions tab: the v2 row shows v2 since the base; Enter and Space')
        def purged_versions_tab(page):
            open_pr(page, fake_ref('purged'), '?from=0&to=3')
            page.click('.rv-tab[data-tab="versions"]')
            v2 = page.locator('.rv-tbl tbody tr[data-v="2"]')
            v3 = page.locator('.rv-tbl tbody tr[data-v="3"]')
            v2.click()
            expect_selection(page, 0, 2)
            expect(v2).to_have_attribute('role', 'button')
            expect(page.locator('.rv-tbl tbody tr[data-v="1"]')).to_have_attribute('aria-disabled', 'true')
            v3.focus()
            page.keyboard.press(' ')
            expect_selection(page, 2, 3)
            v2.focus()
            page.keyboard.press('Enter')
            expect_selection(page, 0, 2)
        purged_versions_tab(page)

    @check('settings: save and test the connection')
    def settings(page):
        page.goto(url('settings'))
        expect(page.locator('#set-email')).to_be_visible()
        before = api('/settings')
        assert 'Jeton enregistré' in (page.locator('#set-token').get_attribute('placeholder') or '')
        repos = list(before['repos'])
        page.fill('#set-repos', '\n'.join(repos + ['acme/e2e-test-repo']))
        page.click('.rv-settings button[type="submit"]')
        expect(page.locator('.rv-status')).to_have_text('Réglages enregistrés.')
        assert api('/settings')['repos'] == repos + ['acme/e2e-test-repo']
        page.click('text=Tester la connexion')
        expect(page.locator('.rv-status')).to_contain_text(f'Connecté en tant que {me.get("displayName", "")}', timeout=15000)
        page.fill('#set-repos', '\n'.join(repos))
        page.click('.rv-settings button[type="submit"]')
        expect(page.locator('.rv-status')).to_have_text('Réglages enregistrés.')
    settings(page)

    @check('settings: review section (overrides table, invalid input, disabled notifications) saved and restored')
    def review_settings(page):
        page.goto(url('settings'))
        before = api('/settings')['review']
        headers = page.locator('.rv-overrides th')
        expect(page.locator('#set-approvals')).to_have_value(str(before['requiredApprovals']))
        for toggle in page.locator('.rv-toggles input[type="checkbox"]').all():
            expect(toggle).to_be_disabled()
        expect(page.locator('.rv-toggles .help')).to_have_text('Les notifications ne sont disponibles que dans l’extension VS Code.')
        page.click('text=Ajouter un dépôt')
        expect(headers.nth(0)).to_have_text('Dépôt')
        expect(headers.nth(1)).to_have_text('Approbations requises')
        row = page.locator('.rv-overrides tbody tr').first
        row.locator('input[type="text"]').fill('not a repo')
        page.click('.rv-settings button[type="submit"]')
        expect(page.locator('.rv-status')).to_contain_text('Ligne invalide')
        assert api('/settings')['review'] == before, 'an invalid row must not be saved'
        row.locator('input[type="text"]').fill('acme/e2e-test-repo')
        row.locator('input[type="number"]').fill('3')
        page.fill('#set-approvals', '1')
        page.click('.rv-settings button[type="submit"]')
        expect(page.locator('.rv-status')).to_have_text('Réglages enregistrés.')
        saved = api('/settings')['review']
        assert saved['requiredApprovals'] == 1 and saved['requiredApprovalsByRepo'] == {'acme/e2e-test-repo': 3}, saved
        page.reload()
        expect(page.locator('.rv-overrides tbody tr')).to_have_count(1)
        page.click('.rv-overrides tbody tr >> text=Retirer')
        expect(page.locator('.rv-overrides')).to_have_count(0)
        page.fill('#set-approvals', str(before['requiredApprovals']))
        page.click('.rv-settings button[type="submit"]')
        expect(page.locator('.rv-status')).to_have_text('Réglages enregistrés.')
        assert api('/settings')['review'] == before
    review_settings(page)

    if FAKE_TOKEN:
        @check('token deleted: the home page points to the settings, then token put back')
        def no_token(page):
            page.goto(url('settings'))
            expect(page.locator('#set-email')).to_be_visible()
            saved = api('/settings')
            draft_repos = '\n'.join(saved['repos'] + ['acme/brouillon-non-enregistre'])
            page.fill('#set-email', 'brouillon@example.test')
            page.fill('#set-repos', draft_repos)
            page.click('text=Supprimer le jeton')
            expect(page.locator('.rv-status')).to_have_text('Jeton supprimé.')
            expect(page.locator('#set-token')).to_have_attribute('placeholder', 'Colle ici ton jeton API Atlassian')
            # input in progress not saved: kept
            expect(page.locator('#set-email')).to_have_value('brouillon@example.test')
            expect(page.locator('#set-repos')).to_have_value(draft_repos)
            assert api('/settings')['email'] == saved['email'], 'the e-mail being typed must not be saved'
            page.goto(url(''))
            expect(page).to_have_url(re.compile('#/settings$'), timeout=10000)
            page.goto(url(f'pr/{MAIN_PR}'))
            expect(page.locator('.rv-panel-msg')).to_contain_text('Ouvrir les réglages')
            page.goto(url('settings'))
            page.fill('#set-token', FAKE_TOKEN)
            page.click('.rv-settings button[type="submit"]')
            expect(page.locator('.rv-status')).to_have_text('Réglages enregistrés.')
            expect(page.locator('#set-token')).to_have_attribute('placeholder', re.compile('^Jeton enregistré'))
            page.goto(url(''))
            expect(page.locator(f'.rv-row[data-pr="{MAIN_PR}"]')).to_be_visible(timeout=20000)
        no_token(page)


# ---------------------------------------------------------------------------
# Languages: the journey above runs in French (fr-FR browser); this one checks English and the host-imposed language.
# ---------------------------------------------------------------------------

def run_language_checks(page, fr_page):
    ws, repo, _ = MAIN_PR.split('/')
    missing_pr = f'{ws}/{repo}/9999'

    @check('English (en-US browser): home page')
    def en_home(page):
        page.goto(url(''))
        expect(page.locator('html')).to_have_attribute('lang', 'en')
        expect(page.locator('.rv-home h1')).to_have_text('My PRs')
        expect(page.locator('.rv-home-top .rv-btn')).to_have_text('↻ Refresh', timeout=20000)
        expect(page.locator(f'.rv-row[data-pr="{MAIN_PR}"]')).to_be_visible(timeout=20000)
        titles = {'To do', 'My PRs', 'Waiting on the author', 'Other open PRs'}
        for title in page.locator('.rv-lgrp').evaluate_all('els => els.map((el) => el.textContent.trim())'):
            assert title.split(' · ')[0] in titles or title.rsplit(' · ', 1)[0] in titles, f'untranslated group title: {title}'
        expect(page.locator('.rv-nav .rv-url')).to_have_attribute('placeholder', 'Paste a Bitbucket PR URL…')
    en_home(page)

    @check('English (en-US browser): a PR, its tabs and the Versions table')
    def en_pr(page):
        open_pr(page, MAIN_PR, '?from=0&to=2')
        expect(readout(page)).to_contain_text('Full v2 · against its base on master ·')
        expect(page.locator('.rv-preset[data-preset="all"]')).to_have_text('All vs master')
        expect(page.locator('.rv-tab[data-tab="diff"]')).to_contain_text('Diff')
        expect(page.locator('.rv-tab[data-tab="discussions"]')).to_contain_text('open')
        expect(page.locator('.rv-dtb')).to_contain_text('Show resolved threads')
        expect(page.locator('.rv-banner .h')).not_to_have_text(re.compile('[àéèù]|relu'))
        page.click('.rv-tab[data-tab="versions"]')
        expect(page.locator('.rv-tbl thead')).to_contain_text('Changed by the author')
        expect(page.locator('.rv-tbl tbody tr[data-v="1"]')).to_contain_text('creation')
        page.click('.rv-tab[data-tab="discussions"]')
        expect(page.locator('.rv-disc .rv-comp textarea')).to_have_attribute('placeholder', 'New general comment…')
    en_pr(page)

    @check('English (en-US browser): settings')
    def en_settings(page):
        page.goto(url('settings'))
        expect(page.locator('label[for="set-email"]')).to_have_text('Atlassian email')
        expect(page.locator('.rv-helpbox')).to_contain_text('Create an Atlassian API token at id.atlassian.com')
        assert (page.locator('#set-token').get_attribute('placeholder') or '').startswith('Token saved'), 'token placeholder'
        page.click('.rv-settings button[type="submit"]')
        expect(page.locator('.rv-status')).to_have_text('Settings saved.')
        page.click('text=Test connection')
        expect(page.locator('.rv-status')).to_contain_text('Connected as ', timeout=15000)
    en_settings(page)

    @check('English (en-US browser): server error translated from its code')
    def en_error(page):
        page.goto(url(f'pr/{missing_pr}'))
        panel = page.locator('.rv-panel-msg')
        expect(panel).to_contain_text('Couldn’t load this page', timeout=20000)
        expect(panel).to_contain_text('Not found on Bitbucket: ')
        expect(panel).to_contain_text('Back to home')
    en_error(page)

    @check('French (fr-FR browser): server error translated from its code')
    def fr_error(page):
        page.goto(url(f'pr/{missing_pr}'))
        expect(page.locator('html')).to_have_attribute('lang', 'fr')
        expect(page.locator('.rv-panel-msg')).to_contain_text('Introuvable sur Bitbucket : ', timeout=20000)
    fr_error(fr_page)

    @check('language imposed by the host (<meta name="revspan-locale">) wins over the browser')
    def host_locale(page):
        def with_meta(route):
            response = route.fetch()
            html = response.text().replace('<head>', '<head><meta name="revspan-locale" content="fr">', 1)
            route.fulfill(response=response, body=html)
        # a query string forces a real page load (a hash change alone keeps the current document)
        is_page = lambda u: u.startswith(f'{BASE}/?host-locale')  # noqa: E731
        page.route(is_page, with_meta)
        try:
            page.goto(f'{BASE}/?host-locale#/')
            expect(page.locator('html')).to_have_attribute('lang', 'fr')
            expect(page.locator('.rv-home h1')).to_have_text('Mes PR')
        finally:
            page.unroute(is_page)
    host_locale(page)


def main():
    if not BASE:
        log('REVSPAN_BASE_URL missing: run "node test/e2e/run-against-fake.ts" (after "npx --no-install vite build").')
        sys.exit(2)
    log(f'Revspan UI test -- {BASE} — PR {MAIN_PR}')
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=CHROMIUM_ARGS, headless=not os.environ.get('REVSPAN_HEADED'))
        fixed_time = os.environ.get('REVSPAN_FIXED_TIME')
        try:
            screenshots(browser, fixed_time)
        except Exception as error:  # noqa: BLE001
            results.append(('captures', False))
            log(f'FAIL  captures\n      {error}')
        context = browser.new_context(viewport={'width': 1440, 'height': 900}, locale='fr-FR', timezone_id='Europe/Paris')
        context.set_default_timeout(10000)
        page = context.new_page()
        if fixed_time:
            page.clock.set_fixed_time(fixed_time)
        page.on('dialog', lambda d: d.accept())
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        run_checks(page)
        en_context = browser.new_context(viewport={'width': 1440, 'height': 900}, locale='en-US', timezone_id='Europe/Paris')
        en_context.set_default_timeout(10000)
        en_page = en_context.new_page()
        if fixed_time:
            en_page.clock.set_fixed_time(fixed_time)
        en_page.on('pageerror', lambda e: errors.append(str(e)))
        run_language_checks(en_page, page)
        results.append(('no JavaScript error', not errors))
        log('PASS  no JavaScript error' if not errors else f'FAIL  no JavaScript error\n      {errors}')
        browser.close()
    failed = [r for r in results if not r[1]]
    log(f'\n{len(results) - len(failed)}/{len(results)} checks passed')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
