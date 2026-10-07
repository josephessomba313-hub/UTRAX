// Migration 005 — code de confirmation par agence bancaire.
//
// Chaque agence a désormais un code de confirmation (chiffré, comme un mot de passe), que
// l'école doit saisir pour valider l'enregistrement d'un paiement — preuve que le versement
// a bien été fait à cette agence. Les agences déjà créées n'ont pas encore de code : tant
// qu'UTRAX ne leur en définit pas un depuis la Vue UTRAX, les écoles rattachées ne pourront
// pas enregistrer de nouveaux paiements (message d'erreur explicite).
//
// À lancer UNE FOIS, depuis le dossier du backend :
//     node src/migrations/005-code-agence.js
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
  if (!(await colonneExiste('agences_bancaires', 'code_hash'))) {
    await pool.query('ALTER TABLE agences_bancaires ADD COLUMN code_hash VARCHAR(255) COLLATE utf8mb4_unicode_ci NULL AFTER telephone')
    console.log('• agences_bancaires : colonne code_hash ajoutée')
  } else {
    console.log('• agences_bancaires : colonne déjà présente')
  }
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM agences_bancaires WHERE code_hash IS NULL')
  if (Number(n) > 0) {
    console.log(`⚠ ${n} agence(s) sans code de confirmation. Définissez-en un pour chacune depuis la Vue UTRAX`)
    console.log('  (section « Agences bancaires ») avant que les écoles concernées puissent enregistrer un paiement.')
  }
  console.log('\n✔ Migration terminée.')
} catch (err) {
  console.error('\n✘ Migration interrompue :', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
