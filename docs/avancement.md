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

## M1 à M8, M7bis
- Statut : à faire
