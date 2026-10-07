import jwt from 'jsonwebtoken'

// Vérifie le jeton envoyé par le tableau de bord d'une école connectée.
// Ajoute req.ecoleId, utilisé par toutes les routes "côté école".
export function verifierEcole(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ erreur: 'Authentification établissement requise.' })
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET)
    req.ecoleId = payload.ecoleId
    next()
  } catch (err) {
    return res.status(401).json({ erreur: 'Session invalide ou expirée, reconnectez-vous.' })
  }
}
