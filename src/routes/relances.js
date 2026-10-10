import { Router } from 'express'
import { pool } from '../db.js'
import { verifierEcole } from '../middleware/auth-ecole.js'
import { anneeActive } from '../annee.js'
import { verifierFiche } from '../middleware/auth-fiche.js'

const router = Router()

function genererMessage(ecoleNom, ecoleCode, agenceNom, eleve) {
  const solde = Math.max(eleve.frais - eleve.montant_paye, 0)
  const prenom = eleve.nom.split(' ')[0]
  return `${ecoleNom} : Bonjour, la scolarité de ${prenom} (${eleve.classe}) présente un solde impayé de `
    + `${solde.toLocaleString('fr-FR')} FCFA. Merci de le régler à l'agence bancaire ${agenceNom} de l'établissement `
    + `(École : ${ecoleCode}, Matricule : ${eleve.matricule}).`
}

const INFOS_ECOLE = `SELECT ec.nom, ec.code, ag.nom AS agence
  FROM ecoles ec JOIN agences_bancaires ag ON ag.id = ec.agence_bancaire_id WHERE ec.id = ?`

async function chargerEleveAvecSolde(eleveId, ecoleId) {
  const annee = await anneeActive()
  const [rows] = await pool.query(
    `SELECT e.id, e.nom, e.matricule, e.telephone_parent, c.nom AS classe, c.frais_fcfa AS frais,
            COALESCE(SUM(p.montant_fcfa), 0) AS montant_paye
     FROM eleves e
     JOIN classes c ON c.id = e.classe_id
     LEFT JOIN paiements p ON p.eleve_id = e.id AND p.annee_id = ? AND p.annule = FALSE
     WHERE e.id = ? AND e.ecole_id = ?
     GROUP BY e.id, e.nom, e.matricule, e.telephone_parent, c.nom, c.frais_fcfa`,
    [annee.id, eleveId, ecoleId]
  )
  return rows[0] || null
}

// Relancer un élève précis
router.post('/:eleveId', verifierEcole, async (req, res) => {
  const [[ecole]] = await pool.query(INFOS_ECOLE, [req.ecoleId])
  const eleve = await chargerEleveAvecSolde(req.params.eleveId, req.ecoleId)
  if (!eleve) return res.status(404).json({ erreur: 'Élève introuvable dans cet établissement.' })

  const message = genererMessage(ecole.nom, ecole.code, ecole.agence, eleve)
  await pool.query(
    'INSERT INTO relances (eleve_id, canal, message, date_envoi) VALUES (?, "SMS", ?, CURDATE())',
    [eleve.id, message]
  )
  res.status(201).json({ message, telephone: eleve.telephone_parent || null })
})

// Relancer tous les élèves en retard de l'école connectée
router.post('/', verifierEcole, async (req, res) => {
  const annee = await anneeActive()
  const [[ecole]] = await pool.query(INFOS_ECOLE, [req.ecoleId])
  const [eleves] = await pool.query(
    `SELECT e.id, e.nom, e.matricule, c.nom AS classe, c.frais_fcfa AS frais,
            COALESCE(SUM(p.montant_fcfa), 0) AS montant_paye
     FROM eleves e
     JOIN classes c ON c.id = e.classe_id
     LEFT JOIN paiements p ON p.eleve_id = e.id AND p.annee_id = ? AND p.annule = FALSE
     WHERE e.ecole_id = ? AND e.actif = TRUE
     GROUP BY e.id, e.nom, e.matricule, c.nom, c.frais_fcfa`,
    [annee.id, req.ecoleId]
  )
  const enRetard = eleves.filter((e) => e.frais - e.montant_paye > 0)
  for (const eleve of enRetard) {
    const message = genererMessage(ecole.nom, ecole.code, ecole.agence, eleve)
    await pool.query('INSERT INTO relances (eleve_id, canal, message, date_envoi) VALUES (?, "SMS", ?, CURDATE())', [eleve.id, message])
  }
  res.json({ nombre: enRetard.length })
})

// Historique des relances d'un élève — côté école
router.get('/eleve/:eleveId', verifierEcole, async (req, res) => {
  const [propres] = await pool.query('SELECT 1 FROM eleves WHERE id = ? AND ecole_id = ?', [req.params.eleveId, req.ecoleId])
  if (propres.length === 0) return res.status(404).json({ erreur: 'Élève introuvable dans cet établissement.' })
  const [relances] = await pool.query(
    'SELECT canal, message, date_envoi AS date FROM relances WHERE eleve_id = ? ORDER BY date_envoi DESC',
    [req.params.eleveId]
  )
  res.json(relances)
})

// CÔTÉ PARENT — mêmes relances, en lecture seule. Exige le jeton remis avec la fiche de cet élève
// (obtenue avec le code établissement, la classe et le matricule) : le numéro interne ne suffit plus.
router.get('/eleve/:eleveId/public', verifierFiche, async (req, res) => {
  const [relances] = await pool.query(
    'SELECT canal, message, date_envoi AS date FROM relances WHERE eleve_id = ? ORDER BY date_envoi DESC',
    [req.params.eleveId]
  )
  res.json(relances)
})

export default router
