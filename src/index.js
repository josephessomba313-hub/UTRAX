import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
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

dotenv.config()

// ---------- Avertissement si les clés secrètes sont encore celles de test ----------
// Ne bloque jamais le démarrage (utile en développement), mais prévient clairement avant une
// mise en ligne : ces valeurs doivent être remplacées par de longues chaînes aléatoires.
const valeursParDefaut = { ADMIN_KEY: 'change-moi-aussi', JWT_SECRET: 'change-moi-en-production' }
for (const [cle, defaut] of Object.entries(valeursParDefaut)) {
  if (!process.env[cle] || process.env[cle] === defaut) {
    console.warn(`⚠️  ${cle} a encore sa valeur de test ("${defaut}"). À changer avant toute mise en ligne (voir .env).`)
  }
}

// ---------- CORS ----------
// En développement (FRONTEND_URL absent), autorise localhost:5173 par défaut, pour ne rien
// casser. En production, définissez FRONTEND_URL dans le .env avec votre vraie adresse
// (ex. https://utrax.monsite.com) : seule cette adresse pourra alors appeler l'API.
const originAutorisee = process.env.FRONTEND_URL || 'http://localhost:5173'
if (!process.env.FRONTEND_URL) {
  console.warn(`⚠️  FRONTEND_URL non défini : CORS autorise seulement ${originAutorisee} par défaut. En production, définissez FRONTEND_URL dans le .env.`)
}

const app = express()
app.use(cors({ origin: originAutorisee }))
app.use(express.json())

app.get('/api/health', (req, res) => res.json({ statut: 'ok' }))

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

const PORT = process.env.PORT || 4000
app.listen(PORT, () => console.log(`UTRAX API démarrée sur http://localhost:${PORT}`))
