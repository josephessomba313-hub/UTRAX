// Migration 008 — lie chaque paiement au virement (règlement) qui l'a réglé.
//
// Avant : « ce qui reste à virer » = total des paiements - total des règlements, un calcul qui
// comptait les paiements annulés, mélangeait les années et permettait de virer deux fois la même
// somme. Après : un paiement est « en attente » tant que sa colonne reglement_id est vide ; le
// virement marque exactement les paiements qu'il règle, et un paiement déjà viré ne peut plus
// être annulé par l'école.
// La vue v_soldes_eleves ignore aussi, désormais, les paiements annulés.
//
// À lancer UNE FOIS, depuis le dossier du backend :
//     node src/migrations/008-lien-paiements-reglements.js
// FAITES UNE SAUVEGARDE AVANT. Peut être relancée sans danger.
await import('dotenv/config').catch(() => {})
const { pool } = await import('../db.js')

async function existe(sql, params) { const [r] = await pool.query(sql, params); return r.length > 0 }
const colonneExiste = (t, c) => existe('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [t, c])
const contrainteExiste = (t, n) => existe('SELECT 1 FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = ?', [t, n])
const log = (m) => console.log('•', m)

try {
  if (!(await colonneExiste('paiements', 'reglement_id'))) {
    // On ne sait pas retrouver, après coup, quels paiements un ancien règlement a réglés :
    // la migration ne s'applique qu'à une base où aucun virement n'a encore été généré.
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM reglements')
    if (Number(n) > 0) {
      throw new Error("Des règlements existent déjà : cette migration ne sait pas les rattacher aux paiements. Ne la lancez pas avant d'avoir un script de rattachement.")
    }
    await pool.query('ALTER TABLE paiements ADD COLUMN reglement_id BIGINT UNSIGNED NULL AFTER annule_le')
    log('paiements : colonne reglement_id ajoutée')
  }
  if (!(await contrainteExiste('paiements', 'fk_paiements_reglement'))) {
    await pool.query('ALTER TABLE paiements ADD CONSTRAINT fk_paiements_reglement FOREIGN KEY (reglement_id) REFERENCES reglements (id) ON DELETE RESTRICT')
    log('paiements : lien vers reglements créé')
  }

  try {
    await pool.query(`CREATE OR REPLACE VIEW v_soldes_eleves AS
      SELECT e.id AS eleve_id, e.ecole_id AS ecole_id, e.nom AS nom, c.nom AS classe, c.frais_fcfa AS frais_fcfa,
             COALESCE(SUM(p.montant_fcfa), 0) AS montant_paye,
             (c.frais_fcfa - COALESCE(SUM(p.montant_fcfa), 0)) AS solde_du
      FROM eleves e
      JOIN classes c ON c.id = e.classe_id
      LEFT JOIN paiements p ON p.eleve_id = e.id AND p.annule = 0 AND p.annee_id = (SELECT id FROM annees_scolaires WHERE active = 1 LIMIT 1)
      WHERE e.actif = TRUE
      GROUP BY e.id, e.ecole_id, e.nom, c.nom, c.frais_fcfa`)
    log('Vue v_soldes_eleves mise à jour (paiements annulés ignorés)')
  } catch (err) {
    console.warn("⚠ Vue v_soldes_eleves non mise à jour (sans effet sur l'application) :", err.message)
  }

  console.log('\n✔ Migration terminée.')
} catch (err) {
  console.error('\n✘ Migration interrompue :', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
