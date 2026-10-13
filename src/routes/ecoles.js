import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { pool } from '../db.js'
import { randomInt } from 'node:crypto'
import { verifierAdmin } from '../middleware/auth-admin.js'
import { verifierEcole } from '../middleware/auth-ecole.js'
import { limiteEssais } from '../middleware/limite-essais.js'
import { anneeActive } from '../annee.js'

const router = Router()

// Commission LUTRAXE par élève actif et par an, appliquée à chaque NOUVEL établissement.
// Modifiable sans toucher au code : variable COMMISSION_PAR_ELEVE_FCFA sur Railway. Les établissements
// déjà créés gardent leur propre valeur (modifiable depuis leur fiche, côté LUTRAXE).
const COMMISSION_DEFAUT_FCFA = Number.isInteger(Number(process.env.COMMISSION_PAR_ELEVE_FCFA)) && Number(process.env.COMMISSION_PAR_ELEVE_FCFA) >= 0 && process.env.COMMISSION_PAR_ELEVE_FCFA
  ? Number(process.env.COMMISSION_PAR_ELEVE_FCFA)
  : 1999

// Liste des écoles — supervision LUTRAXE
router.get('/', verifierAdmin, async (req, res) => {
  const [ecoles] = await pool.query(
    `SELECT ec.id, ec.nom, ec.ville, ec.code, ec.actif, ec.commission_fcfa, ec.created_at,
            ag.nom AS agenceBancaire, ag.telephone AS agenceTelephone
     FROM ecoles ec JOIN agences_bancaires ag ON ag.id = ec.agence_bancaire_id
     ORDER BY ec.nom`
  )
  res.json(ecoles)
})

// Liste des écoles actives — utilisée par l'écran "Choisissez votre établissement" côté Parent.
// Le code établissement n'est JAMAIS renvoyé ici : c'est un secret que seule l'école communique aux parents.
router.get('/actives', async (req, res) => {
  const [ecoles] = await pool.query('SELECT id, nom, ville FROM ecoles WHERE actif = TRUE ORDER BY nom')
  res.json(ecoles)
})

// Vérification du code établissement saisi par un parent. Le code est comparé côté serveur ;
// les échecs répétés sont limités par adresse IP (voir middleware/limite-essais.js).
router.post('/:id/verifier-code', limiteEssais(), async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase()
  if (!code) return res.status(400).json({ erreur: 'Code établissement requis.' })
  const [rows] = await pool.query('SELECT id FROM ecoles WHERE id = ? AND code = ? AND actif = TRUE', [req.params.id, code])
  if (rows.length === 0) return res.status(401).json({ erreur: 'Code établissement incorrect. Vérifiez auprès de l\'école.' })
  res.json({ ok: true })
})

// Classes d'un établissement (utilisées côté Parent pour la sélection de classe)
router.get('/:id/classes', async (req, res) => {
  const [classes] = await pool.query(
    'SELECT id, nom, ordre, frais_fcfa FROM classes WHERE ecole_id = ? ORDER BY ordre',
    [req.params.id]
  )
  res.json(classes)
})

// Créer un établissement — LUTRAXE uniquement.
// Body attendu : { nom, ville, code, motDePasse, classes: [{ nom, ordre, frais }] }
router.post('/', verifierAdmin, async (req, res) => {
  const { nom, ville, code, motDePasse, classes, agenceBancaireId } = req.body
  if (!nom || !ville || !code || !motDePasse || !agenceBancaireId || !Array.isArray(classes) || classes.length === 0) {
    return res.status(400).json({ erreur: 'Champs requis : nom, ville, code, motDePasse, agenceBancaireId, classes[].' })
  }
  const [agence] = await pool.query('SELECT 1 FROM agences_bancaires WHERE id = ?', [agenceBancaireId])
  if (agence.length === 0) return res.status(400).json({ erreur: 'Agence bancaire inconnue.' })
  // Une classe en double dans la liste envoyée provoquerait une erreur peu claire au niveau de la
  // base de données (contrainte d'unicité) ; on le détecte avant et on dit laquelle pose problème.
  const noms = new Set()
  for (const c of classes) {
    const cle = String(c.nom || '').trim().toLowerCase()
    if (!cle) return res.status(400).json({ erreur: 'Une classe a un nom vide.' })
    if (noms.has(cle)) return res.status(400).json({ erreur: `Classe en double : « ${c.nom} » apparaît plusieurs fois.` })
    noms.add(cle)
  }

  const [codeExistant] = await pool.query('SELECT 1 FROM ecoles WHERE code = ?', [code.trim().toUpperCase()])
  if (codeExistant.length > 0) return res.status(409).json({ erreur: `Le code « ${code.trim().toUpperCase()} » est déjà utilisé par un autre établissement.` })

  const hash = await bcrypt.hash(motDePasse, 10)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [result] = await conn.query(
      'INSERT INTO ecoles (nom, ville, code, mot_de_passe_hash, agence_bancaire_id, commission_fcfa) VALUES (?, ?, ?, ?, ?, ?)',
      [nom, ville, code.trim().toUpperCase(), hash, agenceBancaireId, COMMISSION_DEFAUT_FCFA]
    )
    const ecoleId = result.insertId
    for (const c of classes) {
      await conn.query(
        'INSERT INTO classes (ecole_id, nom, ordre, frais_fcfa) VALUES (?, ?, ?, ?)',
        [ecoleId, c.nom, c.ordre, c.frais]
      )
    }
    const annee = await anneeActive(conn)
    await conn.query('INSERT INTO rentrees (ecole_id, annee_id, faite_le) VALUES (?, ?, CURDATE())', [ecoleId, annee.id])
    await conn.commit()
    res.status(201).json({ id: ecoleId, nom, ville, code: code.trim().toUpperCase() })
  } catch (err) {
    await conn.rollback()
    if (err.code === 'ER_DUP_ENTRY') {
      const message = err.sqlMessage || ''
      if (message.includes('uq_classe_par_ecole')) {
        return res.status(409).json({ erreur: 'Deux classes ont le même nom dans la liste envoyée.' })
      }
      if (message.includes("for key 'code'") || message.includes("for key 'ecoles.code'")) {
        return res.status(409).json({ erreur: `Le code « ${code.trim().toUpperCase()} » est déjà utilisé par un autre établissement.` })
      }
    }
    console.error(err)
    res.status(500).json({ erreur: 'Échec de la création.' })
  } finally {
    conn.release()
  }
})

