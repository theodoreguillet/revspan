#!/usr/bin/env python3
"""Revspan UI test (Playwright for Python, no pytest), against the real server wired to the fake Bitbucket.

Normal launch (after "npx --no-install vite build"):
    node test/e2e/run-against-fake.ts

run-against-fake.ts starts the fake Bitbucket and the server, then runs this script with:
    REVSPAN_BASE_URL    URL of the Revspan server (required).
    REVSPAN_OPEN_URL    Its /open?k=<secret> address (as printed by the CLI): opened once by each browser context.
    REVSPAN_SECRET      Its per-run secret, sent as the revspan_k_<port> cookie by the direct API reads (api()).
    REVSPAN_CALLS_URL   Log of the writes received by the fake Bitbucket (GET -> JSON array).
    REVSPAN_REQUESTS_URL  Log of every request received by the fake Bitbucket, reads included (GET -> JSON array).
    REVSPAN_PR          Main PR, "workspace/repo/id" (acme/demo-repo/42).
    REVSPAN_FAKE_PRS    JSON of the fake Bitbucket's PRs: main, long, rebaseOnly, mine, neverReviewed, others, purged, waiting, draft
                        (waiting also changes the Vue component src/components/RecordList.vue).
    REVSPAN_FAKE_EMAIL, REVSPAN_FAKE_TOKEN   Credentials of the fake Bitbucket (token put back after deletion).
Options:
    REVSPAN_SHOTS_DIR   Screenshots folder (default: <tmp>/revspan-shots).
    REVSPAN_FIXED_TIME  Frozen browser time (ISO).
    REVSPAN_HEADED=1    Visible browser.

A single server for the whole script: each check sees the writes of the previous ones (order matters).
Exits with a non-zero code if a check fails.
"""
import base64
import json
import os
import re
import sys
import tempfile
import time
import traceback
import urllib.parse
import urllib.request

from playwright.sync_api import expect, sync_playwright

BASE = os.environ.get('REVSPAN_BASE_URL', '').rstrip('/')
OPEN_URL = os.environ.get('REVSPAN_OPEN_URL')
SECRET = os.environ.get('REVSPAN_SECRET')
# The secret cookie is named after the server's port.
SECRET_COOKIE = f'revspan_k_{urllib.parse.urlsplit(BASE).port}'
CALLS_URL = os.environ.get('REVSPAN_CALLS_URL')
REQUESTS_URL = os.environ.get('REVSPAN_REQUESTS_URL')
MAIN_PR = os.environ.get('REVSPAN_PR', 'acme/demo-repo/42')
FAKE_PRS = json.loads(os.environ.get('REVSPAN_FAKE_PRS', '{}'))
FAKE_TOKEN = os.environ.get('REVSPAN_FAKE_TOKEN', '')
FAKE_EMAIL = os.environ.get('REVSPAN_FAKE_EMAIL', '')
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


def http_json(url, headers=None):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=60) as res:
        return json.loads(res.read().decode() or 'null')


def api(path):
    return http_json(f'{BASE}/api{path}', {'Cookie': f'{SECRET_COOKIE}={SECRET}'} if SECRET else None)


def new_context(browser, **options):
    """Browser context holding the server's secret cookie: the ?k= address is opened once, before anything else
    (through the context's own cookie jar, without a page, so no page load counts in the checks)."""
    context = browser.new_context(**options)
    if OPEN_URL:
        response = context.request.get(OPEN_URL, max_redirects=0)
        assert response.status == 302, f'{OPEN_URL} answered {response.status}'
    return context


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


def fake_delete_comment(cid):
    """Deletes a comment directly at the fake Bitbucket (somebody else deleted it meanwhile)."""
    ws, repo, pid = MAIN_PR.split('/')
    base = CALLS_URL.rsplit('/__calls', 1)[0]
    token = base64.b64encode(f'{FAKE_EMAIL}:{FAKE_TOKEN}'.encode()).decode()
    request = urllib.request.Request(f'{base}/2.0/repositories/{ws}/{repo}/pullrequests/{pid}/comments/{cid}',
                                     method='DELETE', headers={'Authorization': f'Basic {token}'})
    urllib.request.urlopen(request, timeout=10).close()


def fake_comment(raw):
    """Adds a general comment by Yann Bernard on the main PR directly at the fake Bitbucket (written meanwhile)."""
    base = CALLS_URL.rsplit('/__calls', 1)[0]
    request = urllib.request.Request(f'{base}/__comment', data=json.dumps({'raw': raw}).encode(), method='POST',
                                     headers={'Content-Type': 'application/json'})
    urllib.request.urlopen(request, timeout=10).close()


def bitbucket_requests():
    """Requests the fake Bitbucket received so far (reads included)."""
    return http_json(REQUESTS_URL) if REQUESTS_URL else []


def wait_fake_quiet(quiet=1.0, timeout=15.0):
    """Waits until the fake Bitbucket received no request for `quiet` seconds (page load, summary, prefetch done)."""
    deadline = time.time() + timeout
    count, since = len(bitbucket_requests()), time.time()
    while time.time() - since < quiet:
        assert time.time() < deadline, 'the fake Bitbucket never went quiet'
        time.sleep(0.2)
        now = len(bitbucket_requests())
        if now != count:
            count, since = now, time.time()


def fake_delay(route, ms):
    """Slows down the fake Bitbucket's requests whose path has that segment (ms=0: back to normal)."""
    base = CALLS_URL.rsplit('/__calls', 1)[0]
    http_json(f'{base}/__delay?route={route}&ms={ms}')


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
    page.wait_for_function('() => !document.querySelector(".rv-progress") && !document.querySelector(".rv-diff-skel")', timeout=20000)


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


def followed_uuids():
    return [u['uuid'] for u in api('/settings')['review']['followed']]


def home_cards(group):
    return next(g for g in api('/home')['groups'] if g['key'] == group)['prs']


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
            context = new_context(browser, viewport={'width': width, 'height': 900}, color_scheme=scheme, locale='fr-FR', timezone_id='Europe/Paris')
            page = context.new_page()
            if fixed_time:
                page.clock.set_fixed_time(fixed_time)
            for name, hash_part in targets:
                page.goto(url(hash_part))
                if name.startswith('pr'):
                    wait_pr_ready(page)
                    page.wait_for_timeout(300)
                    if name == 'pr':  # syntax colors arrive after the first render
                        try:
                            page.wait_for_selector('.rv-l .c span[style*="color"]', state='attached', timeout=5000)
                        except Exception:  # noqa: BLE001
                            pass
                else:
                    page.wait_for_timeout(800)
                page.screenshot(path=os.path.join(SHOTS, f'{name}-{scheme}-{width}.png'))
                if name == 'pr' and width == 1440:
                    page.locator('.rv-tab[data-tab="description"]').click()
                    page.wait_for_timeout(200)
                    page.screenshot(path=os.path.join(SHOTS, f'pr-description-{scheme}.png'))
                if name == 'pr-long':
                    page.locator('.rv-tl').screenshot(path=os.path.join(SHOTS, f'timeline-{scheme}-{width}.png'))
                    page.goto(url(f'pr/{fake_ref("long")}?from=0&to=34'))  # wide range: the bar under every item
                    wait_pr_ready(page)
                    page.wait_for_timeout(300)
                    page.locator('.rv-tl').screenshot(path=os.path.join(SHOTS, f'timeline-range-{scheme}-{width}.png'))
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
    for scheme in ('light', 'dark'):  # zoomed symbols (x3) to check the letters' optical centering
        context = new_context(browser, viewport={'width': 1440, 'height': 900}, color_scheme=scheme, locale='fr-FR', timezone_id='Europe/Paris', device_scale_factor=3)
        page = context.new_page()
        if fixed_time:
            page.clock.set_fixed_time(fixed_time)
        if FAKE_PRS:
            for name, key, nodes in (('long', 'long', (27, 28)), ('purged', 'purged', (1, 2))):
                page.goto(url(f'pr/{fake_ref(key)}'))
                wait_pr_ready(page)
                for i in nodes:
                    page.locator(f'.rv-v[data-i="{i}"] .rv-dot').screenshot(path=os.path.join(SHOTS, f'symbol-{name}-v{i}-{scheme}.png'))
                if name == 'long':
                    box = page.evaluate('() => { const r = e => document.querySelector(e).getBoundingClientRect(); return {legendRight: r("[data-legend]").right, tlRight: r(".rv-tl").right, foot: r(".rv-tl-foot").height}; }')
                    log(f'      timeline footer at 1440: {box}')
                    assert box['legendRight'] <= box['tlRight'] - 15 and box['foot'] < 40, box
                assert page.locator('[data-legend-gone]').count() == 0, 'the legend has no entry for unavailable versions (the timeline says it)'
                if name == 'purged':
                    page.locator('[data-legend]').screenshot(path=os.path.join(SHOTS, f'legend-{scheme}.png'))
        context.close()
    change_shots(browser, fixed_time)
    goto_shots(browser, fixed_time)
    if CALLS_URL:
        like_shots(browser, fixed_time)
    log(f'      screenshots in {SHOTS}')


# VS Code Dark+ colors of a webview (the variables VS Code sets), to see the page as in the extension.
VSCODE_DARK_PLUS = {
    'editor-background': '#1e1e1e', 'foreground': '#cccccc', 'descriptionForeground': '#9d9d9d', 'sideBar-background': '#252526',
    'panel-border': 'rgba(128,128,128,.35)', 'textLink-foreground': '#3794ff', 'button-background': '#0e639c', 'button-foreground': '#ffffff',
    'diffEditor-insertedLineBackground': 'rgba(155,185,85,.2)', 'diffEditor-removedLineBackground': 'rgba(255,0,0,.2)',
    'diffEditor-insertedTextBackground': 'rgba(156,204,44,.2)', 'diffEditor-removedTextBackground': 'rgba(255,0,0,.2)',
    'editor-font-family': 'Menlo, Monaco, "Courier New", monospace',
}


def change_shots(browser, fixed_time):
    """Changed lines of the main PR (one band per changed range): light, dark, and VS Code Dark+ colors."""
    for name, scheme, vscode in (('light', 'light', False), ('dark', 'dark', False), ('vscode-dark', 'dark', True)):
        context = new_context(browser, viewport={'width': 1024, 'height': 800}, color_scheme=scheme, locale='fr-FR', timezone_id='Europe/Paris', device_scale_factor=2)
        page = context.new_page()
        if fixed_time:
            page.clock.set_fixed_time(fixed_time)
        page.goto(url(f'pr/{MAIN_PR}'))
        wait_pr_ready(page)
        if vscode:
            page.evaluate('''(vars) => {
                for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(`--vscode-${k}`, v);
                document.body.classList.add('vscode-dark');
            }''', VSCODE_DARK_PLUS)
        band = page.locator('.rv-diff .rv-l em').first
        band.wait_for(state='attached')
        page.wait_for_selector('.rv-l .c span[style*="color"]', state='attached', timeout=10000)
        band.evaluate('(em) => em.scrollIntoView({ block: "center" })')
        page.wait_for_timeout(300)
        # The changed rows around the band, with the context row above them.
        clip = band.evaluate('''(em) => {
            const row = em.closest('.rv-l');
            const rows = [...row.closest('.rv-file').querySelectorAll('.rv-l')];
            let from = rows.indexOf(row);
            let to = from;
            while (from > 0 && rows[from - 1].matches('.r, .a')) from--;
            while (to < rows.length - 1 && rows[to + 1].matches('.r, .a')) to++;
            const first = rows[Math.max(0, from - 1)].getBoundingClientRect();
            const last = rows[to].getBoundingClientRect();
            return { x: first.left, y: first.top, width: Math.min(first.width, 760), height: last.bottom - first.top };
        }''')
        page.screenshot(path=os.path.join(SHOTS, f'diff-change-{name}.png'), clip=clip)
        context.close()


def goto_shots(browser, fixed_time):
    """Go to definition on the main PR: underline with the modifier held, the choice, the notices; light, dark, VS Code Dark+."""
    n = len(api(pr_api(MAIN_PR))['versions'])
    for name, scheme, vscode in (('light', 'light', False), ('dark', 'dark', False), ('vscode-dark', 'dark', True)):
        context = new_context(browser, viewport={'width': 1024, 'height': 700}, color_scheme=scheme, locale='fr-FR', timezone_id='Europe/Paris', device_scale_factor=2)
        page = context.new_page()
        if fixed_time:
            page.clock.set_fixed_time(fixed_time)
        page.goto(url(f'pr/{MAIN_PR}?from=0&to={n}'))
        wait_pr_ready(page)
        if vscode:
            page.evaluate('''(vars) => {
                for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(`--vscode-${k}`, v);
                document.body.classList.add('vscode-dark');
            }''', VSCODE_DARK_PLUS)
        spec = page.locator('.rv-file[data-path="tests/ActionSpec.ts"]')
        use = spec.locator('.rv-l', has_text='return new Action().run(payload)').first
        sym = lambda line, word: line.locator('.c .sym', has_text=re.compile(f'^{word}$')).first  # noqa: E731
        sym(use, 'Action').wait_for(state='attached', timeout=10000)
        use.evaluate('(e) => e.scrollIntoView({ block: "center" })')
        page.wait_for_timeout(300)
        clip = use.evaluate('e => { const r = e.closest(".rv-file").getBoundingClientRect(); const l = e.getBoundingClientRect(); return { x: r.left, y: Math.max(0, l.top - 140), width: Math.min(r.width, 760), height: 300 }; }')
        page.keyboard.down('ControlOrMeta')
        sym(use, 'Action').hover()
        page.screenshot(path=os.path.join(SHOTS, f'goto-hover-{name}.png'), clip=clip)
        sym(use, 'payload').click()
        page.keyboard.up('ControlOrMeta')
        page.locator('[data-goto-choice]').wait_for()
        page.wait_for_timeout(100)
        page.screenshot(path=os.path.join(SHOTS, f'goto-choice-{name}.png'), clip=clip)
        page.keyboard.press('Escape')
        sym(spec.locator('.rv-l', has_text='describe(').first, 'describe').click(modifiers=['ControlOrMeta'])
        page.locator('[data-goto-notice]').wait_for()
        page.screenshot(path=os.path.join(SHOTS, f'goto-notfound-{name}.png'))
        page.keyboard.press('Escape')
        sym(spec.locator('.rv-l', has_text='buildPayload()').first, 'buildPayload').click(modifiers=['ControlOrMeta'])
        page.locator('[data-goto-back]').wait_for()
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(SHOTS, f'goto-import-back-{name}.png'))
        context.close()


