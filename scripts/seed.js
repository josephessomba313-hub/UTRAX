import bcrypt from 'bcryptjs'
import dotenv from 'dotenv'
import { pool } from '../src/db.js'
dotenv.config()

async function main() {
  const motDePasse = 'semence2026'
  const hash = await bcrypt.hash(motDePasse, 10)

  const [result] = await pool.query(
    'INSERT INTO ecoles (nom, ville, code, mot_de_passe_hash) VALUES (?, ?, ?, ?)',
    ['Collège Bilingue La Semence', 'Yaoundé', 'SEM2026', hash]
  )
  const ecoleId = result.insertId

  const classes = ['6ème', '5ème', '4ème', '3ème', '2nde', '1ère', 'Tle']
  const frais = [180000, 180000, 190000, 190000, 210000, 220000, 230000]
  for (let i = 0; i < classes.length; i++) {
    await pool.query(
      'INSERT INTO classes (ecole_id, nom, ordre, frais_fcfa) VALUES (?, ?, ?, ?)',
      [ecoleId, classes[i], i + 1, frais[i]]
    )
  }

  console.log('École de démonstration créée avec succès.')
  console.log('  Code établissement : SEM2026')
  console.log(`  Mot de passe       : ${motDePasse}`)
  process.exit(0)
}

main().catch((err) => {
  console.error('Échec du script de démarrage :', err.message)
  process.exit(1)
})
