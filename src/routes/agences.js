import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { pool } from '../db.js'
import { verifierAdmin } from '../middleware/auth-admin.js'

const router = Router()

// Liste des agences bancaires — LUTRAXE uniquement. codeDefini indique si un code de confirmation
// existe déjà (le code lui-même, chiffré, n'est jamais renvoyé).
router.get('/', verifierAdmin, async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id, nom, telephone, (code_hash IS NOT NULL) AS codeDefini, created_at FROM agences_bancaires ORDER BY nom"
  )
  res.json(rows.map((r) => ({ ...r, codeDefini: !!r.codeDefini })))
})

// Créer une agence bancaire — LUTRAXE uniquement.
// Le numéro de téléphone est celui attribué par la banque avant l'enregistrement sur la
// plateforme, pour garder un contact direct entre la banque et LUTRAXE. Le code de confirmation
// (4 caractères minimum) est ce que l'école devra ressaisir pour valider chaque paiement fait
// à cette agence — la preuve que le versement y a bien été effectué.
router.post('/', verifierAdmin, async (req, res) => {
  const nom = String(req.body.nom || '').trim()
  const telephone = String(req.body.telephone || '').trim()
  const code = String(req.body.code || '').trim()
  if (!nom || !telephone || !code) return res.status(400).json({ erreur: 'Nom, téléphone et code de confirmation requis.' })
  if (code.length < 4) return res.status(400).json({ erreur: 'Le code de confirmation doit contenir au moins 4 caractères.' })
  const [existe] = await pool.query('SELECT 1 FROM agences_bancaires WHERE telephone = ?', [telephone])
  if (existe.length > 0) return res.status(409).json({ erreur: 'Ce numéro de téléphone est déjà attribué à une autre agence.' })
  const codeHash = await bcrypt.hash(code, 10)
  const [result] = await pool.query('INSERT INTO agences_bancaires (nom, telephone, code_hash) VALUES (?, ?, ?)', [nom, telephone, codeHash])
  res.status(201).json({ id: result.insertId, nom, telephone })
})

// Définir ou changer le code de confirmation d'une agence existante — LUTRAXE uniquement.
router.post('/:id/code', verifierAdmin, async (req, res) => {
  const code = String(req.body.code || '').trim()
  if (code.length < 4) return res.status(400).json({ erreur: 'Le code de confirmation doit contenir au moins 4 caractères.' })
  const [agences] = await pool.query('SELECT id FROM agences_bancaires WHERE id = ?', [req.params.id])
  if (agences.length === 0) return res.status(404).json({ erreur: 'Agence introuvable.' })
  const codeHash = await bcrypt.hash(code, 10)
  await pool.query('UPDATE agences_bancaires SET code_hash = ? WHERE id = ?', [codeHash, req.params.id])
  res.json({ ok: true })
})

export default router
