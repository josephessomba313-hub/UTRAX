// Migration 004 — paiement par agence bancaire, à la place du Mobile Money.
//
// - Crée la table des agences bancaires (nom + numéro de téléphone de contact, attribué par la
//   banque avant l'enregistrement sur la plateforme).
// - Rattache chaque école à une agence bancaire (chaque école est ratachée à une seule agence,
//   choisie à sa création).
// - Un paiement se fait désormais à l'agence de l'école, plus par Mobile Money : la colonne
//   `mode` (MTN MoMo, Orange Money…) n'est plus obligatoire et n'est plus utilisée pour un
//   nouveau paiement ; elle reste en base pour l'historique des paiements déjà enregistrés.
//
// À lancer UNE FOIS, depuis le dossier du backend :
//     node src/migrations/004-agences-bancaires.js
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
async function contrainteExiste(table, nom) {
  const [r] = await pool.query(
    'SELECT 1 FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = ?',
    [table, nom]
  )
  return r.length > 0
}
const log = (m) => console.log('•', m)

try {
  // 1) Agences bancaires
  await pool.query(`CREATE TABLE IF NOT EXISTS agences_bancaires (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    nom VARCHAR(150) COLLATE utf8mb4_unicode_ci NOT NULL,
    telephone VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_agence_telephone (telephone)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  // 2) Chaque école rattachée à une agence — les écoles déjà créées avant cette migration
  //    reçoivent une agence provisoire "À attribuer", à corriger ensuite depuis la Vue UTRAX.
  if (!(await colonneExiste('ecoles', 'agence_bancaire_id'))) {
    await pool.query('ALTER TABLE ecoles ADD COLUMN agence_bancaire_id BIGINT UNSIGNED NULL AFTER code')
    log('ecoles : colonne agence_bancaire_id ajoutée')
  }
  const [sansAgence] = await pool.query('SELECT id FROM ecoles WHERE agence_bancaire_id IS NULL')
  if (sansAgence.length > 0) {
    let [[provisoire]] = await pool.query("SELECT id FROM agences_bancaires WHERE telephone = '000000000'")
    if (!provisoire) {
      const [ins] = await pool.query(
        "INSERT INTO agences_bancaires (nom, telephone) VALUES ('Agence à attribuer', '000000000')"
      )
      provisoire = { id: ins.insertId }
      log('Agence provisoire "Agence à attribuer" créée pour les écoles déjà existantes')
    }
    await pool.query('UPDATE ecoles SET agence_bancaire_id = ? WHERE agence_bancaire_id IS NULL', [provisoire.id])
    log(`${sansAgence.length} établissement(s) rattaché(s) à l'agence provisoire — à corriger depuis la Vue UTRAX`)
  }
  await pool.query('ALTER TABLE ecoles MODIFY agence_bancaire_id BIGINT UNSIGNED NOT NULL')
  if (!(await contrainteExiste('ecoles', 'fk_ecoles_agence'))) {
    await pool.query('ALTER TABLE ecoles ADD CONSTRAINT fk_ecoles_agence FOREIGN KEY (agence_bancaire_id) REFERENCES agences_bancaires (id) ON DELETE RESTRICT')
    log('ecoles : lien vers agences_bancaires créé')
  }

  // 3) Un paiement enregistre désormais l'agence où il a été fait (celle de l'école à cet instant),
  //    plus le mode Mobile Money. La colonne `mode` devient facultative, gardée pour l'historique.
  if (!(await colonneExiste('paiements', 'agence_bancaire_id'))) {
    await pool.query('ALTER TABLE paiements ADD COLUMN agence_bancaire_id BIGINT UNSIGNED NULL AFTER mode')
    log('paiements : colonne agence_bancaire_id ajoutée')
  }
  await pool.query(
    `ALTER TABLE paiements MODIFY mode ENUM('MTN MoMo','Orange Money','Airtel Money','Moov Money','Caisse école') COLLATE utf8mb4_unicode_ci NULL`
  )
  if (!(await contrainteExiste('paiements', 'fk_paiements_agence'))) {
    await pool.query('ALTER TABLE paiements ADD CONSTRAINT fk_paiements_agence FOREIGN KEY (agence_bancaire_id) REFERENCES agences_bancaires (id) ON DELETE RESTRICT')
    log('paiements : lien vers agences_bancaires créé (facultatif, pour les paiements existants)')
  }

  console.log('\n✔ Migration terminée.')
} catch (err) {
  console.error('\n✘ Migration interrompue :', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
