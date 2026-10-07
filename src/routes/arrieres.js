import { Router } from 'express'
import { pool } from '../db.js'
import { verifierAdmin } from '../middleware/auth-admin.js'

const router = Router()

// Arriérés non soldés, toutes écoles — UTRAX uniquement.
router.get('/', verifierAdmin, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.id, a.identifiant_utrax, a.nom_eleve, a.classe, a.montant_fcfa AS montant, a.cree_le,
            ec.nom AS ecole, an.libelle AS annee
     FROM arrieres a
     JOIN ecoles ec ON ec.id = a.ecole_id
     JOIN annees_scolaires an ON an.id = a.annee_id
     WHERE a.solde = FALSE
     ORDER BY a.cree_le DESC`
  )
  res.json(rows)
})

// Marquer un arriéré comme soldé — c'est-à-dire réglé directement auprès de l'école créancière,
// en dehors de l'application (UTRAX ne détient jamais les fonds). Une fois soldé, il n'apparaît
// plus dans la fiche du parent ni dans la vérification faite par une école avant une inscription.
router.patch('/:id/solder', verifierAdmin, async (req, res) => {
  const commentaire = String(req.body.commentaire || '').trim().slice(0, 255) || null
  const [result] = await pool.query(
    'UPDATE arrieres SET solde = TRUE, solde_le = CURDATE(), solde_commentaire = ? WHERE id = ? AND solde = FALSE',
    [commentaire, req.params.id]
  )
  if (result.affectedRows === 0) return res.status(409).json({ erreur: 'Arriéré introuvable ou déjà soldé.' })
  res.json({ ok: true })
})

export default router
