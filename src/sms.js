// Envoi de SMS via Twilio — utilisé pour les codes de vérification de l'espace parent.
// Nécessite dans le .env du backend : TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
// (un numéro Twilio capable d'envoyer des SMS). Voir https://www.twilio.com/console pour les créer.
//
// ⚠️ Pour des numéros camerounais, vérifiez dans la console Twilio que l'envoi vers le Cameroun
// est activé pour votre compte (Geographic Permissions), et qu'un expéditeur alphanumérique ou
// un numéro compatible est configuré — certains pays africains imposent des règles spécifiques
// que Twilio documente au cas par cas.
import twilio from 'twilio'

const client = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null

export function smsConfigure() {
  return !!(client && process.env.TWILIO_FROM_NUMBER)
}

export async function envoyerSms(telephoneE164, message) {
  if (!smsConfigure()) {
    throw new Error("Envoi de SMS non configuré côté serveur (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER manquants dans le .env).")
  }
  await client.messages.create({ body: message, from: process.env.TWILIO_FROM_NUMBER, to: telephoneE164 })
}

// Normalise un numéro camerounais saisi sous diverses formes (6XXXXXXXX, 06XXXXXXXX,
// +2376XXXXXXXX, 2376XXXXXXXX...) vers le format international E.164 requis par Twilio.
export function normaliserTelephone(saisie) {
  let s = String(saisie || '').replace(/[\s.\-()]/g, '')
  if (s.startsWith('+')) return s
  if (s.startsWith('00')) return '+' + s.slice(2)
  if (s.startsWith('237')) return '+' + s
  if (s.startsWith('0')) s = s.slice(1)
  if (/^[26]\d{8}$/.test(s)) return '+237' + s
  return null // format non reconnu
}
