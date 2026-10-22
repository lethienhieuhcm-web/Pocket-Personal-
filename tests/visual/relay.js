/** Local relay: nhận CONNECT không auth, forward sang egress proxy có auth. */
const net = require('net');
const hp = process.env.https_proxy || process.env.HTTPS_PROXY || '';
const m = hp.match(/^http:\/\/([^:]+):([^@]+)@([^:]+):(\d+)/);
if (!m) { console.error('Không parse được https_proxy'); process.exit(1); }
const [, user, pass, host, port] = m;
const auth = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');

const server = net.createServer(client => {
  client.once('data', chunk => {
    const req = chunk.toString();
    const line = req.split('\r\n')[0];
    const target = line.split(' ')[1]; // host:port
    const upstream = net.connect(+port, host, () => {
      upstream.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${auth}\r\n\r\n`);
      upstream.once('data', res => {
        const status = res.toString().split('\r\n')[0];
        if (/200/.test(status)) {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          client.pipe(upstream); upstream.pipe(client);
        } else {
          client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          client.end(); upstream.end();
        }
      });
    });
    upstream.on('error', () => { client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); client.end(); });
  });
  client.on('error', () => {});
});
server.listen(18899, '127.0.0.1', () => console.log('relay on 127.0.0.1:18899'));
