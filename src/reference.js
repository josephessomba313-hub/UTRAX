import { randomInt } from 'node:crypto'

// Alphabet sans caractères ambigus (ni 0/O, ni 1/I) : références recopiées à la main.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

// Référence aléatoire : 8 caractères parmi 32 = environ 1 100 milliards de combinaisons
// (contre 9 000 avant), donc les collisions deviennent négligeables.
export function genererReference(prefixe) {
  let s = ''
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)]
  return `${prefixe}-${s}`
}

// Exécute `inserer(reference)` et réessaie avec une nouvelle référence si la base signale un
// doublon sur la colonne `reference` (clé UNIQUE). Toute autre erreur est relancée telle quelle.
export async function insererAvecReference(prefixe, inserer) {
  for (let essai = 0; essai < 8; essai++) {
    const reference = genererReference(prefixe)
    try {
      const resultat = await inserer(reference)
      return { reference, resultat }
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY' && /reference/.test(err.sqlMessage || '')) continue
      throw err
    }
  }
  throw new Error('Impossible de générer une référence unique.')
}
