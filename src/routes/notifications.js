import { Router } from 'express'
import { pool } from '../db.js'
import { verifierEcole } from '../middleware/auth-ecole.js'
import { verifierFiche } from '../middleware/auth-fiche.js'

const router = Router()

// CÔTÉ ÉCOLE — envoyer la même notification à TOUS les parents d'élèves actifs de l'école
// (réunion générale, vacances, information commune…).
router.post('/', verifierEcole, async (req, res) => {
  const message = String(req.body.message || '').trim()
  const titre = String(req.body.titre || '').trim() || null
  if (!message) return res.status(400).json({ erreur: 'Message requis.' })
  // Un seul INSERT ... SELECT : tout ou rien, au lieu d'une requête par élève.
  const [result] = await pool.query(
    `INSERT INTO notifications_parent (eleve_id, titre, message, date_envoi)
     SELECT id, ?, ?, CURDATE() FROM eleves WHERE ecole_id = ? AND actif = TRUE`,
    [titre, message.slice(0, 2000), req.ecoleId]
  )
  res.status(201).json({ nombre: result.affectedRows })
})

// CÔTÉ ÉCOLE — envoyer une notification libre au parent d'un élève (réunion, document à
// apporter, sortie scolaire, etc.) — distinct des relances, qui restent automatiques et liées
// aux impayés.
router.post('/:eleveId', verifierEcole, async (req, res) => {
  const message = String(req.body.message || '').trim()
  const titre = String(req.body.titre || '').trim() || null
  if (!message) return res.status(400).json({ erreur: 'Message requis.' })
  const [eleves] = await pool.query('SELECT id FROM eleves WHERE id = ? AND ecole_id = ?', [req.params.eleveId, req.ecoleId])
  if (eleves.length === 0) return res.status(404).json({ erreur: 'Élève introuvable dans cet établissement.' })
  await pool.query(
    'INSERT INTO notifications_parent (eleve_id, titre, message, date_envoi) VALUES (?, ?, ?, CURDATE())',
    [req.params.eleveId, titre, message.slice(0, 2000)]
  )
  res.status(201).json({ ok: true })
})

// CÔTÉ ÉCOLE — historique des notifications envoyées pour un élève.
router.get('/eleve/:eleveId', verifierEcole, async (req, res) => {
  const [eleves] = await pool.query('SELECT id FROM eleves WHERE id = ? AND ecole_id = ?', [req.params.eleveId, req.ecoleId])
  if (eleves.length === 0) return res.status(404).json({ erreur: 'Élève introuvable dans cet établissement.' })
  const [rows] = await pool.query(
    'SELECT titre, message, date_envoi AS date FROM notifications_parent WHERE eleve_id = ? ORDER BY date_envoi DESC',
    [req.params.eleveId]
  )
  res.json(rows)
})

// CÔTÉ PARENT — mêmes notifications, en lecture seule. Exige le jeton remis avec la fiche de cet
// élève (code établissement + classe + matricule) : le numéro interne ne suffit plus.
router.get('/eleve/:eleveId/public', verifierFiche, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT titre, message, date_envoi AS date FROM notifications_parent WHERE eleve_id = ? ORDER BY date_envoi DESC',
    [req.params.eleveId]
  )
  res.json(rows)
})

export default router
