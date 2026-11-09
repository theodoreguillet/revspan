#!/usr/bin/env python3
"""Test UI de Strata (Playwright pour Python, sans pytest), contre le vrai serveur branché sur le faux Bitbucket.

Lancement normal (après « npx --no-install vite build ») :
    node test/e2e/run-against-fake.ts

run-against-fake.ts démarre le faux Bitbucket et le serveur, puis lance ce script avec :
    STRATA_BASE_URL    URL du serveur Strata (obligatoire).
    STRATA_CALLS_URL   Journal des écritures reçues par le faux Bitbucket (GET → JSON array).
    STRATA_PR          PR principale, « workspace/dépôt/id » (acme/demo-repo/42).
    STRATA_FAKE_PRS    JSON des PR du faux Bitbucket : main, long, rebaseOnly, mine, neverReviewed, others, purged.
    STRATA_FAKE_EMAIL, STRATA_FAKE_TOKEN   Identifiants du faux Bitbucket (remise du jeton après suppression).
Options :
    STRATA_SHOTS_DIR   Dossier des captures (défaut : <tmp>/strata-shots).
    STRATA_FIXED_TIME  Heure figée du navigateur (ISO).
    STRATA_HEADED=1    Navigateur visible.

Un seul serveur pour tout le script : chaque vérification voit les écritures des précédentes (ordre important).
Sort avec un code non nul si une vérification échoue.
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

BASE = os.environ.get('STRATA_BASE_URL', '').rstrip('/')
CALLS_URL = os.environ.get('STRATA_CALLS_URL')
MAIN_PR = os.environ.get('STRATA_PR', 'acme/demo-repo/42')
FAKE_PRS = json.loads(os.environ.get('STRATA_FAKE_PRS', '{}'))
FAKE_TOKEN = os.environ.get('STRATA_FAKE_TOKEN', '')
SHOTS = os.environ.get('STRATA_SHOTS_DIR') or os.path.join(tempfile.gettempdir(), 'strata-shots')
CHROMIUM_ARGS = ['--use-mock-keychain', '--password-store=basic']
MINUS = '−'

results = []


def log(msg):
    print(msg, flush=True)


def check(name):
    """Décorateur : exécute une vérification, journalise PASS/FAIL, continue en cas d'échec (capture d'écran à l'appui)."""
    def wrap(fn):
        def run(page):
            try:
                fn(page)
                results.append((name, True))
                log(f'PASS  {name}')
            except Exception as error:  # noqa: BLE001 — on veut tout journaliser
                results.append((name, False))
                log(f'FAIL  {name}\n      {str(error).splitlines()[0] if str(error) else repr(error)}')
                if os.environ.get('STRATA_DEBUG'):
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
# Journal des écritures du faux Bitbucket (format de l'API Bitbucket 2.0)
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
            log(f'      (journal des appels absent : « {desc} » non vérifié)')
            return None
        deadline = time.time() + timeout
        seen = []
        while time.time() < deadline:
            seen = self.all()[self.mark:]
            for call in seen:
                if predicate(call):
                    return call
            time.sleep(0.1)
        raise AssertionError(f'appel attendu absent : {desc} ; reçus : {json.dumps(seen, ensure_ascii=False)[:600]}')


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
# Attentes
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


def wait_api(predicate, desc, timeout=8.0):
    deadline = time.time() + timeout
    while not predicate():
        if time.time() > deadline:
            raise AssertionError(f'état serveur attendu absent : {desc}')
        time.sleep(0.1)


# ---------------------------------------------------------------------------
# Captures (avant les écritures)
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
    log(f'      captures dans {SHOTS}')


# ---------------------------------------------------------------------------
# Vérifications
# ---------------------------------------------------------------------------

