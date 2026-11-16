"""Smoke test of the Revspan extension in an isolated VS Code (launched by run-smoke.ts).

Drives VS Code through its debugging port (Playwright connect_over_cdp): "My PRs" view, PR panel,
"VS Code diff" (native diff editor), "Open file" (local repository), one tab per PR (the "Revspan" tab for the home
page and settings, reopened when closed) and every tab reopened after "Reload Window", without duplicates.

Runs in English: the isolated profile has no language pack, so VS Code's display language is English. The page
must follow it (meta set by the host), even when the webview's own browser language is another one.
"""
import json
import os
import re
import sys
import time
import urllib.request

from playwright.sync_api import Frame, Page, sync_playwright

CDP_URL = os.environ['CDP_URL']
PR_TITLE = os.environ['PR_TITLE']
CALLS_URL = os.environ.get('REVSPAN_CALLS_URL')
SHOTS = os.environ.get('SHOTS_DIR', '/tmp/revspan-vscode-shots')
os.makedirs(SHOTS, exist_ok=True)

results: list[tuple[str, bool, str]] = []


def check(name: str, condition: bool, detail: str = '') -> None:
    results.append((name, condition, detail))
    print(f"{'PASS' if condition else 'FAIL'}  {name}{f' — {detail}' if detail and not condition else ''}", flush=True)


def wait_until(predicate, timeout: float = 30.0, interval: float = 0.3):
    end = time.time() + timeout
    while time.time() < end:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None


def workbench(browser) -> Page:
    def find():
        for context in browser.contexts:
            for page in context.pages:
                if 'workbench' in page.url:
                    return page
        return None
    page = wait_until(find, 60)
    if not page:
        raise RuntimeError('VS Code window not found')
    return page


PR_42 = '/pr/acme/demo-repo/42'
PR_45 = '/pr/acme/demo-repo/45'


def is_home(route: str) -> bool:
    return not route.startswith('/pr/')


def app_frame(page: Page, route=None) -> Frame | None:
    """The webview frame that contains the Revspan page; with several tabs, the one whose route matches
    (`route`: a route prefix, or a predicate on the page's route)."""
    for frame in page.frames:
        try:
            if not frame.query_selector('#app .rv, #app .rv-pr, #app main, .rv-tl'):
                continue
            if route is None:
                return frame
            shown = frame.evaluate('location.hash').lstrip('#') or '/'
            if (route(shown) if callable(route) else shown.startswith(route)):
                return frame
        except Exception:
            continue
    return None


def frame_route(frame: Frame | None) -> str:
    try:
        return frame.evaluate('location.hash').lstrip('#') if frame else ''
    except Exception:  # noqa: BLE001 — frame gone
        return ''


def tab_titles(page: Page) -> list[str]:
    try:
        return [t.strip() for t in page.locator('.tabs-container .tab .label-name').all_inner_texts()]
    except Exception:  # noqa: BLE001 — window being reloaded
        return []


def revspan_tabs(page: Page) -> list[str]:
    """Titles of the Revspan tabs ("Revspan", "Revspan · Settings", "PR #42 · demo-repo"...)."""
    return [t for t in tab_titles(page) if t.startswith('Revspan') or t.startswith('PR #')]


def active_tab(page: Page) -> str:
    try:
        return page.locator('.tabs-container .tab.active .label-name').first.inner_text().strip()
    except Exception:  # noqa: BLE001
        return ''


def tab(page: Page, title: str):
    return page.locator('.tabs-container .tab').filter(has=page.locator('.label-name', has_text=re.compile(f'^{re.escape(title)}'))).first


def command(page: Page, name: str) -> None:
    palette = page.locator('.quick-input-widget input').first
    for attempt in range(3):
        if attempt:
            # A webview that just took focus may not forward F1 yet: focus goes back to the workbench.
            page.locator('.part.titlebar').first.click()
        page.keyboard.press('F1')
        try:
            palette.wait_for(timeout=4000)
            break
        except Exception:  # noqa: BLE001 — retried
            continue
    palette.wait_for(timeout=4000)
    page.keyboard.type(name)
    time.sleep(1)
    page.keyboard.press('Enter')


