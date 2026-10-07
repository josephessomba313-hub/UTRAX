// Version simple pour cette phase : une clé secrète que seul UTRAX connaît,
// envoyée dans l'en-tête "x-admin-key". Suffisant tant que c'est toi seul qui
// opères la supervision ; à remplacer par un vrai login UTRAX (avec équipe,
// rôles) quand vous serez plusieurs à l'utiliser.
export function verifierAdmin(req, res, next) {
  const cle = req.headers['x-admin-key']
  if (!cle || cle !== process.env.ADMIN_KEY) {
    return res.status(401).json({ erreur: 'Accès réservé à la supervision UTRAX.' })
  }
  next()
}