def run_checks(page):
    data = api(pr_api(MAIN_PR))
    n = len(data['versions'])
    lr = data['review']['lastReviewed']
    me = data['me'] or {}
    exp_from, exp_to = expected_default(n, lr)
    by_id = {t['id']: t for t in data['threads']}
    # mon fil en ligne encore ouvert
    my_thread = next((t for t in data['threads'] if t['path'] and not t['resolved'] and t['comments'][0]['mine']), None)

    @check('accueil : groupes et cartes (avant d\'ouvrir les PR)')
    def home(page):
        page.goto(url(''))
        expect(page.locator('.rv-list').first).to_be_visible(timeout=20000)
        card = page.locator(f'.rv-row[data-pr="{MAIN_PR}"]')
        expect(card).to_contain_text(data['pr']['title'])
        if FAKE_PRS:
            expect(page.locator('section[data-group="to-review"]')).to_contain_text(data['pr']['title'])
            expect(card).to_contain_text(f'+{n - lr} versions')
            expect(card).to_contain_text('💬 2 nouveaux')
            expect(page.locator(f'section[data-group="mine"] .rv-row[data-pr="{fake_ref("mine")}"]')).to_contain_text('toi')
            others = page.locator('details[data-group="others"]')
            assert not others.evaluate('d => d.open'), '« Autres PR ouvertes » doit être replié quand on connaît l\'utilisateur'
            others.locator('summary').click()
            light = others.locator(f'.rv-row[data-pr="{fake_ref("others")}"]')
            expect(light.locator('.rv-nb')).to_have_text('pas encore relue')  # versionsCount null : pas de nombre
    home(page)

    @check('ouverture de la PR depuis l\'accueil, plage par défaut')
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

    @check('clic sur une version = ce qu\'elle a changé')
    def click_version(page):
        page.click('.rv-v[data-i="4"]')
        expect(readout(page)).to_have_text('Changements de v4 · par rapport à v3 · aucun changement de code')
        assert current_selection(page) == (3, 4)
    click_version(page)

    @check('Maj+clic : étendre, puis déplacer la borne la plus proche')
    def shift_click(page):
        page.click(f'.rv-v[data-i="{n}"]', modifiers=['Shift'])
        expect(readout(page)).to_contain_text(f'Changements de v4 à v{n} · par rapport à v3')
        page.click('.rv-v[data-i="2"]')
        page.click('.rv-v[data-i="6"]', modifiers=['Shift'])
        expect(readout(page)).to_contain_text('Changements de v2 à v6 · par rapport à v1')
        page.click('.rv-v[data-i="3"]', modifiers=['Shift'])  # 3-1 ≤ 6-3 : « de » plus proche → from = 2
        expect(readout(page)).to_contain_text('Changements de v3 à v6 · par rapport à v2')
        page.click('.rv-v[data-i="5"]', modifiers=['Shift'])  # 5-2 > 6-5 : « à » plus proche → to = 5
        expect(readout(page)).to_contain_text('Changements de v3 à v5 · par rapport à v2')
        assert current_selection(page) == (2, 5)
    shift_click(page)

    @check('préréglage « Tout vs master »')
    def all_vs_master(page):
        page.click('.rv-preset[data-preset="all"]')
        cmp = api(f'{pr_api(MAIN_PR)}/compare?from=0&to={n}&context=3')
        stats = cmp['stats']
        expect(readout(page)).to_have_text(f'v{n} complète · par rapport à sa base sur master · {stats["files"]} fichiers, +{stats["added"]} {MINUS}{stats["removed"]}')
        expect(page.locator('.rv-preset.on[data-preset="all"]')).to_be_visible()
        expect(page.locator('.rv-diff .rv-file')).to_have_count(len(cmp['files']))
    all_vs_master(page)

    @check('masquer rebases seuls et deps : garde la version relue et les bornes')
    def hide_no_code(page):
        page.click('.rv-preset[data-preset="last"]')  # v5 → v6
        page.check('#hide-no-code')
        for i in (lr, n - 1, n):
            expect(page.locator(f'.rv-v[data-i="{i}"]')).to_be_visible()
        expect(page.locator('.rv-v[data-i="3"]')).to_have_count(0)  # rebase seul
        expect(page.locator('.rv-v[data-i="4"]')).to_have_count(0)  # deps
        tick = page.locator('.rv-tick')
        expect(tick).to_have_text('⋯2')
        tick.click()  # clic = tout réafficher
        expect(page.locator('#hide-no-code')).not_to_be_checked()
        expect(page.locator('.rv-v[data-i="3"]')).to_be_visible()
    hide_no_code(page)

    # À partir d'ici : plage par défaut (depuis ma relecture).
    open_pr(page, MAIN_PR, f'?from={exp_from}&to={exp_to}')
    cmp = api(f'{pr_api(MAIN_PR)}/compare?from={exp_from}&to={exp_to}&context=3')
    thread_sel = f'.rv-diff .rv-th[data-thread="{my_thread["id"]}"]' if my_thread else '.rv-diff .rv-th:not([data-resolved])'
    code_file = next(f for f in cmp['files'] if f['category'] == 'code')

    @check('diff : fichiers, fil placé (ligne modifiée), en-tête de hunk, fichiers de master masqués')
    def diff_view(page):
        expect(page.locator('.rv-diff .rv-file')).to_have_count(len(cmp['files']))
        assert my_thread, 'aucun fil ouvert de moi dans la PR'
        placement = next(p for f in cmp['files'] for p in f['threads'] if p['threadId'] == my_thread['id'])
        expect(page.locator(thread_sel)).to_contain_text(my_thread['comments'][0]['raw'])
        expect(page.locator(thread_sel)).to_contain_text(f'Posté sur v{my_thread["version"]} · ligne {my_thread["anchor"]["to"]}')
        if placement['moved']:
            expect(page.locator(f'{thread_sel} .rv-moved')).to_have_text('ligne modifiée depuis')
        previous = page.evaluate(f'() => document.querySelector(\'{thread_sel}\').previousElementSibling.dataset.n')
        assert previous == str(placement['line']), f'le fil devrait suivre la ligne {placement["line"]}, suit {previous}'
        header = code_file['hunks'][0]['header']
        block = page.locator(f'.rv-file[data-path="{code_file["path"]}"]')
        if header:
            expect(block.locator('.rv-hunk .hh').first).to_have_text(header)
        resolved = [p['threadId'] for f in cmp['files'] for p in f['threads'] if by_id[p['threadId']]['resolved']]
        for tid in resolved:
            expect(page.locator(f'.rv-diff .rv-th[data-thread="{tid}"]')).to_have_count(0)  # résolus masqués par défaut
        if cmp['masterOnly']:
            expect(page.locator('.rv-masked')).to_contain_text(f'{len(cmp["masterOnly"])} fichiers modifiés uniquement par master sont masqués')
        if cmp['messageChanged']:
            expect(page.locator('.rv-msgdiff')).to_contain_text('Message du commit modifié')
        expect(page.locator('.rv-prog')).to_contain_text(f'0 / {len(cmp["files"])} vus')
    diff_view(page)

    @check('contexte « fichier entier » puis 3 lignes')
    def full_context(page):
        before = page.locator('.rv-diff .rv-l').count()
        page.locator('.rv-seg button[data-seg="full"]').click()
        page.wait_for_function(f'() => !document.querySelector(".rv-body.loading") && document.querySelectorAll(".rv-diff .rv-l").length > {before}', timeout=10000)
        page.locator('.rv-seg button[data-seg="3"]').click()
        page.wait_for_function(f'() => !document.querySelector(".rv-body.loading") && document.querySelectorAll(".rv-diff .rv-l").length === {before}', timeout=10000)
    full_context(page)

    @check('commentaire en ligne (bouton +, ⌘/Ctrl+Entrée)')
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

    @check('répondre à un fil, puis supprimer ma réponse')
    def reply_and_delete(page):
        assert my_thread, 'aucun fil ouvert de moi'
        page.locator(f'{thread_sel} .rv-th-f textarea').fill('Merci, c\'est bon pour moi.')
        calls.start()
        page.locator(f'{thread_sel} [data-action="send-reply"]').click()
        calls.wait(lambda c: is_post_comment(c) and comment_parent(c) == my_thread['id'], f'POST comments parent={my_thread["id"]}')
        mine = page.locator(f'{thread_sel} .rv-cm', has_text='Merci, c\'est bon pour moi.')
        expect(mine).to_have_count(1, timeout=10000)
        cid = int(mine.get_attribute('data-comment'))
        calls.start()
        mine.locator('[data-action="delete"]').click()  # confirm() accepté par le gestionnaire de dialogues
        calls.wait(lambda c: c['method'] == 'DELETE' and c['path'].endswith(f'/comments/{cid}'), f'DELETE comments/{cid}')
        expect(page.locator(f'{thread_sel} .rv-cm', has_text='Merci, c\'est bon pour moi.')).to_have_count(0, timeout=10000)
    reply_and_delete(page)

    @check('commentaire sur une ligne supprimée (commentaire général avec citation)')
    def deleted_line(page):
        target = next(((f['path'], ln['o'], ln['text']) for f in cmp['files'] for h in f['hunks'] for ln in h['lines'] if ln['t'] == '-'), None)
        assert target, 'aucune ligne supprimée dans le diff'
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
                   'POST comments général avec citation')
        expect(page.locator('.rv-comp')).to_have_count(0, timeout=10000)
    deleted_line(page)

    @check('résoudre un fil')
    def resolve(page):
        assert my_thread, 'aucun fil ouvert de moi'
        calls.start()
        page.locator(f'{thread_sel} [data-action="resolve"]').click()
        calls.wait(lambda c: c['method'] == 'POST' and c['path'].endswith(f'/comments/{my_thread["id"]}/resolve'), f'POST comments/{my_thread["id"]}/resolve')
        expect(page.locator(thread_sel)).to_have_count(0, timeout=10000)
        page.check('#show-resolved')
        expect(page.locator(f'{thread_sel} .rv-th-bar')).to_contain_text('Fil résolu')
        page.uncheck('#show-resolved')
    resolve(page)

    @check('marquer un fichier « Vu » (état local du serveur)')
    def viewed(page):
        block = page.locator(f'.rv-file[data-path="{code_file["path"]}"]')
        block.locator('input[data-action="viewed"]').check()
        expect(block).to_have_class(re.compile(r'\bfolded\b'))
        expect(page.locator(f'.rv-f[data-path="{code_file["path"]}"] .ck.seen')).to_be_visible()
        expect(page.locator('.rv-prog')).to_contain_text(f'1 / {len(cmp["files"])} vus')
        wait_api(lambda: api(pr_api(MAIN_PR))['review']['viewed'].get(code_file['path']) == code_file['contentHash'], 'review.viewed mis à jour')
    viewed(page)

    @check('demander des modifs (bascule)')
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

    @check('approuver')
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

    @check('onglet Discussions : commentaire général, groupes, « Voir dans le diff », HTML assaini')
    def discussions(page):
        page.click('.rv-tab[data-tab="discussions"]')
        page.fill('.rv-disc .rv-comp textarea', 'Commentaire général de test')
        calls.start()
        page.click('[data-action="send-general"]')
        calls.wait(lambda c: is_post_comment(c) and comment_raw(c) == 'Commentaire général de test' and comment_parent(c) is None and not body_of(c).get('inline'),
                   'POST comments général')
        expect(page.locator('.rv-ditem', has_text='Commentaire général de test')).to_be_visible(timeout=10000)
        expect(page.locator('.rv-dgrp[data-group="open"]')).to_contain_text('Ouverts')
        expect(page.locator('details[data-group="resolved"] summary')).to_contain_text('Résolus')
        # HTML des commentaires (le faux Bitbucket en sert un avec <img onerror>) : rien d'exécutable dans le DOM
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
        assert out['count'] > 0, 'aucun commentaire rendu'
        assert not out['bad'], f'HTML non assaini : {out["bad"]}'
        shown = page.locator('.rv-ditem:visible [data-action="show-in-diff"]').first
        tid = shown.evaluate('b => b.closest(".rv-ditem").dataset.thread')
        shown.click()
        expect(page.locator('.rv-tab.on[data-tab="diff"]')).to_be_visible()
        expect(page.locator(f'.rv-diff .rv-th[data-thread="{tid}"]')).to_be_visible()
    discussions(page)

    @check('onglet Versions : clic sur une ligne')
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

    @check('raccourcis clavier ([ ] n j k ?)')
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
    keyboard(page)

    @check('collage d\'une URL Bitbucket dans la barre du haut')
    def url_paste(page):
        ws, repo, pid = MAIN_PR.split('/')
        page.goto(url(''))
        page.fill('.rv-nav .rv-url', f'https://bitbucket.org/{ws}/{repo}/pull-requests/{pid}/diff')
        page.press('.rv-nav .rv-url', 'Enter')
        expect(page).to_have_url(re.compile(f'#/pr/{ws}/{repo}/{pid}'))
        wait_pr_ready(page)
    url_paste(page)

    if FAKE_PRS:
        @check('PR longue : repli automatique, approbation périmée, dépliage')
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

        @check('seulement des rebases depuis ma relecture : groupe d\'accueil et réapprobation rapide')
        def fast_path(page):
            ref = fake_ref('rebaseOnly')
            open_pr(page, ref)  # calcule le résumé : la PR passe dans « Réapprobation rapide »
            banner = page.locator('.rv-banner[data-banner="fast"]')
            expect(banner).to_contain_text('Depuis ta relecture de v1 : seulement des rebases, aucun changement de l\'auteur')
            expect(page.locator('.rv-empty')).to_contain_text('Aucun changement de l\'auteur entre v1 et v2')
            page.goto(url(''))
            card = page.locator(f'section[data-group="rebase-only"] .rv-row[data-pr="{ref}"]')
            expect(card).to_contain_text('rebase seul', timeout=20000)
            card.click()
            wait_pr_ready(page)
            calls.start()
            page.click('[data-action="reapprove"]')
            calls.wait(lambda c: c['method'] == 'POST' and c['path'].endswith(f'/pullrequests/{FAKE_PRS["rebaseOnly"]}/approve'), 'POST approve (réapprobation)')
            expect(page.locator('.rv-banner')).to_contain_text('Tu es à jour : v2 relue', timeout=10000)
        fast_path(page)

        @check('ma PR : pas de bouton d\'approbation')
        def mine(page):
            open_pr(page, fake_ref('mine'))
            expect(page.locator('.rv-head .own')).to_have_text('Ta PR')
            expect(page.locator('[data-action="approve"]')).to_have_count(0)
            expect(page.locator('[data-action="request-changes"]')).to_have_count(0)
        mine(page)

        @check('jamais relue : « Première relecture » puis « Marquer vN comme relue »')
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
            wait_api(lambda: api(pr_api(ref))['review']['lastReviewed'] == total, 'lastReviewed avancé (marque locale)')
        never_reviewed(page)

        @check('version effacée par Bitbucket : page chargée, v1 indisponible et non cliquable, plage depuis master')
        def purged(page):
            open_pr(page, fake_ref('purged'))
            gone = page.locator('.rv-v[data-i="1"]')
            expect(gone).to_have_class(re.compile(r'\bgone\b'))
            expect(gone).to_have_attribute('aria-disabled', 'true')
            expect(gone.locator('.rv-dl')).to_have_text('indisponible')
            assert 'Bitbucket a effacé ce commit' in (gone.get_attribute('title') or '')
            # Ma relecture date de v1 (indisponible) : la plage par défaut part de master.
            assert current_selection(page) == (0, 3), page.evaluate('location.hash')
            gone.click(force=True)  # aria-disabled : Playwright refuse le clic ordinaire, un utilisateur peut cliquer
            assert current_selection(page) == (0, 3), 'un clic sur une version indisponible ne doit rien changer'
            page.click('.rv-v[data-i="2"]')
            assert current_selection(page) == (0, 2), page.evaluate('location.hash')
            expect(page.locator('.rv-v[data-i="2"]')).to_have_attribute('title', re.compile('changements comptés depuis la base'))
        purged(page)

    @check('réglages : enregistrer et tester la connexion')
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

    if FAKE_TOKEN:
        @check('jeton supprimé : l\'accueil renvoie vers les réglages, puis jeton remis')
        def no_token(page):
            page.goto(url('settings'))
            page.click('text=Supprimer le jeton')
            expect(page.locator('.rv-status')).to_have_text('Jeton supprimé.')
            expect(page.locator('#set-token')).to_have_attribute('placeholder', 'Colle ici ton jeton API Atlassian')
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


def main():
    if not BASE:
        log('STRATA_BASE_URL manquant : lancer « node test/e2e/run-against-fake.ts » (après « npx --no-install vite build »).')
        sys.exit(2)
    log(f'Strata UI test — {BASE} — PR {MAIN_PR}')
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=CHROMIUM_ARGS, headless=not os.environ.get('STRATA_HEADED'))
        fixed_time = os.environ.get('STRATA_FIXED_TIME')
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
        results.append(('aucune erreur JavaScript', not errors))
        log('PASS  aucune erreur JavaScript' if not errors else f'FAIL  aucune erreur JavaScript\n      {errors}')
        browser.close()
    failed = [r for r in results if not r[1]]
    log(f'\n{len(results) - len(failed)}/{len(results)} vérifications réussies')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
