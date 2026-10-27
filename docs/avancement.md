# Avancement SplatCam

## M0. Squelette
- Statut : validé
- Date : 2026-10-27
- Commit : voir `git log` (commit « M0 : squelette… »)
- Ce qui marche : Vite + PlayCanvas 2.23.3 en WebGPU (Apple Metal-3), chargement .ply par glisser-déposer, orbite de debug (clic = orbite, clic droit/Maj = pan, molette = zoom), HUD FPS. `Tribunal3b_export_28000.ply` (27 971 splats) s'affiche à 60 fps. `tsc --noEmit` OK.
- Approximatif : le fichier contient des splats aberrants (traînées étirées) ; rendu brut, non nettoyé. Pas de test .sog/.splat/.spz. Pas encore de Vitest ni de `src/optics/`.
- Décisions non évidentes :
  - La AABB fournie par PlayCanvas (`customAabb` / instance) est faussée par les splats aberrants (demi-étendue ≈ 1995 m), la caméra finissait au-delà du `farClip` (1000) : écran noir. Le cadrage utilise les percentiles 2-98 % de `GSplatResource.centers`.
  - Yaw initial de 180° : l'export se regarde depuis -Z (vu depuis +Z, on voit l'arrière).
  - `samples/` est ignoré par git (fichiers lourds).
- Capture : `docs/captures/M0.png` (rendu après chargement du .ply, vue de face, 60 fps).
- Reproduction : `npm run dev`, http://localhost:5173, glisser `samples/Tribunal3b_export_28000.ply`. Aucun réglage d'objectif à ce stade.
- Prochaine étape : M1 (formats de capteur, focales, FOV H/V/D, échelle de scène en mètres, mode caméra de tournage), avec `src/optics/` + Vitest. Brief `docs/brief-splatcam.md` toujours absent.

## M1. Caméra réelle
- Statut : validé
- Date : 2026-10-27
- Commit : voir `git log` (commit « M1 : … »)
- Ce qui marche : `src/optics/sensor.ts` (9 formats Super 8 à moyen format, FOV H/V/D = 2·atan(taille/2f), focale depuis FOV), `src/optics/scale.ts` (échelle m/unité), 9 tests Vitest verts. Deux caméras indépendantes (exploration E / tournage T) avec leur propre orbite ; en tournage le cadre est au rapport du capteur (bandes noires). Panneau HTML : capteur, focale (curseur + valeur), échelle, lecture FOV et distance à la cible en mètres.
- Vérifié dans l'app : FF 50 mm = 39,6° / 27,0° / 46,8° ; FF 100 mm = 20,4° / 13,7° ; Super 16 10 mm : H 64,1°, conformes à la formule.
- Approximatif : dimensions de capteur = valeurs usuelles de la zone active, à ajuster selon le mode d'une caméra réelle. L'échelle ne sert qu'à l'affichage de la distance (elle servira à la profondeur de champ en M2). Pas de test sur écran tactile. En exploration, le panneau est grisé mais l'exploration reste à FOV fixe 50° vertical.
- Décisions : voir `docs/gotchas.md` section Optique (fov vertical, letterbox, caméra de fond).
- Capture : `docs/captures/M1.png` (Full Frame 24×36, 50 mm, échelle 1 m/unité, mode tournage, Tribunal3b_export_28000.ply).
- Prochaine étape : M2 (accumulation HDR multi-échantillons, ouverture f/x, distance de mise au point en mètres, aperçu progressif, mise au point par clic).

## M2 à M8, M7bis
- Statut : à faire
