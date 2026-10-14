import { pool } from './db.js'

// Historique des corrections de nom d'élève (qui, quand, ancien et nouveau nom). Créée au démarrage
// du serveur si elle n'existe pas (CREATE TABLE IF NOT EXISTS : sans effet si elle est déjà là).
export async function initialiserTablesEleves() {
  await pool.query(`CREATE TABLE IF NOT EXISTS corrections_nom_eleves (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    eleve_id BIGINT UNSIGNED NOT NULL,
    ecole_id BIGINT UNSIGNED NOT NULL,
    ancien_nom VARCHAR(150) COLLATE utf8mb4_unicode_ci NOT NULL,
    nouveau_nom VARCHAR(150) COLLATE utf8mb4_unicode_ci NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_corrections_eleve (eleve_id),
    CONSTRAINT fk_corrections_eleve FOREIGN KEY (eleve_id) REFERENCES eleves (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  // Historique des corrections de classe (noms conservés tels quels, sans lien vers la table classes :
  // une classe supprimée plus tard ne doit pas être bloquée par son historique).
  await pool.query(`CREATE TABLE IF NOT EXISTS corrections_classe_eleves (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    eleve_id BIGINT UNSIGNED NOT NULL,
    ecole_id BIGINT UNSIGNED NOT NULL,
    ancienne_classe VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    nouvelle_classe VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_corrections_classe_eleve (eleve_id),
    CONSTRAINT fk_corrections_classe_eleve FOREIGN KEY (eleve_id) REFERENCES eleves (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
}
