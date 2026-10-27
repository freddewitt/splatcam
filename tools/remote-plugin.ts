// Relais de la télécommande, intégré au serveur de dev Vite (aucun serveur séparé, rien hors du réseau local).
//
// Le téléphone ouvre /remote.html?t=JETON ; l'application sur le Mac se connecte en SSE. Flux :
//   téléphone  --POST /relay/cmd-->  relais  --SSE-->  Mac  (applique la commande)
//   Mac  --POST /relay/state-->  relais  --SSE-->  téléphones  (affichent l'état)
// Protection : jeton aléatoire par démarrage du serveur (comparé en temps constant) ; l'adresse du jeton et
// l'envoi de l'état ne sont acceptés que depuis la boucle locale (le Mac) ; corps limités à 4 Ko.
// Le relais ne comprend pas les commandes : le Mac les valide (src/remote/protocol.ts).

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Plugin } from 'vite';

const MAX_BODY = 4096;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const isLoopback = (addr: string | undefined): boolean => !!addr && LOOPBACK.has(addr);

export function tokenMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Adresses IPv4 du Mac sur le réseau local. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

export function remotePlugin(): Plugin {
  const token = randomBytes(9).toString('base64url');
  const macs = new Set<ServerResponse>();
  const phones = new Set<ServerResponse>();
  let lastState: string | null = null;
  let origin: { https: boolean; port: number; exposed: boolean } = { https: false, port: 5173, exposed: false };

  const send = (res: ServerResponse, msg: unknown) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
  const broadcast = (set: Set<ServerResponse>, msg: unknown) => { for (const r of set) send(r, msg); };
  const phoneUrls = (): string[] => {
    const scheme = origin.https ? 'https' : 'http';
    const hosts = origin.exposed ? lanAddresses() : ['localhost'];
    return hosts.map((h) => `${scheme}://${h}:${origin.port}/remote.html?t=${token}`);
  };

  function events(req: IncomingMessage, res: ServerResponse, role: string | null) {
    if (role !== 'mac' && role !== 'phone') { res.statusCode = 400; res.end(); return; }
    if (role === 'mac' && !isLoopback(req.socket.remoteAddress)) { res.statusCode = 403; res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const mine = role === 'mac' ? macs : phones;
    mine.add(res);
    if (role === 'mac') send(res, { type: 'peers', n: phones.size });
    else {
      send(res, { type: 'mac', online: macs.size > 0 });
      if (lastState) res.write(`data: ${lastState}\n\n`);
      broadcast(macs, { type: 'peers', n: phones.size });
    }
    const beat = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(beat);
      mine.delete(res);
      if (role === 'mac') broadcast(phones, { type: 'mac', online: macs.size > 0 });
      else broadcast(macs, { type: 'peers', n: phones.size });
    });
  }

  return {
    name: 'splatcam-remote',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        const a = server.httpServer!.address() as AddressInfo | string | null;
        if (!a || typeof a === 'string') return;
        origin = { https: 'setSecureContext' in server.httpServer!, port: a.port, exposed: a.address === '::' || a.address === '0.0.0.0' };
        if (origin.exposed) setTimeout(() => console.log(`\n  Télécommande (ouvrir sur le téléphone, même Wi-Fi) :\n${phoneUrls().map((u) => `    ${u}`).join('\n')}\n`), 100);
      });

      server.middlewares.use('/relay', async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const route = url.pathname;
        const okToken = tokenMatches(url.searchParams.get('t'), token);
        const local = isLoopback(req.socket.remoteAddress);
        res.setHeader('Cache-Control', 'no-store');

        if (route === '/info' && req.method === 'GET') {
          // Le jeton n'est donné qu'à l'application locale (le Mac), jamais à une machine du réseau.
          if (!local) { res.statusCode = 403; res.end(); return; }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ token, urls: phoneUrls(), exposed: origin.exposed, https: origin.https }));
          return;
        }
        if (!okToken) { res.statusCode = 401; res.end(); return; }

        if (route === '/events' && req.method === 'GET') { events(req, res, url.searchParams.get('role')); return; }

        if ((route === '/cmd' || route === '/state') && req.method === 'POST') {
          if (route === '/state' && !local) { res.statusCode = 403; res.end(); return; }
          const body = await readBody(req);
          let parsed: unknown;
          try { parsed = body === null ? undefined : JSON.parse(body); } catch { parsed = undefined; }
          if (parsed === undefined) { res.statusCode = 400; res.end(); return; }
          if (route === '/cmd') {
            if (!macs.size) { res.statusCode = 503; res.end(); return; }
            broadcast(macs, { type: 'cmd', cmd: parsed });
          } else {
            lastState = JSON.stringify({ type: 'state', state: parsed });
            for (const r of phones) r.write(`data: ${lastState}\n\n`);
          }
          res.statusCode = 204; res.end();
          return;
        }
        res.statusCode = 404; res.end();
      });
    },
  };
}
