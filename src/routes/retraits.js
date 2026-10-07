import { Router } from 'express'
import { pool } from '../db.js'
import { verifierAdmin } from '../middleware/auth-admin.js'

// ⚠️ UTRAX ne détient jamais les fonds des écoles ni des parents — c'est la
// banque dépositaire qui les encaisse et exécute les virements. Ces routes ne
// « retirent » rien au sens propre : elles calculent la commission due à UTRAX
// et produisent l'instruction de virement que la banque exécute ensuite.
// "Générer" = créer l'instruction ; le virement réel est un acte bancaire, hors logiciel.

const router = Router()

async function calculerSolde() {
  const [[{ commission_totale }]] = await pool.query('SELECT COALESCE(SUM(commission_fcfa), 0) AS commission_totale FROM reglements')
  const [[{ deja_instruit }]] = await pool.query('SELECT COALESCE(SUM(montant_fcfa), 0) AS deja_instruit FROM retraits_utrax')
  return commission_totale - deja_instruit
}

// Commission UTRAX due, pas encore virée par la banque
router.get('/solde', verifierAdmin, async (req, res) => {
  res.json({ soldeDisponible: await calculerSolde() })
})

// Créer l'instruction de virement vers le compte bancaire d'UTRAX.
// La banque dépositaire exécute le virement réel sur la base de cette instruction.
router.post('/generer', verifierAdmin, async (req, res) => {
  const solde = await calculerSolde()
  if (solde <= 0) return res.status(400).json({ erreur: 'Aucune commission en attente pour le moment.' })
  const reference = `UTX-OUT-${Math.floor(1000 + Math.random() * 9000)}`
  await pool.query('INSERT INTO retraits_utrax (reference, montant_fcfa, date_retrait) VALUES (?, ?, CURDATE())', [reference, solde])
  res.status(201).json({ reference, montant: solde })
})

// Historique des instructions de virement transmises à la banque
router.get('/', verifierAdmin, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT reference, montant_fcfa AS montant, date_retrait AS date FROM retraits_utrax ORDER BY date_retrait DESC'
  )
  res.json(rows)
})

export default router
