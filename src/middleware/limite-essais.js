// Freine les essais de codes au hasard : au-delà de `max` échecs (401/404) par adresse IP
// dans la fenêtre, la route répond 429. Le compteur est en mémoire (repart à zéro au redémarrage).
export function limiteEssais({ max = 10, fenetreMs = 15 * 60 * 1000 } = {}) {
  const echecs = new Map() // ip -> { n, debut }

  setInterval(() => {
    const maintenant = Date.now()
    for (const [ip, e] of echecs) if (maintenant - e.debut > fenetreMs) echecs.delete(ip)
  }, fenetreMs).unref()

  return (req, res, next) => {
    const ip = req.ip
    const e = echecs.get(ip)
    if (e && Date.now() - e.debut <= fenetreMs && e.n >= max) {
      return res.status(429).json({ erreur: 'Trop de tentatives. Réessayez dans quelques minutes.' })
    }
    res.on('finish', () => {
      if (res.statusCode !== 401 && res.statusCode !== 404) return
      const actuel = echecs.get(ip)
      if (actuel && Date.now() - actuel.debut <= fenetreMs) actuel.n += 1
      else echecs.set(ip, { n: 1, debut: Date.now() })
    })
    next()
  }
}
