import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { pool } from '../db.js'
import { verifierAdmin, exigerProprietaire } from '../middleware/auth-admin.js'
import { limiteEssais } from '../middleware/limite-essais.js'

const router = Router()

const DUREE_SESSION = '8h'
const MDP_MIN = 10
const IDENTIFIANT_VALIDE = /^[a-z0-9._-]{3,40}$/
// Hash factice : on compare toujours un mot de passe, même quand l'identifiant n'existe pas, pour
// que la durée de réponse ne révèle pas quels identifiants existent.
const HASH_FACTICE = bcrypt.hashSync('mot-de-passe-factice', 10)

const ALPHABET_MDP = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
const genererMotDePasse = (n = 14) => Array.from({ length: n }, () => ALPHABET_MDP[randomInt(ALPHABET_MDP.length)]).join('')

const empreinte = (s) => createHash('sha256').update(String(s)).digest()
function cleInstallationValide(fournie) {
  const attendue = process.env.ADMIN_KEY
  if (!attendue || !fournie) return false
  return timingSafeEqual(empreinte(fournie), empreinte(attendue))
}

// Un mot de passe copié-collé emporte souvent une espace invisible au début ou à la fin. Les mots de
// passe sont donc enregistrés SANS espace en bordure, et à la connexion on accepte aussi la saisie
// débarrassée de ses espaces (les anciens comptes continuent de fonctionner tels quels).
async function motDePasseCorrect(saisi, hash) {
  if (await bcrypt.compare(saisi, hash)) return true
  const nettoye = saisi.trim()
  return nettoye !== saisi && (await bcrypt.compare(nettoye, hash))
}

async function ouvrirSession(admin, ip) {
  const jti = randomBytes(16).toString('hex')
  // Ménage : on oublie les sessions terminées depuis plus d'une semaine.
  await pool.query('DELETE FROM admin_sessions WHERE expire_le < DATE_SUB(NOW(), INTERVAL 7 DAY)')
  await pool.query(
    'INSERT INTO admin_sessions (jti, admin_id, ip, expire_le) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 8 HOUR))',
    [jti, admin.id, ip]
  )
  return jwt.sign({ type: 'admin', adminId: Number(admin.id), jti }, process.env.JWT_SECRET, { expiresIn: DUREE_SESSION })
}

const enJson = (a) => ({ id: Number(a.id), identifiant: a.identifiant, nom: a.nom, role: a.role, doitChangerMotDePasse: !!a.doit_changer_mdp })

function journaliser(adminId, identifiant, action, statut, ip) {
  return pool.query(
    'INSERT INTO journal_admin (admin_id, identifiant, action, statut, ip) VALUES (?, ?, ?, ?, ?)',
    [adminId, identifiant, action, statut, ip]
  ).catch((err) => console.error('Journal admin :', err.message))
}

// ---------- Public : y a-t-il déjà un compte LUTRAXE ? (choisit l'écran de connexion) ----------
router.get('/etat', async (req, res) => {
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM admins')
  res.json({ initialise: Number(n) > 0 })
})

// ---------- Création du PREMIER compte (propriétaire) ----------
// Possible une seule fois, tant qu'aucun compte n'existe, et seulement avec la clé d'installation
// (la variable ADMIN_KEY de Railway). Ensuite cette clé ne sert plus à rien.
router.post('/premier-compte', limiteEssais({ max: 5 }), async (req, res) => {
  if (!cleInstallationValide(req.headers['x-admin-key'])) {
    return res.status(401).json({ erreur: "Clé d'installation incorrecte." })
  }
  const identifiant = String(req.body.identifiant || '').trim().toLowerCase()
  const nom = String(req.body.nom || '').trim()
  const motDePasse = String(req.body.motDePasse || '').trim()
  if (!IDENTIFIANT_VALIDE.test(identifiant)) return res.status(400).json({ erreur: 'Identifiant : 3 à 40 caractères (lettres minuscules, chiffres, point, tiret).' })
  if (nom.length < 2 || nom.length > 120) return res.status(400).json({ erreur: 'Nom requis.' })
  if (motDePasse.length < MDP_MIN) return res.status(400).json({ erreur: `Le mot de passe doit contenir au moins ${MDP_MIN} caractères.` })

  const hash = await bcrypt.hash(motDePasse, 10)
  // Un seul INSERT, atomique : n'insère que si la table est vide.
  const [r] = await pool.query(
    `INSERT INTO admins (identifiant, nom, mot_de_passe_hash, role)
     SELECT ?, ?, ?, 'proprietaire' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM admins)`,
    [identifiant, nom, hash]
  )
  if (r.affectedRows === 0) return res.status(409).json({ erreur: 'Un compte LUTRAXE existe déjà : utilisez « Se connecter ».' })

  const admin = { id: r.insertId, identifiant, nom, role: 'proprietaire' }
  const token = await ouvrirSession(admin, req.ip)
  await journaliser(admin.id, identifiant, 'Création du premier compte', 201, req.ip)
  res.status(201).json({ token, admin: enJson(admin) })
})