def run() -> None:
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(CDP_URL)
        page = workbench(browser)
        page.wait_for_selector('.monaco-workbench', timeout=60000)
        page.screenshot(path=f'{SHOTS}/01-workbench.png')

        # "My PRs" view in the activity bar.
        icon = page.locator('.activitybar .action-item a[aria-label^="Revspan"], .activitybar .action-item [aria-label^="Revspan"]').first
        icon.wait_for(timeout=60000)
        icon.click()
        row = page.locator('.monaco-list-row', has_text=PR_TITLE).first
        try:
            row.wait_for(timeout=60000)
        except Exception:
            pass
        page.screenshot(path=f'{SHOTS}/02-mes-pr.png')
        tree_text = ' | '.join(page.locator('.pane-body .monaco-list-row').all_inner_texts())
        check('"My PRs" tree: main PR listed', row.count() > 0, tree_text[:400])
        check('"My PRs" tree: "To review" and "To rebase" groups', 'To review (' in tree_text and 'To rebase (' in tree_text, tree_text[:400])
        check('"My PRs" tree: no old "To do" title', 'To do (' not in tree_text, tree_text[:400])
        check('"My PRs" tree: queue titles', 'Waiting on the author' in tree_text or 'Other open PRs' in tree_text, tree_text[:600])
        check('"My PRs" tree: repository subgroups by default', 'acme/' in tree_text, tree_text[:600])
        # Group by contributor (command from the palette, then the quick pick).
        page.keyboard.press('F1')
        page.locator('.quick-input-widget input').first.wait_for(timeout=10000)
        page.keyboard.type('Revspan: Group by')
        time.sleep(1)
        page.keyboard.press('Enter')
        time.sleep(1)
        page.locator('.quick-input-widget .monaco-list-row', has_text='Contributor').first.click()
        by_contributor = wait_until(lambda: 'Yann Bernard (' in ' | '.join(page.locator('.pane-body .monaco-list-row').all_inner_texts()), 20)
        tree_text = ' | '.join(page.locator('.pane-body .monaco-list-row').all_inner_texts())
        check('"My PRs" tree: grouping by contributor changes the tree', bool(by_contributor), tree_text[:600])
        page.screenshot(path=f'{SHOTS}/02b-mes-pr-contributeur.png')
        view_title = ' '.join(page.locator('.pane-header .title').all_text_contents())
        check('view title localized from package.nls.json', 'my prs' in view_title.lower(), view_title)
        actions = page.locator('.pane-header .actions .action-label').evaluate_all('els => els.map((el) => el.getAttribute("aria-label") || el.title || "")')
        check('"My PRs" title bar: no "Open a PR (URL)" action, home button still there', not any('Open a PR' in a for a in actions) and any('Home' in a or 'home' in a for a in actions), str(actions))
        page.keyboard.press('F1')
        page.locator('.quick-input-widget input').first.wait_for(timeout=10000)
        page.keyboard.type('Revspan: Open a PR')
        time.sleep(1)
        palette = ' | '.join(page.locator('.quick-input-widget .monaco-list-row').all_inner_texts())
        check('command palette still offers "Open a PR (URL)"', 'Open a PR (URL)' in palette, palette[:300])
        page.keyboard.press('Escape')

        # PR panel.
        row.click()
        frame = wait_until(lambda: app_frame(page, PR_42), 60)
        check('panel: page loaded in the webview', frame is not None, f'frames: {[f.url[:80] for f in page.frames]}')
        if not frame:
            return
        frame.wait_for_selector('.rv-v', timeout=60000)
        readout = frame.locator('.rv-readout').first.inner_text()
        check('panel: timeline of the 6 versions + master', frame.locator('.rv-v').count() == 7, f'{frame.locator(".rv-v").count()} nodes')
        check('panel: comparison since my review (v2)', 'against v2' in readout, readout)
        language = frame.evaluate("""() => ({
            page: document.documentElement.lang,
            host: document.querySelector('meta[name="revspan-locale"]')?.content ?? null,
            browser: navigator.language,
        })""")
        workbench_lang = page.evaluate('document.documentElement.lang')
        check('page language = VS Code display language passed by the host',
              language['page'] == language['host'] == 'en' and workbench_lang.startswith('en'),
              f'{language}, workbench {workbench_lang}')
        check('page follows the host, not the webview browser language',
              language['browser'].lower().startswith('fr') and language['page'] == 'en',
              f'{language}')
        frame.wait_for_selector('.rv-file', timeout=30000)
        # no scrolling: the first file sits below the panel, within the 600 px margin that starts the highlighting
        colored = wait_until(lambda: frame.locator('.rv-l .c span[style*="color"]').count() > 0, 30)
        check('panel: syntax colors under the webview CSP (lazy grammar chunks, JS regex engine)', bool(colored),
              frame.evaluate('document.body.className'))
        tabs = [t for t in tab_titles(page) if t]
        check('panel: tab titled "PR #42"', any('PR #42' in t for t in tabs), str(tabs))
        widths = frame.evaluate('[document.documentElement.scrollWidth, window.innerWidth]')
        check('panel: no horizontal page scroll', widths[0] <= widths[1] + 1, f'content {widths[0]} px for {widths[1]} px')
        page.screenshot(path=f'{SHOTS}/03-panneau.png')

        # Native VS Code diff on the first file.
        file_block = frame.locator('.rv-file').first
        file_path = file_block.locator('.rv-fh').first.inner_text()
        diff_button = file_block.get_by_role('button', name='VS Code diff')
        check('panel: "VS Code diff" button present', diff_button.count() > 0, file_path)
        if diff_button.count():
            diff_button.first.click()
            opened = wait_until(lambda: [t for t in tab_titles(page) if '→' in t], 30)
            check('native diff: tab opened', bool(opened), str(tab_titles(page)))
            check('native diff: diff editor', page.locator('.monaco-diff-editor').count() > 0)
            page.screenshot(path=f'{SHOTS}/04-diff-natif.png')

        # Back to the panel then "Open file" (simulated local repository on the PR's branch).
        page.locator('.tabs-container .tab', has_text='PR #42').first.click()
        frame = wait_until(lambda: app_frame(page, PR_42), 30)
        open_button = frame.locator('.rv-file').first.get_by_role('button', name='Open file') if frame else None
        check('panel: "Open file" button present', bool(open_button and open_button.count()))
        if open_button and open_button.count():
            open_button.first.click()
            name = file_path.strip().split('/')[-1].split()[0] if file_path else 'Action.ts'
            opened_file = wait_until(lambda: [t for t in tab_titles(page) if t == 'Action.ts' or t.startswith(name)], 30)
            check('local file: opened in an editor', bool(opened_file), str(tab_titles(page)))
            page.screenshot(path=f'{SHOTS}/05-local-file.png')

        # An action from the panel does reach the (fake) Bitbucket: marking a file "Seen" is local,
        # so we check instead that no write was made without an action.
        if CALLS_URL:
            calls = json.loads(urllib.request.urlopen(CALLS_URL).read())
            check('no Bitbucket write without an explicit action', calls == [], str(calls)[:200])

        # One tab per PR: "Revspan" in the PR tab brings up the "Revspan" tab, the PR tab stays on its PR.
        tab(page, 'PR #42').click()
        frame = wait_until(lambda: app_frame(page, PR_42), 30)
        if not frame:
            check('panel: found before going back to the home page', False, str(tab_titles(page)))
            return
        frame.locator('a.home').first.click()
        home = wait_until(lambda: 'Revspan' in tab_titles(page) and app_frame(page, is_home), 30)
        check('tabs: "Revspan" in a PR tab opens the "Revspan" tab, the PR tab stays',
              bool(home) and any('PR #42' in t for t in tab_titles(page)) and frame_route(frame).startswith(PR_42),
              f'{tab_titles(page)}, PR tab on {frame_route(frame)}')
        if not home:
            return
        # From the home page: PR 42 already open (its tab comes back, no duplicate), PR 45 in a new tab.
        home.locator('.rv-row[data-pr$="/42"]').first.click()
        back_on_42 = wait_until(lambda: active_tab(page).startswith('PR #42'), 30)
        check('tabs: an open PR is brought to the front, no duplicate',
              bool(back_on_42) and len([t for t in tab_titles(page) if t.startswith('PR #42')]) == 1 and frame_route(home) in ('/', ''),
              f'{tab_titles(page)}, active {active_tab(page)}, home on {frame_route(home)}')
        tab(page, 'Revspan').click()
        home = wait_until(lambda: app_frame(page, is_home), 30)
        home.locator('.rv-row[data-pr$="/45"]').first.click()
        pr45 = wait_until(lambda: app_frame(page, PR_45), 60)
        check('tabs: open PR 42 then PR 45 -> tabs "PR #42" and "PR #45"',
              bool(pr45) and any(t.startswith('PR #42') for t in tab_titles(page)) and any(t.startswith('PR #45') for t in tab_titles(page)),
              str(tab_titles(page)))
        page.screenshot(path=f'{SHOTS}/06-two-prs.png')

        # ⚙ in the PR tab: the "Revspan" tab on settings, the PR tab still on PR 42.
        tab(page, 'PR #42').click()
        frame = wait_until(lambda: app_frame(page, PR_42), 30)
        frame.locator('a.rv-ic[href$="/settings"]').first.click()
        settings_tab = wait_until(lambda: active_tab(page) == 'Revspan · Settings', 30)
        check('tabs: ⚙ in the PR tab shows the "Revspan · Settings" tab, the PR tab still on #42',
              bool(settings_tab) and frame_route(frame).startswith(PR_42) and any(t.startswith('PR #42') for t in tab_titles(page)),
              f'{tab_titles(page)}, active {active_tab(page)}, PR tab on {frame_route(frame)}')
        page.screenshot(path=f'{SHOTS}/07-settings-from-pr.png')

        # The "Revspan" tab closed, "Revspan" clicked in the PR tab: it reopens.
        tab(page, 'Revspan · Settings').locator('.tab-actions .action-label').first.click()
        closed = wait_until(lambda: not any(t.startswith('Revspan') for t in tab_titles(page)), 15)
        check('tabs: "Revspan" tab closed', bool(closed), str(tab_titles(page)))
        tab(page, 'PR #42').click()
        frame = wait_until(lambda: app_frame(page, PR_42), 30)
        frame.locator('a.home').first.click()
        reopened = wait_until(lambda: active_tab(page) == 'Revspan' and app_frame(page, is_home), 30)
        check('tabs: closed "Revspan" tab reopened from the PR tab, the PR tab still on #42',
              bool(reopened) and frame_route(frame).startswith(PR_42),
              f'{tab_titles(page)}, active {active_tab(page)}, PR tab on {frame_route(frame)}')
        before = sorted(revspan_tabs(page))
        check('tabs: exactly 3 Revspan tabs before the reload', len(before) == 3, str(before))

        # "Reload Window": VS Code reopens every tab on the route saved by its page, no duplicate.
        command(page, 'Developer: Reload Window')
        time.sleep(3)
        page.wait_for_selector('.monaco-workbench', timeout=60000)
        restored = wait_until(lambda: sorted(revspan_tabs(page)) == before, 60)
        check('reload: same Revspan tabs', bool(restored), f'{revspan_tabs(page)} vs {before}')
        # Tabs are revived when shown: each one shows its own route, still without duplicates.
        for title, route in (('PR #45', PR_45), ('PR #42', PR_42), ('Revspan', is_home)):
            tab(page, title).click()
            shown = wait_until(lambda: app_frame(page, route), 60)
            check(f'reload: "{title}" tab shows its page', bool(shown), f'{revspan_tabs(page)}')
        frame = app_frame(page, PR_42)
        if frame:
            frame.wait_for_selector('.rv-v', timeout=60000)
        page.screenshot(path=f'{SHOTS}/08-recharge.png')
        check('reload: PR page displayed', bool(frame) and frame.locator('.rv-v').count() == 7)
        time.sleep(2)
        check('reload: exactly 3 Revspan tabs once all revived', sorted(revspan_tabs(page)) == before, f'{revspan_tabs(page)} vs {before}')


def main() -> int:
    try:
        run()
    except Exception as error:  # noqa: BLE001 -- readable report on an unexpected error
        check('run without error', False, repr(error))
    failed = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(failed)}/{len(results)} checks passed -- screenshots: {SHOTS}')
    return 1 if failed or not results else 0


if __name__ == '__main__':
    sys.exit(main())
