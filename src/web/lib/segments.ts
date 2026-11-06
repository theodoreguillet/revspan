// Texte enrichi minimal produit par la logique (bandeau, onglet Versions) et rendu par <SegText>.

export type SegKind = 'b' | 'mono' | 'add' | 'del';
export type Seg = string | { text: string; kind: SegKind };

export const b = (text: string): Seg => ({ text, kind: 'b' });
export const mono = (text: string): Seg => ({ text, kind: 'mono' });
export const add = (text: string): Seg => ({ text, kind: 'add' });
export const del = (text: string): Seg => ({ text, kind: 'del' });

/** Texte brut (pour les tests et les infobulles). */
export function segText(segs: Seg[]): string {
    return segs.map((s) => (typeof s === 'string' ? s : s.text)).join('');
}
