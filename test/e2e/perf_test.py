#!/usr/bin/env python3
"""Revspan diff performance run (Playwright for Python): long tasks of the page on a large PR of the fake Bitbucket.

Launch: npm run test:perf (builds, starts the fake Bitbucket with its large PR and the server, then runs this script).
Environment (set by run-against-fake.ts --perf):
    REVSPAN_BASE_URL    URL of the Revspan server (required).
    REVSPAN_PR          Large PR, "workspace/repo/id".
Options:
    REVSPAN_PERF_CPU    CPU slowdown factor of the browser (Chrome DevTools throttling, default 1).
    REVSPAN_PERF_OUT    JSON file where the measures are also written.
    REVSPAN_HEADED=1    Visible browser.

Each scenario records the long tasks (> 50 ms, PerformanceObserver 'longtask') from its first action until the page
has been quiet for QUIET_MS: the longest one and their total. Criterion of the spec: no long task > 100 ms when
switching files (list click, j/k); first render of the big file < 300 ms or progressive.
"""
import json
import os
import sys
import time

from playwright.sync_api import expect, sync_playwright

BASE = os.environ.get('REVSPAN_BASE_URL', '').rstrip('/')
PR = os.environ.get('REVSPAN_PR', 'acme/demo-repo/50')
CPU = float(os.environ.get('REVSPAN_PERF_CPU', '1'))
OUT = os.environ.get('REVSPAN_PERF_OUT')
CHROMIUM_ARGS = ['--use-mock-keychain', '--password-store=basic']
QUIET_MS = 700
SWITCH_LIMIT_MS = 100
BIG = 'src/big/Fixtures.ts'
GENERATED = 'src/big/Generated.ts'

# Long tasks of the page since its load, plus the end of the last one (to detect a quiet page).
OBSERVER = """
window.__lt = [];
new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__lt.push({ start: e.startTime, duration: e.duration });
}).observe({ type: 'longtask', buffered: true });
"""

results = []


def log(msg):
    print(msg, flush=True)


def now(page):
    return page.evaluate('performance.now()')


def settle(page, since, timeout=30):
    """Waits until no long task and no loading indicator for QUIET_MS, then returns the long tasks since `since`."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = page.evaluate("""() => {
            const last = window.__lt.reduce((end, e) => Math.max(end, e.start + e.duration), 0);
            const busy = !!document.querySelector('.rv-progress, .rv-diff-skel');
            return { quiet: performance.now() - last, busy };
        }""")
        if not state['busy'] and state['quiet'] > QUIET_MS and now(page) - since > QUIET_MS:
            break
        page.wait_for_timeout(100)
    return page.evaluate('(since) => window.__lt.filter((e) => e.start >= since).map((e) => e.duration)', since)


def record(name, tasks, extra=None):
    entry = {'scenario': name, 'max': round(max(tasks, default=0)), 'total': round(sum(tasks)), 'count': len(tasks)}
    if extra:
        entry.update(extra)
    results.append(entry)
    more = ''.join(f'  {k}={v}' for k, v in (extra or {}).items())
    log(f'{name:<34} max {entry["max"]:>5} ms  total {entry["total"]:>6} ms  ({entry["count"]} long tasks){more}')


def file_row(page, path):
    return page.locator(f'.rv-f[data-path="{path}"]')


def file_block(page, path):
    return page.locator(f'.rv-file[data-path="{path}"]')


def click_and_paint(page, selector):
    """Clicks in the page and returns the time until the next frame is painted (ms)."""
    return round(page.evaluate("""async (selector) => {
        const start = performance.now();
        document.querySelector(selector).click();
        await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        return performance.now() - start;
    }""", selector))


def scenario_load(page):
    since = 0
    page.goto(f'{BASE}/#/pr/{PR}')
    expect(page.locator('.rv-file').first).to_be_visible(timeout=60000)
    record('load of the PR', settle(page, since, timeout=60), {'files': page.locator('.rv-file').count()})


def scenario_grammars(page, paths):
    """First file of each language: shiki compiles the grammar's rules on first use (one-off, recorded apart)."""
    tasks = []
    for path in paths:
        since = now(page)
        click_and_paint(page, f'.rv-f[data-path="{path}"]')
        tasks += settle(page, since)
    record('first use of each grammar (one-off)', tasks)


def scenario_list_clicks(page, paths):
    tasks, paints, per_click = [], [], []
    for path in paths:
        since = now(page)
        paints.append(click_and_paint(page, f'.rv-f[data-path="{path}"]'))
        click = settle(page, since)
        per_click.append(round(max(click, default=0)))
        tasks += click
    record('file click in the list (x%d)' % len(paths), tasks, {'paint_max': max(paints), 'max_per_click': per_click})


def scenario_jk(page):
    click_and_paint(page, '.rv-f')
    settle(page, now(page))
    since = now(page)
    for key in ['j'] * 5 + ['k'] * 5:
        page.keyboard.press(key)
        page.wait_for_timeout(250)
    record('j x5 then k x5', settle(page, since))


