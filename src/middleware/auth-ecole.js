import jwt from 'jsonwebtoken'

// Vérifie le jeton envoyé par le tableau de bord d'une école connectée.
// Ajoute req.ecoleId, utilisé par toutes les routes "côté école".
// Seul un jeton d'école (qui contient ecoleId) est accepté : un jeton de fiche parent, signé avec
// le même secret, ne donne jamais accès aux routes de l'école.
export function verifierEcole(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ erreur: 'Authentification établissement requise.', code: 'session_ecole' })
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET)
    const ecoleId = Number(payload.ecoleId)
    if (payload.type === 'fiche' || !Number.isInteger(ecoleId) || ecoleId <= 0) {
      return res.status(401).json({ erreur: 'Session invalide, reconnectez-vous.', code: 'session_ecole' })
    }
    req.ecoleId = ecoleId
    next()
  } catch (err) {
    return res.status(401).json({ erreur: 'Session invalide ou expirée, reconnectez-vous.', code: 'session_ecole' })
  }
}
