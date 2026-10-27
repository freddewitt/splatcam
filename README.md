# SplatCam

**Une caméra de cinéma pour les scènes en Gaussian Splats.**

SplatCam traite une scène capturée en Gaussian Splats comme un plateau de tournage. On y pose une vraie caméra avec un vrai objectif, on planifie ses mouvements sur une timeline, puis on exporte un rendu de qualité cinéma en séquence d'images 16 bits ou en aperçu MP4.

Le rendu se veut physiquement crédible : un objectif à f/1.4 mis au point à 2 m se comporte comme un f/1.4 à 2 m. Tout est exprimé en mètres grâce à une échelle de scène réglable.

L'application tourne en local dans Chrome sur un Mac Apple Silicon. Elle n'a ni serveur distant, ni compte, ni télémétrie : rien ne quitte la machine.

![Interface de SplatCam](docs/captures/refonte-ui.png)

> **Statut : v0.1, usage personnel.** Les fonctions principales sont en place et testées. Plusieurs restent à valider à l'œil sur de vraies scènes (voir [CHANGELOG](CHANGELOG.md) et [docs/avancement.md](docs/avancement.md)).

---

## Pourquoi c'est différent

Les splats n'écrivent pas dans le depth buffer. Une profondeur de champ en post-traitement, calculée d'après la profondeur, est donc impossible. SplatCam fait comme une vraie caméra : il **accumule des centaines de sous-rendus** en HDR linéaire.

- Chaque sous-rendu déplace la caméra sur un point de la pupille de l'objectif et le place à un instant de la fenêtre d'obturation. Le tirage est stratifié (Halton) sur l'ouverture et sur le temps.
- La projection est cisaillée pour que le plan de netteté tombe toujours au même pixel. Ce qui est au point reste net, et le reste se brouille exactement selon le cercle de confusion.
- Le caractère du bokeh vient uniquement de la distribution des échantillons d'ouverture : forme des lames, anneaux, cat-eye, swirl, aberration sphérique, squeeze anamorphique.
- Le flou de mouvement vient du même mécanisme : chaque échantillon lit la caméra, la mise au point et le zoom à son propre instant.

En exploration, l'aperçu tourne avec peu d'échantillons. Dès que la caméra s'arrête, l'image s'affine progressivement jusqu'au nombre cible. L'export peut monter jusqu'à 1024 échantillons par image.

## Fonctions principales

### Caméra et objectif
- **Formats de capteur** du Super 8 au moyen format (Super 16, Super 35, Full Frame…). Le champ de vision horizontal, vertical et diagonal est calculé et affiché.
- **Deux caméras** : une caméra d'exploration libre et une caméra de tournage cadrée au rapport du capteur.
- **34 objectifs**, dont 24 séries réelles (ARRI, Cooke, Zeiss, Leica, Canon, anamorphiques, zooms, vintage), avec leurs focales, leur ouverture max., leur distance de mise au point minimale et leurs défauts optiques.
- **Profondeur de champ** physique : ouverture de f/1.2 à f/22, mise au point en mètres ou par clic sur la scène, affichage de l'hyperfocale et des limites de netteté.
- **Bokeh** paramétrable : disque ou polygone à N lames, arrondi, onion rings, cat-eye, swirl, aberration sphérique, anamorphique.
- **Tilt / shift** : décentrement par frustum asymétrique, bascule de Scheimpflug (plan de netteté incliné).

### Timeline de plan
- Pistes séparées : position X / Y / Z, pan / tilt / roll, mise au point, zoom.
- Éditeur de courbes à poignées Bézier, avec des clés Bézier, linéaires ou en palier.
- Mise au point sur une échelle de bague de map (en dioptries), zoom sur une échelle logarithmique.
- **Mode enregistrement** : on bouge la caméra ou on tire la bague de map à la main, et les clés se posent.
- Lecture, scrub, boucle, image par image.

### Obturateur et défauts de caméra
- Angle d'obturation de 0 à 360°, cadences de 23,976 à 60 i/s.
- Rolling shutter, gate weave.