// ---------- Connexion ----------
// Limites d'essais ratés : par adresse IP, et par identifiant (protège un compte précis même si
// l'attaquant change d'adresse).
const limiteIp = limiteEssais({ max: 10 })
const limiteIdentifiant = limiteEssais({ max: 8, cle: (req) => `admin:${String(req.body?.identifiant || '').toLowerCase().slice(0, 60)}` })

router.post('/login', limiteIp, limiteIdentifiant, async (req, res) => {
  const identifiant = String(req.body.identifiant || '').trim().toLowerCase()
  const motDePasse = String(req.body.motDePasse || '')
  if (!identifiant || !motDePasse) return res.status(400).json({ erreur: 'Identifiant et mot de passe requis.' })

  const [[admin]] = await pool.query('SELECT * FROM admins WHERE identifiant = ?', [identifiant])
  const valide = await motDePasseCorrect(motDePasse, admin ? admin.mot_de_passe_hash : HASH_FACTICE)
  if (!admin || !valide || !admin.actif) {
    if (admin) await journaliser(admin.id, admin.identifiant, 'Échec de connexion', 401, req.ip)
    return res.status(401).json({ erreur: 'Identifiant ou mot de passe incorrect.' })
  }
  await pool.query('UPDATE admins SET derniere_connexion = NOW() WHERE id = ?', [admin.id])
  const token = await ouvrirSession(admin, req.ip)
  await journaliser(admin.id, admin.identifiant, 'Connexion', 200, req.ip)
  res.json({ token, admin: enJson(admin) })
})

// ---------- Session en cours ----------
router.get('/moi', verifierAdmin, (req, res) => res.json(enJson(req.admin)))

router.post('/logout', verifierAdmin, async (req, res) => {
  await pool.query('UPDATE admin_sessions SET revoque_le = NOW() WHERE jti = ?', [req.admin.jti])
  res.json({ ok: true })
})

// Déconnecte tous les appareils de ce compte (y compris celui-ci).
router.post('/logout-all', verifierAdmin, async (req, res) => {
  await pool.query('UPDATE admin_sessions SET revoque_le = NOW() WHERE admin_id = ? AND revoque_le IS NULL', [req.admin.id])
  res.json({ ok: true })
})

router.patch('/mot-de-passe', verifierAdmin, limiteEssais({ max: 8, cle: (req) => `mdp-admin:${req.admin.id}` }), async (req, res) => {
  const actuel = String(req.body.motDePasseActuel || '')
  const nouveau = String(req.body.nouveauMotDePasse || '').trim()
  if (!actuel || !nouveau) return res.status(400).json({ erreur: 'Mot de passe actuel et nouveau mot de passe requis.' })
  if (nouveau.length < MDP_MIN) return res.status(400).json({ erreur: `Le nouveau mot de passe doit contenir au moins ${MDP_MIN} caractères.` })
  if (nouveau === actuel.trim()) return res.status(400).json({ erreur: "Le nouveau mot de passe doit être différent de l'ancien." })
  const [[admin]] = await pool.query('SELECT mot_de_passe_hash FROM admins WHERE id = ?', [req.admin.id])
  if (!(await motDePasseCorrect(actuel, admin.mot_de_passe_hash))) return res.status(401).json({ erreur: 'Mot de passe actuel incorrect.' })
  const hash = await bcrypt.hash(nouveau, 10)
  await pool.query('UPDATE admins SET mot_de_passe_hash = ?, doit_changer_mdp = 0 WHERE id = ?', [hash, req.admin.id])
  // Les autres appareils connectés avec l'ancien mot de passe sont déconnectés.
  await pool.query('UPDATE admin_sessions SET revoque_le = NOW() WHERE admin_id = ? AND jti <> ? AND revoque_le IS NULL', [req.admin.id, req.admin.jti])
  res.json({ ok: true })
})

