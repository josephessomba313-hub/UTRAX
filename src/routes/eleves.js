import { Router } from 'express'
import { randomInt } from 'node:crypto'
import { pool } from '../db.js'
import { anneeActive } from '../annee.js'
import { verifierEcole } from '../middleware/auth-ecole.js'
import { limiteEssais } from '../middleware/limite-essais.js'

const router = Router()

// Alphabet sans caractères ambigus (ni 0/O, ni 1/I) : matricules et identifiants recopiés à la main.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function suffixeAleatoire(longueur) {
  let s = ''
  for (let i = 0; i < longueur; i++) s += ALPHABET[randomInt(ALPHABET.length)]
  return s
}

// Comparaison de noms insensible à la casse, aux accents et aux espaces multiples.
const normaliser = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim()

// Total des arriérés (toutes années, toutes écoles) rattachés à l'identifiant UTRAX de l'élève.
const SQL_ARRIERES = `(SELECT COALESCE(SUM(a.montant_fcfa), 0) FROM arrieres a WHERE a.identifiant_utrax = e.identifiant_utrax AND a.solde = FALSE)`

const MOTIFS_SORTIE = ['exclusion', 'abandon', 'diplome', 'transfert']
const LIBELLE_MOTIF = { exclusion: 'Exclusion', abandon: 'Départ en cours d\'année', diplome: 'Fin de scolarité', transfert: 'Transfert vers une autre école' }

// Antécédents d'un élève, toutes écoles confondues, à partir de son identifiant UTRAX permanent —
// utilisé avant et pendant une inscription pour qu'une école sache si l'élève a été exclu ailleurs,
// s'il est déjà inscrit activement dans une autre école, et ce qu'il doit en arriérés. Ne bloque rien :
// l'information est donnée à l'école, qui reste seule décisionnaire.
async function antecedents(identifiant, ecoleIdAIgnorer = null) {
  const [lignes] = await pool.query(
    `SELECT ec.id AS ecole_id, ec.nom AS ecole, e.nom, e.actif, e.motif_sortie AS motif, e.commentaire_sortie AS commentaire, e.sortie_le AS date
     FROM eleves e JOIN ecoles ec ON ec.id = e.ecole_id
     WHERE e.identifiant_utrax = ?
     ORDER BY e.sortie_le DESC`,
    [identifiant]
  )
  const autres = lignes.filter((l) => Number(l.ecole_id) !== Number(ecoleIdAIgnorer))
  const [arrieres] = await pool.query(
    `SELECT a.montant_fcfa AS montant, ec.nom AS ecole, an.libelle AS annee
     FROM arrieres a JOIN ecoles ec ON ec.id = a.ecole_id JOIN annees_scolaires an ON an.id = a.annee_id
     WHERE a.identifiant_utrax = ? AND a.solde = FALSE ORDER BY an.id`,
    [identifiant]
  )
  return {
    nom: lignes[0]?.nom || null,
    inscritActivementAilleurs: autres.filter((l) => l.actif).map((l) => l.ecole),
    exclusions: autres.filter((l) => l.motif === 'exclusion').map((l) => ({ ecole: l.ecole, commentaire: l.commentaire, date: l.date })),
    sorties: autres.filter((l) => l.motif && l.motif !== 'exclusion').map((l) => ({ ecole: l.ecole, motif: l.motif, libelleMotif: LIBELLE_MOTIF[l.motif], date: l.date })),
    arrieres,
    arrieresTotal: arrieres.reduce((t, a) => t + Number(a.montant), 0),
  }
}

// CÔTÉ ÉCOLE — liste des élèves de l'établissement connecté, avec solde de l'ANNÉE EN COURS.
router.get('/', verifierEcole, async (req, res) => {
  const annee = await anneeActive()
  const [eleves] = await pool.query(
    `SELECT e.id, e.matricule, e.identifiant_utrax, e.nom, e.telephone_parent, e.actif,
            e.motif_sortie, e.commentaire_sortie, e.sortie_le,
            c.id AS classe_id, c.nom AS classe, c.frais_fcfa AS frais,
            COALESCE(SUM(p.montant_fcfa), 0) AS montant_paye,
            ${SQL_ARRIERES} AS arrieres
     FROM eleves e
     JOIN classes c ON c.id = e.classe_id
     LEFT JOIN paiements p ON p.eleve_id = e.id AND p.annee_id = ? AND p.annule = FALSE
     WHERE e.ecole_id = ?
     GROUP BY e.id, e.matricule, e.identifiant_utrax, e.nom, e.telephone_parent, e.actif,
              e.motif_sortie, e.commentaire_sortie, e.sortie_le, c.id, c.nom, c.frais_fcfa
     ORDER BY e.nom`,
    [annee.id, req.ecoleId]
  )
  res.json(eleves)
})