### Optique et pellicule
Tout reste en lumière linéaire jusqu'à l'affichage. Un gain des hautes lumières pousse les splats au-delà de 1.0 pour que le bloom et la halation réagissent.
- Bloom, halation, étoiles de diffraction (liées aux lames), streaks anamorphiques, ghosts, lens dirt.
- Vignettage, distorsion, aberration chromatique.
- Bruit capteur lié à l'ISO (100 à 12800), grain de pellicule.
- Tone mapping (ACES, Reinhard ou aucun), exposition en EV.
- 9 **émulsions** originales inspirées de familles de pellicules (diapo, négatif ciné, bleach bypass, noir et blanc…).
- **Étalonnage** : balance des blancs, contraste, saturation, lift / gamma / gain avec couleur.
- **Looks** LUT `.cube`.

### Aides au tournage
- Focus peaking, zébras, grille des tiers, zones de sécurité, masques de format.
- Placement de la scène (position, rotation, échelle) et position de la caméra au chiffre.

### Export
- **Séquence PNG 16 bits** (encodeur maison, sans passer par un canvas 8 bits) : rendu déterministe, fichiers `shot_00001.png`, écriture dans un dossier choisi (File System Access) ou en ZIP, avec progression, annulation et reprise.
- **Aperçu MP4** H.264 / H.265 par WebCodecs et [Mediabunny](https://mediabunny.dev). C'est un aperçu 8 bits : la séquence PNG 16 bits reste le master.
- À la fin d'une séquence, l'app affiche des **commandes `ffmpeg`** prêtes à copier pour produire un ProRes 4444 ou un H.265 10 bits.

### Confort
- **Projet JSON** : scène, caméra, objectif, timeline et effets, à enregistrer et rouvrir.
- **Raccourcis clavier** (aide avec `?`).
- **Télécommande sur téléphone** : sur le réseau local en HTTPS, avec un QR code. Le Mac fait le rendu, le téléphone pilote le transport, les clés, la focale, le diaph et la map.

## Démarrage

Prérequis : macOS sur Apple Silicon, Chrome récent (WebGPU), Node.js.

```bash
npm install
npm run dev          # http://localhost:5173
```

Glissez ensuite une scène `.ply` sur la fenêtre (le format `.ply` est le seul testé pour l'instant ; les autres formats passent par le chargeur PlayCanvas). Glissez un `.json` pour rouvrir un projet.

Pour piloter depuis un téléphone sur le même réseau :

```bash
npm run dev:phone    # HTTPS auto-signé, adresse et QR code affichés dans l'app (bouton « Téléphone »)
```

Autres commandes :

```bash
npm test             # tests Vitest (optique, timeline, export, projet, télécommande)
npm run build        # vérification des types et build
```

Les scènes de test vont dans `samples/`, qui est ignoré par git.

## Raccourcis utiles

| Touche | Action |
|---|---|
| `E` / `T` | Vue exploration / vue tournage |
| `Espace` | Lecture / pause |
| `R` | Mode enregistrement |
| `K` / `C` | Poser une clé (tout / caméra seule) |
| `←` `→` | Image précédente / suivante (`Maj` : 1 s) |
| `[` `]` | Ouvrir / fermer d'un tiers de diaph |
| `P` | Focus peaking |
| `X` | Fenêtre d'export |
| `Cmd S` / `Cmd O` | Enregistrer / ouvrir un projet |
| `?` | Toutes les touches |

## Architecture

```
src/
  optics/     maths pures et testées : FOV, CoC, hyperfocale, Scheimpflug, ouverture, flares, émulsions, étalonnage
  render/     pipeline WebGPU : accumulation multi-échantillons, post-traitement (WGSL), picking
  timeline/   courbes Bézier, pistes, plan, contrôleur de lecture et d'enregistrement
  export/     PNG 16 bits, ZIP, MP4, séquence, reprise
  project/    format de projet JSON
  remote/     protocole et page de télécommande
  ui/         panneaux, timeline, export, raccourcis
  presets/    objectifs et émulsions (JSON)
```

Stack : [Vite](https://vite.dev), TypeScript, [PlayCanvas Engine](https://playcanvas.com) 2.23 avec le device WebGPU, shaders WGSL, Vitest.

## Limites connues

- Pas de rendu par tuiles : la résolution d'export est bornée par la taille de texture maximale du GPU.
- L'export est reproductible à ~0,02 % près (ordre des splats à profondeur égale dans PlayCanvas).
- Les caractères des objectifs réels et les émulsions sont réglés à l'œil, pas mesurés.
- Pas de 4DGS, pas d'encodage de finition dans le navigateur (passer par la commande `ffmpeg` fournie).

## Pistes

Lumières ajoutées dans la scène, préréglages ease in / ease out sur les clés, plusieurs scènes dans un même plan, export EXR.
