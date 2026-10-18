import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { pool } from '../db.js'
import { verifierEcole } from '../middleware/auth-ecole.js'
import { verifierAdmin } from '../middleware/auth-admin.js'
import { anneeActive } from '../annee.js'
import { insererAvecReference } from '../reference.js'
import { limiteEssais } from '../middleware/limite-essais.js'
import { limiteCalculsMotDePasse } from '../middleware/limite-simultanes.js'

// Le code de confirmation de l'agence est court : on limite les essais ratés par établissement.
const limiteCodeAgence = (nom) => limiteEssais({ max: 8, cle: (req) => `${nom}:${req.ecoleId}` })

const router = Router()

// LUTRAXE — derniers paiements de toutes les écoles (supervision, lecture seule).
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

// CÔTÉ ÉCOLE — paiement effectué par le parent à l'agence bancaire de l'établissement.
// L'agence enregistrée est celle de l'école au moment du paiement, pour garder une trace même
// si l'école en change plus tard.
// La vérification du reste dû et l'enregistrement se font dans une transaction qui verrouille
// l'élève : deux paiements simultanés ne peuvent plus dépasser ensemble les frais annuels.
router.post('/ecole', verifierEcole, limiteCalculsMotDePasse, limiteCodeAgence('paiement'), async (req, res) => {
  const { eleveId, montant, codeAgence } = req.body
  if (!eleveId || !montant || !codeAgence) return res.status(400).json({ erreur: 'eleveId, montant et codeAgence requis.' })
  const montantNum = Number(montant)
  if (!Number.isInteger(montantNum) || montantNum <= 0) {
    return res.status(400).json({ erreur: 'Montant invalide : indiquez un nombre entier de FCFA.' })
  }

  // Code de confirmation de l'agence : vérifié avant d'ouvrir la transaction (bcrypt est lent).
  const [agences] = await pool.query(
    'SELECT ec.agence_bancaire_id, ag.code_hash FROM ecoles ec JOIN agences_bancaires ag ON ag.id = ec.agence_bancaire_id WHERE ec.id = ?',
    [req.ecoleId]
  )
  if (agences.length === 0) return res.status(404).json({ erreur: 'Établissement introuvable.' })
  const { agence_bancaire_id: agenceId, code_hash: codeHash } = agences[0]
  if (!codeHash) return res.status(409).json({ erreur: "L'agence bancaire de votre établissement n'a pas encore de code de confirmation défini — contactez LUTRAXE." })
  const codeValide = await bcrypt.compare(String(codeAgence).trim(), codeHash)
  if (!codeValide) return res.status(401).json({ erreur: "Code de l'agence incorrect." })

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    // Verrou partagé sur l'année active : pas de paiement pendant que l'année s'ouvre.
    const [annees] = await conn.query('SELECT id FROM annees_scolaires WHERE active = TRUE LIMIT 1 FOR SHARE')
    if (annees.length === 0) {
      await conn.rollback()
      return res.status(500).json({ erreur: 'Aucune année scolaire active.' })
    }
    const anneeId = Number(annees[0].id)

    const [eleves] = await conn.query(
      `SELECT e.id, e.actif, c.frais_fcfa AS frais
       FROM eleves e JOIN classes c ON c.id = e.classe_id
       WHERE e.id = ? AND e.ecole_id = ?
       FOR UPDATE OF e`,
      [eleveId, req.ecoleId]
    )
    if (eleves.length === 0) {
      await conn.rollback()
      return res.status(404).json({ erreur: 'Élève introuvable dans cet établissement.' })
    }
    if (!eleves[0].actif) {
      await conn.rollback()
      return res.status(409).json({ erreur: "Cet élève est archivé : son impayé a été enregistré comme arriéré, à régler directement auprès de l'établissement. Réintégrez-le d'abord si l'archivage était une erreur." })
    }
    const [[{ deja_paye }]] = await conn.query(
      'SELECT COALESCE(SUM(montant_fcfa), 0) AS deja_paye FROM paiements WHERE eleve_id = ? AND annee_id = ? AND annule = FALSE',
      [eleveId, anneeId]
    )
    const frais = Number(eleves[0].frais)
    const restant = frais - Number(deja_paye)
    if (montantNum > restant) {
      await conn.rollback()
      return res.status(400).json({
        erreur: `Ce paiement (${montantNum.toLocaleString('fr-FR')} FCFA) dépasse le reste dû pour cet élève (${restant.toLocaleString('fr-FR')} FCFA sur des frais annuels de ${frais.toLocaleString('fr-FR')} FCFA). Vérifiez le montant saisi.`,
      })
    }

    const { reference } = await insererAvecReference('LTX', (ref) =>
      conn.query(
        `INSERT INTO paiements (eleve_id, annee_id, reference, montant_fcfa, agence_bancaire_id, origine, date_paiement)
         VALUES (?, ?, ?, ?, ?, 'ecole', CURDATE())`,
        [eleveId, anneeId, ref, montantNum, agenceId]
      )
    )
    await conn.commit()
    res.status(201).json({ reference })
  } catch (err) {
    await conn.rollback().catch(() => {})
    console.error(err)
    res.status(500).json({ erreur: "Échec de l'enregistrement du paiement." })
  } finally {
    conn.release()
  }
})

