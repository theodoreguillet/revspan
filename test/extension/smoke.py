"""Smoke test of the Revspan extension in an isolated VS Code (launched by run-smoke.ts).

Drives VS Code through its debugging port (Playwright connect_over_cdp): "My PRs" view, PR panel,
"VS Code diff" (native diff editor), "Open file" (local repository), tab title during
navigation and panel reopened after "Reload Window".

Runs in English: the isolated profile has no language pack, so VS Code's display language is English. The page
must follow it (meta set by the host), even when the webview's own browser language is another one.
"""
import json
import os
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


def app_frame(page: Page) -> Frame | None:
    """The panel frame that contains the Revspan page (webview iframe)."""
    for frame in page.frames:
        try:
            if frame.query_selector('#app .rv, #app .rv-pr, #app main, .rv-tl'):
                return frame
        except Exception:
            continue
    return None


def tab_titles(page: Page) -> list[str]:
    try:
        return [t.strip() for t in page.locator('.tabs-container .tab .label-name').all_inner_texts()]
    except Exception:  # noqa: BLE001 — window being reloaded
        return []


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
        check('"My PRs" tree: groups', 'To review' in tree_text and 'My PRs' in tree_text, tree_text[:400])
        view_title = ' '.join(page.locator('.pane-header .title').all_text_contents())
        check('view title localized from package.nls.json', 'my prs' in view_title.lower(), view_title)

        # PR panel.
        row.click()
        frame = wait_until(lambda: app_frame(page), 60)
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
        frame = wait_until(lambda: app_frame(page), 30)
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

        # Back to the home page from the page: the tab does not keep the PR's title.
        page.locator('.tabs-container .tab', has_text='PR #42').first.click()
        frame = wait_until(lambda: app_frame(page), 30)
        if not frame:
            check('panel: found before going back to the home page', False, str(tab_titles(page)))
            return
        frame.locator('a.home').first.click()
        home_tab = wait_until(lambda: 'Revspan' in tab_titles(page), 30)
        check('panel: tab titled "Revspan" back on the home page', bool(home_tab), str(tab_titles(page)))
        frame.locator('.rv-row[data-pr$="/42"]').first.click()
        back_on_pr = wait_until(lambda: any('PR #42' in t for t in tab_titles(page)), 30)
        check('panel: tab titled "PR #42" when reopening the PR from the home page', bool(back_on_pr), str(tab_titles(page)))
        frame.wait_for_selector('.rv-v', timeout=60000)

        # "Reload Window": VS Code reopens the panel on the route saved by the page.
        page.keyboard.press('F1')
        page.locator('.quick-input-widget input').first.wait_for(timeout=10000)
        page.keyboard.type('Developer: Reload Window')
        time.sleep(1)
        page.keyboard.press('Enter')
        time.sleep(3)
        page.wait_for_selector('.monaco-workbench', timeout=60000)
        restored = wait_until(lambda: any('PR #42' in t for t in tab_titles(page)), 60)
        check('reload: "PR #42" tab reopened', bool(restored), str(tab_titles(page)))
        frame = wait_until(lambda: app_frame(page), 60)
        if frame:
            frame.wait_for_selector('.rv-v', timeout=60000)
        page.screenshot(path=f'{SHOTS}/06-recharge.png')
        check('reload: PR page displayed', bool(frame) and frame.locator('.rv-v').count() == 7)


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
