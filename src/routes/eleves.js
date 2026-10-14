import { Router } from 'express'
import { randomInt } from 'node:crypto'
import { pool } from '../db.js'
import { anneeActive } from '../annee.js'
import { verifierEcole } from '../middleware/auth-ecole.js'
import { limiteEssais } from '../middleware/limite-essais.js'
import { signerFiche, verifierFicheOuEcole } from '../middleware/auth-fiche.js'

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

// Total des arriérés (toutes années, toutes écoles) rattachés à l'identifiant LUTRAXE de l'élève.
const SQL_ARRIERES = `(SELECT COALESCE(SUM(a.montant_fcfa), 0) FROM arrieres a WHERE a.identifiant_utrax = e.identifiant_utrax AND a.solde = FALSE)`

const MOTIFS_SORTIE = ['exclusion', 'abandon', 'diplome', 'transfert']
const LIBELLE_MOTIF = { exclusion: 'Exclusion', abandon: 'Départ en cours d\'année', diplome: 'Fin de scolarité', transfert: 'Transfert vers une autre école' }

// Antécédents d'un élève, toutes écoles confondues, à partir de son identifiant LUTRAXE permanent —
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

// CÔTÉ ÉCOLE — consulter le passé d'un élève par son identifiant LUTRAXE AVANT de l'inscrire
// (exclusions, arriérés, inscription active ailleurs). Le nom doit correspondre, comme à l'inscription.
router.get('/identifiant/:id/antecedents', verifierEcole, limiteEssais({ max: 20, cle: (req) => `antecedents:${req.ecoleId}` }), async (req, res) => {
  const identifiant = req.params.id.trim().toUpperCase()
  const nomAttendu = String(req.query.nom || '').trim()
  const [existants] = await pool.query('SELECT nom FROM eleves WHERE identifiant_utrax = ?', [identifiant])
  if (existants.length === 0 || (nomAttendu && !existants.some((e) => normaliser(e.nom) === normaliser(nomAttendu)))) {
    return res.status(404).json({ erreur: 'Identifiant LUTRAXE inconnu, ou qui ne correspond pas au nom saisi.' })
  }
  res.json(await antecedents(identifiant, req.ecoleId))
})

// CÔTÉ ÉCOLE — inscrire un élève. Matricule généré (CODE-XXXXXX, aléatoire).
// Nouvel élève : un identifiant LUTRAXE permanent (UE-XXXXXXXX) lui est attribué.
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
        return res.status(404).json({ erreur: 'Identifiant LUTRAXE inconnu, ou qui ne correspond pas au nom saisi.' })
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
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ erreur: 'Conflit pendant l\u2019inscription (élève déjà inscrit ou matricule déjà pris), réessayez.' })
    console.error(err)
    res.status(500).json({ erreur: 'Échec de l\u2019inscription.' })
  }
})

