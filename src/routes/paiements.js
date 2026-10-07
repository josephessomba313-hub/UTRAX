import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { pool } from '../db.js'
import { verifierEcole } from '../middleware/auth-ecole.js'
import { verifierAdmin } from '../middleware/auth-admin.js'
import { anneeActive } from '../annee.js'

const router = Router()

function genererReference() {
  return `UTX-${Math.floor(1000 + Math.random() * 9000)}`
}

// UTRAX — derniers paiements de toutes les écoles (supervision, lecture seule).
router.get('/recents', verifierAdmin, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT p.reference, p.montant_fcfa AS montant, p.mode, p.origine, p.date_paiement AS date, p.created_at AS dateHeure,
            p.annule, p.motif_annulation AS motifAnnulation, ag.nom AS agenceBancaire,
            e.nom AS eleve, ec.nom AS ecole
     FROM paiements p
     JOIN eleves e ON e.id = p.eleve_id
     JOIN ecoles ec ON ec.id = e.ecole_id
     LEFT JOIN agences_bancaires ag ON ag.id = p.agence_bancaire_id
     ORDER BY p.created_at DESC LIMIT 15`
  )
  res.json(rows)
})

// CÔTÉ ÉCOLE — paiement effectué par le parent à l'agence bancaire de l'établissement
// (les frais de scolarité ne passent plus par Mobile Money). L'agence enregistrée est celle
// de l'école au moment du paiement, pour garder une trace même si l'école en change plus tard.
router.post('/ecole', verifierEcole, async (req, res) => {
  const { eleveId, montant, codeAgence } = req.body
  if (!eleveId || !montant || !codeAgence) return res.status(400).json({ erreur: 'eleveId, montant et codeAgence requis.' })
  const montantNum = Number(montant)
  if (!Number.isFinite(montantNum) || montantNum <= 0) return res.status(400).json({ erreur: 'Montant invalide.' })

  const annee = await anneeActive()
  const [eleves] = await pool.query(
    `SELECT e.id, ec.agence_bancaire_id, ag.code_hash, c.frais_fcfa AS frais,
            COALESCE((SELECT SUM(p.montant_fcfa) FROM paiements p
                      WHERE p.eleve_id = e.id AND p.annee_id = ? AND p.annule = FALSE), 0) AS dejaPaye
     FROM eleves e
     JOIN ecoles ec ON ec.id = e.ecole_id
     JOIN agences_bancaires ag ON ag.id = ec.agence_bancaire_id
     JOIN classes c ON c.id = e.classe_id
     WHERE e.id = ? AND e.ecole_id = ?`,
    [annee.id, eleveId, req.ecoleId]
  )
  if (eleves.length === 0) return res.status(404).json({ erreur: 'Élève introuvable dans cet établissement.' })
  const { code_hash: codeHash, frais, dejaPaye } = eleves[0]
  if (!codeHash) return res.status(409).json({ erreur: "L'agence bancaire de votre établissement n'a pas encore de code de confirmation défini — contactez UTRAX." })
  const codeValide = await bcrypt.compare(String(codeAgence).trim(), codeHash)
  if (!codeValide) return res.status(401).json({ erreur: "Code de l'agence incorrect." })

  const restant = Number(frais) - Number(dejaPaye)
  if (montantNum > restant) {
    return res.status(400).json({
      erreur: `Ce paiement (${montantNum.toLocaleString('fr-FR')} FCFA) dépasse le reste dû pour cet élève (${restant.toLocaleString('fr-FR')} FCFA sur des frais annuels de ${Number(frais).toLocaleString('fr-FR')} FCFA). Vérifiez le montant saisi.`,
    })
  }

  const reference = genererReference()
  await pool.query(
    `INSERT INTO paiements (eleve_id, annee_id, reference, montant_fcfa, agence_bancaire_id, origine, date_paiement)
     VALUES (?, ?, ?, ?, ?, 'ecole', CURDATE())`,
    [eleveId, annee.id, reference, montantNum, eleves[0].agence_bancaire_id]
  )
  res.status(201).json({ reference })
})

// L'ancienne route de paiement Mobile Money côté parent n'existe plus : les frais de scolarité
// se règlent désormais uniquement à l'agence bancaire de l'établissement. Ce point de terminaison
// est conservé pour répondre clairement si un ancien client l'appelle encore par erreur.
router.post('/parent', (req, res) => {
  res.status(410).json({ erreur: "Le paiement en ligne n'est plus disponible : les frais de scolarité se règlent à l'agence bancaire de l'établissement." })
})

// CÔTÉ ÉCOLE — annuler un paiement mal saisi (montant ou mode erroné, doublon, etc.).
// Le paiement n'est pas supprimé mais marqué annulé, avec un motif obligatoire : il n'est plus compté
// dans les soldes, mais reste visible dans l'historique pour la traçabilité.
// ⚠️ Ceci ne défait pas un virement déjà généré vers l'école : si le montant a déjà été inclus dans
// un règlement, contactez UTRAX pour un ajustement manuel du prochain virement.
router.patch('/:id/annuler', verifierEcole, async (req, res) => {
  const motif = String(req.body.motif || '').trim()
  const codeAgence = String(req.body.codeAgence || '').trim()
  if (!motif) return res.status(400).json({ erreur: 'Un motif est requis pour annuler un paiement.' })
  if (!codeAgence) return res.status(400).json({ erreur: "Le code de l'agence est requis pour annuler un paiement." })

  const [ecoles] = await pool.query(
    'SELECT ag.code_hash FROM ecoles ec JOIN agences_bancaires ag ON ag.id = ec.agence_bancaire_id WHERE ec.id = ?',
    [req.ecoleId]
  )
  const codeHash = ecoles[0]?.code_hash
  if (!codeHash) return res.status(409).json({ erreur: "L'agence bancaire de votre établissement n'a pas encore de code de confirmation défini — contactez UTRAX." })
  const codeValide = await bcrypt.compare(codeAgence, codeHash)
  if (!codeValide) return res.status(401).json({ erreur: "Code de l'agence incorrect." })

  const [result] = await pool.query(
    `UPDATE paiements p JOIN eleves e ON e.id = p.eleve_id
     SET p.annule = TRUE, p.motif_annulation = ?, p.annule_le = CURDATE()
     WHERE p.id = ? AND e.ecole_id = ? AND p.annule = FALSE`,
    [motif.slice(0, 255), req.params.id, req.ecoleId]
  )
  if (result.affectedRows === 0) return res.status(404).json({ erreur: 'Paiement introuvable dans cet établissement, ou déjà annulé.' })
  res.json({ ok: true })
})

// CÔTÉ ÉCOLE — tous les paiements de l'établissement connecté (section « Reçus »).
// Par défaut, seule l'année scolaire en cours est renvoyée (voir /eleves/:id/paiements).
router.get('/ecole', verifierEcole, async (req, res) => {
  const toutesAnnees = req.query.toutesAnnees === '1'
  const annee = await anneeActive()
  const [rows] = await pool.query(
    `SELECT p.id, p.reference, p.montant_fcfa AS montant, p.mode, p.date_paiement AS date, p.created_at AS dateHeure,
            p.annule, p.motif_annulation AS motifAnnulation, ag.nom AS agenceBancaire, an.libelle AS annee,
            e.id AS eleveId, e.nom AS eleve, e.matricule
     FROM paiements p
     JOIN eleves e ON e.id = p.eleve_id
     LEFT JOIN agences_bancaires ag ON ag.id = p.agence_bancaire_id
     JOIN annees_scolaires an ON an.id = p.annee_id
     WHERE e.ecole_id = ? ${toutesAnnees ? '' : 'AND p.annee_id = ?'}
     ORDER BY p.created_at DESC LIMIT 100`,
    toutesAnnees ? [req.ecoleId] : [req.ecoleId, annee.id]
  )
  res.json(rows)
})

export default router
