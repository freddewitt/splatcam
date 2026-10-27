# Pièges permanents (lu à la demande, section du domaine, avant de coder)

## Rendu / WebGPU
(vide)

## Optique
- PlayCanvas : `camera.fov` est VERTICAL par défaut (`horizontalFov = false`). Passer `rad2deg(fov.v)` du capteur, pas `fov.h`.
- Cadre de tournage au rapport du capteur : `aspectRatioMode = ASPECT_MANUAL` + `rect` + `scissorRect` identiques. Hors du rect rien n'est effacé : une caméra « de fond » (`layers: []`, priority 0) efface tout l'écran, les caméras visibles sont en priority 1.
- La AABB d'un gsplat PlayCanvas est faussée par les splats aberrants : cadrer sur les percentiles 2-98 % de `GSplatResource.centers`.

## Export
(vide)