// CÔTÉ ÉCOLE — archiver un élève, avec le motif de sortie (exclusion, abandon, diplôme, transfert) —
// ce motif suit l'élève partout via son identifiant LUTRAXE. Réintégrer un élève efface le motif.
router.patch('/:id/statut', verifierEcole, async (req, res) => {
  const { actif } = req.body
  let motif = null
  let commentaire = null
  if (!actif) {
    motif = String(req.body.motif || '').trim()
    if (!MOTIFS_SORTIE.includes(motif)) {
      return res.status(400).json({ erreur: `Motif requis pour archiver un élève : ${MOTIFS_SORTIE.join(', ')}.` })
    }
    commentaire = String(req.body.commentaire || '').trim().slice(0, 500) || null
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    // Verrou partagé sur l'année active (pas de bascule d'année pendant l'opération), puis verrou
    // sur l'élève (pas de paiement en même temps : le calcul du reste dû reste exact).
    const [annees] = await conn.query('SELECT id FROM annees_scolaires WHERE active = TRUE LIMIT 1 FOR SHARE')
    if (annees.length === 0) {
      await conn.rollback()
      return res.status(500).json({ erreur: 'Aucune année scolaire active.' })
    }
    const anneeId = Number(annees[0].id)
    const [eleves] = await conn.query(
      `SELECT e.id, e.identifiant_utrax, e.nom, c.nom AS classe, c.frais_fcfa AS frais
       FROM eleves e JOIN classes c ON c.id = e.classe_id
       WHERE e.id = ? AND e.ecole_id = ?
       FOR UPDATE OF e`,
      [req.params.id, req.ecoleId]
    )
    if (eleves.length === 0) {
      await conn.rollback()
      return res.status(404).json({ erreur: 'Élève introuvable dans cet établissement.' })
    }
    const eleve = eleves[0]

    if (actif) {
      await conn.query(
        'UPDATE eleves SET actif = TRUE, motif_sortie = NULL, commentaire_sortie = NULL, sortie_le = NULL WHERE id = ?',
        [eleve.id]
      )
      // L'arriéré créé à l'archivage n'a plus lieu d'être : l'élève est de nouveau compté normalement.
      // (Un arriéré déjà soldé par LUTRAXE, ou celui d'une année précédente, n'est pas touché.)
      await conn.query(
        'DELETE FROM arrieres WHERE annee_id = ? AND eleve_id = ? AND ecole_id = ? AND solde = FALSE',
        [anneeId, eleve.id, req.ecoleId]
      )
      await conn.commit()
      return res.json({ ok: true })
    }

    await conn.query(
      'UPDATE eleves SET actif = FALSE, motif_sortie = ?, commentaire_sortie = ?, sortie_le = CURDATE() WHERE id = ?',
      [motif, commentaire, eleve.id]
    )

    // Un élève qui quitte l'établissement avec une scolarité impayée laisse un arriéré, rattaché à son
    // identifiant LUTRAXE : il apparaît dans la fiche du parent et dans la vérification faite par une
    // nouvelle école (sans jamais bloquer l'inscription).
    const [[{ paye }]] = await conn.query(
      'SELECT COALESCE(SUM(montant_fcfa), 0) AS paye FROM paiements WHERE eleve_id = ? AND annee_id = ? AND annule = FALSE',
      [eleve.id, anneeId]
    )
    const reste = Number(eleve.frais) - Number(paye)
    const [existant] = await conn.query(
      'SELECT id, solde FROM arrieres WHERE annee_id = ? AND identifiant_utrax = ? AND ecole_id = ? FOR UPDATE',
      [anneeId, eleve.identifiant_utrax, req.ecoleId]
    )
    let arriere = 0
    if (reste > 0) {
      if (existant.length === 0) {
        await conn.query(
          `INSERT INTO arrieres (identifiant_utrax, ecole_id, eleve_id, nom_eleve, classe, annee_id, montant_fcfa, cree_le)
           VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE())`,
          [eleve.identifiant_utrax, req.ecoleId, eleve.id, eleve.nom, eleve.classe, anneeId, reste]
        )
        arriere = reste
      } else if (!existant[0].solde) {
        await conn.query('UPDATE arrieres SET montant_fcfa = ?, eleve_id = ?, nom_eleve = ?, classe = ? WHERE id = ?',
          [reste, eleve.id, eleve.nom, eleve.classe, existant[0].id])
        arriere = reste
      }
    } else if (existant.length > 0 && !existant[0].solde) {
      await conn.query('DELETE FROM arrieres WHERE id = ?', [existant[0].id]) // soldé entre-temps : plus de dette
    }
    await conn.commit()
    res.json({ ok: true, arriere })
  } catch (err) {
    await conn.rollback().catch(() => {})
    console.error(err)
    res.status(500).json({ erreur: 'Échec du changement de statut.' })
  } finally {
    conn.release()
  }
})

// CÔTÉ ÉCOLE — la rentrée est-elle à faire ? (une seule fois par année, après l'ouverture par LUTRAXE)
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
    return res.status(409).json({ erreur: "La rentrée n'est possible qu'après l'ouverture d'une nouvelle année par LUTRAXE." })
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
    console.error(err)
    res.status(500).json({ erreur: 'Échec de la rentrée.' })
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
  // Le jeton ouvre uniquement les reçus, relances et notifications de CET élève (2 h).
  res.json({ ...rows[0], arrieres, jeton: signerFiche(rows[0].id) })
})