// L'ancienne route de paiement Mobile Money côté parent n'existe plus : les frais de scolarité
// se règlent désormais uniquement à l'agence bancaire de l'établissement. Ce point de terminaison
// est conservé pour répondre clairement si un ancien client l'appelle encore par erreur.
router.post('/parent', (req, res) => {
  res.status(410).json({ erreur: "Le paiement en ligne n'est plus disponible : les frais de scolarité se règlent à l'agence bancaire de l'établissement." })
})

// CÔTÉ ÉCOLE — annuler un paiement mal saisi (montant erroné, doublon, etc.).
// Le paiement n'est pas supprimé mais marqué annulé, avec un motif obligatoire : il n'est plus
// compté dans les soldes, mais reste visible dans l'historique pour la traçabilité.
// Un paiement déjà inclus dans un virement vers l'école ne peut plus être annulé ici : l'ajustement
// du prochain virement passe par LUTRAXE.
router.patch('/:id/annuler', verifierEcole, limiteCalculsMotDePasse, limiteCodeAgence('annulation'), async (req, res) => {
  const motif = String(req.body.motif || '').trim()
  const codeAgence = String(req.body.codeAgence || '').trim()
  if (!motif) return res.status(400).json({ erreur: 'Un motif est requis pour annuler un paiement.' })
  if (!codeAgence) return res.status(400).json({ erreur: "Le code de l'agence est requis pour annuler un paiement." })

  const [ecoles] = await pool.query(
    'SELECT ag.code_hash FROM ecoles ec JOIN agences_bancaires ag ON ag.id = ec.agence_bancaire_id WHERE ec.id = ?',
    [req.ecoleId]
  )
  const codeHash = ecoles[0]?.code_hash
  if (!codeHash) return res.status(409).json({ erreur: "L'agence bancaire de votre établissement n'a pas encore de code de confirmation défini — contactez LUTRAXE." })
  const codeValide = await bcrypt.compare(codeAgence, codeHash)
  if (!codeValide) return res.status(401).json({ erreur: "Code de l'agence incorrect." })

  const [result] = await pool.query(
    `UPDATE paiements p JOIN eleves e ON e.id = p.eleve_id
     SET p.annule = TRUE, p.motif_annulation = ?, p.annule_le = CURDATE()
     WHERE p.id = ? AND e.ecole_id = ? AND p.annule = FALSE AND p.reglement_id IS NULL`,
    [motif.slice(0, 255), req.params.id, req.ecoleId]
  )
  if (result.affectedRows === 0) {
    const [[paiement]] = await pool.query(
      'SELECT p.annule, p.reglement_id FROM paiements p JOIN eleves e ON e.id = p.eleve_id WHERE p.id = ? AND e.ecole_id = ?',
      [req.params.id, req.ecoleId]
    )
    if (paiement && !paiement.annule && paiement.reglement_id) {
      return res.status(409).json({ erreur: 'Ce paiement a déjà été inclus dans un virement vers votre établissement : il ne peut plus être annulé ici. Contactez LUTRAXE pour un ajustement.' })
    }
    return res.status(404).json({ erreur: 'Paiement introuvable dans cet établissement, ou déjà annulé.' })
  }
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
