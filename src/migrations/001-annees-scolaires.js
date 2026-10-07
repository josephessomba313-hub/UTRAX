// Migration 001 — années scolaires, identifiant UTRAX permanent, arriérés, rentrée.
//
// À lancer UNE FOIS, depuis le dossier du backend :
//     node src/migrations/001-annees-scolaires.js
//
// FAITES UNE SAUVEGARDE DE LA BASE AVANT. Le script peut être relancé sans danger :
// chaque étape vérifie d'abord si elle a déjà été faite.
import { randomInt } from 'node:crypto'

await import('dotenv/config').catch(() => {}) // charge le .env si dotenv est installé
const { pool } = await import('../db.js')

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const suffixe = (n) => Array.from({ length: n }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')

// Année scolaire camerounaise : commence début septembre.
function libelleCourant(date = new Date()) {
  const y = date.getFullYear()
  return date.getMonth() >= 8 ? `${y}-${y + 1}` : `${y - 1}-${y}`
}

async function existe(sql, params) { const [r] = await pool.query(sql, params); return r.length > 0 }
const colonneExiste = (t, c) => existe('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [t, c])
const contrainteExiste = (t, n) => existe('SELECT 1 FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = ?', [t, n])
const indexExiste = (t, n) => existe('SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?', [t, n])
const log = (m) => console.log('•', m)

async function rattacherAnnee(table, contrainte, anneeId, apres) {
  if (!(await colonneExiste(table, 'annee_id'))) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN annee_id BIGINT UNSIGNED NULL AFTER ${apres}`)
    log(`${table} : colonne annee_id ajoutée`)
  }
  const [r] = await pool.query(`UPDATE ${table} SET annee_id = ? WHERE annee_id IS NULL`, [anneeId])
  if (r.affectedRows) log(`${table} : ${r.affectedRows} ligne(s) rattachée(s) à l'année initiale`)
  await pool.query(`ALTER TABLE ${table} MODIFY annee_id BIGINT UNSIGNED NOT NULL`)
  if (!(await contrainteExiste(table, contrainte))) {
    await pool.query(`ALTER TABLE ${table} ADD CONSTRAINT ${contrainte} FOREIGN KEY (annee_id) REFERENCES annees_scolaires (id) ON DELETE RESTRICT`)
    log(`${table} : lien vers annees_scolaires créé`)
  }
}

try {
  // 1) Années scolaires
  await pool.query(`CREATE TABLE IF NOT EXISTS annees_scolaires (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    libelle VARCHAR(9) COLLATE utf8mb4_unicode_ci NOT NULL,
    active TINYINT(1) NOT NULL DEFAULT 0,
    ouverte_le DATE NOT NULL,
    cloturee_le DATE NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_annee_libelle (libelle)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  let anneeId
  const [actives] = await pool.query('SELECT id, libelle FROM annees_scolaires WHERE active = TRUE LIMIT 1')
  if (actives.length) {
    anneeId = Number(actives[0].id)
    log(`Année active déjà en place : ${actives[0].libelle}`)
  } else {
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM annees_scolaires')
    if (Number(n) > 0) throw new Error("Des années existent mais aucune n'est active : corrigez la table annees_scolaires à la main.")
    const libelle = libelleCourant()
    const [ins] = await pool.query('INSERT INTO annees_scolaires (libelle, active, ouverte_le) VALUES (?, 1, CURDATE())', [libelle])
    anneeId = Number(ins.insertId)
    log(`Année initiale créée et activée : ${libelle}`)
  }

  // 2) Identifiant UTRAX permanent des élèves
  if (!(await colonneExiste('eleves', 'identifiant_utrax'))) {
    await pool.query('ALTER TABLE eleves ADD COLUMN identifiant_utrax VARCHAR(16) COLLATE utf8mb4_unicode_ci NULL AFTER matricule')
    log('eleves : colonne identifiant_utrax ajoutée')
  }
  const [sans] = await pool.query('SELECT id FROM eleves WHERE identifiant_utrax IS NULL')
  if (sans.length) {
    const [pris] = await pool.query('SELECT identifiant_utrax FROM eleves WHERE identifiant_utrax IS NOT NULL')
    const utilises = new Set(pris.map((r) => r.identifiant_utrax))
    for (const e of sans) {
      let id
      do { id = `UE-${suffixe(8)}` } while (utilises.has(id))
      utilises.add(id)
      await pool.query('UPDATE eleves SET identifiant_utrax = ? WHERE id = ?', [id, e.id])
    }
    log(`${sans.length} élève(s) ont reçu un identifiant UTRAX`)
  }
  await pool.query('ALTER TABLE eleves MODIFY identifiant_utrax VARCHAR(16) COLLATE utf8mb4_unicode_ci NOT NULL')
  if (!(await indexExiste('eleves', 'uq_identifiant_par_ecole'))) {
    await pool.query('ALTER TABLE eleves ADD UNIQUE KEY uq_identifiant_par_ecole (identifiant_utrax, ecole_id)')
  }

  // 3) Paiements et règlements rattachés à une année
  await rattacherAnnee('paiements', 'fk_paiements_annee', anneeId, 'eleve_id')
  await rattacherAnnee('reglements', 'fk_reglements_annee', anneeId, 'ecole_id')

  // 4) Arriérés (créés à l'ouverture d'une nouvelle année) et rentrées faites par les écoles
  await pool.query(`CREATE TABLE IF NOT EXISTS arrieres (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    identifiant_utrax VARCHAR(16) COLLATE utf8mb4_unicode_ci NOT NULL,
    ecole_id BIGINT UNSIGNED NOT NULL,
    eleve_id BIGINT UNSIGNED NULL,
    nom_eleve VARCHAR(150) COLLATE utf8mb4_unicode_ci NOT NULL,
    classe VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    annee_id BIGINT UNSIGNED NOT NULL,
    montant_fcfa INT UNSIGNED NOT NULL,
    cree_le DATE NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_arriere_annee (annee_id, identifiant_utrax, ecole_id),
    KEY idx_arrieres_identifiant (identifiant_utrax),
    CONSTRAINT fk_arrieres_ecole FOREIGN KEY (ecole_id) REFERENCES ecoles (id) ON DELETE RESTRICT,
    CONSTRAINT fk_arrieres_eleve FOREIGN KEY (eleve_id) REFERENCES eleves (id) ON DELETE SET NULL,
    CONSTRAINT fk_arrieres_annee FOREIGN KEY (annee_id) REFERENCES annees_scolaires (id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  await pool.query(`CREATE TABLE IF NOT EXISTS rentrees (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    ecole_id BIGINT UNSIGNED NOT NULL,
    annee_id BIGINT UNSIGNED NOT NULL,
    faite_le DATE NOT NULL,
    nb_promus INT UNSIGNED NOT NULL DEFAULT 0,
    nb_redoublants INT UNSIGNED NOT NULL DEFAULT 0,
    nb_sortis INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uq_rentree (ecole_id, annee_id),
    CONSTRAINT fk_rentrees_ecole FOREIGN KEY (ecole_id) REFERENCES ecoles (id) ON DELETE CASCADE,
    CONSTRAINT fk_rentrees_annee FOREIGN KEY (annee_id) REFERENCES annees_scolaires (id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  // Les écoles existantes démarrent dans l'année initiale : pas de rentrée à faire pour elle.
  await pool.query('INSERT IGNORE INTO rentrees (ecole_id, annee_id, faite_le) SELECT id, ?, CURDATE() FROM ecoles', [anneeId])

  // 5) La vue v_soldes_eleves ne doit compter que l'année active
  try {
    await pool.query(`CREATE OR REPLACE VIEW v_soldes_eleves AS
      SELECT e.id AS eleve_id, e.ecole_id AS ecole_id, e.nom AS nom, c.nom AS classe, c.frais_fcfa AS frais_fcfa,
             COALESCE(SUM(p.montant_fcfa), 0) AS montant_paye,
             (c.frais_fcfa - COALESCE(SUM(p.montant_fcfa), 0)) AS solde_du
      FROM eleves e
      JOIN classes c ON c.id = e.classe_id
      LEFT JOIN paiements p ON p.eleve_id = e.id AND p.annee_id = (SELECT id FROM annees_scolaires WHERE active = 1 LIMIT 1)
      WHERE e.actif = TRUE
      GROUP BY e.id, e.ecole_id, e.nom, c.nom, c.frais_fcfa`)
    log('Vue v_soldes_eleves mise à jour (année active)')
  } catch (err) {
    console.warn('⚠ Vue v_soldes_eleves non mise à jour (sans effet sur l\'application) :', err.message)
  }

  console.log('\n✔ Migration terminée.')
} catch (err) {
  console.error('\n✘ Migration interrompue :', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
