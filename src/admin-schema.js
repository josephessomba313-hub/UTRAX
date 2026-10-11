import { pool } from './db.js'

// Crée, au démarrage du serveur, les tables des comptes UTRAX si elles n'existent pas encore
// (CREATE TABLE IF NOT EXISTS : sans effet si elles sont déjà là). Choix volontaire : ça évite de
// rouvrir l'accès public à la base juste pour une migration.
export async function initialiserTablesAdmin() {
  await pool.query(`CREATE TABLE IF NOT EXISTS admins (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    identifiant VARCHAR(60) COLLATE utf8mb4_unicode_ci NOT NULL,
    nom VARCHAR(120) COLLATE utf8mb4_unicode_ci NOT NULL,
    mot_de_passe_hash VARCHAR(255) NOT NULL,
    role ENUM('proprietaire','operateur') NOT NULL DEFAULT 'operateur',
    actif TINYINT(1) NOT NULL DEFAULT 1,
    derniere_connexion DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_admin_identifiant (identifiant)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  await pool.query(`CREATE TABLE IF NOT EXISTS admin_sessions (
    jti CHAR(32) NOT NULL,
    admin_id BIGINT UNSIGNED NOT NULL,
    ip VARCHAR(64) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expire_le DATETIME NOT NULL,
    revoque_le DATETIME NULL,
    PRIMARY KEY (jti),
    KEY idx_admin_sessions_admin (admin_id),
    CONSTRAINT fk_admin_sessions_admin FOREIGN KEY (admin_id) REFERENCES admins (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  await pool.query(`CREATE TABLE IF NOT EXISTS journal_admin (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    admin_id BIGINT UNSIGNED NULL,
    identifiant VARCHAR(60) COLLATE utf8mb4_unicode_ci NULL,
    action VARCHAR(150) COLLATE utf8mb4_unicode_ci NOT NULL,
    statut SMALLINT UNSIGNED NULL,
    ip VARCHAR(64) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_journal_date (created_at),
    CONSTRAINT fk_journal_admin FOREIGN KEY (admin_id) REFERENCES admins (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  // Colonne ajoutée après la création initiale des tables : on l'ajoute si elle manque.
  const [colonne] = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'admins' AND column_name = 'doit_changer_mdp'"
  )
  if (colonne.length === 0) {
    await pool.query('ALTER TABLE admins ADD COLUMN doit_changer_mdp TINYINT(1) NOT NULL DEFAULT 0 AFTER actif')
  }
}
