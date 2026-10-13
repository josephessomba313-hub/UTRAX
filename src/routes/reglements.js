import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { pool } from '../db.js'
import { verifierAdmin } from '../middleware/auth-admin.js'
import { verifierEcole } from '../middleware/auth-ecole.js'
import { limiteEssais } from '../middleware/limite-essais.js'
import { anneeActive } from '../annee.js'
import { insererAvecReference } from '../reference.js'

// ⚠️ LUTRAXE ne détient jamais les fonds des écoles — c'est la banque dépositaire qui encaisse
// les versements faits aux agences et exécute les virements aux écoles. Ces routes calculent
// QUOI virer et À QUI (commission prélevée automatiquement, reste net à l'école) ; elles
// produisent l'instruction que la banque exécute — le logiciel n'effectue aucun mouvement
// d'argent réel.
//
// Un paiement est « en attente » tant que paiements.reglement_id est vide (et qu'il n'est pas
// annulé). Générer un virement marque exactement les paiements qu'il règle.

const router = Router()

// Montant en attente de règlement, école par école — LUTRAXE uniquement.
router.get('/en-attente', verifierAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ec.id, ec.nom, COALESCE(SUM(p.montant_fcfa), 0) AS en_attente
       FROM ecoles ec
       LEFT JOIN eleves e ON e.ecole_id = ec.id
       LEFT JOIN paiements p ON p.eleve_id = e.id AND p.annule = FALSE AND p.reglement_id IS NULL
       GROUP BY ec.id, ec.nom
       ORDER BY ec.nom`
    )
    res.json(rows.map((r) => ({ ecoleId: r.id, nom: r.nom, enAttente: Number(r.en_attente) })))
  } catch (err) {
    console.error(err)
    res.status(500).json({ erreur: 'Échec du calcul des montants en attente.' })
  }
})

// Générer le virement d'une école — prélève automatiquement la commission LUTRAXE due.
// Tout se passe dans une transaction qui verrouille l'école et les paiements concernés : deux
// appels simultanés ne peuvent plus virer deux fois la même somme.
router.post('/:ecoleId/generer', verifierAdmin, async (req, res) => {
  const ecoleId = Number(req.params.ecoleId)
  if (!Number.isInteger(ecoleId) || ecoleId <= 0) return res.status(400).json({ erreur: 'Identifiant établissement invalide.' })

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    // Verrou partagé sur l'année active : on ne génère pas un virement pendant que l'année s'ouvre.
    const [annees] = await conn.query('SELECT id FROM annees_scolaires WHERE active = TRUE LIMIT 1 FOR SHARE')
    if (annees.length === 0) {
      await conn.rollback()
      return res.status(500).json({ erreur: 'Aucune année scolaire active.' })
    }
    const anneeId = Number(annees[0].id)

    const [[ecole]] = await conn.query('SELECT id, commission_fcfa FROM ecoles WHERE id = ? FOR UPDATE', [ecoleId])
    if (!ecole) {
      await conn.rollback()
      return res.status(404).json({ erreur: 'Établissement introuvable.' })
    }

    const [[{ nb_actifs }]] = await conn.query(
      'SELECT COUNT(*) AS nb_actifs FROM eleves WHERE ecole_id = ? AND actif = TRUE', [ecoleId]
    )
    // Les paiements à régler : non annulés, pas encore rattachés à un virement. Verrouillés ici,
    // et marqués plus bas par leur identifiant exact (pas par une condition qui pourrait en attraper d'autres).
    const [aRegler] = await conn.query(
      `SELECT p.id, p.montant_fcfa
       FROM paiements p JOIN eleves e ON e.id = p.eleve_id
       WHERE e.ecole_id = ? AND p.annule = FALSE AND p.reglement_id IS NULL
       FOR UPDATE OF p`,
      [ecoleId]
    )
    const enAttente = aRegler.reduce((t, p) => t + Number(p.montant_fcfa), 0)
    if (enAttente <= 0) {
      await conn.rollback()
      return res.status(400).json({ erreur: 'Rien à régler pour cet établissement.' })
    }

    const [[{ deja_prelevee }]] = await conn.query(
      'SELECT COALESCE(SUM(commission_fcfa), 0) AS deja_prelevee FROM reglements WHERE ecole_id = ? AND annee_id = ?',
      [ecoleId, anneeId]
    )
    const commissionAnnuelleDue = Number(nb_actifs) * Number(ecole.commission_fcfa)
    const commission = Math.max(0, Math.min(enAttente, commissionAnnuelleDue - Number(deja_prelevee)))
    const montantNet = enAttente - commission

    const { reference, resultat } = await insererAvecReference('VIR', (ref) =>
      conn.query(
        `INSERT INTO reglements (ecole_id, annee_id, reference, montant_collecte_fcfa, commission_fcfa, montant_net_fcfa, date_reglement)
         VALUES (?, ?, ?, ?, ?, ?, CURDATE())`,
        [ecoleId, anneeId, ref, enAttente, commission, montantNet]
      )
    )
    const reglementId = resultat[0].insertId
    await conn.query('UPDATE paiements SET reglement_id = ? WHERE id IN (?)', [reglementId, aRegler.map((p) => p.id)])

    await conn.commit()
    res.status(201).json({ reference, montantCollecte: enAttente, commission, montantNet })
  } catch (err) {
    await conn.rollback().catch(() => {})
    console.error(err)
    res.status(500).json({ erreur: 'Échec de la génération du virement.' })
  } finally {
    conn.release()
  }
})

// Historique de tous les règlements — LUTRAXE uniquement.
// Par défaut, seule l'année scolaire en cours.
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
     ORDER BY r.date_reglement DESC, r.id DESC`,
    toutesAnnees ? [] : [annee.id]
  )
  res.json(rows)
})

// CÔTÉ ÉCOLE — historique des règlements reçus par l'établissement connecté. Réservé, même une
// fois connectée, derrière une nouvelle confirmation du mot de passe : donnée financière sensible.
// (verifierEcole passe avant le limiteur : une requête sans jeton valide ne consomme pas d'essais.)
router.post('/moi', verifierEcole, limiteEssais(), async (req, res) => {
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
     ORDER BY r.date_reglement DESC, r.id DESC`,
    toutesAnnees ? [req.ecoleId] : [req.ecoleId, annee.id]
  )
  res.json(rows)
})

export default router
