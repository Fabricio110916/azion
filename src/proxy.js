// proxy.js
const net = require('net');

// ============================================================
// CONFIG — aponte tudo para sua VPS
// ============================================================
const CONFIG = {
  ServerAddr: '0.0.0.0',
  ServerPort: 8080,

  // ==== SUA VPS ====
  VPS_IP: '137.131.176.224',
  VPS_PORT: 80,

  BufferSize: 524288,
  KeepAliveTimeout: 24 * 60 * 60 * 1000,
};

// ============================================================
// MINI-ROUTER (inspirado no MainRouter da Azion)
// ============================================================
class Router {
  constructor() {
    this.routes = [];
  }

  // registra uma rota: pattern pode ter * (wildcard)
  all(pattern, handler) {
    this.routes.push({ regex: Router.toRegex(pattern), handler });
    return this;
  }

  // converte "/ws/*" → /^\/ws\/.*$/  ;  "*" → /^.*$/
  static toRegex(pattern) {
    if (pattern === '*') return /^.*$/;
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$');
  }

  // percorre na ordem de registro, retorna o handler do primeiro match
  match(path) {
    for (const route of this.routes) {
      if (route.regex.test(path)) return route.handler;
    }
    return null;
  }
}

// ============================================================
// ROUTER DO PROXY
// ============================================================
const router = new Router();

// /ws/*  → V2Ray (passthrough, sem 101)
router.all('/ws/*', (ctx) => proxyTo(ctx, { v2ray: true }));

// /ws (sem barra) → V2Ray também
router.all('/ws', (ctx) => proxyTo(ctx, { v2ray: true }));

// /ssh/* → SSH
router.all('/ssh/*', (ctx) => proxyTo(ctx, { v2ray: false }));

// /health → endpoint HTTP de diagnóstico (não vai pra VPS)
router.all('/health', (ctx) => {
  const body = JSON.stringify({ status: 'ok', target: `${CONFIG.VPS_IP}:${CONFIG.VPS_PORT}` });
  ctx.client.end(
    'HTTP/1.1 200 OK\r\n' +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    'Connection: close\r\n\r\n' +
    body
  );
  return true;
});

// FALLBACK: qualquer outro path → SSH (mantém compatibilidade com o Go original)
router.all('*', (ctx) => proxyTo(ctx, { v2ray: false }));

// ============================================================
// HELPERS DE LOG
// ============================================================
const logInfo  = (m) => console.log(`[INFO]  ${m}`);
const logDebug = (m) => console.log(`[DEBUG] ${m}`);
const logError = (m) => console.error(`[ERROR] ${m}`);
const logWarn  = (m) => console.warn(`[WARN]  ${m}`);

// ============================================================
// PIPE COM KEEP-ALIVE
// ============================================================
function pipeWithKeepAlive(src, dst, label) {
  const timeout = CONFIG.KeepAliveTimeout;

  src.setTimeout(timeout);
  dst.setTimeout(timeout);

  const onTimeout = () => {
    logWarn(`Keep-alive expirou (${label}). Fechando.`);
    src.destroy();
    dst.destroy();
  };

  src.on('timeout', onTimeout);
  dst.on('timeout', onTimeout);

  const onError = (err) => {
    if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
      logError(`Stream ${label}: ${err.message}`);
    }
    src.destroy();
    dst.destroy();
  };

  src.on('error', onError);
  dst.on('error', onError);

  src.pipe(dst, { end: false });

  src.on('close', () => dst.destroy());
}

// ============================================================
// PROXY TCP — o "músculo"
// ============================================================
function proxyTo(ctx, { v2ray }) {
  const { client, chunk, clientAddr } = ctx;

  const targetConn = net.createConnection(
    { host: CONFIG.VPS_IP, port: CONFIG.VPS_PORT },
    () => {
      logDebug(`${clientAddr} → ${CONFIG.VPS_IP}:${CONFIG.VPS_PORT} (v2ray=${v2ray})`);

      if (v2ray) {
        // passthrough: o primeiro chunk vai intacto pro V2Ray
        targetConn.write(chunk);
      } else {
        // responde 101 e a partir daí é túnel SSH binário
        client.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          '\r\n'
        );
      }

      pipeWithKeepAlive(client, targetConn, `${clientAddr} → vps`);
      pipeWithKeepAlive(targetConn, client, `vps → ${clientAddr}`);
    }
  );

  targetConn.on('error', (err) => {
    logError(`Falha ao conectar em ${CONFIG.VPS_IP}:${CONFIG.VPS_PORT}: ${err.message}`);
    client.destroy();
  });

  targetConn.on('close', () => {
    logInfo(`Conexão encerrada: ${clientAddr}`);
    client.destroy();
  });

  return true;
}

// ============================================================
// HANDLER PRINCIPAL (equivalente ao handleClient do Go)
// ============================================================
function handleClient(client) {
  const clientAddr = `${client.remoteAddress}:${client.remotePort}`;
  logInfo(`Cliente conectado: ${clientAddr}`);

  let handled = false;

  const onFirstData = (chunk) => {
    if (handled) return;
    handled = true;
    client.removeListener('data', onFirstData);

    const payload = chunk.toString('utf8');
    logDebug(`Payload: ${payload.replace(/\n/g, '\\n').slice(0, 200)}`);

    // extrai o path de "GET /ws/ HTTP/1.1"
    const parts = payload.split(' ');
    const fullPath = parts[1] || '/';
    const path = fullPath.split('?')[0]; // remove query string

    const handler = router.match(path);
    if (!handler) {
      // não deveria acontecer por causa do "*", mas por segurança:
      client.destroy();
      return;
    }

    logDebug(`Rota: ${path} → ${handler.name || 'anônima'}`);
    handler({ client, chunk, clientAddr, path });
  };

  client.on('data', onFirstData);

  client.on('error', (err) => {
    if (err.code !== 'ECONNRESET') logError(`Cliente ${clientAddr}: ${err.message}`);
  });

  client.on('close', () => logInfo(`Cliente desconectado: ${clientAddr}`));
}

// ============================================================
// BOOTSTRAP
// ============================================================
function main() {
  const server = net.createServer(handleClient);

  server.on('error', (err) => {
    logError(`Servidor: ${err.message}`);
    process.exit(1);
  });

  server.listen(CONFIG.ServerPort, CONFIG.ServerAddr, () => {
    logInfo(`Proxy escutando em ${CONFIG.ServerAddr}:${CONFIG.ServerPort}`);
    logInfo(`Destino (VPS): ${CONFIG.VPS_IP}:${CONFIG.VPS_PORT}`);
    logInfo('Rotas:');
    for (const r of router.routes) logInfo(`  → ${r.regex}`);
  });

  const shutdown = () => {
    logInfo('Encerrando...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
