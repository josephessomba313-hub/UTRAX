import { Router } from 'express'
import { pool } from '../db.js'
import { verifierAdmin } from '../middleware/auth-admin.js'

const router = Router()

// "2026-2027" -> "2027-2028"
function libelleSuivant(libelle) {
  const [a, b] = libelle.split('-').map(Number)
  return `${a + 1}-${b + 1}`
}

// Année active et historique des années — UTRAX uniquement.
router.get('/', verifierAdmin, async (req, res) => {
  const [annees] = await pool.query(
    'SELECT id, libelle, active, ouverte_le, cloturee_le FROM annees_scolaires ORDER BY id DESC'
  )
  const active = annees.find((a) => a.active) || null
  res.json({ active, prochaine: active ? libelleSuivant(active.libelle) : null, annees })
})

// Ouvrir la nouvelle année — UTRAX uniquement.
//  1. refuse s'il reste des paiements non réglés aux écoles (commission de l'année à prélever d'abord) ;
//  2. enregistre en arriérés le solde impayé de chaque élève actif, rattaché à son identifiant UTRAX
//     et à l'école créancière (avec les frais de l'année qui se termine) ;
//  3. clôture l'année en cours et ouvre la suivante.
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

    const [ecoles] = await conn.query(
      `SELECT ec.id, ec.nom,
              COALESCE((SELECT SUM(p.montant_fcfa) FROM paiements p JOIN eleves e ON e.id = p.eleve_id WHERE e.ecole_id = ec.id), 0)
            - COALESCE((SELECT SUM(r.montant_collecte_fcfa) FROM reglements r WHERE r.ecole_id = ec.id), 0) AS en_attente
       FROM ecoles ec`
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
       LEFT JOIN paiements p ON p.eleve_id = e.id AND p.annee_id = ?
       WHERE e.actif = TRUE
       GROUP BY e.id, e.identifiant_utrax, e.ecole_id, e.nom, c.nom, c.frais_fcfa
       HAVING reste > 0`,
      [active.id, active.id]
    )
    await conn.query('UPDATE annees_scolaires SET active = FALSE, cloturee_le = CURDATE() WHERE id = ?', [active.id])
    await conn.query('INSERT INTO annees_scolaires (libelle, active, ouverte_le) VALUES (?, TRUE, CURDATE())', [nouveau])
    const [[bilan]] = await conn.query(
      'SELECT COUNT(*) AS n, COALESCE(SUM(montant_fcfa), 0) AS total FROM arrieres WHERE annee_id = ?', [active.id]
    )
    await conn.commit()
    res.status(201).json({ ancienne: active.libelle, nouvelle: nouveau, arrieresCrees: Number(bilan.n), montantArrieres: Number(bilan.total) })
  } catch (err) {
    await conn.rollback()
    res.status(500).json({ erreur: "Échec de l'ouverture de l'année.", details: err.message })
  } finally {
    conn.release()
  }
})

export default router
