import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { pool } from '../db.js'
import { OAuth2Client } from 'google-auth-library'
import { verifierEcole } from '../middleware/auth-ecole.js'
import { limiteEssais } from '../middleware/limite-essais.js'
import { randomInt } from 'node:crypto'
import { envoyerSms, normaliserTelephone, smsConfigure } from '../sms.js'

const router = Router()

// Côté ÉCOLE : connexion avec code établissement + mot de passe.
router.post('/ecole/login', async (req, res) => {
  const { code, motDePasse } = req.body
  if (!code || !motDePasse) {
    return res.status(400).json({ erreur: 'Code établissement et mot de passe requis.' })
  }

  const [rows] = await pool.query(
    `SELECT ec.*, ag.nom AS agence_nom, ag.telephone AS agence_telephone
     FROM ecoles ec JOIN agences_bancaires ag ON ag.id = ec.agence_bancaire_id
     WHERE ec.code = ?`,
    [code.trim().toUpperCase()]
  )
  const ecole = rows[0]
  if (!ecole) return res.status(401).json({ erreur: 'Code ou mot de passe incorrect.' })
  if (!ecole.actif) return res.status(403).json({ erreur: "Cet établissement n'est plus partenaire actif d'UTRAX." })

  const valide = await bcrypt.compare(motDePasse, ecole.mot_de_passe_hash)
  if (!valide) return res.status(401).json({ erreur: 'Code ou mot de passe incorrect.' })

  const token = jwt.sign({ ecoleId: ecole.id }, process.env.JWT_SECRET, { expiresIn: '12h' })
  res.json({
    token,
    ecole: { id: ecole.id, nom: ecole.nom, ville: ecole.ville, code: ecole.code, agenceBancaire: ecole.agence_nom, agenceTelephone: ecole.agence_telephone },
  })
})

// CÔTÉ ÉCOLE — changer son propre mot de passe (menu Paramètres), en confirmant l'ancien.
router.patch('/ecole/mot-de-passe', verifierEcole, async (req, res) => {
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

// CÔTÉ PARENT — vérifie la connexion Google avant d'ouvrir l'espace parent (lecture seule).
// Le parent ne saisit ni code ni mot de passe : le jeton `credential` vient du bouton "Se
// connecter avec Google" (Google Identity Services) côté interface, et est vérifié ici auprès
// de Google avant d'autoriser l'accès. Nécessite GOOGLE_CLIENT_ID dans le .env du backend
// (voir Google Cloud Console → Identifiants → ID client OAuth).
const clientGoogle = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null

router.post('/parent/google', async (req, res) => {
  if (!clientGoogle) {
    return res.status(501).json({ erreur: "Connexion Google non configurée côté serveur (GOOGLE_CLIENT_ID manquant dans le .env)." })
  }
  const { credential } = req.body
  if (!credential) return res.status(400).json({ erreur: 'Jeton Google requis.' })
  try {
    const ticket = await clientGoogle.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID })
    const payload = ticket.getPayload()
    res.json({ email: payload.email, nom: payload.name || payload.email })
  } catch {
    res.status(401).json({ erreur: 'Connexion Google invalide ou expirée.' })
  }
})

// ---------- CÔTÉ PARENT — inscription / connexion par numéro de téléphone + code SMS ----------
// Remplace la connexion Google : un parent s'inscrit avec son numéro, son nom, son prénom, sa
// date et son lieu de naissance, puis confirme son numéro avec un code à 6 chiffres reçu par SMS
// — comme à l'installation de la plupart des applications. Nécessite TWILIO_ACCOUNT_SID,
// TWILIO_AUTH_TOKEN et TWILIO_FROM_NUMBER dans le .env du backend (voir sms.js).

function genererCode() {
  return String(randomInt(0, 1000000)).padStart(6, '0')
}

// Limiteur dédié : un code SMS coûte de l'argent réel à chaque envoi, donc on restreint plus
// sévèrement ces routes que les autres (voir middleware/limite-essais.js).
const limiteSms = limiteEssais({ max: 5, fenetreMs: 15 * 60 * 1000 })