def like_shots(browser, fixed_time):
    """My thread in the Discussions tab with my 👍 (chip highlighted, button pressed) and Yann's on Camille's reply: light,
    dark, VS Code Dark+. The like is real (fake Bitbucket) and taken back afterwards, so the checks start without it."""
    data = api(pr_api(MAIN_PR))
    thread = next((t for t in data['threads'] if t['path'] and not t['resolved'] and t['comments'][0]['mine']), None)
    assert thread, 'no open thread of mine'
    root = thread['comments'][0]['id']
    item = f'.rv-ditem[data-thread="{thread["id"]}"]'
    try:
        for name, scheme, vscode in (('light', 'light', False), ('dark', 'dark', False), ('vscode-dark', 'dark', True)):
            context = new_context(browser, viewport={'width': 1024, 'height': 800}, color_scheme=scheme, locale='fr-FR', timezone_id='Europe/Paris', device_scale_factor=2)
            page = context.new_page()
            if fixed_time:
                page.clock.set_fixed_time(fixed_time)
            page.goto(url(f'pr/{MAIN_PR}'))
            wait_pr_ready(page)
            if vscode:
                page.evaluate('''(vars) => {
                    for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(`--vscode-${k}`, v);
                    document.body.classList.add('vscode-dark');
                }''', VSCODE_DARK_PLUS)
            page.click('.rv-tab[data-tab="discussions"]')
            button = page.locator(f'{item} .rv-cm[data-comment="{root}"] [data-action="like"]')
            if button.get_attribute('aria-pressed') != 'true':
                button.click()
            expect(page.locator(f'{item} .rv-cm[data-comment="{root}"] .rv-react.mine')).to_be_visible(timeout=10000)
            expect(button).not_to_have_attribute('aria-busy', 'true', timeout=10000)
            expect(page.locator('.rv-head [data-action="refresh"]')).not_to_have_attribute('aria-busy', 'true', timeout=10000)
            page.locator(item).scroll_into_view_if_needed()
            page.mouse.move(0, 0)
            page.wait_for_timeout(200)
            page.locator(item).screenshot(path=os.path.join(SHOTS, f'like-{name}.png'))
            if name == 'vscode-dark':
                button.click()
                expect(page.locator(f'{item} .rv-cm[data-comment="{root}"] .rv-react')).to_have_count(0, timeout=10000)
                expect(page.locator('.rv-head [data-action="refresh"]')).not_to_have_attribute('aria-busy', 'true', timeout=10000)
            context.close()
    finally:
        # never leave the like for the checks, even when a shot failed
        for t in api(pr_api(MAIN_PR) + '?fresh=1')['threads']:
            for c in t['comments']:
                if c['id'] == root:
                    for r in c['reactions']:
                        for cid in r['myCommentIds']:
                            fake_delete_comment(cid)


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
            expect(page.locator(f'section[data-group="to-rebase"] .rv-row[data-pr="{fake_ref("mine")}"]')).to_contain_text('toi')
            others = page.locator('details[data-group="others"]')
            assert not others.evaluate('d => d.open'), '"Autres PR ouvertes" must be collapsed when the user is known'
            others.locator('summary').click()
            light = others.locator(f'.rv-row[data-pr="{fake_ref("others")}"]')
            expect(light.locator('.rv-nb')).to_have_text('pas encore relue')  # versionsCount null : pas de nombre
    home(page)

    if FAKE_PRS:
        ws, repo, _ = MAIN_PR.split('/')

        @check('home: the groups ("À relire", "À rebaser"…), build badges, "needs rebase" on my PR, no "mark as reviewed"')
        def queue_groups(page):
            page.goto(url(''))
            todo = page.locator('section[data-group="to-do"]')
            expect(todo).to_be_visible(timeout=20000)
            rebase = page.locator('section[data-group="to-rebase"]')
            expect(rebase).to_be_visible()
            expect(page.locator('section[data-group="mine"]')).to_have_count(0)  # my only PR needs a rebase
            expect(page.locator('section[data-group="waiting"]')).to_be_visible()
            expect(page.locator('details[data-group="others"]')).to_be_visible()
            titles = page.locator('.rv-lgrp').evaluate_all('els => els.map((el) => el.firstChild.textContent.trim())')
            assert titles == ['À relire', 'À rebaser', 'En attente de l\'auteur', 'Autres PR ouvertes'], titles
            expect(todo.locator('.rv-lgrp')).to_contain_text('À relire')
            expect(todo.locator('.rv-lgrp .desc')).to_have_text('PR qui attendent ta relecture')
            expect(rebase.locator('.rv-lgrp')).to_contain_text('À rebaser')
            expect(rebase.locator('.rv-lgrp .desc')).to_have_text('la branche cible a avancé depuis leur base')
            waiting = page.locator('section[data-group="waiting"]')
            expect(waiting.locator('.rv-lgrp')).to_contain_text('En attente de l\'auteur')
            expect(waiting.locator('.rv-lgrp .desc')).to_have_text('rien à faire de ton côté')
            expect(waiting.locator(f'.rv-row[data-pr="{fake_ref("waiting")}"]')).to_be_visible()
            main_row = todo.locator(f'.rv-row[data-pr="{MAIN_PR}"]')
            expect(main_row.locator('.rv-build')).to_have_text('✗ échec')
            expect(main_row.locator('.rv-build')).to_have_attribute('data-build', 'failed')
            expect(main_row).to_contain_text('1/2 approbation')
            expect(main_row.locator('[data-chip="designated"]')).to_have_text('désigné relecteur')
            mine_row = rebase.locator(f'.rv-row[data-pr="{fake_ref("mine")}"]')
            expect(mine_row.locator('[data-chip="needs-rebase"]')).to_have_text('à rebaser')
            expect(mine_row.locator('.rv-build')).to_have_attribute('data-build', 'running')
            expect(page.locator('[data-chip="needs-rebase"]')).to_have_count(1)  # own PRs only
            expect(page.locator('.rv-roww [data-action="mark-reviewed"]')).to_have_count(0)
            expect(page.locator(f'.rv-roww[data-row="{fake_ref("mine")}"] .rv-row-more')).to_have_count(0)  # nobody to follow
        queue_groups(page)

        @check('home_search: title part, #number, no match, Escape brings everything back')
        def home_search(page):
            page.goto(url(''))
            page.reload()  # same-document goto: start from a fresh page, the fold is closed again
            expect(page.locator('section[data-group="to-do"]')).to_be_visible(timeout=20000)
            all_rows = page.locator('.rv-row').count()
            assert all_rows > 1, all_rows
            search = page.locator('[data-home-search]')
            expect(search).to_have_attribute('placeholder', 'Rechercher une PR…')
            page.locator('body').click(position={'x': 5, 'y': 5})
            page.keyboard.press('/')
            expect(search).to_be_focused()
            search.fill('NOT reviewed')
            only = page.locator(f'.rv-row[data-pr="{fake_ref("neverReviewed")}"]')
            expect(page.locator('.rv-row')).to_have_count(1)
            expect(only).to_be_visible()
            expect(page.locator('section[data-group="to-do"] .rv-lgrp .cnt')).to_have_text('· 1')
            expect(page.locator('section[data-group="waiting"]')).to_have_count(0)
            for scheme in ('light', 'dark'):
                page.emulate_media(color_scheme=scheme)
                page.screenshot(path=os.path.join(SHOTS, f'home-search-match-{scheme}.png'))
            page.emulate_media(color_scheme='null')
            search.fill(f'#{FAKE_PRS["mine"]}')
            expect(page.locator('.rv-row')).to_have_count(1)
            expect(page.locator(f'.rv-row[data-pr="{fake_ref("mine")}"]')).to_be_visible()
            search.fill('zzz-nothing')
            expect(page.locator('.rv-row')).to_have_count(0)
            expect(page.locator('[data-testid="no-match"]')).to_have_text('Aucune PR ne correspond')
            for scheme in ('light', 'dark'):
                page.emulate_media(color_scheme=scheme)
                page.screenshot(path=os.path.join(SHOTS, f'home-search-none-{scheme}.png'))
            page.emulate_media(color_scheme='null')
            search.fill('not about me')  # a PR of "Autres PR ouvertes": the fold opens
            expect(page.locator(f'details[data-group="others"] .rv-row[data-pr="{fake_ref("others")}"]')).to_be_visible()
            search.press('Escape')
            expect(search).to_have_value('')
            expect(page.locator('.rv-row')).to_have_count(all_rows)
            page.wait_for_function('() => !document.querySelector(\'details[data-group="others"]\').open', timeout=5000)  # back to its state
            # opened by the user (one click), closed by the user during a search: cleared, the search gives it back open
            others_title = page.locator('details[data-group="others"] > summary')
            others_title.click()
            page.wait_for_function('() => document.querySelector(\'details[data-group="others"]\').open', timeout=5000)
            search.fill('not about me')
            others_title.click()
            page.wait_for_function('() => !document.querySelector(\'details[data-group="others"]\').open', timeout=5000)
            search.press('Escape')
            expect(search).to_have_value('')
            page.wait_for_function('() => document.querySelector(\'details[data-group="others"]\').open', timeout=5000)
        home_search(page)

        @check('home: "Refresh" reads Bitbucket again, where a reload reuses the home just computed')
        def refresh_fresh(page):
            assert REQUESTS_URL, 'REVSPAN_REQUESTS_URL missing'
            lists = lambda: sum(1 for r in http_json(REQUESTS_URL) if r['path'].endswith('/pullrequests'))  # noqa: E731
            page.goto(url(''))
            expect(page.locator('section[data-group="to-do"]')).to_be_visible(timeout=20000)
            before = lists()
            page.reload()
            expect(page.locator('section[data-group="to-do"]')).to_be_visible(timeout=20000)
            assert lists() == before, 'a plain reload must reuse the home'
            with page.expect_response(lambda r: '/api/home?fresh=1' in r.url):
                page.click('.rv-home-top .rv-btn')
            expect(page.locator('section[data-group="to-do"]')).to_be_visible(timeout=20000)
            assert lists() > before, 'Refresh must read the PR list from Bitbucket'
        refresh_fresh(page)

        @check('home: grouping by contributor regroups "to do" and survives a reload')
        def grouping(page):
            todo_prs = home_cards('to-do')
            latest = {}
            for p in todo_prs:
                name = p['author']['displayName']
                latest[name] = max(latest.get(name, ''), p['lastPushAt'])
            # Subgroups by their most recent PR, then by name.
            authors = sorted(sorted(latest), key=lambda name: latest[name], reverse=True)
            by_author = [f'{name} · {sum(1 for p in todo_prs if p["author"]["displayName"] == name)}' for name in authors]
            subs = page.locator('section[data-group="to-do"] .rv-sg')
            expect(subs).to_have_text([f'{ws}/{repo} · {len(todo_prs)}'])
            page.click('.rv-home-bar button[data-grouping="contributor"]')
            expect(subs).to_have_text(by_author)
            assert len(by_author) > 1, by_author
            expect(page.locator('section[data-group="to-rebase"] .rv-sg')).to_have_text([f'{ws}/{repo} · 1'])  # always by repository
            expect(page.locator('section[data-group="waiting"] .rv-sg')).to_have_count(0)  # never grouped
            page.reload()
            expect(page.locator('.rv-home-bar button[data-grouping="contributor"]')).to_have_attribute('aria-pressed', 'true', timeout=20000)
            expect(subs).to_have_text(by_author)
            page.click('.rv-home-bar button[data-grouping="none"]')
            expect(subs).to_have_count(0)
            expect(page.locator('section[data-group="to-do"] .rv-row')).to_have_count(len(todo_prs))
            page.click('.rv-home-bar button[data-grouping="repository"]')
            expect(subs).to_have_count(1)
        grouping(page)

        @check('home: following an author from the row menu adds a ★; PRs stay sorted newest push first')
        def follow_row(page):
            ref = fake_ref('neverReviewed')
            author = next(p['author'] for p in home_cards('to-do') if p['id'] == FAKE_PRS['neverReviewed'])
            row = page.locator(f'.rv-roww[data-row="{ref}"]')
            expect(page.locator('.rv-star')).to_have_count(0)
            row.locator('.rv-row-more').click()
            item = page.locator('.rv-menu [data-action="follow"]')
            expect(item).to_have_text(f'Suivre {author["displayName"]}')
            item.click()
            expect(row.locator('.rv-star')).to_be_visible()
            wait_api(lambda: followed_uuids() == [author['uuid']], 'author saved in review.followed')
            page.reload()
            expect(row.locator('.rv-star')).to_be_visible(timeout=20000)
            # Following does not reorder: "to do" rows follow the push dates of the home data.
            todo = sorted(home_cards('to-do'), key=lambda p: p['lastPushAt'], reverse=True)
            shown = page.locator('section[data-group="to-do"] .rv-row').evaluate_all('rows => rows.map((r) => r.dataset.pr)')
            expected = [f"{p['workspace']}/{p['repo']}/{p['id']}" for p in todo]
            assert shown == expected, (shown, expected)
            page.locator(f'.rv-roww[data-row="{ref}"] .rv-row-more').click()
            expect(item).to_have_text(f'Ne plus suivre {author["displayName"]}')
            item.click()
            expect(page.locator('.rv-star')).to_have_count(0)
            wait_api(lambda: followed_uuids() == [], 'author removed from review.followed')
        follow_row(page)

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

    if FAKE_PRS and CALLS_URL:
        @check('diff_skeleton: a slow diff shows the progress bar, then a skeleton instead of the greyed diff')
        def diff_skeleton(page):
            # v5 alone (v4 → v5) is computed by the version summaries; Shift+click on v6 then gives v4 → v6, a range no
            # other check selects nor the prefetch computes: its diffstat reaches the (slowed down) fake Bitbucket.
            page.click('.rv-v[data-i="5"]')
            expect_selection(page, 4, 5)
            wait_pr_ready(page)
            fake_delay('diffstat', 3000)
            try:
                page.click('.rv-v[data-i="6"]', modifiers=['Shift'])
                expect_selection(page, 4, 6)
                expect(page.locator('.rv-progress[role="progressbar"][data-loading]')).to_be_attached()
                expect(page.locator('.rv-diff-skel[aria-busy="true"]')).to_be_visible()
                expect(page.locator('.rv-files-skel[aria-busy="true"]')).to_be_visible()
                expect(page.locator('.rv-diff .rv-file')).to_have_count(0)
                # the diff area is never greyed out nor blocked (the old loading state)
                style = page.evaluate('() => { const s = getComputedStyle(document.querySelector(".rv-diff")); return [s.opacity, s.pointerEvents]; }')
                assert style == ['1', 'auto'], f'diff area greyed or blocked while loading: {style}'
            finally:
                fake_delay('diffstat', 0)
            expect(page.locator('.rv-diff-skel')).to_have_count(0, timeout=10000)
            expect(page.locator('.rv-progress')).to_have_count(0)
            expect(page.locator('.rv-diff .rv-file')).not_to_have_count(0)
            expect(readout(page)).to_contain_text('Changements de v5 à v6 · par rapport à v4')
        diff_skeleton(page)

    @check('click on a version = what it changed')
    def click_version(page):
        page.click('.rv-v[data-i="4"]')
        expect(readout(page)).to_have_text('Changements de v4 · par rapport à v3 · aucun changement de code')
        assert current_selection(page) == (3, 4)
    click_version(page)

    @check('click on the selected version again = the whole version against master, a third click = back')
    def click_again(page):
        page.click('.rv-v[data-i="4"]')
        expect(readout(page)).to_contain_text('v4 complète · par rapport à sa base sur master')
        expect_selection(page, 0, 4)
        page.click('.rv-v[data-i="4"]')
        expect(readout(page)).to_have_text('Changements de v4 · par rapport à v3 · aucun changement de code')
        expect_selection(page, 3, 4)
        page.click('.rv-v[data-i="1"]')
        expect_selection(page, 0, 1)
        page.click('.rv-v[data-i="1"]')  # the base of v1 is master: nothing to toggle
        expect_selection(page, 0, 1)
        page.click('.rv-v[data-i="4"]')
        expect_selection(page, 3, 4)
    click_again(page)

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

    @check('diff: syntax colors on a .ts file, change emphasis kept, theme followed')
    def syntax_colors(page):
        ts_file = next(f for f in cmp['files'] if f['path'].endswith('.ts') and any(ln['hl'] for h in f['hunks'] for ln in h['lines']))
        changed = next(ln for h in ts_file['hunks'] for ln in h['lines'] if ln['hl'] and ln['t'] == '+' and not ln.get('noEol'))
        block = page.locator(f'.rv-file[data-path="{ts_file["path"]}"]')
        block.scroll_into_view_if_needed()
        colored = block.locator('.rv-l .c span[style*="color"]')
        expect(colored.first).to_be_attached(timeout=10000)
        code = block.locator(f'.rv-l.a[data-n="{changed["n"]}"] .c')
        expect(code.locator('em').first).to_be_attached()
        expect(code).to_have_text(changed['text'])  # colors never change the text
        light = colored.first.evaluate('e => getComputedStyle(e).color')
        page.emulate_media(color_scheme='dark')
        try:
            page.wait_for_function('c => { const e = document.querySelector(\'.rv-l .c span[style*="color"]\'); return e && getComputedStyle(e).color !== c; }', arg=light, timeout=10000)
        finally:
            page.emulate_media(color_scheme='light')
        page.wait_for_function('c => { const e = document.querySelector(\'.rv-l .c span[style*="color"]\'); return e && getComputedStyle(e).color === c; }', arg=light, timeout=10000)
    syntax_colors(page)

    @check('diff: one band (<em>) per changed range, across the syntax tokens it covers')
    def change_bands(page):
        changed = [(f, ln) for f in cmp['files'] if f['path'].endswith('.ts') for h in f['hunks'] for ln in h['lines'] if ln['hl'] and not ln.get('noEol')]
        assert changed, 'no changed range in the .ts files of the PR'
        spans_tokens = False
        for f, ln in changed:
            side = 'a' if ln['t'] == '+' else 'r'
            number = ln['n'] if ln['t'] == '+' else ln['o']
            attr = 'data-n' if ln['t'] == '+' else 'data-o'
            code = page.locator(f'.rv-file[data-path="{f["path"]}"] .rv-l.{side}[{attr}="{number}"] .c')
            code.scroll_into_view_if_needed()
            words = re.search(r'\w', ln['text'])
            if words:  # the syntax colors first (a punctuation-only line like `});` gets none)
                expect(code.locator('span[style*="color"]').first).to_be_attached(timeout=10000)
            bands = code.locator('em')
            expect(bands).to_have_count(len(ln['hl']))
            texts = bands.all_text_contents()
            assert texts == [ln['text'][s:e] for s, e in ln['hl']], f'{texts} for {ln["hl"]} in {ln["text"]!r}'
            if words:
                # Several non-empty children: the band wraps several tokens (Vue's empty fragment anchors aside).
                spans_tokens = spans_tokens or code.evaluate('c => [...c.querySelectorAll("em")].some((em) => [...em.childNodes].filter((n) => n.textContent).length > 1)')
        assert spans_tokens, 'no band covers several syntax tokens: the check proves nothing'
    change_bands(page)

    @check('"whole file" context then 3 lines')
    def full_context(page):
        before = page.locator('.rv-diff .rv-l').count()
        page.locator('.rv-seg button[data-seg="full"]').click()
        page.wait_for_function(f'() => !document.querySelector(".rv-progress") && document.querySelectorAll(".rv-diff .rv-l").length > {before}', timeout=10000)
        page.locator('.rv-seg button[data-seg="3"]').click()
        page.wait_for_function(f'() => !document.querySelector(".rv-progress") && document.querySelectorAll(".rv-diff .rv-l").length === {before}', timeout=10000)
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

    @check('range comment: "+" then Shift+click "+" on a later line, range marked, one POST with start_to, card « lignes a–b »')
    def range_comment(page):
        new_side = lambda h: [ln['n'] for ln in h['lines'] if ln['t'] != '-' and ln['n'] is not None]  # noqa: E731
        lines = next(ns for ns in map(new_side, code_file['hunks']) if len(ns) >= 4)
        start, end = lines[0], lines[3]
        expected = sum(1 for h in code_file['hunks'] for n in new_side(h) if start <= n <= end)
        block = page.locator(f'.rv-file[data-path="{code_file["path"]}"]')

        def plus(n, shift=False):
            row = block.locator(f'.rv-l[data-n="{n}"]').first
            row.hover()
            row.locator('.rv-plus').click(modifiers=['Shift'] if shift else None)

        plus(start)
        composer = page.locator('.rv-comp textarea')
        expect(composer).to_be_focused()
        composer.fill('Commentaire sur une plage')
        expect(block.locator('.rv-l.in-range')).to_have_count(0)
        plus(end, shift=True)
        # the range is marked, the composer moved under its last line with the text typed, still focused
        expect(block.locator('.rv-l.in-range.composing')).to_have_count(expected)
        expect(page.locator('.rv-comp')).to_have_count(1)
        expect(page.locator('.rv-comp .q')).to_contain_text(f'Lignes {start}–{end} de v{exp_to}')
        under = page.evaluate('''() => {
            let e = document.querySelector('.rv-comp').previousElementSibling;
            while (e && !e.classList.contains('rv-l')) e = e.previousElementSibling;
            return e && e.dataset.n;
        }''')
        assert under == str(end), f'the composer should follow line {end}, follows {under}'
        expect(composer).to_have_value('Commentaire sur une plage')
        expect(composer).to_be_focused()
        # the browser did not select the text between the two clicks
        assert page.evaluate('() => String(window.getSelection())') == '', 'Shift+click selected text'
        calls.start()
        composer.press('ControlOrMeta+Enter')
        call = calls.wait(lambda c: is_post_comment(c) and (body_of(c).get('inline') or {}).get('start_to') == start, f'POST comments inline start_to={start}')
        assert call is None or body_of(call)['inline'] == {'path': code_file['path'], 'to': end, 'start_to': start}, call
        card = page.locator('.rv-diff .rv-th', has_text='Commentaire sur une plage')
        expect(card).to_contain_text(f'Posté sur v{exp_to} · lignes {start}–{end}', timeout=10000)
        expect(page.locator('.rv-comp')).to_have_count(0)
        # after the background refresh, the server's thread (start_to read back) keeps its lines marked
        expect(page.locator('.rv-head [data-action="refresh"]')).not_to_have_attribute('aria-busy', 'true', timeout=10000)
        expect(card.locator('.rv-cm')).not_to_have_class(re.compile(r'\bpending\b'))
        assert int(card.get_attribute('data-thread')) > 0
        expect(block.locator('.rv-l.composing')).to_have_count(0)
        expect(block.locator('.rv-l.in-range')).to_have_count(expected)
        if CALLS_URL:
            assert sum(1 for c in calls.all()[calls.mark:] if is_post_comment(c)) == 1, 'one POST for the range comment'
        # side by side: the new-side cells only
        page.locator('.rv-seg button[data-seg="split"]').click()
        try:
            expect(block.locator('.rv-sl .half.in-range')).to_have_count(expected)
            expect(block.locator('.rv-sl .half.in-range[data-o]')).to_have_count(0)
        finally:
            page.locator('.rv-seg button[data-seg="unified"]').click()
        expect(block.locator('.rv-l.in-range')).to_have_count(expected)
    range_comment(page)

    @check('reply to a thread, then delete my reply: it goes, no "deleted comment" left behind')
    def reply_and_delete(page):
        assert my_thread, 'no open thread of mine'
        page.locator(f'{thread_sel} .rv-th-f textarea').fill('Merci, c\'est bon pour moi.')
        calls.start()
        page.locator(f'{thread_sel} [data-action="send-reply"]').click()
        calls.wait(lambda c: is_post_comment(c) and comment_parent(c) == my_thread['id'], f'POST comments parent={my_thread["id"]}')
        mine = page.locator(f'{thread_sel} .rv-cm', has_text='Merci, c\'est bon pour moi.')
        expect(mine).to_have_count(1, timeout=10000)
        # shown at once as pending (temporary negative id), then replaced by the comment Bitbucket created
        expect(mine).not_to_have_class(re.compile(r'\bpending\b'), timeout=10000)
        cid = int(mine.get_attribute('data-comment'))
        assert cid > 0, cid
        deleted_cards = page.locator(f'{thread_sel} .rv-cm .deleted').count()
        calls.start()
        mine.locator('[data-action="delete"]').click()  # confirm() accepted by the dialog handler
        calls.wait(lambda c: c['method'] == 'DELETE' and c['path'].endswith(f'/comments/{cid}'), f'DELETE comments/{cid}')
        expect(page.locator(f'{thread_sel} .rv-cm', has_text='Merci, c\'est bon pour moi.')).to_have_count(0, timeout=10000)
        # nothing answered it: it is not shown at all, neither before nor after the background refresh
        expect(page.locator(f'{thread_sel} .rv-cm[data-comment="{cid}"]')).to_have_count(0)
        expect(page.locator('.rv-head [data-action="refresh"]')).not_to_have_attribute('aria-busy', 'true', timeout=10000)
        expect(page.locator(f'{thread_sel} .rv-cm[data-comment="{cid}"]')).to_have_count(0)
        expect(page.locator(f'{thread_sel} .rv-cm .deleted')).to_have_count(deleted_cards)
    reply_and_delete(page)

    @check('like: 👍 posts a "👍" reply shown as my chip, a second click deletes it; a single-emoji reply is a chip, not a reply')
    def like(page):
        assert my_thread and len(my_thread['comments']) >= 2, 'no open thread of mine with a reply'
        root, reply = my_thread['comments'][0], my_thread['comments'][1]
        thread = page.locator(thread_sel)
        emoji_card = thread.locator('.rv-cm .rv-html', has_text=re.compile(r'^\s*👍\s*$'))
        # Yann's "👍" reply to Camille's comment (fake Bitbucket): a chip under her comment, not a reply card
        theirs = thread.locator(f'.rv-cm[data-comment="{reply["id"]}"] .rv-react[data-emoji="👍"]')
        expect(theirs).to_have_text('👍 1')
        expect(theirs).not_to_have_class(re.compile(r'\bmine\b'))
        expect(theirs).to_have_attribute('title', 'Yann Bernard')
        expect(emoji_card).to_have_count(0)
        item = thread.locator(f'.rv-cm[data-comment="{root["id"]}"]')
        button = item.locator('[data-action="like"]')
        chip = item.locator('.rv-react[data-emoji="👍"]')
        refresh = page.locator('.rv-head [data-action="refresh"]')
        expect(button).to_have_attribute('aria-pressed', 'false')
        expect(button).to_have_attribute('title', 'J’aime')
        expect(chip).to_have_count(0)
        deleted_cards = thread.locator('.rv-cm .deleted').count()
        calls.start()
        button.click()
        call = calls.wait(lambda c: is_post_comment(c) and comment_parent(c) == root['id'], f'POST comments "👍" parent={root["id"]}')
        assert call is None or comment_raw(call) == '👍', call
        expect(chip).to_have_text('👍 1')
        expect(chip).to_have_class(re.compile(r'\bmine\b'))
        expect(chip).to_have_attribute('title', 'Thomas Girard (toi)')
        expect(button).to_have_attribute('aria-pressed', 'true')
        expect(button).to_have_attribute('title', 'Retirer ton 👍')
        # the write is over, then the background refresh: still my chip, never a reply card
        expect(button).not_to_have_attribute('aria-busy', 'true', timeout=10000)
        expect(refresh).not_to_have_attribute('aria-busy', 'true', timeout=10000)
        expect(chip).to_have_text('👍 1')
        expect(chip).to_have_class(re.compile(r'\bmine\b'))
        expect(emoji_card).to_have_count(0)
        # the reply just created: the unlike must delete that one
        detail = api(pr_api(MAIN_PR) + '?fresh=1')
        mine = next((c for t in detail['threads'] for c in t['comments'] if c['id'] == root['id']), None)
        liked = next((r for r in (mine or {}).get('reactions', []) if r['emoji'] == '👍'), None)
        assert liked and len(liked['myCommentIds']) == 1, mine
        like_id = liked['myCommentIds'][0]
        calls.start()
        button.click()
        calls.wait(lambda c: c['method'] == 'DELETE' and c['path'].endswith(f'/comments/{like_id}'), f'DELETE comments/{like_id} (my "👍" reply)')
        expect(chip).to_have_count(0, timeout=10000)
        expect(button).to_have_attribute('aria-pressed', 'false')
        expect(button).not_to_have_attribute('aria-busy', 'true', timeout=10000)
        expect(refresh).not_to_have_attribute('aria-busy', 'true', timeout=10000)
        # a like taken back shows neither as a chip nor as a deleted comment
        expect(chip).to_have_count(0)
        expect(thread.locator('.rv-cm .deleted')).to_have_count(deleted_cards)
    like(page)

    @check('edit my comment: save, Escape, comment deleted meanwhile')
    def edit_comment(page):
        assert my_thread, 'no open thread of mine'
        page.locator(f'{thread_sel} .rv-th-f textarea').fill('Texte à modifier')
        page.locator(f'{thread_sel} [data-action="send-reply"]').click()
        mine = page.locator(f'{thread_sel} .rv-cm', has_text='Texte à modifier')
        expect(mine).to_have_count(1, timeout=10000)
        expect(mine).not_to_have_class(re.compile(r'\bpending\b'), timeout=10000)
        cid = int(mine.get_attribute('data-comment'))
        item = page.locator(f'{thread_sel} .rv-cm[data-comment="{cid}"]')
        # save with Cmd/Ctrl+Enter: the PUT carries the new text, shown without reload
        item.locator('[data-action="edit"]').click()
        editor = item.locator('textarea[data-edit]')
        expect(editor).to_have_value('Texte à modifier')
        expect(editor).to_be_focused()
        editor.fill('Texte corrigé')
        calls.start()
        editor.press('ControlOrMeta+Enter')
        call = calls.wait(lambda c: c['method'] == 'PUT' and c['path'].endswith(f'/comments/{cid}'), f'PUT comments/{cid}')
        assert call is None or (body_of(call).get('content') or {}).get('raw') == 'Texte corrigé', call
        expect(item).to_contain_text('Texte corrigé', timeout=10000)
        expect(item.locator('textarea[data-edit]')).to_have_count(0)
        # Escape cancels: the old text stays, no write
        item.locator('[data-action="edit"]').click()
        item.locator('textarea[data-edit]').fill('Brouillon abandonné')
        calls.start()
        item.locator('textarea[data-edit]').press('Escape')
        expect(item.locator('textarea[data-edit]')).to_have_count(0)
        expect(item).to_contain_text('Texte corrigé')
        expect(item).not_to_contain_text('Brouillon abandonné')
        assert not any(c['method'] == 'PUT' for c in calls.all()[calls.mark:]), 'Escape must not send anything'
        # deleted meanwhile: error shown, the editor stays open with the text
        fake_delete_comment(cid)
        item.locator('[data-action="edit"]').click()
        editor = item.locator('textarea[data-edit]')
        editor.fill('Texte perdu ?')
        editor.press('ControlOrMeta+Enter')
        expect(page.locator('.rv-alert')).to_have_count(1, timeout=10000)
        expect(editor).to_have_value('Texte perdu ?')
        page.locator('.rv-alert button').click()
    edit_comment(page)

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

    @check('reopen a resolved thread from its folded bar, then from the Discussions tab')
    def reopen_folded(page):
        assert my_thread, 'no open thread of mine'
        page.check('#show-resolved')
        bar = page.locator(f'{thread_sel}[data-resolved="1"]')
        expect(bar.locator('[data-action="reopen"]')).to_be_visible()
        calls.start()
        bar.locator('[data-action="reopen"]').click()
        calls.wait(lambda c: c['method'] == 'DELETE' and c['path'].endswith(f'/comments/{my_thread["id"]}/resolve'), f'DELETE comments/{my_thread["id"]}/resolve')
        expect(page.locator(f'{thread_sel} [data-action="resolve"]')).to_be_visible(timeout=10000)
        expect(page.locator(f'{thread_sel}[data-resolved="1"]')).to_have_count(0)
        page.uncheck('#show-resolved')
        # same from the Discussions tab (expanded thread)
        page.locator(f'{thread_sel} [data-action="resolve"]').click()
        expect(page.locator(thread_sel)).to_have_count(0, timeout=10000)
        page.click('.rv-tab[data-tab="discussions"]')
        page.locator('details[data-group="resolved"] summary').click()
        calls.start()
        page.locator(f'.rv-ditem[data-thread="{my_thread["id"]}"] [data-action="reopen"]').click()
        calls.wait(lambda c: c['method'] == 'DELETE' and c['path'].endswith(f'/comments/{my_thread["id"]}/resolve'), f'DELETE comments/{my_thread["id"]}/resolve (Discussions)')
        expect(page.locator(f'.rv-ditem[data-thread="{my_thread["id"]}"] [data-action="resolve"]')).to_be_visible(timeout=10000)
        page.click('.rv-tab[data-tab="diff"]')
    reopen_folded(page)

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
        count = page.locator('.rv-appr [data-appr-count]')
        expect(count).to_have_text('1/2 approbation')
        expect(count).not_to_have_class(re.compile(r'\bok\b'))
        expect(count).to_have_attribute('title', 'Approbations requises pour ce dépôt : 2 (réglages)')
        calls.start()
        button.click()
        calls.wait(lambda c: c['method'] == 'POST' and c['path'].endswith('/approve'), 'POST approve')
        expect(page.locator('[data-action="unapprove"]')).to_have_text('Retirer l\'approbation', timeout=10000)
        expect(page.locator('.rv-appr')).to_contain_text(f'toi · sur v{n}')
        expect(count).to_have_text('2/2 approbations')
        expect(count).to_have_class(re.compile(r'\bok\b'))
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

    @check('file list: folder tree in the diff order, folder collapsed with a summary and reopened by k')
    def file_tree(page):
        open_pr(page, MAIN_PR, f'?from={exp_from}&to={exp_to}')
        list_paths = page.locator('.rv-files .rv-f').evaluate_all('els => els.map(e => e.dataset.path)')
        diff_paths = page.locator('.rv-diff .rv-file').evaluate_all('els => els.map(e => e.dataset.path)')
        assert list_paths == diff_paths, f'list {list_paths} != diff {diff_paths}'
        path = code_file['path']
        folder = path.rsplit('/', 1)[0]
        idx = list_paths.index(path)
        assert idx + 1 < len(list_paths) and not list_paths[idx + 1].startswith(f'{folder}/'), list_paths
        dir_row = page.locator(f'.rv-d[data-dir="{folder}"]')
        file_row = page.locator(f'.rv-f[data-path="{path}"]')
        expect(dir_row).to_have_attribute('aria-expanded', 'true')
        expect(file_row).to_contain_text(path.rsplit('/', 1)[1])
        page.locator(f'.rv-f[data-path="{list_paths[idx + 1]}"]').click()
        expect(page.locator('.rv-f.cur')).to_have_attribute('data-idx', str(idx + 1))
        dir_row.click()
        expect(dir_row).to_have_attribute('aria-expanded', 'false')
        expect(file_row).to_have_count(0)
        expect(dir_row.locator('.un, .ck.seen')).to_have_count(1)
        page.locator('.rv-files').screenshot(path=os.path.join(SHOTS, 'file-tree-collapsed.png'))
        page.keyboard.press('k')
        expect(dir_row).to_have_attribute('aria-expanded', 'true')
        expect(page.locator('.rv-f.cur')).to_have_attribute('data-path', path)
    file_tree(page)

    @check('mark all as viewed: one click ticks every file, the same button undoes it, no Bitbucket call')
    def mark_all_viewed(page):
        open_pr(page, MAIN_PR, f'?from={exp_from}&to={exp_to}')
        rows = page.locator('.rv-files .rv-f')
        total = page.locator('.rv-diff .rv-file').count()
        before = len(bitbucket_requests())
        if page.locator('[data-action="unmark-all-viewed"]').count():
            page.locator('[data-action="unmark-all-viewed"]').click()
        expect(page.locator('[data-action="mark-all-viewed"]')).to_be_visible()
        page.locator('[data-action="mark-all-viewed"]').click()
        expect(page.locator('.rv-files .rv-f .ck.seen')).to_have_count(rows.count())
        expect(page.locator('.rv-files .rv-prog .cnt')).to_contain_text(f'{total} / {total}')
        expect(page.locator('[data-action="unmark-all-viewed"]')).to_have_text('Tout marquer non vu')
        page.reload()  # persisted by the server
        wait_pr_ready(page)
        expect(page.locator('.rv-files .rv-prog .cnt')).to_contain_text(f'{total} / {total}')
        page.locator('[data-action="unmark-all-viewed"]').click()
        expect(page.locator('.rv-files .rv-f .ck.seen')).to_have_count(0)
        expect(page.locator('.rv-files .rv-prog .cnt')).to_contain_text(f'0 / {total}')
        page.keyboard.press('Shift+V')
        expect(page.locator('.rv-files .rv-prog .cnt')).to_contain_text(f'{total} / {total}')
        assert [r for r in bitbucket_requests()[before:] if r.get('method') != 'GET'] == [], 'a write reached Bitbucket'
        # back to the state the next checks expect: only the code file seen
        page.locator('[data-action="unmark-all-viewed"]').click()
        expect(page.locator('.rv-files .rv-f .ck.seen')).to_have_count(0)
        page.locator(f'.rv-file[data-path="{code_file["path"]}"] input[data-action="viewed"]').check()
        expect(page.locator('.rv-files .rv-prog .cnt')).to_contain_text(f'1 / {total}')
        wait_api(lambda: list(api(pr_api(MAIN_PR))['review']['viewed']) == [code_file['path']], 'review.viewed restored')
    mark_all_viewed(page)

    @check('v marks the current file seen and moves to the next unseen one (then stays when nothing is left)')
    def v_walks_unseen(page):
        open_pr(page, MAIN_PR, f'?from={exp_from}&to={exp_to}')
        total = page.locator('.rv-diff .rv-file').count()
        assert total == 2, f'the fixture range has 2 files, got {total}'
        page.locator('[data-action="mark-all-viewed"]').click()
        page.locator('[data-action="unmark-all-viewed"]').click()
        expect(page.locator('.rv-files .rv-f .ck.seen')).to_have_count(0)
        first = int(page.locator('.rv-f.cur').get_attribute('data-idx'))
        assert first == 0, f'starts on the first file, got {first}'
        page.locator('body').click(position={'x': 5, 'y': 5})
        page.keyboard.press('v')
        expect(page.locator('.rv-files .rv-f .ck.seen')).to_have_count(1)
        expect(page.locator('.rv-f.cur')).to_have_attribute('data-idx', str(first + 1))
        # after the scroll has settled (files collapsed, page re-laid out) the current file is still the target
        page.wait_for_timeout(800)
        expect(page.locator('.rv-f.cur')).to_have_attribute('data-idx', str(first + 1))
        page.keyboard.press('v')
        expect(page.locator('.rv-files .rv-f .ck.seen')).to_have_count(2)
        # every file is seen now: v on the last one marks it and stays
        expect(page.locator('.rv-f.cur')).to_have_attribute('data-idx', str(first + 1))
        # back to the state the next checks expect: only the code file seen
        page.locator('[data-action="unmark-all-viewed"]').click()
        expect(page.locator('.rv-files .rv-f .ck.seen')).to_have_count(0)
        page.locator(f'.rv-file[data-path="{code_file["path"]}"] input[data-action="viewed"]').check()
        expect(page.locator('.rv-files .rv-prog .cnt')).to_contain_text(f'1 / {total}')
        wait_api(lambda: list(api(pr_api(MAIN_PR))['review']['viewed']) == [code_file['path']], 'review.viewed restored')
    v_walks_unseen(page)

    @check('file list: width dragged from its edge, remembered after a reload, reset by double-click')
    def file_list_resize(page):
        panel = page.locator('.rv-files')
        handle = page.locator('.rv-resize')
        initial = panel.bounding_box()['width']
        box = handle.bounding_box()
        x, y = box['x'] + box['width'] / 2, box['y'] + min(60, box['height'] / 2)
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x + 120, y, steps=6)
        page.mouse.up()
        wider = panel.bounding_box()['width']
        assert abs(wider - (initial + 120)) <= 2, f'{initial} -> {wider}'
        page.reload()
        wait_pr_ready(page)
        assert abs(panel.bounding_box()['width'] - wider) <= 2
        handle.dblclick()
        page.wait_for_function(f'() => Math.abs(document.querySelector(".rv-files").getBoundingClientRect().width - {initial}) <= 2')
        handle.focus()
        page.keyboard.press('ArrowRight')
        assert abs(panel.bounding_box()['width'] - (initial + 16)) <= 2
        handle.dblclick()
    file_list_resize(page)

    @check('diff_search: a file name fragment filters the list, a word gives counts, Enter walks the matches, Escape restores')
    def diff_search(page):
        # full version against master: three files, enough words shared by two of them
        open_pr(page, MAIN_PR, f'?from=0&to={n}')
        full = api(f'{pr_api(MAIN_PR)}/compare?from=0&to={n}&context=3')
        box = page.locator('[data-search]')
        rows = page.locator('.rv-files .rv-f')
        all_paths = sorted(rows.evaluate_all('els => els.map(e => e.dataset.path)'))
        lines_of = [[ln['text'].lower() for h in f['hunks'] for ln in h['lines']] for f in full['files']]

        def listed(query):
            q = query.lower()
            return sorted(f['path'] for f, lines in zip(full['files'], lines_of) if q in f['path'].lower() or any(q in t for t in lines))

        status = page.locator('[data-search-status]')
        expect(status).to_have_text('')  # live region present before any search
        expect(box).to_have_attribute('aria-keyshortcuts', '/')
        page.locator('body').click(position={'x': 5, 'y': 5})
        page.keyboard.press('/')
        expect(box).to_be_focused()
        # a file name found in no line: the status says so and tells the name matches; the fragment is highlighted
        name_only = next(b for b in (f['path'].rsplit('/', 1)[1] for f in full['files']) if not any(b.lower() in t for lines in lines_of for t in lines))
        box.fill(name_only)
        expect(status).to_contain_text('Aucun résultat dans le contenu')
        expect(page.locator('.rv-files .rv-f .nm mark')).to_have_text(name_only)
        # file names (case-insensitive): only the matching rows, plus the files containing the fragment
        stem = code_file['path'].rsplit('/', 1)[1].split('.')[0]
        frag = stem[:max(4, len(stem) // 2)].upper()
        box.fill(frag)
        page.wait_for_function('n => document.querySelectorAll(".rv-files .rv-f").length === n', arg=len(listed(frag)))
        assert sorted(rows.evaluate_all('els => els.map(e => e.dataset.path)')) == listed(frag)
        by_name = sum(1 for f in full['files'] if frag.lower() in f['path'].lower())
        expect(page.locator('.rv-prog [data-name-matches]')).to_contain_text(str(by_name))
        # contents: a word found once in a first file and in a second one, in no other file
        words = sorted({w for lines in lines_of for t in lines for w in re.findall(r'[a-z_]{4,}', t)})
        word, first, second = None, None, None
        for w in words:
            counts = [sum(t.count(w) for t in lines) for lines in lines_of]
            found = [i for i, c in enumerate(counts) if c]
            if len(found) == 2 and counts[found[0]] == 1:
                word, first, second = w, full['files'][found[0]]['path'], full['files'][found[1]]['path']
                total = sum(counts)
                break
        assert word, 'no word found once in one file and in exactly one other file'
        box.fill(word)
        expect(rows).to_have_count(len(listed(word)))
        expect(page.locator(f'.rv-f[data-path="{first}"] [data-hits]')).to_have_text('1')
        expect(page.locator(f'.rv-f[data-path="{second}"] [data-hits]')).to_have_text(str(total - 1))
        expect(status).to_contain_text(str(total))
        box.press('Enter')
        expect(page.locator(f'.rv-file[data-path="{first}"] mark.cur')).to_have_count(1)
        box.press('Enter')
        second_block = page.locator(f'.rv-file[data-path="{second}"]')
        expect(second_block).not_to_have_class(re.compile(r'\bfolded\b'))
        cur = second_block.locator('mark.cur')
        expect(cur).to_have_count(1)
        expect(page.locator('mark.cur')).to_have_count(1)
        assert cur.inner_text().lower() == word
        expect(cur).to_be_in_viewport()
        expect(status).to_have_text(f'2 / {total}')
        expect(page.locator('.rv-f.cur')).to_have_attribute('data-path', second)
        expect(box).to_be_focused()
        expect(box).to_be_in_viewport()
        assert box.evaluate('e => getComputedStyle(e.parentElement).position') == 'sticky'
        page.screenshot(path=os.path.join(SHOTS, 'diff-search.png'))
        # side-by-side: the same current match
        page.locator('.rv-seg button[data-seg="split"]').click()
        second_added = next(f for f in full['files'] if f['path'] == second)['status'] == 'added'
        # an added file stays unified in side-by-side view
        expect(second_block.locator('.rv-l mark.cur' if second_added else '.rv-sl mark.cur').first).to_be_attached()
        page.locator('.rv-seg button[data-seg="unified"]').click()
        box.press('Shift+Enter')
        expect(page.locator(f'.rv-file[data-path="{first}"] mark.cur')).to_have_count(1)
        box.press('Escape')
        expect(box).to_have_value('')
        expect(box).not_to_be_focused()
        expect(page.locator('mark')).to_have_count(0)
        expect(rows).to_have_count(len(all_paths))
    diff_search(page)

    @check('diff_search side by side: Enter moves the current match from a removed line to the added one on its row')
    def diff_search_split_pair(page):
        full = api(f'{pr_api(MAIN_PR)}/compare?from=0&to={n}&context=3')
        # a removed line and the added line paired with it (same row side by side) starting with the same words
        pair = None
        for f in full['files']:
            if f['status'] != 'modified':
                continue
            for h in f['hunks']:
                lines = h['lines']
                k = 0
                while k < len(lines) and not pair:
                    if lines[k]['t'] != '-':
                        k += 1
                        continue
                    removed = []
                    while k < len(lines) and lines[k]['t'] == '-':
                        removed.append(lines[k]['text'])
                        k += 1
                    added = []
                    while k < len(lines) and lines[k]['t'] == '+':
                        added.append(lines[k]['text'])
                        k += 1
                    for old, new in zip(removed, added):
                        common = os.path.commonprefix([old, new])
                        query = common.strip()
                        if len(query) >= 4 and old.lower().find(query.lower()) == new.lower().find(query.lower()) == common.index(query):
                            pair = (old, new, query)
                            break
        assert pair, 'no removed / added pair starting with the same words'
        old, new, query = pair
        pattern = re.compile(re.escape(query), re.I)
        hits = [(ln['t'], ln['text']) for f in full['files'] for h in f['hunks'] for ln in h['lines'] for _ in pattern.finditer(ln['text'])]
        at = next(i for i, (t, text) in enumerate(hits) if t == '-' and text == old)
        assert hits[at + 1] == ('+', new), f'the two matches of "{query}" do not follow each other: {hits}'
        open_pr(page, MAIN_PR, f'?from=0&to={n}')
        page.locator('.rv-seg button[data-seg="split"]').click()
        box = page.locator('[data-search]')
        # a match cut by the syntax colors is several <mark> elements: count the cells holding the current one
        cur_removed = page.locator('.rv-sl .half.r:has(mark.cur)')
        cur_added = page.locator('.rv-sl .half.a:has(mark.cur)')
        try:
            status = page.locator('[data-search-status]')
            box.fill(query)
            for _ in range(at + 1):
                box.press('Enter')
            expect(status).to_have_text(f'{at + 1} / {len(hits)}')
            expect(cur_removed).to_have_count(1)
            expect(cur_added).to_have_count(0)
            box.press('Enter')
            expect(status).to_have_text(f'{at + 2} / {len(hits)}')
            expect(cur_added).to_have_count(1)
            expect(cur_removed).to_have_count(0)
            expect(page.locator('.rv-sl:has(mark.cur)')).to_have_count(1)
            box.press('Shift+Enter')
            expect(cur_removed).to_have_count(1)
            expect(cur_added).to_have_count(0)
        finally:
            box.fill('')
            page.locator('.rv-seg button[data-seg="unified"]').click()
    diff_search_split_pair(page)

    @check('added_file_unified: in side-by-side view, an added file stays unified, a modified one splits')
    def added_file_unified(page):
        full_files = api(f'{pr_api(MAIN_PR)}/compare?from=0&to={n}&context=3')['files']
        added = next((f for f in full_files if f['status'] == 'added' and f['hunks']), None)
        assert added, 'no added file in the PR'
        page.locator('.rv-seg button[data-seg="split"]').click()
        try:
            block = page.locator(f'.rv-file[data-path="{added["path"]}"]')
            expect(block.locator('.rv-l').first).to_be_attached()
            expect(block.locator('.rv-sl')).to_have_count(0)
            expect(page.locator('.rv-file.split .rv-sl').first).to_be_attached()
        finally:
            page.locator('.rv-seg button[data-seg="unified"]').click()
    added_file_unified(page)

    @check('goto_definition: Ctrl/⌘+click a name → its definition in another file, else its import, several → a choice, none → a notice; Alt+← back')
    def goto_definition(page):
        open_pr(page, MAIN_PR, f'?from=0&to={n}')
        full = api(f'{pr_api(MAIN_PR)}/compare?from=0&to={n}&context=3')
        spec_path, action_path = 'tests/ActionSpec.ts', 'src/Action.ts'
        lines_of = {f['path']: [ln for h in f['hunks'] for ln in h['lines']] for f in full['files']}
        spec, action = lines_of[spec_path], lines_of[action_path]
        new_n = lambda lines, text: next(ln['n'] for ln in lines if ln['t'] != '-' and text in ln['text'])  # noqa: E731
        use_n = new_n(spec, 'return new Action().run(payload)')
        class_n = new_n(action, 'export class Action')
        import_n = new_n(spec, 'import { buildPayload }')
        call_n = new_n(spec, 'const payload = buildPayload()')
        describe_n = new_n(spec, 'describe(')
        payload_ns = [ln['n'] for ln in spec if 'const payload' in ln['text']]
        assert len(payload_ns) == 2, payload_ns
        spec_block = page.locator(f'.rv-file[data-path="{spec_path}"]')
        action_block = page.locator(f'.rv-file[data-path="{action_path}"]')
        flashed = re.compile(r'\bflash\b')
        notice = page.locator('[data-goto-notice]')
        choice = page.locator('[data-goto-choice]')

        def row(block, number):
            return block.locator(f'.rv-l[data-n="{number}"]')

        def name(number, word):
            return row(spec_block, number).locator('.c .sym', has_text=re.compile(f'^{word}$')).first

        def top(locator):
            return locator.evaluate('e => e.getBoundingClientRect().top')

        def settled_scroll():
            """The scroll position once it stayed put for 3 polls of 100 ms (no fixed sleep: the machine may be slow)."""
            page.evaluate('() => { window.__gotoY = undefined; window.__gotoN = 0; }')
            page.wait_for_function('''() => {
                if (window.__gotoY === scrollY) { window.__gotoN++; } else { window.__gotoY = scrollY; window.__gotoN = 0; }
                return window.__gotoN >= 3;
            }''', polling=100)
            return page.evaluate('scrollY')

        def centered(locator):
            """In the middle of the window (a click does not scroll), returns the settled scroll position."""
            locator.evaluate('e => e.scrollIntoView({ block: "center" })')
            return settled_scroll()

        def stays(scroll):
            """Nothing moved: the scroll settles where it was (2 px of tolerance)."""
            now = settled_scroll()
            assert abs(now - scroll) <= 2, (scroll, now)

        def lands_under_bars(locator):
            """The line settles just under the toolbar (polled)."""
            page.wait_for_function('''(e) => {
                const bar = document.querySelector(".rv-dtb").getBoundingClientRect().bottom;
                const t = e.getBoundingClientRect().top;
                return t >= bar - 0.5 && t <= bar + 120;
            }''', arg=locator.element_handle(), polling=100)

        def lands_at(locator, y):
            """The line settles at `y` px from the top of the window, 2 px of tolerance (polled)."""
            page.wait_for_function('([e, y]) => Math.abs(e.getBoundingClientRect().top - y) <= 2', arg=[locator.element_handle(), y], polling=100)

        action_name = name(use_n, 'Action')
        action_name.scroll_into_view_if_needed()
        expect(action_name).to_be_attached(timeout=10000)  # names are tagged once the syntax colors arrive
        underline = 'e => getComputedStyle(e).textDecorationLine'
        # the modifier held: a class on the diff, names underline on hover (CSS), keywords and strings do not
        action_name.hover()
        assert action_name.evaluate(underline) == 'none'
        page.keyboard.down('ControlOrMeta')
        try:
            expect(page.locator('.rv-diff.rv-goto')).to_have_count(1)
            action_name.hover()
            assert action_name.evaluate(underline) == 'underline'
            assert action_name.evaluate('e => getComputedStyle(e).cursor') == 'pointer'
            keyword = row(spec_block, use_n).locator('.c .nosym', has_text=re.compile('^return$')).first
            keyword.hover()
            assert keyword.evaluate(underline) == 'none'
        finally:
            page.keyboard.up('ControlOrMeta')
        expect(page.locator('.rv-diff.rv-goto')).to_have_count(0)

        # a plain click: nothing (no jump, no composer)
        scroll = centered(action_name)
        action_name.click()
        stays(scroll)
        expect(notice).to_have_count(0)
        expect(page.locator('.rv-comp')).to_have_count(0)

        # a class used here, defined in another file: that file's line under the bars, flashed; Alt+← comes back
        before = top(row(spec_block, use_n))
        action_name.click(modifiers=['ControlOrMeta'])
        dest = row(action_block, class_n)
        expect(dest).to_have_class(flashed)
        expect(dest).to_be_in_viewport()
        expect(notice.locator('[data-goto-back]')).to_be_visible()
        lands_under_bars(dest)
        expect(page.locator('.rv-f.cur')).to_have_attribute('data-path', action_path)
        page.keyboard.press('Alt+ArrowLeft')
        expect(row(spec_block, use_n)).to_have_class(flashed)
        lands_at(row(spec_block, use_n), before)

        # imported from a file outside the PR: the import line, no offer
        name(call_n, 'buildPayload').click(modifiers=['ControlOrMeta'])
        expect(row(spec_block, import_n)).to_have_class(flashed)
        expect(notice).to_contain_text('La définition de buildPayload n’est pas dans la diff affichée : voici son import')
        expect(notice.locator('[data-goto-offer]')).to_have_count(0)
        page.keyboard.press('Escape')
        expect(notice).to_have_count(0)

        # defined twice: a choice under the click, keyboard driven
        payload = name(use_n, 'payload')
        payload.scroll_into_view_if_needed()
        payload.click(modifiers=['ControlOrMeta'])
        items = choice.locator('[data-goto-item]')
        expect(items).to_have_count(2)
        assert items.evaluate_all('els => els.map((e) => +e.dataset.line)') == payload_ns
        expect(items.first).to_be_focused()
        assert top(choice) >= payload.bounding_box()['y'] + payload.bounding_box()['height'] - 1, 'the choice opens under the click'
        page.keyboard.press('Escape')
        expect(choice).to_have_count(0)
        expect(row(spec_block, use_n)).to_be_focused()  # the focus back on the clicked line
        payload.click(modifiers=['ControlOrMeta'])
        expect(items.first).to_be_focused()
        page.keyboard.press('ArrowDown')
        expect(items.nth(1)).to_be_focused()
        page.keyboard.press('Enter')
        expect(choice).to_have_count(0)
        expect(row(spec_block, payload_ns[1])).to_have_class(flashed)
        expect(row(spec_block, payload_ns[1])).to_be_focused()  # on the line reached
        page.keyboard.press('Escape')

        # the definition line itself: nothing
        own = name(payload_ns[0], 'payload')
        scroll = centered(own)
        own.click(modifiers=['ControlOrMeta'])
        stays(scroll)
        expect(choice).to_have_count(0)
        expect(notice).to_have_count(0)

        # selecting text with the modifier held: nothing
        scroll = centered(action_name)
        box = action_name.bounding_box()
        page.keyboard.down('ControlOrMeta')
        try:
            page.mouse.move(box['x'] + 1, box['y'] + box['height'] / 2)
            page.mouse.down()
            page.mouse.move(box['x'] + box['width'] - 1, box['y'] + box['height'] / 2, steps=5)
            page.mouse.up()
        finally:
            page.keyboard.up('ControlOrMeta')
        assert page.evaluate('getSelection().toString()'), 'the drag selected nothing: the check proves nothing'
        stays(scroll)
        expect(notice).to_have_count(0)
        page.evaluate('getSelection().removeAllRanges()')

        # nothing anywhere: a notice, with the "whole file" hint while it is off
        name(describe_n, 'describe').click(modifiers=['ControlOrMeta'])
        expect(notice).to_contain_text('Définition introuvable dans la diff affichée')
        expect(notice).to_contain_text('active « fichier entier » pour chercher dans tout le fichier')
        page.keyboard.press('Escape')

        # side by side: a name on the old side (left) reaches the definition on the new side (right)
        page.locator('.rv-seg button[data-seg="split"]').click()
        try:
            if_o = next(ln['o'] for ln in action if ln['t'] == ' ' and 'if (!id)' in ln['text'])
            id_n = new_n(action, 'const id =')
            left = action_block.locator(f'.half[data-o="{if_o}"] .c .sym', has_text=re.compile('^id$')).first
            left.scroll_into_view_if_needed()
            left.click(modifiers=['ControlOrMeta'])
            expect(action_block.locator(f'.half[data-n="{id_n}"]')).to_have_class(flashed)
        finally:
            page.locator('.rv-seg button[data-seg="unified"]').click()
    goto_definition(page)

    @check('sticky_toolbar: the diff toolbar stays under the timeline, j/k lands the file header just under it')
    def sticky_toolbar(page):
        # a short window: the last file can reach the top (the tail below the diff is 55vh)
        page.set_viewport_size({'width': 1440, 'height': 520})
        try:
            open_pr(page, MAIN_PR, f'?from=0&to={n}')
            count = page.locator('.rv-diff .rv-file').count()
            assert count >= 2, f'{count} files: j/k needs two'
            page.evaluate('() => { const f = [...document.querySelectorAll(".rv-diff .rv-file")].pop(); window.scrollTo(0, f.getBoundingClientRect().top + scrollY); }')
            bars = '() => { const r = s => document.querySelector(s).getBoundingClientRect(); return {tl: r(".rv-tl").bottom, top: r(".rv-dtb").top, bottom: r(".rv-dtb").bottom}; }'
            expect(page.locator('.rv-f.cur')).to_have_attribute('data-idx', str(count - 1))
            box = page.evaluate(bars)
            assert abs(box['top'] - box['tl']) <= 1, f'toolbar not right under the timeline: {box}'
            assert box['bottom'] - box['top'] > 20, box
            expect(page.locator('.rv-dtb [data-seg="split"]')).to_be_in_viewport()
            page.evaluate('document.activeElement && document.activeElement.blur()')

            def header_under_toolbar(key, idx):
                page.keyboard.press(key)
                expect(page.locator('.rv-f.cur')).to_have_attribute('data-idx', str(idx))
                page.wait_for_timeout(100)
                pos = page.evaluate('''i => {
                    const fh = document.querySelectorAll(".rv-diff .rv-file")[i].querySelector(".rv-fh").getBoundingClientRect();
                    const at = document.elementFromPoint(fh.left + 20, fh.top + fh.height / 2);
                    return {fh: fh.top, toolbar: document.querySelector(".rv-dtb").getBoundingClientRect().bottom,
                            visible: !!at && !!at.closest(".rv-fh"), atEnd: scrollY >= document.documentElement.scrollHeight - innerHeight - 1};
                }''', idx)
                assert pos['visible'] and pos['fh'] >= pos['toolbar'] - 0.5, f'{key}: file header hidden behind the toolbar: {pos}'
                assert pos['atEnd'] or pos['fh'] <= pos['toolbar'] + 12, f'{key}: file header not just under the toolbar: {pos}'
                now = page.evaluate(bars)
                assert abs(now['top'] - now['tl']) <= 1, f'{key}: toolbar no longer under the timeline: {now}'

            header_under_toolbar('k', count - 2)
            header_under_toolbar('j', count - 1)
            header_under_toolbar('k', count - 2)
            # narrow window (file list above the diff): same sticky toolbar, no horizontal scroll
            page.set_viewport_size({'width': 760, 'height': 520})
            page.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)')
            page.wait_for_timeout(100)
            box = page.evaluate(bars)
            assert abs(box['top'] - box['tl']) <= 1, f'narrow: toolbar not right under the timeline: {box}'
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'narrow: horizontal scroll'
        finally:
            page.set_viewport_size({'width': 1440, 'height': 900})
    sticky_toolbar(page)

    @check('shortcuts help: focus trapped in the box, returned to the button on close')
    def shortcuts_focus(page):
        opener = page.locator('.rv-nav button[aria-label="Raccourcis clavier"]')
        opener.click()
        overlay = page.locator('.rv-overlay')
        expect(overlay).to_be_visible()
        expect(overlay.locator('button', has_text='Fermer')).to_be_focused()
        expect(overlay).to_contain_text('⌘/Ctrl + clic')
        expect(overlay).to_contain_text('⌥/Alt + ←')
        expect(overlay).to_contain_text('Accueil : rechercher dans les PR')
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

    @check('home: one URL field, no top bar; ? opens the shortcuts, ⚙ goes to settings')
    def home_header(page):
        page.goto(url(''))
        expect(page.locator('.rv-home-top .rv-btn')).to_be_visible(timeout=20000)
        expect(page.locator('.rv-url')).to_have_count(1)
        expect(page.locator('.rv-nav')).to_have_count(0)
        page.locator('.rv-home-top button[aria-label="Raccourcis clavier"]').click()
        overlay = page.locator('.rv-overlay')
        expect(overlay).to_be_visible()
        overlay.locator('button', has_text='Fermer').click()
        expect(overlay).to_have_count(0)
        page.locator('.rv-home-top a[aria-label="Réglages"]').click()
        expect(page).to_have_url(re.compile('#/settings'))
        page.goto(url(''))
    home_header(page)

    @check('pasting a Bitbucket URL in the top bar')
    def url_paste(page):
        ws, repo, pid = MAIN_PR.split('/')
        page.goto(url(''))
        page.fill('.rv-home-top .rv-url', f'https://bitbucket.org/{ws}/{repo}/pull-requests/{pid}/diff')
        page.press('.rv-home-top .rv-url', 'Enter')
        expect(page).to_have_url(re.compile(f'#/pr/{ws}/{repo}/{pid}'))
        wait_pr_ready(page)
    url_paste(page)

    if FAKE_PRS and CALLS_URL:
        @check('refresh_button: ↻ shows a comment written meanwhile on Bitbucket and says what is new')
        def refresh_button(page):
            open_pr(page, MAIN_PR)
            fake_comment('Yann a commenté pendant ta relecture')
            before = len(bitbucket_requests())
            button = page.locator('.rv-head [data-action="refresh"]')
            button.click()
            status = page.locator('.rv-head .rv-refresh-status[role="status"]')
            expect(status).to_have_text('1 nouveau commentaire', timeout=10000)
            expect(button).not_to_have_attribute('aria-busy', 'true')
            spent = bitbucket_requests()[before:]
            per_path = {}
            for r in spent:
                key = r['path'].rsplit('/pullrequests/', 1)[-1]
                per_path[key] = per_path.get(key, 0) + 1
            log(f'      ↻: {len(spent)} Bitbucket requests (fake pages of 3 activities, 4 comments): {per_path}')
            page.click('.rv-tab[data-tab="discussions"]')
            expect(page.locator('.rv-ditem', has_text='Yann a commenté pendant ta relecture')).to_be_visible()
            # nothing new since: "À jour", then the text goes away by itself
            button.click()
            expect(status).to_have_text('À jour', timeout=10000)
            expect(status).to_have_text('', timeout=8000)
            page.click('.rv-tab[data-tab="diff"]')
        refresh_button(page)

        @check('pulse_banner: news found by the periodic check, never for my own comment')
        def pulse_banner(page):
            other = page.context.new_page()
            try:
                # fake clock installed before the page loads: the check interval (5 min by default) is fast-forwarded
                other.clock.install()
                open_pr(other, MAIN_PR)
                fake_comment('Yann repasse sur la PR')
                banner = other.locator('.rv-pulse[data-banner="pulse"]')
                # the page's own loading (summary, prefetch) is over: the requests counted below are the checks' only
                wait_fake_quiet()
                pr_path = f'/pullrequests/{FAKE_PRS["main"]}'
                # The check reads the PR through the server's 15 s live cache (real time): fast-forward until a check
                # reads it after Yann's comment (bounded: about 30 s, 30 checks).
                deadline = time.time() + 30
                for attempt in range(30):
                    before = len(bitbucket_requests())
                    with other.expect_response(lambda r: r.url.endswith('/pulse')) as answer:
                        other.clock.fast_forward('05:01')
                    assert answer.value.ok, answer.value.status
                    # one GET of the PR at most (none when the live cache answers), never its comments or activity
                    spent = bitbucket_requests()[before:]
                    on_pr = [r for r in spent if r['path'].endswith(pr_path)]
                    details = [r for r in spent if f'{pr_path}/' in r['path']]
                    assert len(on_pr) <= 1 and not details, spent
                    try:
                        expect(banner).to_be_visible(timeout=1000)
                        break
                    except AssertionError:
                        assert time.time() < deadline and attempt < 29, 'no banner after Yann\'s comment'
                log(f'      periodic check: {len(on_pr)} Bitbucket request on the PR')
                expect(banner).to_contain_text('Du nouveau sur la PR : 1 nouveau commentaire')
                # the page did not change by itself: the comment shows only after "Actualiser"
                other.click('.rv-tab[data-tab="discussions"]')
                expect(other.locator('.rv-ditem', has_text='Yann repasse sur la PR')).to_have_count(0)
                banner.locator('[data-action="pulse-refresh"]').click()
                expect(banner).to_have_count(0)
                expect(other.locator('.rv-ditem', has_text='Yann repasse sur la PR')).to_be_visible(timeout=10000)
                expect(other.locator('.rv-head .rv-refresh-status')).to_have_text('1 nouveau commentaire')
                # my own comment from the page: the following checks find nothing new
                other.fill('.rv-disc .rv-comp textarea', 'Mon commentaire, pas une nouveauté')
                other.click('[data-action="send-general"]')
                mine = other.locator('.rv-ditem', has_text='Mon commentaire, pas une nouveauté')
                expect(mine).to_be_visible(timeout=10000)
                expect(mine.locator('.rv-cm.pending')).to_have_count(0, timeout=10000)
                expect(other.locator('.rv-head [data-action="refresh"]')).not_to_have_attribute('aria-busy', 'true')
                for _ in range(2):
                    with other.expect_response(lambda r: r.url.endswith('/pulse')):
                        other.clock.fast_forward('05:01')
                    other.wait_for_timeout(300)
                    expect(banner).to_have_count(0)
            finally:
                other.close()
        pulse_banner(page)

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
            expect(page.locator('.rv-fold')).to_have_count(0)
            refold = page.locator('.rv-refold')
            expect(refold).to_have_text('Replier')
            # Linux CI fonts are wider than macOS ones: widen the text so the check holds on both
            wide = page.add_style_tag(content='.rv-tl-foot { letter-spacing: .6px; }')
            foot = page.evaluate('() => document.querySelector(".rv-tl-foot").getBoundingClientRect().height')
            assert foot < 40, f'timeline footer wraps once expanded: {foot}'
            wide.evaluate('(e) => e.remove()')
            refold.click()
            expect(fold).to_have_count(1)
            expect(fold).to_contain_text('⋯ v1 → v22 · juin → août')
            expect(page.locator('.rv-track .rv-v:not(.base)')).to_have_count(12)
            expect(refold).to_have_count(0)
        long_pr(page)

        @check('range bar: every item draws it at the same height, folds and gaps included')
        def range_bar_aligned(page):
            ref = fake_ref('long')
            open_pr(page, ref, '?from=0&to=34')
            page.reload()  # the previous check expanded the fold; a reload folds again
            wait_pr_ready(page)
            page.wait_for_timeout(300)
            bars = page.evaluate('''() => [...document.querySelectorAll('.rv-track .in, .rv-track .to')]
                .filter((e) => getComputedStyle(e, '::after').content !== 'none')
                .map((e) => ({ cls: e.className, bottom: e.getBoundingClientRect().bottom - parseFloat(getComputedStyle(e, '::after').bottom) }))''')
            kinds = {b['cls'].split()[0] for b in bars}
            assert {'rv-v', 'rv-gap', 'rv-fold'} <= kinds, kinds
            lows = [b['bottom'] for b in bars]
            assert max(lows) - min(lows) <= 0.5, f'range bar heights differ: {sorted(set(round(x, 1) for x in lows))}'
            track = page.evaluate("() => document.querySelector('.rv-track').getBoundingClientRect().bottom")
            assert track - max(lows) < 14, 'the bar sits at the bottom of the track row'
        range_bar_aligned(page)

        @check('only rebases since my review: home group and quick re-approval')
        def fast_path(page):
            ref = fake_ref('rebaseOnly')
            open_pr(page, ref)  # computes the summary: the card shows "rebase only"
            banner = page.locator('.rv-banner[data-banner="fast"]')
            expect(banner).to_contain_text('Depuis ta relecture de v1 : seulement des rebases, aucun changement de l\'auteur')
            expect(page.locator('.rv-empty')).to_contain_text('Aucun changement de l\'auteur entre v1 et v2')
            page.goto(url(''))
            # Designated reviewer whose approval Bitbucket removed: still "To review"
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

        @check('PR page: the header build badge opens the Builds tab listing the checks')
        def builds_tab(page):
            open_pr(page, MAIN_PR)
            badge = page.locator('.rv-head .rv-bbadge')
            tab = page.locator('.rv-tab[data-tab="builds"]')
            expect(badge).to_have_text('✗ 1 échec')
            expect(tab.locator('.n.red')).to_have_text('2')
            expect(page.locator('.rv-head .rv-chk')).to_have_count(0)  # the checks are listed in the tab only
            badge.click()
            expect(tab).to_have_attribute('aria-selected', 'true')
            expect(page.locator('.rv-builds .rv-chk[data-check]')).to_have_count(2)
            expect(page.locator('.rv-chk[data-check="pipeline"] .nm')).to_have_text('Pipeline #12 — échec')
            expect(page.locator('.rv-chk[data-check="scan"] .nm')).to_have_text('Security scan — réussi')
            link = page.locator('.rv-chk[data-check="pipeline"] a.ext')
            expect(link).to_have_attribute('href', f'https://ci.example.test/pipeline/{FAKE_PRS["main"]}')
            expect(link).to_have_attribute('target', '_blank')
            expect(link).to_have_attribute('rel', 'noopener noreferrer')
            open_pr(page, fake_ref('neverReviewed'))
            expect(page.locator('.rv-head .rv-bbadge')).to_have_count(0)
            expect(page.locator('.rv-tab[data-tab="builds"] .n')).to_have_count(0)
            page.click('.rv-tab[data-tab="builds"]')
            expect(page.locator('[data-builds="empty"]')).to_have_text('Aucun build rattaché à cette PR')
        builds_tab(page)

        if CALLS_URL and REQUESTS_URL:
            @check('tasks_tab: open count on the tab, list read on opening only; create, tick, delete, see the comment')
            def tasks_tab(page):
                open_pr(page, MAIN_PR, '?from=0&to=6')
                wait_fake_quiet()
                tab = page.locator('.rv-tab[data-tab="tasks"]')
                expect(tab).to_contain_text('Tâches')
                expect(tab.locator('.n')).to_have_text('1')
                assert not [r for r in bitbucket_requests() if r['path'].endswith('/tasks')], 'tasks read before the tab was opened'
                before = len(bitbucket_requests())
                tab.click()
                expect(tab).to_have_attribute('aria-selected', 'true')
                rows = page.locator('.rv-task[data-task]')
                expect(rows).to_have_count(2)
                seeded = page.locator('.rv-task[data-state="open"]')
                expect(seeded).to_contain_text('Ajouter un test pour archiveAll')
                expect(seeded.locator('.who')).to_have_text('Camille Durand')
                expect(seeded.locator('[data-action="delete-task"]')).to_have_count(0)  # not mine
                done = page.locator('.rv-task[data-state="resolved"]')
                expect(done).to_contain_text('Mettre à jour le changelog')
                expect(done).to_contain_text('faite par Camille Durand')
                expect(done.locator('[data-action="resolve-task"]')).to_be_checked()
                reads = [r for r in bitbucket_requests()[before:] if r['path'].endswith('/tasks')]
                assert len(reads) == 1, reads
                os.makedirs(SHOTS, exist_ok=True)
                page.screenshot(path=os.path.join(SHOTS, 'pr-tasks.png'))
                # create: Enter in the input; listed at once, then Bitbucket's task; the count follows
                box = page.locator('input[data-new-task]')
                expect(box).to_have_attribute('placeholder', 'Nouvelle tâche')
                box.fill('Renommer archiveAll')
                calls.start()
                box.press('Enter')
                call = calls.wait(lambda c: c['method'] == 'POST' and c['path'].endswith('/tasks'), 'POST tasks')
                assert call is None or body_of(call) == {'content': {'raw': 'Renommer archiveAll'}}, call
                created = page.locator('.rv-task', has_text='Renommer archiveAll')
                expect(created).to_have_count(1, timeout=10000)
                expect(created).not_to_have_class(re.compile(r'\bpending\b'), timeout=10000)
                expect(box).to_have_value('')
                expect(tab.locator('.n')).to_have_text('2', timeout=10000)
                tid = int(created.get_attribute('data-task'))
                assert tid > 0, tid
                # tick: resolved, count back to 1
                calls.start()
                created.locator('[data-action="resolve-task"]').check()
                call = calls.wait(lambda c: c['method'] == 'PUT' and c['path'].endswith(f'/tasks/{tid}'), f'PUT tasks/{tid}')
                assert call is None or body_of(call) == {'state': 'RESOLVED'}, call
                expect(created).to_have_attribute('data-state', 'resolved')
                expect(created).to_contain_text('faite par Thomas Girard', timeout=10000)
                expect(tab.locator('.n')).to_have_text('1', timeout=10000)
                # ↻ with the tab open reads the list again (once)
                before = len(bitbucket_requests())
                page.locator('.rv-head [data-action="refresh"]').click()
                expect(page.locator('.rv-head .rv-refresh-status[role="status"]')).not_to_have_text('', timeout=10000)
                wait_fake_quiet()
                reads = [r for r in bitbucket_requests()[before:] if r['path'].endswith('/tasks')]
                assert len(reads) == 1, reads
                # delete my task (confirm() accepted by the dialog handler)
                calls.start()
                page.locator(f'.rv-task[data-task="{tid}"] [data-action="delete-task"]').click()
                calls.wait(lambda c: c['method'] == 'DELETE' and c['path'].endswith(f'/tasks/{tid}'), f'DELETE tasks/{tid}')
                expect(page.locator(f'.rv-task[data-task="{tid}"]')).to_have_count(0, timeout=10000)
                expect(rows).to_have_count(2)
                expect(tab.locator('.n')).to_have_text('1')
                # the seeded task was created under my comment: "voir le commentaire" goes to its thread in the diff
                cid = api(pr_api(MAIN_PR) + '/tasks')[0]['commentId']
                seeded.locator('[data-action="show-comment"]').click()
                expect(page.locator('.rv-tab.on[data-tab="diff"]')).to_be_visible()
                expect(page.locator(f'.rv-diff .rv-th[data-thread="{cid}"]')).to_be_visible()
            tasks_tab(page)

        @check('description_tab: first tab, Diff stays selected on open, shows the sanitized description, no extra request')
        def description_tab(page):
            open_pr(page, MAIN_PR)
            wait_fake_quiet()
            tabs = page.locator('.rv-tabs .rv-tab')
            expect(tabs.first).to_have_attribute('data-tab', 'description')
            expect(tabs.first).to_have_text('Description')
            expect(page.locator('.rv-tab.on')).to_have_attribute('data-tab', 'diff')
            before = len(bitbucket_requests())
            tabs.first.click()
            expect(tabs.first).to_have_attribute('aria-selected', 'true')
            body = page.locator('.rv-description .rv-html')
            expect(body).to_contain_text('Archives records in bulk.')
            expect(body.locator('li')).to_have_text('keeps the history')
            link = body.locator('a')
            expect(link).to_have_attribute('href', 'https://example.com/guide')
            expect(link).to_have_attribute('rel', 'noopener noreferrer')
            expect(body.locator('script')).to_have_count(0)
            assert page.evaluate('window.__descriptionPwned') is None, 'script of the description ran'
            wait_fake_quiet()
            assert len(bitbucket_requests()) == before, 'opening the tab must not read Bitbucket'
            tabs.nth(1).click()
            expect(page.locator('.rv-tab.on')).to_have_attribute('data-tab', 'diff')
        description_tab(page)

        @check('PR page: follow toggle on the author; my PR shows "needs rebase" and its running build')
        def follow_header(page):
            open_pr(page, fake_ref('neverReviewed'))
            uuid = api(pr_api(fake_ref('neverReviewed')))['pr']['author']['uuid']
            toggle = page.locator('.rv-head [data-action="follow"]')
            expect(toggle).to_have_text('☆ Suivre')
            toggle.click()
            expect(toggle).to_have_text('★ Suivi')
            expect(toggle).to_have_attribute('aria-pressed', 'true')
            wait_api(lambda: followed_uuids() == [uuid], 'author saved in review.followed')
            toggle.click()
            expect(toggle).to_have_text('☆ Suivre')
            wait_api(lambda: followed_uuids() == [], 'author removed from review.followed')
            open_pr(page, fake_ref('mine'))
            chip = page.locator('.rv-head [data-chip="needs-rebase"]')
            expect(chip).to_have_text('À rebaser sur master')
            expect(chip).to_have_attribute('title', 'master a avancé depuis la base de la PR : la PR est à rebaser')
            expect(page.locator('.rv-head [data-chip="merge-conflicts"]')).to_have_count(0)  # behind, no conflict
            expect(page.locator('.rv-head .rv-bbadge')).to_have_text('build en cours')
            expect(page.locator('.rv-head [data-action="follow"]')).to_have_count(0)
        follow_header(page)

        @check('PR page: rebase and merge-conflict chips on a colleague\'s PR, click opens the conflicting file')
        def rebase_conflict_chips(page):
            open_pr(page, fake_ref('rebaseOnly'))  # based on master's head: no chip at all
            expect(page.locator('.rv-head [data-chip]')).to_have_count(0)
            open_pr(page, fake_ref('others'))
            head = page.locator('.rv-head')
            expect(head.locator('[data-chip="needs-rebase"]')).to_have_text('À rebaser sur master')
            conflicts = head.locator('[data-chip="merge-conflicts"]')
            expect(conflicts).to_have_text('⚠ Conflit avec master · 1 fichier')
            title = conflicts.get_attribute('title') or ''
            assert title.split('\n') == ['Bitbucket signale des conflits de merge avec master dans :', 'src/others.ts',
                                          'Clic : ouvrir le premier fichier en conflit dans le diff'], title
            marker = page.locator('.rv-f[data-path="src/others.ts"] [data-merge-conflict]')
            expect(marker).to_have_attribute('title', 'Conflit de merge avec master')
            os.makedirs(SHOTS, exist_ok=True)
            head.screenshot(path=os.path.join(SHOTS, 'pr-header-rebase-conflicts.png'))
            page.click('.rv-tab[data-tab="versions"]')
            conflicts.click()
            expect(page.locator('.rv-tab.on[data-tab="diff"]')).to_be_visible()
            expect(page.locator('.rv-f.cur')).to_have_attribute('data-path', 'src/others.ts')
        rebase_conflict_chips(page)

        @check('PR page: draft chip replaces "Ouverte", copy-link button puts the PR URL in the clipboard and holds its line')
        def draft_and_copy(page):
            page.context.grant_permissions(['clipboard-read', 'clipboard-write'])
            open_pr(page, fake_ref('draft'))
            pill = page.locator('.rv-head .rv-pill')
            expect(pill).to_have_text('Brouillon')
            expect(pill).to_have_class(re.compile(r'\bdraft\b'))
            open_pr(page, fake_ref('mine'))
            expect(pill).to_have_text('● Ouverte')
            pr_url = api(pr_api(fake_ref('mine')))['pr']['url']
            button = page.locator('.rv-head [data-copy-link]')
            expect(button).to_have_attribute('aria-label', 'Copier le lien de la PR')
            status = page.locator('.rv-head [data-copy-status]')
            expect(status).to_have_attribute('aria-live', 'polite')
            button.click()
            expect(status).to_have_text('Lien copié')
            assert page.evaluate('navigator.clipboard.readText()') == pr_url
            expect(status).to_have_text('', timeout=4000)
            # Wider fonts (Linux CI): the icon stays on the line of the Bitbucket link, never alone on the next one.
            stress = page.add_style_tag(content='.rv-head { letter-spacing: 0.12em }')
            link = page.locator('.rv-head .rv-link-copy a').bounding_box()
            icon = button.bounding_box()
            assert link and icon and abs((link['y'] + link['height'] / 2) - (icon['y'] + icon['height'] / 2)) < 6, (link, icon)
            assert icon['x'] >= link['x'] + link['width'], (link, icon)
            stress.evaluate('node => node.remove()')
            os.makedirs(SHOTS, exist_ok=True)
            for scheme in ('light', 'dark'):
                page.emulate_media(color_scheme=scheme)
                for name, key in (('draft', 'draft'), ('open', 'mine')):
                    open_pr(page, fake_ref(key))
                    page.locator('.rv-head').screenshot(path=os.path.join(SHOTS, f'pr-header-{name}-{scheme}.png'))
            page.emulate_media(color_scheme=None)
        draft_and_copy(page)

        @check('diff: a Vue hunk inside <script setup lang="ts"> gets TypeScript colors (keyword, type)')
        def vue_script_colors(page):
            ref = fake_ref('waiting')
            path = 'src/components/RecordList.vue'
            hunk = next(f for f in api(f'{pr_api(ref)}/compare?from=0&to=1&context=3')['files'] if f['path'] == path)['hunks'][0]
            assert hunk['newStart'] > 10, f'the hunk must start below the <script setup> tag (line 10): {hunk["newStart"]}'
            assert hunk.get('leadIn') == {'old': '<script setup lang="ts">', 'new': '<script setup lang="ts">'}, hunk.get('leadIn')
            open_pr(page, ref, '?from=0&to=1')
            block = page.locator(f'.rv-file[data-path="{path}"]')
            block.scroll_into_view_if_needed()
            code = block.locator('.rv-l.a[data-n="20"] .c')
            expect(code).to_have_text('const limit = ref<number>(50);')
            keyword = code.locator('span[style*="color"]', has_text=re.compile(r'^const$'))
            expect(keyword).to_have_count(1, timeout=10000)  # alone, the line was template text: `const` uncolored
            type_name = code.locator('span[style*="color"]', has_text=re.compile(r'^number$'))
            expect(type_name).to_have_count(1)  # alone, `<number>` was colored as an HTML tag
            plain = code.evaluate('c => getComputedStyle(c).color')
            colors = [keyword.evaluate('e => getComputedStyle(e).color'), type_name.evaluate('e => getComputedStyle(e).color')]
            assert plain not in colors and colors[0] != colors[1], (plain, colors)
            os.makedirs(SHOTS, exist_ok=True)
            block.screenshot(path=os.path.join(SHOTS, 'diff-vue-script.png'))
        vue_script_colors(page)

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
            assert 'écrasée par un force-push' in (gone.get_attribute('title') or '')
            # My review dates from v1 (unavailable): the default range starts from master.
            assert current_selection(page) == (0, 3), page.evaluate('location.hash')
            gone.click(force=True)  # aria-disabled: Playwright refuses the ordinary click, a user can click
            assert current_selection(page) == (0, 3), 'a click on an unavailable version must change nothing'
            page.click('.rv-v[data-i="2"]')
            assert current_selection(page) == (0, 2), page.evaluate('location.hash')
            expect(page.locator('.rv-v[data-i="2"]')).to_have_attribute('title', re.compile(r'^v2 · code \(\+\d+ −\d+\)\n'))
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

    if FAKE_PRS:
        @check('settings: follow a contributor with « Ajouter », the home hides the unfollowed PRs, then the setting shows them')
        def follow_from_settings(page):
            before = api('/settings')['review']
            assert before['followed'] == [] and before['hideUnfollowed'] is True, before
            page.goto(url('settings'))
            picker = page.locator('#set-follow')
            expect(picker).to_be_visible(timeout=20000)
            expect(picker.locator('option:not([disabled])')).to_have_text(['Camille Durand', 'Yann Bernard'])
            expect(page.locator('.rv-field', has=picker)).to_contain_text(
                'Les PR à relire de ces personnes te sont proposées dans « À relire ». Tu peux aussi suivre quelqu’un depuis une PR (☆ Suivre).')
            add = page.locator('[data-action="follow-add"]')
            expect(add).to_have_text('Ajouter')
            expect(add).to_be_disabled()
            picker.select_option(label='Camille Durand')
            add.click()
            expect(page.locator('.rv-status')).to_have_text('Tu suis maintenant Camille Durand.')
            expect(page.locator('.rv-followed li')).to_have_count(1)
            expect(page.locator('.rv-followed li span')).to_have_text('Camille Durand')
            expect(picker.locator('option:not([disabled])')).to_have_text(['Yann Bernard'])
            wait_api(lambda: followed_uuids() == ['{cam}'], 'Camille saved in review.followed')
            hide = page.locator('#set-hide-unfollowed')
            expect(hide).to_be_checked()
            expect(page.locator('.rv-hide-toggle')).to_contain_text('Masquer les PR des contributeurs non suivis')

            # Home: Yann's PR that asks nothing of me is hidden, with a discreet count and a link to the setting.
            page.goto(url(''))
            note = page.locator('[data-testid="hidden"]')
            expect(note).to_have_text('2 PR masquées (contributeurs non suivis) · modifier dans les réglages', timeout=20000)  # Yann's #47 and the draft
            expect(page.locator(f'.rv-row[data-pr="{fake_ref("others")}"]')).to_have_count(0)
            expect(page.locator(f'.rv-row[data-pr="{fake_ref("neverReviewed")}"]')).to_be_visible()  # designated reviewer
            expect(page.locator(f'.rv-row[data-pr="{fake_ref("waiting")}"]')).to_be_visible()  # approved by me
            expect(page.locator(f'.rv-row[data-pr="{fake_ref("mine")}"]')).to_be_visible()  # my own PR
            note.locator('a').click()
            expect(page).to_have_url(re.compile('#/settings$'))

            # Setting off: every PR is listed again.
            page.locator('#set-hide-unfollowed').uncheck()
            page.click('.rv-settings button[type="submit"]')
            expect(page.locator('.rv-status')).to_have_text('Réglages enregistrés.')
            page.goto(url(''))
            expect(page.locator(f'.rv-row[data-pr="{fake_ref("others")}"]')).to_have_count(1, timeout=20000)
            expect(page.locator('[data-testid="hidden"]')).to_have_count(0)

            # Back to the defaults for the next checks.
            page.goto(url('settings'))
            page.locator('.rv-followed li >> text=Retirer').click()
            page.locator('#set-hide-unfollowed').check()
            page.click('.rv-settings button[type="submit"]')
            expect(page.locator('.rv-status')).to_have_text('Réglages enregistrés.')
            assert api('/settings')['review'] == before, api('/settings')['review']
        follow_from_settings(page)

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
        titles = {'To review', 'To rebase', 'My PRs', 'Waiting on the author', 'Other open PRs'}
        for title in page.locator('.rv-lgrp').evaluate_all('els => els.map((el) => el.textContent.trim())'):
            assert title.split(' · ')[0] in titles or title.rsplit(' · ', 1)[0] in titles, f'untranslated group title: {title}'
        expect(page.locator('.rv-home-top .rv-url')).to_have_attribute('placeholder', 'Paste a Bitbucket PR URL…')
    en_home(page)

    if FAKE_PRS:
        @check('English (en-US browser): grouping switch, rebase chip, build pill and row menu')
        def en_queue(page):
            page.goto(url(''))
            expect(page.locator('section[data-group="waiting"] .rv-lgrp')).to_contain_text('Waiting on the author', timeout=20000)
            expect(page.locator('section[data-group="to-do"] .rv-lgrp')).to_contain_text('To review')
            expect(page.locator('section[data-group="to-do"] .rv-lgrp .desc')).to_have_text('PRs waiting for your review')
            expect(page.locator('section[data-group="to-rebase"] .rv-lgrp')).to_contain_text('To rebase')
            expect(page.locator('section[data-group="to-rebase"] .rv-lgrp .desc')).to_have_text('the target branch moved since their base')
            expect(page.locator('.rv-home-bar')).to_contain_text('Group by')
            expect(page.locator('.rv-home-bar button')).to_have_text(['Repository', 'Contributor', 'None'])
            mine_row = page.locator(f'.rv-row[data-pr="{fake_ref("mine")}"]')
            expect(mine_row.locator('[data-chip="needs-rebase"]')).to_have_text('needs rebase')
            expect(mine_row.locator('.rv-build')).to_have_text('running')
            expect(mine_row).to_contain_text('1/2 approval')
            page.locator(f'.rv-roww[data-row="{fake_ref("waiting")}"] .rv-row-more').click()
            expect(page.locator('.rv-menu [data-action="follow"]')).to_have_text('Follow Yann Bernard')
            page.keyboard.press('Escape')
            expect(page.locator('.rv-menu')).to_have_count(0)
        en_queue(page)

        @check('English (en-US browser): Builds tab and follow toggle')
        def en_builds(page):
            open_pr(page, MAIN_PR)
            expect(page.locator('.rv-head [data-action="follow"]')).to_have_text('☆ Follow')
            badge = page.locator('.rv-head .rv-bbadge')
            expect(badge).to_have_text('✗ 1 failure')
            badge.click()
            expect(page.locator('.rv-tab[data-tab="builds"]')).to_contain_text('Builds')
            expect(page.locator('.rv-chk[data-check="pipeline"] .nm')).to_have_text('Pipeline #12 — failed')
            expect(page.locator('.rv-builds .note')).to_contain_text('Statuses published to Bitbucket')
            page.click('.rv-tab[data-tab="diff"]')  # same PR next: the page (and its tab) is kept across range changes
        en_builds(page)

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
        if FAKE_PRS:
            expect(page.locator('[data-action="follow-add"]')).to_have_text('Add', timeout=20000)
            expect(page.locator('#set-follow option[disabled]')).to_have_text('Choose a contributor…')
            expect(page.locator('.rv-field', has=page.locator('#set-follow'))).to_contain_text(
                'Their PRs that need a review are put in “To review” for you. You can also follow someone from a PR (☆ Follow).')
            expect(page.locator('.rv-hide-toggle')).to_contain_text('Hide the PRs of contributors I don’t follow')
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


def secret_checks(browser):
    """CLI per-run secret, in a context WITHOUT the cookie: the page says how to open it, the ?k= address fixes it."""
    if not OPEN_URL:
        log('      (REVSPAN_OPEN_URL missing: secret not checked)')
        return
    context = browser.new_context(viewport={'width': 1024, 'height': 800}, locale='fr-FR', timezone_id='Europe/Paris')
    context.set_default_timeout(10000)

    @check('secret: without the cookie (or with a stale ?k=) the page says to open it from revspan; the ?k= address sets it')
    def secret(page):
        page.goto(url(''))
        expect(page.locator('.rv-panel-msg')).to_contain_text('Ouvre Revspan depuis la commande revspan (ou l\'adresse qu\'elle affiche).')
        # An old address from the history: same redirect, no cookie, the same message.
        page.goto(f'{BASE}/open?k=stale&to={urllib.parse.quote("#/settings", safe="")}')
        expect(page).to_have_url(f'{BASE}/#/settings')
        expect(page.locator('.rv-panel-msg')).to_contain_text('Ouvre Revspan depuis la commande revspan')
        assert not context.cookies(), context.cookies()
        page.goto(f'{OPEN_URL}&to={urllib.parse.quote("#/settings", safe="")}')
        expect(page).to_have_url(f'{BASE}/#/settings')
        expect(page.locator('.rv-settings h1')).to_have_text('Réglages')
        cookie = next(c for c in context.cookies() if c['name'] == SECRET_COOKIE)
        assert cookie['httpOnly'] and cookie['sameSite'] == 'Strict', cookie
        assert page.evaluate('document.cookie') == '', 'the secret cookie must not be readable by the page'
        page.goto(url(''))
        expect(page.locator('.rv-home h1')).to_have_text('Mes PR')
    secret(context.new_page())
    context.close()


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
        context = new_context(browser, viewport={'width': 1440, 'height': 900}, locale='fr-FR', timezone_id='Europe/Paris')
        context.set_default_timeout(10000)
        page = context.new_page()
        if fixed_time:
            page.clock.set_fixed_time(fixed_time)
        page.on('dialog', lambda d: d.accept())
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        run_checks(page)
        en_context = new_context(browser, viewport={'width': 1440, 'height': 900}, locale='en-US', timezone_id='Europe/Paris')
        en_context.set_default_timeout(10000)
        en_page = en_context.new_page()
        if fixed_time:
            en_page.clock.set_fixed_time(fixed_time)
        en_page.on('pageerror', lambda e: errors.append(str(e)))
        run_language_checks(en_page, page)
        secret_checks(browser)
        results.append(('no JavaScript error', not errors))
        log('PASS  no JavaScript error' if not errors else f'FAIL  no JavaScript error\n      {errors}')
        browser.close()
    failed = [r for r in results if not r[1]]
    log(f'\n{len(results) - len(failed)}/{len(results)} checks passed')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