def toggle_file(page, path):
    since = now(page)
    paint = click_and_paint(page, f'.rv-file[data-path="{path}"] .rv-fh .tog')
    return since, paint


def scenario_expand(page, path, label):
    # the file is shown, collapsed, then measured while it expands
    click_and_paint(page, f'.rv-f[data-path="{path}"]')
    settle(page, now(page))
    toggle_file(page, path)
    settle(page, now(page))
    since, paint = toggle_file(page, path)
    tasks = settle(page, since)
    record(label, tasks, {'paint': paint, 'rows': file_block(page, path).locator('.rv-l').count()})


def scenario_context(page):
    since = now(page)
    click_and_paint(page, '.rv-dtb [data-seg="full"]')
    record('full-file context on', settle(page, since, timeout=60))
    since = now(page)
    click_and_paint(page, '.rv-dtb [data-seg="3"]')
    record('full-file context off', settle(page, since, timeout=60))


def scenario_search(page, query, label):
    box = page.locator('.rv-search input')
    box.click()
    settle(page, now(page))
    since = now(page)
    # slower than the debounce: every key runs a search
    box.press_sequentially(query, delay=200)
    tasks = settle(page, since)
    marks = page.evaluate("document.querySelectorAll('.rv-diff mark').length")
    record(label, tasks, {'marks': marks})
    since = now(page)
    box.fill('')
    record('clearing the search', settle(page, since))


def scenario_fast_scroll(page, path):
    """Scrolls fast (12 frames) from the top down to a file, then waits for the colors of its lines on screen.
    Run first: the files passed on the way (among them Generated.ts, 125 hunks) have no colors yet."""
    page.evaluate('window.scrollTo(0, 0)')
    settle(page, now(page))
    since = now(page)
    elapsed = page.evaluate("""async (path) => {
        const file = document.querySelector(`.rv-file[data-path="${path}"]`);
        const end = file.getBoundingClientRect().top + scrollY - 120;
        for (let k = 1; k <= 12; k++) {
            window.scrollTo(0, (end * k) / 12);
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        const start = performance.now();
        const colored = () => [...file.querySelectorAll('.rv-l .c')].some((c) => {
            const r = c.getBoundingClientRect();
            return r.bottom > 0 && r.top < innerHeight && c.querySelector('span[style]');
        });
        while (!colored()) {
            if (performance.now() - start > 30000) return -1;
            await new Promise((resolve) => setTimeout(resolve, 16));
        }
        return performance.now() - start;
    }""", path)
    record('fast scroll, then colors on screen', settle(page, since), {'colors_after_ms': round(elapsed)})


def main():
    if not BASE:
        log('REVSPAN_BASE_URL missing: run "npm run test:perf".')
        sys.exit(2)
    log(f'Revspan perf run -- {BASE} — PR {PR} — CPU x{CPU:g}')
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=CHROMIUM_ARGS, headless=not os.environ.get('REVSPAN_HEADED'))
        context = browser.new_context(viewport={'width': 1440, 'height': 900}, locale='en-US', timezone_id='Europe/Paris')
        context.set_default_timeout(30000)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.add_init_script(OBSERVER)
        if CPU > 1:
            page.context.new_cdp_session(page).send('Emulation.setCPUThrottlingRate', {'rate': CPU})
        scenario_load(page)
        paths = page.evaluate("[...document.querySelectorAll('.rv-f')].map((e) => e.dataset.path)")
        services = [p for p in paths if p.endswith('Service.ts')]
        scenario_fast_scroll(page, services[(3 * len(services)) // 4])
        scenario_grammars(page, [services[0], *(next(p for p in paths if p.endswith(ext)) for ext in ('.vue', '.md', '.json'))])
        scenario_list_clicks(page, [services[len(services) // 2], BIG, paths[-1], GENERATED, paths[0], services[-1]])
        scenario_jk(page)
        scenario_expand(page, BIG, 'expanding the big file (5 000 lines)')
        scenario_expand(page, GENERATED, 'expanding Generated.ts (125 hunks)')
        scenario_search(page, 'handler12', 'typing a narrow query (9 keys)')
        scenario_search(page, 'weight', 'typing a broad query (6 keys)')
        scenario_context(page)
        browser.close()
    switch = [r for r in results if r['scenario'].startswith(('file click', 'j x5'))]
    ok = all(r['max'] <= SWITCH_LIMIT_MS for r in switch)
    log(f'\nfile switch criterion (no long task > {SWITCH_LIMIT_MS} ms): {"PASS" if ok else "FAIL"}')
    if errors:
        log(f'JavaScript errors: {errors}')
    if OUT:
        with open(OUT, 'w', encoding='utf-8') as out:
            json.dump({'cpu': CPU, 'results': results, 'errors': errors}, out, indent=2)
    sys.exit(1 if errors else 0)


if __name__ == '__main__':
    main()
