// Freine les essais répétés : au-delà de `max` échecs (401/404) pour une même clé dans la fenêtre,
// la route répond 429. Par défaut la clé est l'adresse IP ; `cle` permet d'en choisir une autre
// (par exemple l'établissement connecté, pour protéger le code de confirmation d'une agence).
// Le compteur est en mémoire (repart à zéro au redémarrage).
// Derrière le proxy de Railway, index.js active `trust proxy` pour que req.ip soit l'adresse
// réelle du visiteur et non celle du proxy.
export function limiteEssais({ max = 10, fenetreMs = 15 * 60 * 1000, cle = (req) => req.ip } = {}) {
  const echecs = new Map() // clé -> { n, debut }

  setInterval(() => {
    const maintenant = Date.now()
    for (const [k, e] of echecs) if (maintenant - e.debut > fenetreMs) echecs.delete(k)
  }, fenetreMs).unref()

  return (req, res, next) => {
    const k = cle(req)
    const e = echecs.get(k)
    if (e && Date.now() - e.debut <= fenetreMs && e.n >= max) {
      return res.status(429).json({ erreur: 'Trop de tentatives. Réessayez dans quelques minutes.' })
    }
    res.on('finish', () => {
      if (res.statusCode !== 401 && res.statusCode !== 404) return
      const actuel = echecs.get(k)
      if (actuel && Date.now() - actuel.debut <= fenetreMs) actuel.n += 1
      else echecs.set(k, { n: 1, debut: Date.now() })
    })
    next()
  }
}
