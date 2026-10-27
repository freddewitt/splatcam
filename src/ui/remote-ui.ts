// Bouton « Téléphone » : adresse à ouvrir sur le téléphone et nombre d'appareils connectés.

import type { RemoteHost } from '../remote/host';

export function createRemoteUi(root: HTMLElement, host: RemoteHost): void {
  const btn = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Téléphone', title: 'Piloter le plan depuis le téléphone' });
  const card = Object.assign(document.createElement('div'), { className: 'card hidden' });
  root.append(btn, card);

  const render = () => {
    const n = host.peers();
    const { info } = host;
    card.replaceChildren();
    const line = (text: string, cls = '') => card.append(Object.assign(document.createElement('div'), { className: cls, textContent: text }));
    line(n ? `${n} téléphone${n > 1 ? 's' : ''} connecté${n > 1 ? 's' : ''}` : 'Aucun téléphone connecté', n ? 'ok' : '');
    if (!info.exposed) {
      line('Le serveur n\'est pas ouvert au réseau. Relancer avec : npm run dev:phone', 'warn');
      return;
    }
    line(`Ouvrir sur le téléphone (même Wi-Fi)${info.https ? ', accepter l\'alerte du certificat' : ''} :`);
    for (const u of info.urls) {
      const a = Object.assign(document.createElement('textarea'), { readOnly: true, rows: 2, value: u });
      a.addEventListener('focus', () => a.select());
      card.append(a);
    }
    line('Le lien contient un jeton valable jusqu\'à l\'arrêt du serveur.', 'small');
  };
  btn.addEventListener('click', () => { card.classList.toggle('hidden'); render(); });
  host.onPeers(() => { btn.classList.toggle('on', host.peers() > 0); render(); });
}
