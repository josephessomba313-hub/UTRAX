// Migration 006 — comptes parents (inscription/connexion par numéro de téléphone + code SMS).
// Remplace la connexion Google de la Vue Parent : désormais, un parent s'inscrit avec son
// numéro de téléphone, son nom, son prénom, sa date et son lieu de naissance, et confirme son
// numéro avec un code reçu par SMS — comme à l'installation de la plupart des applications.
//
// À lancer UNE FOIS, depuis le dossier du backend :
//     node src/migrations/006-comptes-parents.js
// Peut être relancée sans danger.
await import('dotenv/config').catch(() => {})
const { pool } = await import('../db.js')

async function tableExiste(table) {
  const [r] = await pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
    [table]
  )
  return r.length > 0
}

try {
  if (!(await tableExiste('comptes_parents'))) {
    await pool.query(`CREATE TABLE comptes_parents (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      telephone VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL,
      nom VARCHAR(100) COLLATE utf8mb4_unicode_ci NOT NULL,
      prenom VARCHAR(100) COLLATE utf8mb4_unicode_ci NOT NULL,
      date_naissance DATE NOT NULL,
      lieu_naissance VARCHAR(150) COLLATE utf8mb4_unicode_ci NOT NULL,
      otp_code VARCHAR(6) COLLATE utf8mb4_unicode_ci NULL,
      otp_expire_le DATETIME NULL,
      otp_tentatives INT UNSIGNED NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_parent_telephone (telephone)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
    console.log('• Table comptes_parents créée')
  } else {
    console.log('• Table comptes_parents déjà présente')
  }
  console.log('\n✔ Migration terminée.')
} catch (err) {
  console.error('\n✘ Migration interrompue :', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