// CÔTÉ ÉCOLE — consulter le passé d'un élève par son identifiant UTRAX AVANT de l'inscrire
// (exclusions, arriérés, inscription active ailleurs). Le nom doit correspondre, comme à l'inscription.
router.get('/identifiant/:id/antecedents', verifierEcole, async (req, res) => {
  const identifiant = req.params.id.trim().toUpperCase()
  const nomAttendu = String(req.query.nom || '').trim()
  const [existants] = await pool.query('SELECT nom FROM eleves WHERE identifiant_utrax = ?', [identifiant])
  if (existants.length === 0 || (nomAttendu && !existants.some((e) => normaliser(e.nom) === normaliser(nomAttendu)))) {
    return res.status(404).json({ erreur: 'Identifiant UTRAX inconnu, ou qui ne correspond pas au nom saisi.' })
  }
  res.json(await antecedents(identifiant, req.ecoleId))
})

// CÔTÉ ÉCOLE — inscrire un élève. Matricule généré (CODE-XXXXXX, aléatoire).
// Nouvel élève : un identifiant UTRAX permanent (UE-XXXXXXXX) lui est attribué.
// Élève venant d'une autre école : passer son identifiantUtrax ; il doit correspondre au nom saisi,
// et ses arriérés éventuels le suivent.
router.post('/', verifierEcole, async (req, res) => {
  const { nom, classeId, telephone } = req.body
  const identifiantSaisi = String(req.body.identifiantUtrax || '').trim().toUpperCase()
  if (!nom || !classeId) return res.status(400).json({ erreur: 'nom et classeId requis.' })

  try {
    const [classes] = await pool.query('SELECT id FROM classes WHERE id = ? AND ecole_id = ?', [classeId, req.ecoleId])
    if (classes.length === 0) return res.status(400).json({ erreur: 'Classe invalide pour cet établissement.' })
    const [[ecole]] = await pool.query('SELECT code FROM ecoles WHERE id = ?', [req.ecoleId])

    let identifiant
    if (identifiantSaisi) {
      const [existants] = await pool.query('SELECT nom, ecole_id FROM eleves WHERE identifiant_utrax = ?', [identifiantSaisi])
      // Même message dans les deux cas : on ne révèle pas si un identifiant existe.
      if (existants.length === 0 || !existants.some((e) => normaliser(e.nom) === normaliser(nom))) {
        return res.status(404).json({ erreur: 'Identifiant UTRAX inconnu, ou qui ne correspond pas au nom saisi.' })
      }
      if (existants.some((e) => Number(e.ecole_id) === Number(req.ecoleId))) {
        return res.status(409).json({ erreur: 'Cet élève est déjà inscrit dans votre établissement.' })
      }
      identifiant = identifiantSaisi
    } else {
      for (let essai = 0; essai < 10 && !identifiant; essai++) {
        const candidat = `UE-${suffixeAleatoire(8)}`
        const [rows] = await pool.query('SELECT 1 FROM eleves WHERE identifiant_utrax = ? LIMIT 1', [candidat])
        if (rows.length === 0) identifiant = candidat
      }
      if (!identifiant) return res.status(500).json({ erreur: "Impossible de générer un identifiant unique, réessayez." })
    }

    let matricule
    for (let essai = 0; essai < 10; essai++) {
      const candidat = `${ecole.code}-${suffixeAleatoire(6)}`
      const [existe] = await pool.query('SELECT 1 FROM eleves WHERE matricule = ?', [candidat])
      if (existe.length === 0) { matricule = candidat; break }
    }
    if (!matricule) return res.status(500).json({ erreur: 'Impossible de générer un matricule unique, réessayez.' })

    const [result] = await pool.query(
      'INSERT INTO eleves (ecole_id, classe_id, matricule, identifiant_utrax, nom, telephone_parent) VALUES (?, ?, ?, ?, ?, ?)',
      [req.ecoleId, classeId, matricule, identifiant, nom, telephone || null]
    )
    const passe = identifiantSaisi ? await antecedents(identifiant, req.ecoleId) : null
    res.status(201).json({
      id: result.insertId, matricule, identifiantUtrax: identifiant,
      arrieres: passe ? passe.arrieresTotal : 0,
      exclusions: passe ? passe.exclusions : [],
      sorties: passe ? passe.sorties : [],
      inscritActivementAilleurs: passe ? passe.inscritActivementAilleurs : [],
    })
  } catch (err) {
    res.status(500).json({ erreur: 'Échec de l\u2019inscription.', details: err.message })
  }
})

