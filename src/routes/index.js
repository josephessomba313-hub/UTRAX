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
const app = express()
app.use(cors())
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
