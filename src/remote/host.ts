// Côté Mac de la télécommande : reçoit les commandes du relais (SSE), les valide et les applique ;
// renvoie l'état de l'application tant qu'un téléphone est connecté. Voir protocol.ts et tools/remote-plugin.ts.

import { applyCommand, parseCommand, snapshotState, type RelayInfo, type RelayMessage, type RemoteContext, type RemoteMode } from './protocol';

export interface RemoteHost {
  info: RelayInfo;
  /** Téléphones connectés. */
  peers(): number;
  onPeers(fn: (n: number) => void): void;
}

/** Cadence maximale d'envoi de l'état au relais. */
const STATE_MS = 100;

/** null si le relais n'existe pas (build de production) ou refuse (page ouverte hors du Mac). */
export async function startRemoteHost(ctx: RemoteContext, mode: () => RemoteMode): Promise<RemoteHost | null> {
  let info: RelayInfo;
  try {
    const r = await fetch('/relay/info');
    if (!r.ok) return null;
    info = await r.json() as RelayInfo;
  } catch { return null; }

  let peers = 0;
  const listeners: ((n: number) => void)[] = [];
  let last = '';
  const push = async () => {
    const body = JSON.stringify(snapshotState(ctx, mode()));
    if (body === last) return;
    last = body;
    try { await fetch(`/relay/state?t=${info.token}`, { method: 'POST', body }); } catch { last = ''; }
  };

  const es = new EventSource(`/relay/events?role=mac&t=${info.token}`);
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data) as RelayMessage;
    if (msg.type === 'cmd') {
      const c = parseCommand(msg.cmd);
      if (c) { applyCommand(c, ctx); last = ''; }   // l'état renvoyé suit tout de suite
    } else if (msg.type === 'peers') {
      if (msg.n > peers) last = '';                // nouveau téléphone : état complet
      peers = msg.n;
      for (const fn of listeners) fn(peers);
    }
  };
  setInterval(() => { if (peers > 0) void push(); }, STATE_MS);

  return { info, peers: () => peers, onPeers: (fn) => { listeners.push(fn); fn(peers); } };
}
