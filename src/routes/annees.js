import { Router } from 'express'
import { pool } from '../db.js'
import { verifierAdmin } from '../middleware/auth-admin.js'

const router = Router()

// "2026-2027" -> "2027-2028"
function libelleSuivant(libelle) {
  const [a, b] = libelle.split('-').map(Number)
  return `${a + 1}-${b + 1}`
}

// Année active et historique des années — LUTRAXE uniquement.
router.get('/', verifierAdmin, async (req, res) => {
  const [annees] = await pool.query(
    'SELECT id, libelle, active, ouverte_le, cloturee_le FROM annees_scolaires ORDER BY id DESC'
  )
  const active = annees.find((a) => a.active) || null
  res.json({ active, prochaine: active ? libelleSuivant(active.libelle) : null, annees })
})

// Ouvrir la nouvelle année — LUTRAXE uniquement.
//  1. refuse s'il reste des paiements non réglés aux écoles (commission de l'année à prélever d'abord) ;
//  2. enregistre en arriérés le solde impayé de chaque élève actif, rattaché à son identifiant LUTRAXE
//     et à l'école créancière (avec les frais de l'année qui se termine) ;
//  3. clôture l'année en cours et ouvre la suivante.
// Le verrou posé sur l'année active (FOR UPDATE) fait attendre les paiements et virements en
// cours le temps de la bascule : aucun paiement ne peut être enregistré sur l'ancienne année
// après la vérification. Les paiements annulés ne comptent ni dans l'attente ni dans les arriérés.
// Chaque école fait ensuite sa « rentrée » (passage de classe, nouveaux tarifs) via /api/eleves/rentree.
router.post('/ouvrir', verifierAdmin, async (req, res) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [actives] = await conn.query('SELECT id, libelle FROM annees_scolaires WHERE active = TRUE FOR UPDATE')
    if (actives.length !== 1) {
      await conn.rollback()
      return res.status(500).json({ erreur: "Il doit y avoir exactement une année active." })
    }
    const active = { id: Number(actives[0].id), libelle: actives[0].libelle }

    // Paiements non annulés pas encore rattachés à un virement, par école.
    const [ecoles] = await conn.query(
      `SELECT ec.id, ec.nom, COALESCE(SUM(p.montant_fcfa), 0) AS en_attente
       FROM ecoles ec
       LEFT JOIN eleves e ON e.ecole_id = ec.id
       LEFT JOIN paiements p ON p.eleve_id = e.id AND p.annule = FALSE AND p.reglement_id IS NULL
       GROUP BY ec.id, ec.nom`
    )
    const bloquants = ecoles.filter((e) => Number(e.en_attente) > 0)
    if (bloquants.length > 0) {
      await conn.rollback()
      return res.status(409).json({
        erreur: "Générez d'abord le virement de chaque établissement ayant des fonds en attente, puis réessayez.",
        ecoles: bloquants.map((e) => ({ id: Number(e.id), nom: e.nom, enAttente: Number(e.en_attente) })),
      })
    }

    const propose = String(req.body.libelle || '').trim() || libelleSuivant(active.libelle)
    if (!/^\d{4}-\d{4}$/.test(propose)) {
      await conn.rollback()
      return res.status(400).json({ erreur: 'Le libellé doit être au format AAAA-AAAA, par exemple 2027-2028.' })
    }
    const [a, b] = propose.split('-').map(Number)
    if (b !== a + 1) {
      await conn.rollback()
      return res.status(400).json({ erreur: 'La seconde année doit suivre immédiatement la première, par exemple 2027-2028.' })
    }
    const [dejaExiste] = await conn.query('SELECT 1 FROM annees_scolaires WHERE libelle = ?', [propose])
    if (dejaExiste.length > 0) {
      await conn.rollback()
      return res.status(409).json({ erreur: `L'année ${propose} existe déjà.` })
    }
    const nouveau = propose
    await conn.query(
      `INSERT INTO arrieres (identifiant_utrax, ecole_id, eleve_id, nom_eleve, classe, annee_id, montant_fcfa, cree_le)
       SELECT e.identifiant_utrax, e.ecole_id, e.id, e.nom, c.nom, ?,
              (c.frais_fcfa - COALESCE(SUM(p.montant_fcfa), 0)) AS reste, CURDATE()
       FROM eleves e
       JOIN classes c ON c.id = e.classe_id
       LEFT JOIN paiements p ON p.eleve_id = e.id AND p.annee_id = ? AND p.annule = FALSE
       WHERE e.actif = TRUE
         AND NOT EXISTS (SELECT 1 FROM arrieres a WHERE a.annee_id = ? AND a.identifiant_utrax = e.identifiant_utrax AND a.ecole_id = e.ecole_id)
       GROUP BY e.id, e.identifiant_utrax, e.ecole_id, e.nom, c.nom, c.frais_fcfa
       HAVING reste > 0`,
      [active.id, active.id, active.id]
    )
    await conn.query('UPDATE annees_scolaires SET active = FALSE, cloturee_le = CURDATE() WHERE id = ?', [active.id])
    await conn.query('INSERT INTO annees_scolaires (libelle, active, ouverte_le) VALUES (?, TRUE, CURDATE())', [nouveau])
    const [[bilan]] = await conn.query(
      'SELECT COUNT(*) AS n, COALESCE(SUM(montant_fcfa), 0) AS total FROM arrieres WHERE annee_id = ?', [active.id]
    )
    await conn.commit()
    res.status(201).json({ ancienne: active.libelle, nouvelle: nouveau, arrieresCrees: Number(bilan.n), montantArrieres: Number(bilan.total) })
  } catch (err) {
    await conn.rollback().catch(() => {})
    console.error(err)
    res.status(500).json({ erreur: "Échec de l'ouverture de l'année." })
  } finally {
    conn.release()
  }
})

export default router