// CÔTÉ ÉCOLE — archiver un élève, avec le motif de sortie (exclusion, abandon, diplôme, transfert) —
// ce motif suit l'élève partout via son identifiant UTRAX. Réintégrer un élève efface le motif.
router.patch('/:id/statut', verifierEcole, async (req, res) => {
  const { actif } = req.body
  if (actif) {
    await pool.query(
      'UPDATE eleves SET actif = TRUE, motif_sortie = NULL, commentaire_sortie = NULL, sortie_le = NULL WHERE id = ? AND ecole_id = ?',
      [req.params.id, req.ecoleId]
    )
    return res.json({ ok: true })
  }
  const motif = String(req.body.motif || '').trim()
  if (!MOTIFS_SORTIE.includes(motif)) {
    return res.status(400).json({ erreur: `Motif requis pour archiver un élève : ${MOTIFS_SORTIE.join(', ')}.` })
  }
  const commentaire = String(req.body.commentaire || '').trim().slice(0, 500) || null
  await pool.query(
    'UPDATE eleves SET actif = FALSE, motif_sortie = ?, commentaire_sortie = ?, sortie_le = CURDATE() WHERE id = ? AND ecole_id = ?',
    [motif, commentaire, req.params.id, req.ecoleId]
  )
  res.json({ ok: true })
})

// CÔTÉ ÉCOLE — la rentrée est-elle à faire ? (une seule fois par année, après l'ouverture par UTRAX)
router.get('/rentree/etat', verifierEcole, async (req, res) => {
  const annee = await anneeActive()
  const [precedentes] = await pool.query('SELECT 1 FROM annees_scolaires WHERE id < ? LIMIT 1', [annee.id])
  const [faites] = await pool.query('SELECT 1 FROM rentrees WHERE ecole_id = ? AND annee_id = ?', [req.ecoleId, annee.id])
  res.json({ annee: annee.libelle, disponible: precedentes.length > 0 && faites.length === 0, faite: faites.length > 0 })
})

// CÔTÉ ÉCOLE — rentrée : chaque élève actif passe à la classe supérieure (ordre des classes) ;
// ceux de la dernière classe, et ceux listés dans `sortants`, sont archivés ; ceux listés dans
// `redoublants` restent dans leur classe. `tarifs` = [{ classeId, frais }] met à jour les frais annuels.
// Opération unique par année et par école (tout ou rien).
router.post('/rentree', verifierEcole, async (req, res) => {
  const annee = await anneeActive()
  const redoublants = new Set((req.body.redoublants || []).map(Number))
  // sortants : [{ id, motif }] — motif dans exclusion|abandon|diplome|transfert ; par défaut,
  // 'diplome' pour un élève sans classe supérieure, sinon 'transfert'.
  const sortants = new Map(
    (req.body.sortants || []).map((s) => (typeof s === 'object' ? [Number(s.id), s.motif] : [Number(s), null]))
  )
  const tarifs = Array.isArray(req.body.tarifs) ? req.body.tarifs : []

  const [precedentes] = await pool.query('SELECT 1 FROM annees_scolaires WHERE id < ? LIMIT 1', [annee.id])
  if (precedentes.length === 0) {
    return res.status(409).json({ erreur: "La rentrée n'est possible qu'après l'ouverture d'une nouvelle année par UTRAX." })
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [deja] = await conn.query('SELECT 1 FROM rentrees WHERE ecole_id = ? AND annee_id = ? FOR UPDATE', [req.ecoleId, annee.id])
    if (deja.length > 0) {
      await conn.rollback()
      return res.status(409).json({ erreur: `La rentrée ${annee.libelle} a déjà été effectuée pour votre établissement.` })
    }

    const [classes] = await conn.query('SELECT id, ordre FROM classes WHERE ecole_id = ? ORDER BY ordre', [req.ecoleId])
    const idsClasses = new Set(classes.map((c) => Number(c.id)))
    for (const t of tarifs) {
      const frais = parseInt(t.frais, 10)
      if (!idsClasses.has(Number(t.classeId)) || !(frais > 0)) {
        await conn.rollback()
        return res.status(400).json({ erreur: 'Tarif invalide : classe inconnue ou montant incorrect.' })
      }
      await conn.query('UPDATE classes SET frais_fcfa = ? WHERE id = ? AND ecole_id = ?', [frais, t.classeId, req.ecoleId])
    }

    const [eleves] = await conn.query(
      'SELECT e.id, c.ordre FROM eleves e JOIN classes c ON c.id = e.classe_id WHERE e.ecole_id = ? AND e.actif = TRUE',
      [req.ecoleId]
    )
    let promus = 0, restes = 0, sortis = 0
    for (const e of eleves) {
      const id = Number(e.id)
      if (redoublants.has(id)) { restes++; continue }
      const suivante = classes.find((c) => c.ordre > e.ordre)
      if (sortants.has(id) || !suivante) {
        let motif = sortants.get(id)
        if (!motif || !MOTIFS_SORTIE.includes(motif)) motif = suivante ? 'transfert' : 'diplome'
        await conn.query('UPDATE eleves SET actif = FALSE, motif_sortie = ?, sortie_le = CURDATE() WHERE id = ?', [motif, id])
        sortis++
      } else {
        await conn.query('UPDATE eleves SET classe_id = ? WHERE id = ?', [suivante.id, id])
        promus++
      }
    }

    await conn.query(
      'INSERT INTO rentrees (ecole_id, annee_id, faite_le, nb_promus, nb_redoublants, nb_sortis) VALUES (?, ?, CURDATE(), ?, ?, ?)',
      [req.ecoleId, annee.id, promus, restes, sortis]
    )
    await conn.commit()
    res.json({ annee: annee.libelle, promus, redoublants: restes, sortis })
  } catch (err) {
    await conn.rollback()
    res.status(500).json({ erreur: 'Échec de la rentrée.', details: err.message })
  } finally {
    conn.release()
  }
})

