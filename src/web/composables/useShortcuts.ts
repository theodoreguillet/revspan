// Aide des raccourcis clavier (overlay global).
import { ref } from 'vue';

export const shortcutsOpen = ref(false);

export const SHORTCUTS: [string, string][] = [
    ['j / k', 'Fichier suivant / précédent'],
    ['n / p', 'Fil de discussion suivant / précédent'],
    ['v', 'Marquer le fichier courant comme vu'],
    ['[ / ]', 'Version précédente / suivante'],
    ['Maj + clic', 'Étendre la plage dans la frise'],
    ['⌘/Ctrl + Entrée', 'Envoyer un commentaire'],
    ['Échap', 'Fermer / annuler'],
    ['?', 'Afficher cette aide'],
];

export function openShortcuts(): void {
    shortcutsOpen.value = true;
}

export function closeShortcuts(): void {
    shortcutsOpen.value = false;
}
