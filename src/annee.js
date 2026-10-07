import { pool } from './db.js'

// Année scolaire active (une seule à la fois). `conn` permet de l'appeler dans une transaction.
export async function anneeActive(conn = pool) {
  const [rows] = await conn.query('SELECT id, libelle FROM annees_scolaires WHERE active = TRUE LIMIT 1')
  if (rows.length === 0) {
    throw new Error('Aucune année scolaire active — exécutez la migration 001-annees-scolaires.')
  }
  return { id: Number(rows[0].id), libelle: rows[0].libelle }
}
