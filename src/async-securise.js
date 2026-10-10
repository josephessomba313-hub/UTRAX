// Express 4 ne transmet pas aux gestionnaires d'erreurs les erreurs d'une route `async` :
// une requête SQL qui échoue laisserait la requête pendante. Cette fonction enveloppe chaque
// gestionnaire d'un routeur pour que l'erreur parte vers le gestionnaire d'erreurs global
// (voir index.js). Sans effet néfaste sur Express 5, qui le fait déjà.
export function protegerAsync(routeur) {
  for (const couche of routeur.stack) {
    if (!couche.route) continue
    for (const sousCouche of couche.route.stack) {
      const original = sousCouche.handle
      if (original.length >= 4 || original.__protege) continue // gestionnaire d'erreurs : on n'y touche pas
      const enveloppe = function (req, res, next) {
        try {
          const retour = original.call(this, req, res, next)
          if (retour && typeof retour.catch === 'function') retour.catch(next)
        } catch (err) {
          next(err)
        }
      }
      enveloppe.__protege = true
      sousCouche.handle = enveloppe
    }
  }
}
