const net = require('net');

const VPS_IP = '137.131.176.224';
const VPS_PORT = 80;
const LOCAL_PORT = 8080; // Porta onde o proxy vai escutar localmente

const server = net.createServer((client) => {
    // Escuta os primeiros dados para descobrir se é HTTP/WS ou SSH puro
    client.once('data', (chunk) => {
        const data = chunk.toString();
        let isWebSocket = false;

        // Verifica se a requisição HTTP é um Upgrade para WebSocket
        if (data.includes('GET') && data.includes('Upgrade: websocket')) {
            isWebSocket = true;
        }

        // Conecta na VPS
        const target = net.connect(VPS_PORT, VPS_IP, () => {
            // Envia o primeiro pacote capturado para a VPS
            target.write(chunk);

            // Se for SSH (não for WS), o cliente espera um HTTP 101 para continuar
            if (!isWebSocket) {
                client.write(
                    'HTTP/1.1 101 Switching Protocols\r\n' +
                    'Upgrade: websocket\r\n' +
                    'Connection: Upgrade\r\n\r\n'
                );
            }

            // Faz o túnel bidirecional (Pipe)
            client.pipe(target);
            target.pipe(client);
        });

        target.on('error', (err) => {
            console.error('Erro na VPS:', err.message);
            client.destroy();
        });
    });

    client.on('error', () => client.destroy());
});

server.listen(LOCAL_PORT, '0.0.0.0', () => {
    console.log(`Proxy rodando em 0.0.0.0:${LOCAL_PORT} -> ${VPS_IP}:${VPS_PORT}`);
});