// CÔTÉ PARENT — recherche publique : école -> classe -> matricule -> fiche.
// Ne renvoie ni téléphone, ni code : seulement la fiche de l'année en cours et les arriérés éventuels.
router.get('/public/fiche', limiteEssais(), async (req, res) => {
  const { codeEcole, classe, matricule } = req.query
  if (!codeEcole || !classe || !matricule) {
    return res.status(400).json({ erreur: 'codeEcole, classe et matricule requis.' })
  }
  const annee = await anneeActive()
  const [rows] = await pool.query(
    `SELECT e.id, e.matricule, e.identifiant_utrax, e.nom, c.nom AS classe, c.frais_fcfa AS frais,
            COALESCE(SUM(p.montant_fcfa), 0) AS montant_paye,
            ag.nom AS agenceBancaire
     FROM eleves e
     JOIN classes c ON c.id = e.classe_id
     JOIN ecoles ec ON ec.id = e.ecole_id
     JOIN agences_bancaires ag ON ag.id = ec.agence_bancaire_id
     LEFT JOIN paiements p ON p.eleve_id = e.id AND p.annee_id = ? AND p.annule = FALSE
     WHERE ec.code = ? AND ec.actif = TRUE AND c.nom = ? AND e.matricule = ? AND e.actif = TRUE
     GROUP BY e.id, e.matricule, e.identifiant_utrax, e.nom, c.nom, c.frais_fcfa, ag.nom`,
    [annee.id, codeEcole.trim().toUpperCase(), classe, matricule.trim().toUpperCase()]
  )
  if (rows.length === 0) return res.status(404).json({ erreur: 'Aucun élève trouvé avec ces informations.' })

  const [arrieres] = await pool.query(
    `SELECT a.montant_fcfa AS montant, ec.nom AS ecole, an.libelle AS annee
     FROM arrieres a
     JOIN ecoles ec ON ec.id = a.ecole_id
     JOIN annees_scolaires an ON an.id = a.annee_id
     WHERE a.identifiant_utrax = ? AND a.solde = FALSE
     ORDER BY an.id`,
    [rows[0].identifiant_utrax]
  )
  res.json({ ...rows[0], arrieres })
})

// CÔTÉ PARENT — historique des paiements d'un élève (pour la fiche).
// Par défaut, seule l'année scolaire en cours est renvoyée — un élève promu ou qui redouble ne
// doit pas voir ses reçus d'années passées mélangés à ceux de l'année en cours. Passer
// ?toutesAnnees=1 renvoie l'historique complet, chaque reçu indiquant alors son année.
router.get('/:id/paiements', async (req, res) => {
  const toutesAnnees = req.query.toutesAnnees === '1'
  const annee = await anneeActive()
  const [paiements] = await pool.query(
    `SELECT p.id, p.reference, p.montant_fcfa AS montant, p.mode, p.date_paiement AS date, p.created_at AS dateHeure,
            p.annule, p.motif_annulation AS motifAnnulation, ag.nom AS agenceBancaire, an.libelle AS annee
     FROM paiements p
     LEFT JOIN agences_bancaires ag ON ag.id = p.agence_bancaire_id
     JOIN annees_scolaires an ON an.id = p.annee_id
     WHERE p.eleve_id = ? ${toutesAnnees ? '' : 'AND p.annee_id = ?'}
     ORDER BY p.created_at DESC`,
    toutesAnnees ? [req.params.id] : [req.params.id, annee.id]
  )
  res.json(paiements)
})

export default router
