# Changelog

Toutes les évolutions notables de SplatCam. Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), versions selon [SemVer](https://semver.org/lang/fr/).

## [Non publié]

### Prévu
- Lumières ajoutées dans la scène (ponctuelle / spot, puis orientation des surfaces, puis ombres).
- Préréglages ease in / ease out / ease in-out sur les clés de la timeline.
- Plusieurs scènes dans un même plan.

## [0.1.0] - 2026-10-27

Première version : tous les jalons M0 à M8 sont livrés. M7, M7bis et M8 restent à valider à l'œil (sélecteur de dossier réel, vrai téléphone).

### Ajouté

**Base (M0)**
- Projet Vite + TypeScript, PlayCanvas 2.23 en WebGPU.
- Chargement d'une scène par glisser-déposer, caméra orbite, HUD des FPS.

**Caméra réelle (M1)**
- 9 formats de capteur, du Super 8 au moyen format ; focale, FOV horizontal / vertical / diagonal.
- Échelle de scène en mètres.
- Caméra d'exploration et caméra de tournage séparées, cadre au rapport du capteur.

**Profondeur de champ (M2)**
- Accumulation HDR multi-échantillons : sous-rendus linéaires moyennés, échantillons Halton sur la pupille.
- Projection cisaillée pour garder le plan de netteté fixe ; CoC exacte de la lentille mince.
- Ouverture de f/1.2 à f/22, mise au point en mètres ou par clic sur la scène.
- Aperçu progressif, de 1 à 1024 échantillons.

**Bokeh et tilt / shift (M3)**
- Formes d'ouverture (disque, N lames, arrondi, rotation), onion rings, aberration sphérique, cat-eye, swirl, squeeze anamorphique.
- Shift par frustum asymétrique, tilt / swing selon Scheimpflug.
- Presets d'objectif en JSON.

**Timeline de plan (M4)**
- Pistes X / Y / Z, pan / tilt / roll, mise au point (dioptries), zoom (log).
- Éditeur de courbes Bézier (clés Bézier, linéaires, en palier ; poignées auto sans dépassement).
- Feuille de clés, transport (lecture, scrub, boucle), mode enregistrement.

**Obturateur et défauts (M5)**
- Flou de mouvement par angle d'obturation : chaque échantillon lit la timeline à son instant.
- Rolling shutter, gate weave.

**Optique et pellicule (M6)**
- Tone mapping (ACES, Reinhard, aucun), exposition en EV, gain des hautes lumières.
- Bloom, halation, vignettage, distorsion, aberration chromatique.
- Bruit ISO, grain de pellicule.
- 9 émulsions originales, looks LUT `.cube`.
- Flares : étoiles de diffraction, streaks anamorphiques, ghosts, lens dirt.

**Export (M7, M7bis)**
- Séquence PNG 16 bits déterministe (`shot_00001.png`), vers un dossier ou en ZIP, avec reprise, annulation et réglages écrits dans `shot_export.json`.
- Aperçu MP4 H.264 / H.265 (WebCodecs + Mediabunny), codecs interrogés à l'exécution.
- Commandes `ffmpeg` de finition (ProRes 4444, H.265 10 bits) affichées en fin de séquence.

**Confort (M8)**
- Projet JSON (enregistrer / ouvrir, validation des champs).
- Raccourcis clavier avec aide intégrée.
- Télécommande sur téléphone (relais local dans le serveur Vite, jeton, HTTPS auto-signé) et interface mobile.

**Après M8**
- Interface refaite : barre du haut, onglets Caméra, Objectif, Cadence, Image, Optique, Moniteur, Scène.
- 34 objectifs, dont 24 séries réelles, avec défauts optiques, série de focales, ouverture max. et MAP minimale.
- Affichage de la profondeur de champ et de l'hyperfocale ; position de la caméra au chiffre.
- Placement de la scène (position, rotation, échelle autour du centre du modèle, raccourcis ⌥ + flèches).
- Résolution d'aperçu 50 % / 100 % / Retina.
- Aides à l'écran : zébras, focus peaking (Sobel sur la luminance log, couleur, option noir et blanc, touche `P`), tiers, zones de sécurité, masques de format.
- Étalonnage : température et teinte, contraste, saturation, lift / gamma / gain avec couleur.
- « Mes réglages », cadences de 23,976 à 60 i/s, couleurs libres pour la halation et les streaks.
- QR code pour ouvrir la télécommande.

### Corrigé
- Audit du rendu, de l'export et de la timeline : perte de la cible HDR après l'exploration, fuite mémoire au changement de scène, export bloqué sur erreur, ZIP sans limite, calage des clés à 25 i/s, clavier AZERTY, bornes du projet.
- Export en vrai 16 bits : sous-rendu et source du post-traitement en RGBA32F pendant l'export.
- Rendu à la demande en exploration pour économiser le GPU d'Apple Silicon.

[Non publié]: #
[0.1.0]: #