// Inscription — crée le compte et envoie le premier code de vérification.
router.post('/parent/inscription', limiteSms, async (req, res) => {
  const { nom, prenom, dateNaissance, lieuNaissance } = req.body
  const telephone = normaliserTelephone(req.body.telephone)
  if (!telephone) return res.status(400).json({ erreur: 'Numéro de téléphone invalide.' })
  if (!nom?.trim() || !prenom?.trim() || !dateNaissance || !lieuNaissance?.trim()) {
    return res.status(400).json({ erreur: 'Nom, prénom, date et lieu de naissance requis.' })
  }
  const [existants] = await pool.query('SELECT id FROM comptes_parents WHERE telephone = ?', [telephone])
  if (existants.length > 0) return res.status(409).json({ erreur: 'Un compte existe déjà avec ce numéro — utilisez plutôt « Se connecter ».' })

  const code = genererCode()
  await pool.query(
    `INSERT INTO comptes_parents (telephone, nom, prenom, date_naissance, lieu_naissance, otp_code, otp_expire_le)
     VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
    [telephone, nom.trim(), prenom.trim(), dateNaissance, lieuNaissance.trim(), code]
  )
  // Tant que Twilio n'est pas configuré (développement / avant mise en ligne), le code est
  // affiché ici, dans la console du serveur, au lieu d'être envoyé par SMS — ce qui permet de
  // tester tout le parcours sans dépenser un centime. Dès que Twilio est configuré, les vrais
  // SMS prennent automatiquement le relais, sans rien à changer dans ce fichier.
  if (!smsConfigure()) {
    console.log(`\n📱 [MODE TEST — SMS non configuré] Code d'inscription pour ${telephone} : ${code}\n`)
    return res.status(201).json({ ok: true, modeTest: true })
  }
  try {
    await envoyerSms(telephone, `UTRAX : votre code de vérification est ${code}. Il expire dans 10 minutes.`)
  } catch (err) {
    await pool.query('DELETE FROM comptes_parents WHERE telephone = ?', [telephone])
    return res.status(502).json({ erreur: "Échec de l'envoi du SMS : " + err.message })
  }
  res.status(201).json({ ok: true })
})

// Connexion — compte déjà existant, envoie un nouveau code.
router.post('/parent/connexion', limiteSms, async (req, res) => {
  const telephone = normaliserTelephone(req.body.telephone)
  if (!telephone) return res.status(400).json({ erreur: 'Numéro de téléphone invalide.' })
  const [comptes] = await pool.query('SELECT id FROM comptes_parents WHERE telephone = ?', [telephone])
  if (comptes.length === 0) return res.status(404).json({ erreur: "Aucun compte avec ce numéro — inscrivez-vous d'abord." })

  const code = genererCode()
  await pool.query(
    'UPDATE comptes_parents SET otp_code = ?, otp_expire_le = DATE_ADD(NOW(), INTERVAL 10 MINUTE), otp_tentatives = 0 WHERE telephone = ?',
    [code, telephone]
  )
  if (!smsConfigure()) {
    console.log(`\n📱 [MODE TEST — SMS non configuré] Code de connexion pour ${telephone} : ${code}\n`)
    return res.json({ ok: true, modeTest: true })
  }
  try {
    await envoyerSms(telephone, `UTRAX : votre code de connexion est ${code}. Il expire dans 10 minutes.`)
  } catch (err) {
    return res.status(502).json({ erreur: "Échec de l'envoi du SMS : " + err.message })
  }
  res.json({ ok: true })
})

// Vérification du code — commune à l'inscription et à la connexion. 5 essais maximum par code,
// pour limiter les tentatives de deviner un code intercepté.
router.post('/parent/verifier', limiteEssais(), async (req, res) => {
  const telephone = normaliserTelephone(req.body.telephone)
  const code = String(req.body.code || '').trim()
  if (!telephone || !code) return res.status(400).json({ erreur: 'Numéro de téléphone et code requis.' })

  const [[compte]] = await pool.query(
    'SELECT id, nom, prenom, otp_code, otp_expire_le, otp_tentatives FROM comptes_parents WHERE telephone = ?',
    [telephone]
  )
  if (!compte) return res.status(404).json({ erreur: 'Aucun compte avec ce numéro.' })
  if (!compte.otp_code || new Date(compte.otp_expire_le) < new Date()) {
    return res.status(401).json({ erreur: 'Code expiré — demandez-en un nouveau.' })
  }
  if (compte.otp_tentatives >= 5) {
    return res.status(429).json({ erreur: 'Trop de tentatives pour ce code — demandez-en un nouveau.' })
  }
  if (compte.otp_code !== code) {
    await pool.query('UPDATE comptes_parents SET otp_tentatives = otp_tentatives + 1 WHERE id = ?', [compte.id])
    return res.status(401).json({ erreur: 'Code incorrect.' })
  }

  await pool.query('UPDATE comptes_parents SET otp_code = NULL, otp_expire_le = NULL, otp_tentatives = 0 WHERE id = ?', [compte.id])
  const token = jwt.sign({ parentId: compte.id }, process.env.JWT_SECRET, { expiresIn: '30d' })
  res.json({ token, parent: { nom: compte.nom, prenom: compte.prenom, telephone } })
})

export default router
