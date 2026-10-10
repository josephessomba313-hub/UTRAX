import { createHash, timingSafeEqual } from 'node:crypto'
import { limiteEssais } from './limite-essais.js'

// Version simple pour cette phase : une clé secrète que seul UTRAX connaît, envoyée dans
// l'en-tête "x-admin-key". À remplacer par un vrai login UTRAX (équipe, rôles) quand vous
// serez plusieurs à l'utiliser.
// Deux protections ajoutées : comparaison à temps constant (on compare des empreintes), et
// limite d'essais ratés par adresse IP (la clé ne peut plus être devinée par force brute).
const empreinte = (s) => createHash('sha256').update(String(s)).digest()

function cleValide(fournie) {
  const attendue = process.env.ADMIN_KEY
  if (!attendue || !fournie) return false
  return timingSafeEqual(empreinte(fournie), empreinte(attendue))
}

const limiteAdmin = limiteEssais({ max: 10 })

function controleCle(req, res, next) {
  if (!cleValide(req.headers['x-admin-key'])) {
    return res.status(401).json({ erreur: 'Accès réservé à la supervision UTRAX.' })
  }
  next()
}

// Un tableau de middlewares est accepté tel quel par Express : router.get('/', verifierAdmin, ...)
export const verifierAdmin = [limiteAdmin, controleCle]