// Retirer / réactiver un établissement — LUTRAXE uniquement.
router.patch('/:id/statut', verifierAdmin, async (req, res) => {
  const { actif } = req.body
  await pool.query('UPDATE ecoles SET actif = ? WHERE id = ?', [!!actif, req.params.id])
  res.json({ ok: true })
})

// Changer la commission LUTRAXE d'une école (FCFA par élève actif et par an) — LUTRAXE uniquement.
// Elle s'applique aux PROCHAINS virements : les virements déjà générés gardent leur commission.
router.patch('/:id/commission', verifierAdmin, async (req, res) => {
  const commission = Number(req.body.commission)
  if (!Number.isInteger(commission) || commission < 0 || commission > 1000000) {
    return res.status(400).json({ erreur: 'La commission doit être un nombre entier de FCFA, entre 0 et 1 000 000.' })
  }
  const [ecoles] = await pool.query('SELECT 1 FROM ecoles WHERE id = ?', [req.params.id])
  if (ecoles.length === 0) return res.status(404).json({ erreur: 'Établissement introuvable.' })
  await pool.query('UPDATE ecoles SET commission_fcfa = ? WHERE id = ?', [commission, req.params.id])
  res.json({ ok: true, commission })
})

// Changer l'agence bancaire d'une école — LUTRAXE uniquement. Les paiements déjà enregistrés
// gardent l'agence à laquelle ils ont réellement été faits (non rétroactif).
router.patch('/:id/agence', verifierAdmin, async (req, res) => {
  const { agenceBancaireId } = req.body
  if (!agenceBancaireId) return res.status(400).json({ erreur: 'agenceBancaireId requis.' })
  const [agences] = await pool.query('SELECT 1 FROM agences_bancaires WHERE id = ?', [agenceBancaireId])
  if (agences.length === 0) return res.status(400).json({ erreur: 'Agence bancaire inconnue.' })
  const [ecoles] = await pool.query('SELECT 1 FROM ecoles WHERE id = ?', [req.params.id])
  if (ecoles.length === 0) return res.status(404).json({ erreur: 'Établissement introuvable.' })
  await pool.query('UPDATE ecoles SET agence_bancaire_id = ? WHERE id = ?', [agenceBancaireId, req.params.id])
  res.json({ ok: true })
})

// Réinitialiser le mot de passe d'une école — LUTRAXE uniquement.
// Le mot de passe est stocké chiffré (haché) et ne peut jamais être relu en clair, même par LUTRAXE ;
// cette route en génère un nouveau, aléatoire, et le renvoie UNE SEULE FOIS pour être transmis à
// l'école. Il n'est conservé nulle part ailleurs qu'ici, dans cette réponse.
const ALPHABET_MDP = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
function genererMotDePasse(longueur = 10) {
  let s = ''
  for (let i = 0; i < longueur; i++) s += ALPHABET_MDP[randomInt(ALPHABET_MDP.length)]
  return s
}
router.post('/:id/reinitialiser-mot-de-passe', verifierAdmin, async (req, res) => {
  const [ecoles] = await pool.query('SELECT id FROM ecoles WHERE id = ?', [req.params.id])
  if (ecoles.length === 0) return res.status(404).json({ erreur: 'Établissement introuvable.' })
  const choisi = String(req.body.motDePasse || '').trim()
  if (choisi && choisi.length < 6) return res.status(400).json({ erreur: 'Le mot de passe doit contenir au moins 6 caractères.' })
  const motDePasse = choisi || genererMotDePasse()
  const hash = await bcrypt.hash(motDePasse, 10)
  await pool.query('UPDATE ecoles SET mot_de_passe_hash = ? WHERE id = ?', [hash, req.params.id])
  res.json({ motDePasse })
})