// ---------- Équipe (propriétaire uniquement) ----------
router.get('/admins', verifierAdmin, exigerProprietaire, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, identifiant, nom, role, actif, derniere_connexion, created_at FROM admins ORDER BY actif DESC, nom'
  )
  res.json(rows.map((a) => ({ ...a, actif: !!a.actif })))
})

router.post('/admins', verifierAdmin, exigerProprietaire, async (req, res) => {
  const identifiant = String(req.body.identifiant || '').trim().toLowerCase()
  const nom = String(req.body.nom || '').trim()
  const role = req.body.role === 'proprietaire' ? 'proprietaire' : 'operateur'
  const choisi = String(req.body.motDePasse || '').trim()
  if (!IDENTIFIANT_VALIDE.test(identifiant)) return res.status(400).json({ erreur: 'Identifiant : 3 à 40 caractères (lettres minuscules, chiffres, point, tiret).' })
  if (nom.length < 2 || nom.length > 120) return res.status(400).json({ erreur: 'Nom requis.' })
  if (choisi && choisi.length < MDP_MIN) return res.status(400).json({ erreur: `Le mot de passe doit contenir au moins ${MDP_MIN} caractères.` })

  const motDePasse = choisi || genererMotDePasse()
  const hash = await bcrypt.hash(motDePasse, 10)
  try {
    await pool.query('INSERT INTO admins (identifiant, nom, mot_de_passe_hash, role, doit_changer_mdp) VALUES (?, ?, ?, ?, 1)', [identifiant, nom, hash, role])
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ erreur: 'Cet identifiant est déjà utilisé.' })
    throw err
  }
  // Le mot de passe n'est renvoyé que s'il a été généré, et une seule fois.
  res.status(201).json({ identifiant, ...(choisi ? {} : { motDePasse }) })
})

router.patch('/admins/:id/statut', verifierAdmin, exigerProprietaire, async (req, res) => {
  const id = Number(req.params.id)
  const actif = !!req.body.actif
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erreur: 'Compte invalide.' })
  if (id === req.admin.id) return res.status(400).json({ erreur: 'Vous ne pouvez pas désactiver votre propre compte.' })
  const [[cible]] = await pool.query('SELECT id, role, actif FROM admins WHERE id = ?', [id])
  if (!cible) return res.status(404).json({ erreur: 'Compte introuvable.' })
  if (!actif && cible.role === 'proprietaire' && cible.actif) {
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM admins WHERE role = 'proprietaire' AND actif = TRUE AND id <> ?", [id])
    if (Number(n) === 0) return res.status(409).json({ erreur: 'Il doit rester au moins un propriétaire actif.' })
  }
  await pool.query('UPDATE admins SET actif = ? WHERE id = ?', [actif, id])
  if (!actif) await pool.query('UPDATE admin_sessions SET revoque_le = NOW() WHERE admin_id = ? AND revoque_le IS NULL', [id])
  res.json({ ok: true })
})

router.post('/admins/:id/reinitialiser-mot-de-passe', verifierAdmin, exigerProprietaire, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erreur: 'Compte invalide.' })
  if (id === req.admin.id) return res.status(400).json({ erreur: 'Pour votre propre compte, utilisez « Changer mon mot de passe ».' })
  const [[cible]] = await pool.query('SELECT id FROM admins WHERE id = ?', [id])
  if (!cible) return res.status(404).json({ erreur: 'Compte introuvable.' })
  const choisi = String(req.body.motDePasse || '').trim()
  if (choisi && choisi.length < MDP_MIN) return res.status(400).json({ erreur: `Le mot de passe doit contenir au moins ${MDP_MIN} caractères.` })
  const motDePasse = choisi || genererMotDePasse()
  const hash = await bcrypt.hash(motDePasse, 10)
  // Provisoire : le membre devra choisir le sien à sa prochaine connexion.
  await pool.query('UPDATE admins SET mot_de_passe_hash = ?, doit_changer_mdp = 1 WHERE id = ?', [hash, id])
  await pool.query('UPDATE admin_sessions SET revoque_le = NOW() WHERE admin_id = ? AND revoque_le IS NULL', [id])
  // Le mot de passe n'est renvoyé que s'il a été généré, et une seule fois.
  res.json(choisi ? { ok: true } : { motDePasse })
})

router.get('/journal', verifierAdmin, exigerProprietaire, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, identifiant, action, statut, ip, created_at FROM journal_admin ORDER BY id DESC LIMIT 200'
  )
  res.json(rows)
})

export default router
