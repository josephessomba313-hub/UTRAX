import jwt from 'jsonwebtoken'
import { pool } from '../db.js'

// Connexion UTRAX : chaque membre de l'équipe a son compte (identifiant + mot de passe) et reçoit
// un jeton de session de 8 h. Contrairement à l'ancienne clé unique, une session peut être
// RÉVOQUÉE avant son terme (déconnexion, compte désactivé, mot de passe changé) : le jeton est
// revérifié en base à chaque requête.
// Toute action qui modifie quelque chose (POST, PATCH, DELETE…) est inscrite au journal.
export async function verifierAdmin(req, res, next) {
  const refus = (erreur) => res.status(401).json({ erreur, code: 'session_admin' })

  const entete = req.headers.authorization
  if (!entete || !entete.startsWith('Bearer ')) return refus('Connexion UTRAX requise.')

  let payload
  try {
    payload = jwt.verify(entete.slice(7), process.env.JWT_SECRET)
  } catch {
    return refus('Session UTRAX expirée, reconnectez-vous.')
  }
  if (payload.type !== 'admin' || !payload.jti) return refus('Session UTRAX invalide, reconnectez-vous.')

  try {
    const [lignes] = await pool.query(
      `SELECT a.id, a.identifiant, a.nom, a.role, a.actif
       FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
       WHERE s.jti = ? AND s.revoque_le IS NULL AND s.expire_le > NOW()`,
      [payload.jti]
    )
    if (lignes.length === 0 || !lignes[0].actif) return refus('Session UTRAX terminée, reconnectez-vous.')
    req.admin = { ...lignes[0], jti: payload.jti }
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' })
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const action = `${req.method} ${req.originalUrl.split('?')[0]}`.slice(0, 150)
    res.on('finish', () => {
      pool.query(
        'INSERT INTO journal_admin (admin_id, identifiant, action, statut, ip) VALUES (?, ?, ?, ?, ?)',
        [req.admin.id, req.admin.identifiant, action, res.statusCode, req.ip]
      ).catch((err) => console.error('Journal admin :', err.message))
    })
  }
  next()
}

// Réservé au propriétaire (gestion de l'équipe, journal).
export function exigerProprietaire(req, res, next) {
  if (req.admin?.role !== 'proprietaire') {
    return res.status(403).json({ erreur: "Action réservée au propriétaire du compte UTRAX." })
  }
  next()
}
