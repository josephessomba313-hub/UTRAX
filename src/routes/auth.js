import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { pool } from '../db.js'
import { verifierEcole } from '../middleware/auth-ecole.js'
import { limiteEssais } from '../middleware/limite-essais.js'

const router = Router()

// Côté ÉCOLE : connexion avec code établissement + mot de passe.
// Limite d'essais ratés par adresse IP : les mots de passe d'école ne peuvent plus être devinés
// par force brute.
router.post('/ecole/login', limiteEssais({ max: 15 }), async (req, res) => {
  const { code, motDePasse } = req.body
  if (!code || !motDePasse) {
    return res.status(400).json({ erreur: 'Code établissement et mot de passe requis.' })
  }

  const [rows] = await pool.query(
    `SELECT ec.*, ag.nom AS agence_nom, ag.telephone AS agence_telephone
     FROM ecoles ec JOIN agences_bancaires ag ON ag.id = ec.agence_bancaire_id
     WHERE ec.code = ?`,
    [String(code).trim().toUpperCase()]
  )
  const ecole = rows[0]
  if (!ecole) return res.status(401).json({ erreur: 'Code ou mot de passe incorrect.' })
  if (!ecole.actif) return res.status(403).json({ erreur: "Cet établissement n'est plus partenaire actif d'UTRAX." })

  const valide = await bcrypt.compare(String(motDePasse), ecole.mot_de_passe_hash)
  if (!valide) return res.status(401).json({ erreur: 'Code ou mot de passe incorrect.' })

  const token = jwt.sign({ ecoleId: ecole.id }, process.env.JWT_SECRET, { expiresIn: '12h' })
  res.json({
    token,
    ecole: { id: ecole.id, nom: ecole.nom, ville: ecole.ville, code: ecole.code, agenceBancaire: ecole.agence_nom, agenceTelephone: ecole.agence_telephone },
  })
})

// CÔTÉ ÉCOLE — changer son propre mot de passe (menu Paramètres), en confirmant l'ancien.
router.patch('/ecole/mot-de-passe', verifierEcole, limiteEssais({ max: 8, cle: (req) => `mdp:${req.ecoleId}` }), async (req, res) => {
  const motDePasseActuel = String(req.body.motDePasseActuel || '')
  const nouveauMotDePasse = String(req.body.nouveauMotDePasse || '')
  if (!motDePasseActuel || !nouveauMotDePasse) return res.status(400).json({ erreur: 'Mot de passe actuel et nouveau mot de passe requis.' })
  if (nouveauMotDePasse.length < 6) return res.status(400).json({ erreur: 'Le nouveau mot de passe doit contenir au moins 6 caractères.' })
  const [[ecole]] = await pool.query('SELECT mot_de_passe_hash FROM ecoles WHERE id = ?', [req.ecoleId])
  if (!ecole) return res.status(404).json({ erreur: 'Établissement introuvable.' })
  const valide = await bcrypt.compare(motDePasseActuel, ecole.mot_de_passe_hash)
  if (!valide) return res.status(401).json({ erreur: 'Mot de passe actuel incorrect.' })
  const hash = await bcrypt.hash(nouveauMotDePasse, 10)
  await pool.query('UPDATE ecoles SET mot_de_passe_hash = ? WHERE id = ?', [hash, req.ecoleId])
  res.json({ ok: true })
})

// L'espace Parents n'a plus de compte ni de connexion (ni Google, ni téléphone + SMS) :
// le parent retrouve la fiche de son enfant avec le code établissement, la classe et le matricule
// (voir /api/eleves/public/fiche). Les anciennes routes /parent/* ont donc été retirées.

export default router
