import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { pool } from '../db.js'
import { verifierAdmin } from '../middleware/auth-admin.js'
import { verifierEcole } from '../middleware/auth-ecole.js'
import { limiteEssais } from '../middleware/limite-essais.js'
import { anneeActive } from '../annee.js'

// ⚠️ UTRAX ne détient jamais les fonds des écoles — c'est la banque dépositaire
// qui encaisse les paiements Mobile Money et exécute les virements aux écoles.
// Ces routes calculent QUOI virer et À QUI (le principe reste le même : commission
// prélevée automatiquement, reste net à l'école) ; elles produisent l'instruction
// que la banque exécute — le logiciel n'effectue aucun mouvement d'argent réel.

const router = Router()

// Montant en attente de règlement, école par école — UTRAX uniquement.
router.get('/en-attente', verifierAdmin, async (req, res) => {
  const [ecoles] = await pool.query('SELECT id, nom FROM ecoles')
  const resultat = []
  for (const ecole of ecoles) {
    const [[{ total_collecte }]] = await pool.query(
      `SELECT COALESCE(SUM(p.montant_fcfa), 0) AS total_collecte
       FROM paiements p JOIN eleves e ON e.id = p.eleve_id
       WHERE e.ecole_id = ?`,
      [ecole.id]
    )
    const [[{ deja_collecte }]] = await pool.query(
      'SELECT COALESCE(SUM(montant_collecte_fcfa), 0) AS deja_collecte FROM reglements WHERE ecole_id = ?',
      [ecole.id]
    )
    resultat.push({ ecoleId: ecole.id, nom: ecole.nom, enAttente: total_collecte - deja_collecte })
  }
  res.json(resultat)
})

// Générer le virement d'une école — prélève automatiquement la commission UTRAX due.
router.post('/:ecoleId/generer', verifierAdmin, async (req, res) => {
  const ecoleId = req.params.ecoleId
  const annee = await anneeActive()
  const [[ecole]] = await pool.query('SELECT * FROM ecoles WHERE id = ?', [ecoleId])
  if (!ecole) return res.status(404).json({ erreur: 'Établissement introuvable.' })

  const [[{ nb_actifs }]] = await pool.query(
    'SELECT COUNT(*) AS nb_actifs FROM eleves WHERE ecole_id = ? AND actif = TRUE', [ecoleId]
  )
  const [[{ total_collecte }]] = await pool.query(
    `SELECT COALESCE(SUM(p.montant_fcfa), 0) AS total_collecte
     FROM paiements p JOIN eleves e ON e.id = p.eleve_id WHERE e.ecole_id = ?`,
    [ecoleId]
  )
  const [[{ deja_collecte }]] = await pool.query(
    'SELECT COALESCE(SUM(montant_collecte_fcfa), 0) AS deja_collecte FROM reglements WHERE ecole_id = ?', [ecoleId]
  )
  const [[{ commission_deja_prelevee }]] = await pool.query(
    'SELECT COALESCE(SUM(commission_fcfa), 0) AS commission_deja_prelevee FROM reglements WHERE ecole_id = ? AND annee_id = ?', [ecoleId, annee.id]
  )

  const enAttente = total_collecte - deja_collecte
  if (enAttente <= 0) return res.status(400).json({ erreur: 'Rien à régler pour cet établissement.' })

  const commissionAnnuelleDue = nb_actifs * ecole.commission_fcfa
  const commission = Math.max(0, Math.min(enAttente, commissionAnnuelleDue - commission_deja_prelevee))
  const montantNet = enAttente - commission
  const reference = `VIR-${Math.floor(1000 + Math.random() * 9000)}`

  await pool.query(
    `INSERT INTO reglements (ecole_id, annee_id, reference, montant_collecte_fcfa, commission_fcfa, montant_net_fcfa, date_reglement)
     VALUES (?, ?, ?, ?, ?, ?, CURDATE())`,
    [ecoleId, annee.id, reference, enAttente, commission, montantNet]
  )
  res.status(201).json({ reference, montantCollecte: enAttente, commission, montantNet })
})

// Historique de tous les règlements — UTRAX uniquement.
// Par défaut, seule l'année scolaire en cours — voir /eleves/:id/paiements pour le même principe.
router.get('/', verifierAdmin, async (req, res) => {
  const toutesAnnees = req.query.toutesAnnees === '1'
  const annee = await anneeActive()
  const [rows] = await pool.query(
    `SELECT r.id, r.reference, r.montant_collecte_fcfa AS montantCollecte, r.commission_fcfa AS commission,
            r.montant_net_fcfa AS montantNet, r.date_reglement AS date, an.libelle AS annee, ec.nom AS ecole
     FROM reglements r
     JOIN ecoles ec ON ec.id = r.ecole_id
     JOIN annees_scolaires an ON an.id = r.annee_id
     ${toutesAnnees ? '' : 'WHERE r.annee_id = ?'}
     ORDER BY r.date_reglement DESC`,
    toutesAnnees ? [] : [annee.id]
  )
  res.json(rows)
})


// CÔTÉ ÉCOLE — historique des règlements reçus par l'établissement connecté. Réservé, même une
// fois connectée, derrière une nouvelle confirmation du mot de passe : c'est une donnée financière
// sensible (montants réellement virés par UTRAX), qu'on ne veut pas laisser accessible en
// permanence si l'écran reste ouvert sans surveillance.
router.post('/moi', limiteEssais(), verifierEcole, async (req, res) => {
  const motDePasse = String(req.body.motDePasse || '')
  const toutesAnnees = req.body.toutesAnnees === true
  const [[ecole]] = await pool.query('SELECT mot_de_passe_hash FROM ecoles WHERE id = ?', [req.ecoleId])
  if (!ecole) return res.status(404).json({ erreur: 'Établissement introuvable.' })
  const valide = await bcrypt.compare(motDePasse, ecole.mot_de_passe_hash)
  if (!valide) return res.status(401).json({ erreur: 'Mot de passe incorrect.' })
  const annee = await anneeActive()
  const [rows] = await pool.query(
    `SELECT r.reference, r.montant_collecte_fcfa AS montantCollecte, r.commission_fcfa AS commission,
            r.montant_net_fcfa AS montantNet, r.date_reglement AS date, an.libelle AS annee
     FROM reglements r JOIN annees_scolaires an ON an.id = r.annee_id
     WHERE r.ecole_id = ? ${toutesAnnees ? '' : 'AND r.annee_id = ?'}
     ORDER BY r.date_reglement DESC`,
    toutesAnnees ? [req.ecoleId] : [req.ecoleId, annee.id]
  )
  res.json(rows)
})

export default router
