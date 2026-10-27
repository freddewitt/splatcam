# Pièges permanents (lu à la demande, section du domaine, avant de coder)

## Rendu / WebGPU
- `camera.calculateProjection` n'agit PAS sur le rendu des splats (testé : cisaillement ignoré, blur du plan de netteté inchangé). Utiliser `camera.projectionOffset` (Vec2 → P02/P12), pris en compte par le getter `projectionMatrix`.
- `app.render()` est réentrant : N appels par tick = N sous-rendus. Les passes plein écran (`drawQuadWithShader`) ne marchent que DANS une frame : les accrocher à l'événement `postrender`. `app.autoRender = false` pour piloter soi-même.
- Rendu linéaire HDR : caméra `gammaCorrection: GAMMA_NONE` + `toneMapping: TONEMAP_LINEAR` ; le shader gsplat décode alors les couleurs gamma en linéaire (`prepareOutputFromGamma`). Cible RGBA16F pour le sous-rendu, RGBA32F ping-pong pour l'accumulation (moyenne en 1/(k+1)).
- Shaders WGSL maison : `ShaderUtils.createShader(device, { vertexChunk: 'quadVS', fragmentWGSL })`, syntaxe PlayCanvas (`var tex: texture_2d<f32>; var texSampler: sampler; uniform x: f32; varying uv0: vec2f; fn fragmentMain(input: FragmentInput) -> FragmentOutput`, sortie `output.color`). `textureLoad` fonctionne sur RGBA32F.
- Le tri des splats se fait une fois par image, pas par `render()` : sans conséquence pour des décalages d'ouverture de quelques cm.
- Dans les passes plein écran maison, `uv0.y` croît vers le BAS de l'image (ligne 0 = haut) : pour une position de champ « haut = +y » (cat-eye, swirl), inverser y.
- Masque d'ouverture par pixel (cat-eye, swirl, lames) : l'accumulateur SOMME les échantillons acceptés, l'affichage divise par le nombre d'échantillons × l'acceptation au centre (les lames ne doivent pas assombrir, le cat-eye doit vignetter). Le miroir CPU `apertureMask` (optics/aperture.ts) et le WGSL doivent rester alignés.
- Shift d'objectif = `projectionOffset` additionné au cisaillement d'ouverture (ndc = p·x/(−z) − P02) ; le picking doit ajouter ce décalage au rayon (x/(−z) = (ndc + P02)/p).
- Tilt (Scheimpflug) : la caméra décalée cisaillée pour z = −d voit le plan incliné z = −d + d·τ·(x, y) transformé LINÉAIREMENT : v' = (I − o·τᵀ)·v (`optics/tilt.ts`). On relit donc le sous-rendu avec cette matrice (texture de scène en LINEAR ; v = (ndc + shift)/P, ndc_y vers le haut, uv0.y vers le bas). `d` s'annule : τ = sin θ / f suffit. Un clic de mise au point doit viser le plan (`focusThroughPoint`), pas seulement la profondeur.
- Picking : seules les données PLY brutes (`resource.gsplatData.getProp`) donnent opacité et échelle ; SOG / SPZ / compressé → centres seuls.

## Optique
- PlayCanvas : `camera.fov` est VERTICAL par défaut (`horizontalFov = false`). Passer `rad2deg(fov.v)` du capteur, pas `fov.h`.
- Cadre de tournage au rapport du capteur : `aspectRatioMode = ASPECT_MANUAL` + `rect` + `scissorRect` identiques. Hors du rect rien n'est effacé : une caméra « de fond » (`layers: []`, priority 0) efface tout l'écran, les caméras visibles sont en priority 1.
- CoC exacte (lentille mince) avec FOV donné par f : rayon d'ouverture × d/(d−f) (`apertureScale`).
- La AABB d'un gsplat PlayCanvas est faussée par les splats aberrants : cadrer sur les percentiles 2-98 % de `GSplatResource.centers`.

## Timeline
- Les pistes sont interpolées dans leur espace perceptif : map en DIOPTRIES (1/m, ∞ = 0), zoom en ln(focale). Convertir à l'application (`metersFromDiopters`, `focalFromZoom`), jamais à l'interpolation.
- La pose de la caméra de tournage vient de l'orbite (`orbits.shoot`, source de vérité : pan = yaw, tilt = pitch, + roll). Ne pas relire des angles d'Euler depuis l'entité (représentation ambiguë) ; position = `shoot.getPosition()`, cible = position + avant·dist.
- Pentes automatiques des clés : Fritsch-Carlson (plafond 3× la pente voisine) sinon dépassement entre deux clés proches ; poignées bornées à la largeur du segment pour que x(t) reste monotone.
- Enregistrement en lecture : un geste à la main prime sur la piste pendant `HOLD_MS` (300 ms) puis la lecture reprend ; l'allègement Douglas-Peucker a lieu à l'arrêt (les gestes posent une clé par image).
- Tests Chrome headless : puppeteer-core (hors projet, dans le scratchpad) + `/Applications/Google Chrome.app`, `--enable-unsafe-webgpu` ; `puppeteer` `mouse.click(x, y, { count: 2 })` pour un double-clic.

## Export
(vide)
