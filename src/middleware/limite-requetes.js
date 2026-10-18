// Limite le NOMBRE DE REQUÊTES par clé (par défaut : adresse IP) dans une fenêtre de temps, qu'elles
// réussissent ou non. Complète limite-essais.js, qui ne compte que les échecs. Au-delà de `max`, la route
// répond 429. Les compteurs sont en mémoire (repartent à zéro au redémarrage) et leur nombre est plafonné
// pour qu'une attaque avec des millions d'adresses ne fasse pas gonfler la mémoire du serveur.
export function limiteRequetes({ max = 600, fenetreMs = 60 * 1000, cle = (req) => req.ip, message } = {}) {
  const compteurs = new Map() // clé -> { n, debut }
  const MAX_CLES = 100000

  setInterval(() => {
    const maintenant = Date.now()
    for (const [k, e] of compteurs) if (maintenant - e.debut > fenetreMs) compteurs.delete(k)
  }, fenetreMs).unref()

  return (req, res, next) => {
    const k = cle(req)
    const maintenant = Date.now()
    let e = compteurs.get(k)
    if (!e || maintenant - e.debut > fenetreMs) {
      if (!e && compteurs.size >= MAX_CLES) compteurs.clear() // protection mémoire : on repart de zéro
      e = { n: 0, debut: maintenant }
      compteurs.set(k, e)
    }
    e.n += 1
    if (e.n > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((e.debut + fenetreMs - maintenant) / 1000))))
      return res.status(429).json({ erreur: message || 'Trop de requêtes. Réessayez dans un instant.' })
    }
    next()
  }
}
