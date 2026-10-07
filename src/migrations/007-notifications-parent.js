// Migration 007 — notifications libres de l'école vers un parent (distinctes des relances, qui
// restent automatiques et liées aux impayés). L'école peut écrire un message quelconque à
// destination du parent d'un élève précis (réunion, document à apporter, sortie scolaire, etc.).
//
// À lancer UNE FOIS, depuis le dossier du backend :
//     node src/migrations/007-notifications-parent.js
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
  if (!(await tableExiste('notifications_parent'))) {
    await pool.query(`CREATE TABLE notifications_parent (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      eleve_id BIGINT UNSIGNED NOT NULL,
      titre VARCHAR(150) COLLATE utf8mb4_unicode_ci NULL,
      message TEXT COLLATE utf8mb4_unicode_ci NOT NULL,
      date_envoi DATE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_notifications_eleve_date (eleve_id, date_envoi),
      CONSTRAINT fk_notifications_eleve FOREIGN KEY (eleve_id) REFERENCES eleves (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
    console.log('• Table notifications_parent créée')
  } else {
    console.log('• Table notifications_parent déjà présente')
  }
  console.log('\n✔ Migration terminée.')
} catch (err) {
  console.error('\n✘ Migration interrompue :', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
