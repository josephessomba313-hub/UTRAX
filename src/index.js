import 'dotenv/config' // doit rester le PREMIER import : les modules suivants lisent process.env en démarrant
import express from 'express'
import cors from 'cors'
import { pool } from './db.js'
import { protegerAsync } from './async-securise.js'
import { initialiserTablesAdmin } from './admin-schema.js'
import authRoutes from './routes/auth.js'
import ecolesRoutes from './routes/ecoles.js'
import elevesRoutes from './routes/eleves.js'
import paiementsRoutes from './routes/paiements.js'
import relancesRoutes from './routes/relances.js'
import reglementsRoutes from './routes/reglements.js'
import retraitsRoutes from './routes/retraits.js'
import anneesRoutes from './routes/annees.js'
import arrieresRoutes from './routes/arrieres.js'
import agencesRoutes from './routes/agences.js'
import notificationsRoutes from './routes/notifications.js'
import adminRoutes from './routes/admin.js'

// ---------- Avertissement si les clés secrètes sont encore celles de test ----------
// Ne bloque jamais le démarrage (utile en développement), mais prévient clairement avant une
// mise en ligne : ces valeurs doivent être remplacées par de longues chaînes aléatoires.
// (ADMIN_KEY ne sert plus qu'à créer le premier compte LUTRAXE ; ensuite, chaque membre de l'équipe
// se connecte avec son identifiant et son mot de passe.)
const valeursParDefaut = { ADMIN_KEY: 'change-moi-aussi', JWT_SECRET: 'change-moi-en-production' }
for (const [cle, defaut] of Object.entries(valeursParDefaut)) {
  if (!process.env[cle] || process.env[cle] === defaut) {
    console.warn(`⚠️  ${cle} a encore sa valeur de test ("${defaut}"). À changer avant toute mise en ligne (voir .env).`)
  }
}

// ---------- CORS ----------
// En développement (FRONTEND_URL absent), autorise localhost:5173 par défaut. En production,
// définissez FRONTEND_URL (ex. https://utrax-frontend.vercel.app, sans barre oblique finale) :
// seule cette adresse pourra alors appeler l'API.
const originAutorisee = process.env.FRONTEND_URL || 'http://localhost:5173'
if (!process.env.FRONTEND_URL) {
  console.warn(`⚠️  FRONTEND_URL non défini : CORS autorise seulement ${originAutorisee} par défaut. En production, définissez FRONTEND_URL.`)
}

const app = express()
// Railway place un proxy devant le serveur : sans cette ligne, req.ip serait toujours l'adresse du
// proxy et tous les visiteurs partageraient le même compteur d'essais (voir limite-essais.js).
app.set('trust proxy', 1)
app.use(cors({ origin: originAutorisee }))
app.use(express.json({ limit: '200kb' }))

app.get('/api/health', (req, res) => res.json({ statut: 'ok' }))
// Vérifie aussi la connexion à la base de données.
app.get('/api/health/db', async (req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({ statut: 'ok', base: 'ok' })
  } catch (err) {
    console.error(err)
    res.status(503).json({ statut: 'erreur', base: 'inaccessible' })
  }
})

// Toute erreur d'une route async part vers le gestionnaire d'erreurs plus bas, au lieu de laisser
// la requête sans réponse.
const routeurs = [
  authRoutes, ecolesRoutes, elevesRoutes, paiementsRoutes, relancesRoutes, reglementsRoutes,
  retraitsRoutes, anneesRoutes, arrieresRoutes, agencesRoutes, notificationsRoutes, adminRoutes,
]
routeurs.forEach(protegerAsync)

app.use('/api/auth', authRoutes)
app.use('/api/ecoles', ecolesRoutes)
app.use('/api/eleves', elevesRoutes)
app.use('/api/paiements', paiementsRoutes)
app.use('/api/relances', relancesRoutes)
app.use('/api/reglements', reglementsRoutes)
app.use('/api/retraits', retraitsRoutes)
app.use('/api/annees', anneesRoutes)
app.use('/api/arrieres', arrieresRoutes)
app.use('/api/agences', agencesRoutes)
app.use('/api/notifications', notificationsRoutes)
app.use('/api/admin', adminRoutes)

app.use('/api', (req, res) => res.status(404).json({ erreur: 'Route introuvable.' }))

// Gestionnaire d'erreurs global : le détail (souvent un message SQL) reste dans les logs Railway,
// le client reçoit un message générique.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erreur: 'Requête mal formée.' })
  if (err.type === 'entity.too.large') return res.status(413).json({ erreur: 'Requête trop volumineuse.' })
  console.error(err)
  res.status(500).json({ erreur: 'Erreur interne du serveur.' })
})

// Tables des comptes LUTRAXE : créées au besoin (sans effet si elles existent déjà).
await initialiserTablesAdmin().catch((err) => console.error('⚠️  Initialisation des comptes LUTRAXE impossible :', err.message))

const PORT = process.env.PORT || 4000
app.listen(PORT, () => console.log(`LUTRAXE API démarrée sur http://localhost:${PORT}`))
