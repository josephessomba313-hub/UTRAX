// Migration 003 — annulation d'un paiement mal saisi (école) et arriérés soldés (UTRAX).
// À lancer UNE FOIS, depuis le dossier du backend :
//     node src/migrations/003-annulation-paiements-arrieres.js
// Peut être relancée sans danger.
await import('dotenv/config').catch(() => {})
const { pool } = await import('../db.js')

async function colonneExiste(table, colonne) {
  const [r] = await pool.query(
    'SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    [table, colonne]
  )
  return r.length > 0
}

try {
  if (!(await colonneExiste('paiements', 'annule'))) {
    await pool.query(`ALTER TABLE paiements
      ADD COLUMN annule TINYINT(1) NOT NULL DEFAULT 0 AFTER origine,
      ADD COLUMN motif_annulation VARCHAR(255) COLLATE utf8mb4_unicode_ci NULL AFTER annule,
      ADD COLUMN annule_le DATE NULL AFTER motif_annulation`)
    console.log('• paiements : colonnes annule, motif_annulation, annule_le ajoutées')
  } else {
    console.log('• paiements : colonnes déjà présentes')
  }

  if (!(await colonneExiste('arrieres', 'solde'))) {
    await pool.query(`ALTER TABLE arrieres
      ADD COLUMN solde TINYINT(1) NOT NULL DEFAULT 0 AFTER montant_fcfa,
      ADD COLUMN solde_le DATE NULL AFTER solde,
      ADD COLUMN solde_commentaire VARCHAR(255) COLLATE utf8mb4_unicode_ci NULL AFTER solde_le`)
    console.log('• arrieres : colonnes solde, solde_le, solde_commentaire ajoutées')
  } else {
    console.log('• arrieres : colonnes déjà présentes')
  }

  console.log('\n✔ Migration terminée.')
} catch (err) {
  console.error('\n✘ Migration interrompue :', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
