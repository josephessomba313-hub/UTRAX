// Migration 002 — motif de sortie d'un élève (exclusion, abandon, diplôme, transfert).
// Permet à une nouvelle école, lors de l'inscription par identifiant UTRAX, de voir si
// l'élève a été exclu ailleurs ou a des arriérés — sans jamais bloquer l'inscription :
// la décision reste à l'école.
//
// À lancer UNE FOIS, depuis le dossier du backend :
//     node src/migrations/002-exclusions.js
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
  if (!(await colonneExiste('eleves', 'motif_sortie'))) {
    await pool.query(`ALTER TABLE eleves
      ADD COLUMN motif_sortie ENUM('exclusion','abandon','diplome','transfert') COLLATE utf8mb4_unicode_ci NULL AFTER actif,
      ADD COLUMN commentaire_sortie VARCHAR(500) COLLATE utf8mb4_unicode_ci NULL AFTER motif_sortie,
      ADD COLUMN sortie_le DATE NULL AFTER commentaire_sortie`)
    console.log('• eleves : colonnes motif_sortie, commentaire_sortie, sortie_le ajoutées')
  } else {
    console.log('• eleves : colonnes déjà présentes')
  }
  console.log('\n✔ Migration terminée.')
} catch (err) {
  console.error('\n✘ Migration interrompue :', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
