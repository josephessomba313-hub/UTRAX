import { Router } from 'express'
import { pool } from '../db.js'
import { verifierAdmin } from '../middleware/auth-admin.js'
import { insererAvecReference } from '../reference.js'

// ⚠️ LUTRAXE ne détient jamais les fonds des écoles ni des parents — c'est la banque dépositaire
// qui les encaisse et exécute les virements. Ces routes ne « retirent » rien au sens propre :
// elles calculent la commission due à LUTRAXE et produisent l'instruction de virement que la
// banque exécute ensuite. « Générer » = créer l'instruction ; le virement réel est un acte
// bancaire, hors logiciel.

const router = Router()

async function calculerSolde(conn = pool) {
  const [[{ commission_totale }]] = await conn.query('SELECT COALESCE(SUM(commission_fcfa), 0) AS commission_totale FROM reglements')
  const [[{ deja_instruit }]] = await conn.query('SELECT COALESCE(SUM(montant_fcfa), 0) AS deja_instruit FROM retraits_utrax')
  return Number(commission_totale) - Number(deja_instruit)
}

// Commission LUTRAXE due, pas encore virée par la banque
router.get('/solde', verifierAdmin, async (req, res) => {
  res.json({ soldeDisponible: await calculerSolde() })
})

// Créer l'instruction de virement vers le compte bancaire de LUTRAXE.
// Un verrou nommé garantit que deux demandes simultanées ne créent pas deux instructions
// pour la même commission.
router.post('/generer', verifierAdmin, async (req, res) => {
  const conn = await pool.getConnection()
  let verrouPris = false
  try {
    const [[verrou]] = await conn.query("SELECT GET_LOCK('utrax_retrait', 10) AS ok")
    if (!Number(verrou.ok)) {
      return res.status(409).json({ erreur: 'Une autre génération est en cours, réessayez dans un instant.' })
    }
    verrouPris = true

    const solde = await calculerSolde(conn)
    if (solde <= 0) return res.status(400).json({ erreur: 'Aucune commission en attente pour le moment.' })

    const { reference } = await insererAvecReference('LTX-OUT', (ref) =>
      conn.query('INSERT INTO retraits_utrax (reference, montant_fcfa, date_retrait) VALUES (?, ?, CURDATE())', [ref, solde])
    )
    res.status(201).json({ reference, montant: solde })
  } catch (err) {
    console.error(err)
    res.status(500).json({ erreur: "Échec de la génération de l'instruction de virement." })
  } finally {
    if (verrouPris) await conn.query("SELECT RELEASE_LOCK('utrax_retrait')").catch(() => {})
    conn.release()
  }
})

// Historique des instructions de virement transmises à la banque
router.get('/', verifierAdmin, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT reference, montant_fcfa AS montant, date_retrait AS date FROM retraits_utrax ORDER BY date_retrait DESC, id DESC'
  )
  res.json(rows)
})

export default router