// Statistiques par établissement (élèves actifs uniquement) — LUTRAXE uniquement, lecture seule.
router.get('/stats', verifierAdmin, async (req, res) => {
  const annee = await anneeActive()
  const [lignes] = await pool.query(
    `SELECT e.ecole_id, e.actif, c.frais_fcfa AS frais, COALESCE(SUM(p.montant_fcfa), 0) AS paye
     FROM eleves e
     JOIN classes c ON c.id = e.classe_id
     LEFT JOIN paiements p ON p.eleve_id = e.id AND p.annee_id = ? AND p.annule = FALSE
     GROUP BY e.id, e.ecole_id, e.actif, c.frais_fcfa`,
    [annee.id]
  )
  const [ecoles] = await pool.query('SELECT id, commission_fcfa FROM ecoles WHERE actif = TRUE')
  const stats = {}
  for (const ec of ecoles) {
    stats[ec.id] = { ecoleId: ec.id, nbEleves: 0, attendu: 0, encaisse: 0, revenuPrevu: 0, commission: Number(ec.commission_fcfa) }
  }
  for (const l of lignes) {
    const s = stats[l.ecole_id]
    if (!s || !l.actif) continue
    s.nbEleves += 1
    s.attendu += Number(l.frais)
    s.encaisse += Number(l.paye)
  }
  for (const s of Object.values(stats)) s.revenuPrevu = s.nbEleves * s.commission
  res.json(Object.values(stats))
})

// Inspection d'un établissement — LUTRAXE uniquement, LECTURE SEULE (aucune modification possible,
// pas de jeton d'école). Les numéros de téléphone des parents ne sont pas transmis.
router.get('/:id/inspection', verifierAdmin, async (req, res) => {
  const [[ecole]] = await pool.query(
    `SELECT ec.id, ec.nom, ec.ville, ec.code, ec.actif, ec.commission_fcfa,
            ag.nom AS agenceBancaire, ag.telephone AS agenceTelephone
     FROM ecoles ec JOIN agences_bancaires ag ON ag.id = ec.agence_bancaire_id WHERE ec.id = ?`,
    [req.params.id]
  )
  if (!ecole) return res.status(404).json({ erreur: 'Établissement introuvable.' })
  const annee = await anneeActive()
  const [eleves] = await pool.query(
    `SELECT e.id, e.matricule, e.nom, e.actif, c.nom AS classe, c.ordre, c.frais_fcfa AS frais,
            COALESCE(SUM(p.montant_fcfa), 0) AS montant_paye,
            (SELECT COALESCE(SUM(a.montant_fcfa), 0) FROM arrieres a WHERE a.identifiant_utrax = e.identifiant_utrax AND a.solde = FALSE) AS arrieres
     FROM eleves e
     JOIN classes c ON c.id = e.classe_id
     LEFT JOIN paiements p ON p.eleve_id = e.id AND p.annee_id = ? AND p.annule = FALSE
     WHERE e.ecole_id = ?
     GROUP BY e.id, e.matricule, e.identifiant_utrax, e.nom, e.actif, c.nom, c.ordre, c.frais_fcfa
     ORDER BY c.ordre, e.nom`,
    [annee.id, ecole.id]
  )
  const [paiements] = await pool.query(
    `SELECT p.reference, p.montant_fcfa AS montant, p.mode, p.origine, p.date_paiement AS date, p.created_at AS dateHeure,
            p.annule, p.motif_annulation AS motifAnnulation, ag.nom AS agenceBancaire, e.nom AS eleve
     FROM paiements p JOIN eleves e ON e.id = p.eleve_id
     LEFT JOIN agences_bancaires ag ON ag.id = p.agence_bancaire_id
     WHERE e.ecole_id = ?
     ORDER BY p.created_at DESC LIMIT 20`,
    [ecole.id]
  )
  res.json({ ecole, annee: annee.libelle, eleves, paiements })
})

// Fiche de l'établissement actuellement connecté (pour l'en-tête du tableau de bord école)
router.get('/moi', verifierEcole, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT ec.id, ec.nom, ec.ville, ec.code, ag.nom AS agenceBancaire, ag.telephone AS agenceTelephone
     FROM ecoles ec JOIN agences_bancaires ag ON ag.id = ec.agence_bancaire_id WHERE ec.id = ?`,
    [req.ecoleId]
  )
  res.json(rows[0] || null)
})

export default router
