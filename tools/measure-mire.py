# Mesure le diamètre (équivalent en aire) des disques de flou d'une capture de la mire.
# Usage : python3 tools/measure-mire.py capture.png|jpg [largeur_px_du_cadre]
import sys, numpy as np
from PIL import Image
from scipy import ndimage
im = np.asarray(Image.open(sys.argv[1]).convert('L')).astype(float)
# La capture doit être faite panneau masqué (document.getElementById('panel').style.display='none').
im[:60, :] = 0  # HUD
bg = np.median(im[400:500, 20:100])  # fond
im = im - bg
mask = im > 0.12 * im.max()
lab, n = ndimage.label(mask)
rows = []
for i in range(1, n + 1):
    ys, xs = np.where(lab == i)
    if len(xs) < 4: continue
    sub = im[lab == i]
    plateau = np.median(sub[sub > 0.5 * sub.max()])
    area = (sub > 0.5 * plateau).sum()
    rows.append((xs.mean(), ys.mean(), 2 * np.sqrt(area / np.pi)))
for x, y, d in sorted(rows):
    print(f"x={x:7.1f} y={y:6.1f}  diamètre={d:6.1f} px")
