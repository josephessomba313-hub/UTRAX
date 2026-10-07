import { Router } from 'express'
import { pool } from '../db.js'
import { verifierEcole } from '../middleware/auth-ecole.js'

const router = Router()

// CÔTÉ ÉCOLE — envoyer la même notification à TOUS les parents d'élèves actifs de l'école
// (réunion générale, vacances, information commune…).
router.post('/', verifierEcole, async (req, res) => {
  const message = String(req.body.message || '').trim()
  const titre = String(req.body.titre || '').trim() || null
  if (!message) return res.status(400).json({ erreur: 'Message requis.' })
  const [eleves] = await pool.query('SELECT id FROM eleves WHERE ecole_id = ? AND actif = TRUE', [req.ecoleId])
  if (eleves.length === 0) return res.json({ nombre: 0 })
  const messageTronque = message.slice(0, 2000)
  for (const eleve of eleves) {
    await pool.query(
      'INSERT INTO notifications_parent (eleve_id, titre, message, date_envoi) VALUES (?, ?, ?, CURDATE())',
      [eleve.id, titre, messageTronque]
    )
  }
  res.status(201).json({ nombre: eleves.length })
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

// CÔTÉ PARENT — mêmes notifications, en lecture seule, sans mot de passe : même niveau d'accès
// que la fiche publique (déjà fallu connaître école + classe + matricule pour obtenir cet id).
router.get('/eleve/:eleveId/public', async (req, res) => {
  const [rows] = await pool.query(
    'SELECT titre, message, date_envoi AS date FROM notifications_parent WHERE eleve_id = ? ORDER BY date_envoi DESC',
    [req.params.eleveId]
  )
  res.json(rows)
})

export default router
