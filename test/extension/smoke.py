"""Test de fumée de l'extension Revspan dans un VS Code isolé (lancé par run-smoke.ts).

Pilote VS Code par son port de débogage (Playwright connect_over_cdp) : vue « Mes PR », panneau de la PR,
« Diff VS Code » (éditeur de diff natif), « Ouvrir le fichier » (dépôt local), titre de l'onglet pendant la
navigation et panneau rouvert après « Recharger la fenêtre ».
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
        raise RuntimeError('fenêtre VS Code introuvable')
    return page


def app_frame(page: Page) -> Frame | None:
    """Le cadre du panneau qui contient la page Revspan (iframe du webview)."""
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
    except Exception:  # noqa: BLE001 — fenêtre en cours de rechargement
        return []


def run() -> None:
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(CDP_URL)
        page = workbench(browser)
        page.wait_for_selector('.monaco-workbench', timeout=60000)
        page.screenshot(path=f'{SHOTS}/01-workbench.png')

        # Vue « Mes PR » dans la barre d'activité.
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
        check('arbre « Mes PR » : PR principale listée', row.count() > 0, tree_text[:400])
        check('arbre « Mes PR » : groupes', 'À relire' in tree_text and 'Mes PR' in tree_text, tree_text[:400])

        # Panneau de la PR.
        row.click()
        frame = wait_until(lambda: app_frame(page), 60)
        check('panneau : page chargée dans le webview', frame is not None, f'cadres : {[f.url[:80] for f in page.frames]}')
        if not frame:
            return
        frame.wait_for_selector('.rv-v', timeout=60000)
        readout = frame.locator('.rv-readout').first.inner_text()
        check('panneau : frise des 6 versions + master', frame.locator('.rv-v').count() == 7, f'{frame.locator(".rv-v").count()} nœuds')
        check('panneau : comparaison depuis ma relecture (v2)', 'par rapport à v2' in readout, readout)
        frame.wait_for_selector('.rv-file', timeout=30000)
        tabs = [t for t in tab_titles(page) if t]
        check('panneau : onglet titré « PR #42 »', any('PR #42' in t for t in tabs), str(tabs))
        widths = frame.evaluate('[document.documentElement.scrollWidth, window.innerWidth]')
        check('panneau : pas de défilement horizontal de la page', widths[0] <= widths[1] + 1, f'contenu {widths[0]} px pour {widths[1]} px')
        page.screenshot(path=f'{SHOTS}/03-panneau.png')

        # Diff natif de VS Code sur le premier fichier.
        file_block = frame.locator('.rv-file').first
        file_path = file_block.locator('.rv-fh').first.inner_text()
        diff_button = file_block.get_by_role('button', name='Diff VS Code')
        check('panneau : bouton « Diff VS Code » présent', diff_button.count() > 0, file_path)
        if diff_button.count():
            diff_button.first.click()
            opened = wait_until(lambda: [t for t in tab_titles(page) if '→' in t], 30)
            check('diff natif : onglet ouvert', bool(opened), str(tab_titles(page)))
            check('diff natif : éditeur de diff', page.locator('.monaco-diff-editor').count() > 0)
            page.screenshot(path=f'{SHOTS}/04-diff-natif.png')

        # Retour au panneau puis « Ouvrir le fichier » (dépôt local simulé sur la branche de la PR).
        page.locator('.tabs-container .tab', has_text='PR #42').first.click()
        frame = wait_until(lambda: app_frame(page), 30)
        open_button = frame.locator('.rv-file').first.get_by_role('button', name='Ouvrir le fichier') if frame else None
        check('panneau : bouton « Ouvrir le fichier » présent', bool(open_button and open_button.count()))
        if open_button and open_button.count():
            open_button.first.click()
            name = file_path.strip().split('/')[-1].split()[0] if file_path else 'Action.ts'
            opened_file = wait_until(lambda: [t for t in tab_titles(page) if t == 'Action.ts' or t.startswith(name)], 30)
            check('fichier local : ouvert dans un éditeur', bool(opened_file), str(tab_titles(page)))
            page.screenshot(path=f'{SHOTS}/05-fichier-local.png')

        # Une action depuis le panneau atteint bien Bitbucket (faux) : marquer un fichier « Vu » est local,
        # on vérifie plutôt qu'aucune écriture n'a été faite sans action.
        if CALLS_URL:
            calls = json.loads(urllib.request.urlopen(CALLS_URL).read())
            check('aucune écriture Bitbucket sans action explicite', calls == [], str(calls)[:200])

        # Retour à l'accueil depuis la page : l'onglet ne garde pas le titre de la PR.
        page.locator('.tabs-container .tab', has_text='PR #42').first.click()
        frame = wait_until(lambda: app_frame(page), 30)
        if not frame:
            check('panneau : retrouvé avant le retour à l\'accueil', False, str(tab_titles(page)))
            return
        frame.locator('a.home').first.click()
        home_tab = wait_until(lambda: 'Revspan' in tab_titles(page), 30)
        check('panneau : onglet titré « Revspan » de retour à l\'accueil', bool(home_tab), str(tab_titles(page)))
        frame.locator('.rv-row[data-pr$="/42"]').first.click()
        back_on_pr = wait_until(lambda: any('PR #42' in t for t in tab_titles(page)), 30)
        check('panneau : onglet titré « PR #42 » en rouvrant la PR depuis l\'accueil', bool(back_on_pr), str(tab_titles(page)))
        frame.wait_for_selector('.rv-v', timeout=60000)

        # « Recharger la fenêtre » : VS Code rouvre le panneau sur la route enregistrée par la page.
        page.keyboard.press('F1')
        page.locator('.quick-input-widget input').first.wait_for(timeout=10000)
        page.keyboard.type('Developer: Reload Window')
        time.sleep(1)
        page.keyboard.press('Enter')
        time.sleep(3)
        page.wait_for_selector('.monaco-workbench', timeout=60000)
        restored = wait_until(lambda: any('PR #42' in t for t in tab_titles(page)), 60)
        check('rechargement : onglet « PR #42 » rouvert', bool(restored), str(tab_titles(page)))
        frame = wait_until(lambda: app_frame(page), 60)
        if frame:
            frame.wait_for_selector('.rv-v', timeout=60000)
        page.screenshot(path=f'{SHOTS}/06-recharge.png')
        check('rechargement : page de la PR affichée', bool(frame) and frame.locator('.rv-v').count() == 7)


def main() -> int:
    try:
        run()
    except Exception as error:  # noqa: BLE001 — rapport lisible en cas d'erreur inattendue
        check('exécution sans erreur', False, repr(error))
    failed = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(failed)}/{len(results)} vérifications réussies — captures : {SHOTS}')
    return 1 if failed or not results else 0


if __name__ == '__main__':
    sys.exit(main())
