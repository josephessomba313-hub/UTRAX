import jwt from 'jsonwebtoken'

// Jeton de fiche parent : remis quand un parent retrouve la fiche de son enfant (code
// établissement + classe + matricule). Il n'ouvre QUE cet élève, pendant 2 heures. Les routes
// de reçus, relances et notifications d'un élève l'exigent : connaître le numéro interne d'un
// élève ne suffit plus pour lire ses données.
export function signerFiche(eleveId) {
  return jwt.sign({ type: 'fiche', eleveId: Number(eleveId) }, process.env.JWT_SECRET, { expiresIn: '2h' })
}

function jetonDe(req) {
  const h = req.headers.authorization
  return h && h.startsWith('Bearer ') ? h.slice(7) : null
}

function eleveDemande(req) {
  return String(req.params.eleveId ?? req.params.id)
}

// Réservé à la fiche parent de CET élève.
export function verifierFiche(req, res, next) {
  const jeton = jetonDe(req)
  if (!jeton) return res.status(401).json({ erreur: "Recherchez à nouveau l'élève pour afficher sa fiche.", code: 'fiche_requise' })
  try {
    const p = jwt.verify(jeton, process.env.JWT_SECRET)
    if (p.type !== 'fiche' || String(p.eleveId) !== eleveDemande(req)) {
      return res.status(403).json({ erreur: 'Accès non autorisé à cette fiche.' })
    }
    next()
  } catch {
    return res.status(401).json({ erreur: "Fiche expirée : recherchez à nouveau l'élève.", code: 'fiche_expiree' })
  }
}

// Fiche parent de cet élève OU école connectée. Pour une école, req.ecoleId est renseigné et la
// route doit vérifier que l'élève appartient bien à cet établissement.
export function verifierFicheOuEcole(req, res, next) {
  const jeton = jetonDe(req)
  if (!jeton) return res.status(401).json({ erreur: 'Authentification requise.', code: 'fiche_requise' })
  try {
    const p = jwt.verify(jeton, process.env.JWT_SECRET)
    if (p.type === 'fiche') {
      if (String(p.eleveId) !== eleveDemande(req)) return res.status(403).json({ erreur: 'Accès non autorisé à cette fiche.' })
      return next()
    }
    const ecoleId = Number(p.ecoleId)
    if (!Number.isInteger(ecoleId) || ecoleId <= 0) return res.status(401).json({ erreur: 'Session invalide.', code: 'fiche_expiree' })
    req.ecoleId = ecoleId
    next()
  } catch {
    // Jeton expiré ou invalide : on lit (sans le valider) son type pour savoir qui doit se reconnecter.
    const brut = jwt.decode(jeton)
    if (brut?.type === 'fiche') return res.status(401).json({ erreur: "Fiche expirée : recherchez à nouveau l'élève.", code: 'fiche_expiree' })
    return res.status(401).json({ erreur: 'Session expirée.', code: 'session_ecole' })
  }
}