// CÔTÉ PARENT — historique des paiements d'un élève (pour la fiche).
// Par défaut, seule l'année scolaire en cours est renvoyée — un élève promu ou qui redouble ne
// doit pas voir ses reçus d'années passées mélangés à ceux de l'année en cours. Passer
// ?toutesAnnees=1 renvoie l'historique complet, chaque reçu indiquant alors son année.
router.get('/:id/paiements', verifierFicheOuEcole, async (req, res) => {
  if (req.ecoleId) {
    // Une école ne peut consulter que ses propres élèves.
    const [propres] = await pool.query('SELECT 1 FROM eleves WHERE id = ? AND ecole_id = ?', [req.params.id, req.ecoleId])
    if (propres.length === 0) return res.status(404).json({ erreur: 'Élève introuvable dans cet établissement.' })
  }
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

// CÔTÉ ÉCOLE — corriger le nom d'un élève, UNIQUEMENT en cas d'erreur de saisie à l'enregistrement.
// Le nom sert aussi à reconnaître l'élève quand il change d'établissement (identifiant LUTRAXE + nom) :
// la correction est donc encadrée.
//   - dans les 30 jours qui suivent l'enregistrement, 3 corrections au maximum par élève ;
//   - refusée si l'élève est aussi enregistré dans un autre établissement (son nom y est déjà connu) ;
//   - l'école doit confirmer qu'il s'agit d'une erreur de saisie ;
//   - l'ancien nom est conservé dans l'historique (table corrections_nom_eleves).
const FENETRE_CORRECTION_NOM_JOURS = 30
const MAX_CORRECTIONS_NOM = 3

router.patch('/:id/nom', verifierEcole, async (req, res) => {
  const nom = String(req.body.nom || '').trim().replace(/\s+/g, ' ')
  if (nom.length < 2 || nom.length > 150) return res.status(400).json({ erreur: 'Le nom doit contenir entre 2 et 150 caractères.' })
  if (req.body.confirmeErreur !== true) return res.status(400).json({ erreur: "Confirmez qu'il s'agit d'une erreur de saisie à l'enregistrement." })

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [eleves] = await conn.query(
      `SELECT id, nom, identifiant_utrax, DATEDIFF(NOW(), created_at) AS jours
       FROM eleves WHERE id = ? AND ecole_id = ? FOR UPDATE`,
      [req.params.id, req.ecoleId]
    )
    if (eleves.length === 0) {
      await conn.rollback()
      return res.status(404).json({ erreur: 'Élève introuvable dans cet établissement.' })
    }
    const eleve = eleves[0]
    if (eleve.nom === nom) {
      await conn.rollback()
      return res.status(400).json({ erreur: 'Le nom saisi est identique au nom actuel.' })
    }
    if (Number(eleve.jours) > FENETRE_CORRECTION_NOM_JOURS) {
      await conn.rollback()
      return res.status(409).json({ erreur: `Le nom ne peut être corrigé que dans les ${FENETRE_CORRECTION_NOM_JOURS} jours suivant l'enregistrement de l'élève. Contactez LUTRAXE si une correction reste nécessaire.` })
    }
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM corrections_nom_eleves WHERE eleve_id = ?', [eleve.id])
    if (Number(n) >= MAX_CORRECTIONS_NOM) {
      await conn.rollback()
      return res.status(409).json({ erreur: `Le nom de cet élève a déjà été corrigé ${MAX_CORRECTIONS_NOM} fois. Contactez LUTRAXE.` })
    }
    const [ailleurs] = await conn.query(
      'SELECT 1 FROM eleves WHERE identifiant_utrax = ? AND ecole_id <> ? LIMIT 1',
      [eleve.identifiant_utrax, req.ecoleId]
    )
    if (ailleurs.length > 0) {
      await conn.rollback()
      return res.status(409).json({ erreur: "Cet élève est aussi enregistré dans un autre établissement : son nom ne peut pas être modifié ici. Contactez LUTRAXE." })
    }

    await conn.query('UPDATE eleves SET nom = ? WHERE id = ?', [nom, eleve.id])
    await conn.query(
      'INSERT INTO corrections_nom_eleves (eleve_id, ecole_id, ancien_nom, nouveau_nom) VALUES (?, ?, ?, ?)',
      [eleve.id, req.ecoleId, eleve.nom, nom]
    )
    // Les arriérés déjà enregistrés à son nom suivent la correction.
    await conn.query('UPDATE arrieres SET nom_eleve = ? WHERE eleve_id = ? AND ecole_id = ?', [nom, eleve.id, req.ecoleId])
    await conn.commit()
    res.json({ ok: true, nom })
  } catch (err) {
    await conn.rollback().catch(() => {})
    console.error(err)
    res.status(500).json({ erreur: 'Échec de la correction du nom.' })
  } finally {
    conn.release()
  }
})

// CÔTÉ ÉCOLE — corriger la classe d'un élève inscrit dans la mauvaise classe, UNIQUEMENT en cas d'erreur
// d'enregistrement. (Le passage normal à la classe supérieure se fait par la « rentrée ».)
// Garde-fous : élève actif, classe du même établissement, dans les 30 jours qui suivent l'enregistrement,
// 3 corrections au maximum, confirmation de l'école, historique conservé, et refus si les paiements déjà
// faits dépassent les frais de la nouvelle classe. Les paiements restent rattachés à l'élève : seul son
// solde change, selon les frais de la bonne classe.
router.patch('/:id/classe', verifierEcole, async (req, res) => {
  const classeId = Number(req.body.classeId)
  if (!Number.isInteger(classeId) || classeId <= 0) return res.status(400).json({ erreur: 'Classe invalide.' })
  if (req.body.confirmeErreur !== true) return res.status(400).json({ erreur: "Confirmez qu'il s'agit d'une erreur d'enregistrement." })

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    // Verrou partagé sur l'année active, puis verrou sur l'élève (pas de paiement en même temps).
    const [annees] = await conn.query('SELECT id FROM annees_scolaires WHERE active = TRUE LIMIT 1 FOR SHARE')
    if (annees.length === 0) {
      await conn.rollback()
      return res.status(500).json({ erreur: 'Aucune année scolaire active.' })
    }
    const anneeId = Number(annees[0].id)

    const [eleves] = await conn.query(
      `SELECT e.id, e.actif, e.classe_id, c.nom AS classe, DATEDIFF(NOW(), e.created_at) AS jours
       FROM eleves e JOIN classes c ON c.id = e.classe_id
       WHERE e.id = ? AND e.ecole_id = ?
       FOR UPDATE OF e`,
      [req.params.id, req.ecoleId]
    )
    if (eleves.length === 0) {
      await conn.rollback()
      return res.status(404).json({ erreur: 'Élève introuvable dans cet établissement.' })
    }
    const eleve = eleves[0]
    if (!eleve.actif) {
      await conn.rollback()
      return res.status(409).json({ erreur: "Cet élève est archivé : réintégrez-le avant de corriger sa classe." })
    }
    if (Number(eleve.classe_id) === classeId) {
      await conn.rollback()
      return res.status(400).json({ erreur: "L'élève est déjà dans cette classe." })
    }
    const [classes] = await conn.query('SELECT id, nom, frais_fcfa FROM classes WHERE id = ? AND ecole_id = ?', [classeId, req.ecoleId])
    if (classes.length === 0) {
      await conn.rollback()
      return res.status(400).json({ erreur: 'Classe invalide pour cet établissement.' })
    }
    const nouvelle = classes[0]

    if (Number(eleve.jours) > FENETRE_CORRECTION_NOM_JOURS) {
      await conn.rollback()
      return res.status(409).json({ erreur: `La classe ne peut être corrigée que dans les ${FENETRE_CORRECTION_NOM_JOURS} jours suivant l'enregistrement de l'élève. Contactez LUTRAXE si une correction reste nécessaire.` })
    }
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM corrections_classe_eleves WHERE eleve_id = ?', [eleve.id])
    if (Number(n) >= MAX_CORRECTIONS_NOM) {
      await conn.rollback()
      return res.status(409).json({ erreur: `La classe de cet élève a déjà été corrigée ${MAX_CORRECTIONS_NOM} fois. Contactez LUTRAXE.` })
    }
    const [[{ paye }]] = await conn.query(
      'SELECT COALESCE(SUM(montant_fcfa), 0) AS paye FROM paiements WHERE eleve_id = ? AND annee_id = ? AND annule = FALSE',
      [eleve.id, anneeId]
    )
    if (Number(paye) > Number(nouvelle.frais_fcfa)) {
      await conn.rollback()
      return res.status(409).json({
        erreur: `Cet élève a déjà payé ${Number(paye).toLocaleString('fr-FR')} FCFA, plus que les frais de la classe « ${nouvelle.nom} » (${Number(nouvelle.frais_fcfa).toLocaleString('fr-FR')} FCFA). Annulez d'abord le paiement en trop, ou contactez LUTRAXE.`,
      })
    }

    await conn.query('UPDATE eleves SET classe_id = ? WHERE id = ?', [classeId, eleve.id])
    await conn.query(
      'INSERT INTO corrections_classe_eleves (eleve_id, ecole_id, ancienne_classe, nouvelle_classe) VALUES (?, ?, ?, ?)',
      [eleve.id, req.ecoleId, eleve.classe, nouvelle.nom]
    )
    await conn.commit()
    res.json({ ok: true, classe: nouvelle.nom, frais: Number(nouvelle.frais_fcfa) })
  } catch (err) {
    await conn.rollback().catch(() => {})
    console.error(err)
    res.status(500).json({ erreur: 'Échec de la correction de la classe.' })
  } finally {
    conn.release()
  }
})

export default router
