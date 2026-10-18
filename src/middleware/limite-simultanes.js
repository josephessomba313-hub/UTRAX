// Limite le nombre de requêtes TRAITÉES EN MÊME TEMPS par ce serveur pour une catégorie de routes.
// Sert aux routes qui font un calcul de mot de passe : chaque calcul occupe le processeur plusieurs
// dixièmes de seconde, et des milliers de connexions simultanées figeraient tout le serveur (les
// paiements des écoles comprises). Au-delà de `max`, on répond tout de suite 503 « réessayez » : un
// refus rapide vaut mieux qu'un serveur gelé pour tout le monde.
export function limiteSimultanes(max = 6) {
  let actifs = 0
  return (req, res, next) => {
    if (actifs >= max) {
      res.set('Retry-After', '5')
      return res.status(503).json({ erreur: 'Serveur très sollicité, réessayez dans quelques secondes.' })
    }
    actifs += 1
    let libere = false
    const liberer = () => { if (!libere) { libere = true; actifs -= 1 } }
    res.on('finish', liberer)
    res.on('close', liberer)
    next()
  }
}

// Instance partagée par toutes les routes qui calculent un mot de passe (connexions, codes d'agence).
export const limiteCalculsMotDePasse = limiteSimultanes(6)
