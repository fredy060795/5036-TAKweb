// TAKweb on a Meshtastic radio: a mesh-only build of the TAKweb app for the flash of an ESP32 radio. The Meshtastic
// firmware serves files from /static on its flash over WLAN (gzip: name.gz) and offers its radio over HTTP
// (/api/v1/toradio, /api/v1/fromradio) – a phone on the radio's WLAN opens https://<radio> and has TAKweb, without
// server, internet or anything loaded before. Flat file names (the firmware's upload knows no folders), no server parts
// (3D map, QR scanner, Android app), everything gzipped. Installed onto the radio with public/eud/meshinstall.js.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const EUD = path.join(__dirname, '..', 'public', 'eud');
const MOD = name => path.dirname(require.resolve(name + '/package.json'));

// published name -> source file
// map: 'small' (countries and bigger cities, ~95 KB – fits radios with 4 MB flash / 1 MB file system) or 'full'
// (detailed coasts, more cities, ~330 KB – radios with 8 MB flash such as Heltec V3, XIAO ESP32-S3, T-Beam S3)
function sources(map = 'small') {
  return {
    'index.html': path.join(EUD, 'index.html'),
    'eud.css': path.join(EUD, 'eud.css'),
    'eud.js': path.join(EUD, 'eud.js'),
    'video.js': path.join(EUD, 'video.js'),
    'data.js': path.join(EUD, 'data.js'),
    'meshproto.js': path.join(EUD, 'meshproto.js'),
    'codec2.js': path.join(EUD, 'codec2.js'),
    'codec2.wasm': path.join(EUD, 'codec2.wasm'),
    'mesh.js': path.join(EUD, 'mesh.js'),
    'tools.js': path.join(EUD, 'tools.js'),
    'voice.js': path.join(EUD, 'voice.js'),
    'icon-192.png': path.join(EUD, 'icon-192.png'),
    'tak-badge.png': path.join(EUD, 'tak-badge.png'), // the server button (bottom right)
    'leaflet.js': path.join(MOD('leaflet'), 'dist', 'leaflet.js'),
    'leaflet.css': path.join(MOD('leaflet'), 'dist', 'leaflet.css'),
    'layers.png': path.join(MOD('leaflet'), 'dist', 'images', 'layers.png'),
    'layers-2x.png': path.join(MOD('leaflet'), 'dist', 'images', 'layers-2x.png'),
    'leaflet-rotate.js': path.join(MOD('leaflet-rotate'), 'dist', 'leaflet-rotate.js'),
    'milsymbol.js': path.join(MOD('milsymbol'), 'dist', 'milsymbol.js'),
    // offline world map (Natural Earth, public domain): countries, coasts, cities – the base map without internet
    'worldmap.json': path.join(EUD, map === 'full' ? 'worldmap.json.gz' : 'worldmap-small.json.gz'),
  };
}

// the app page for the radio: flat paths, no version suffix, without server-only scripts, mesh-only flag
function radioIndex(html, version, serverUrl = '') {
  return html
    .split('__TAKWEB_VERSION__').join(version)
    .replace(/<link rel="manifest"[^>]*>\n?/, '')
    .replace(/<link rel="icon" href="\/assets[^>]*>\n?/, '')
    .replace(/<link rel="apple-touch-icon"[^>]*>\n?/, '')
    .replace(/(src|href)="vendor\//g, '$1="')
    .replace(/(src|href)="([\w.-]+)\?v=[^"]*"/g, '$1="$2"')
    .replace(/<script src="(jsQR|view3d|blenative)\.js"><\/script>\n?/g, '')
    .replace('<head>', '<head>\n<script>window.TAKWEB_MESH = true;' + (serverUrl ? ` window.TAKWEB_SERVER = ${JSON.stringify(String(serverUrl)).replace(/</g, '\\u003c')};` : '') + '</script>\n<link rel="apple-touch-icon" href="icon-192.png">');
}

let cache = null;
// -> { version, files: [{ name, size, gz: Buffer }], total } (gzip sizes – what lands on the flash)
// serverUrl: the TAKweb server that installs it – the radio page offers it for the TAK server connection
function build(version = 'dev', serverUrl = '', map = 'small') {
  map = map === 'full' ? 'full' : 'small';
  const key = [version, serverUrl, map].join('|');
  if (cache && cache.key === key) return cache;
  const files = [];
  for (const [name, src] of Object.entries(sources(map))) {
    let data = fs.readFileSync(src);
    if (src.endsWith('.gz')) { // already compressed
      files.push({ name, size: zlib.gunzipSync(data).length, gz: data });
      continue;
    }
    if (name === 'index.html') data = Buffer.from(radioIndex(data.toString('utf8'), version, serverUrl));
    if (name === 'leaflet.css') data = Buffer.from(data.toString('utf8').replace(/url\(images\//g, 'url('));
    const gz = zlib.gzipSync(data, { level: 9 });
    files.push({ name, size: data.length, gz });
  }
  cache = { key, version, serverUrl, map, files, total: files.reduce((n, f) => n + f.gz.length, 0) };
  return cache;
}

// The file system image (LittleFS) for one radio, flashed together with the firmware – no file transfer over USB
// afterwards: the firmware build's image (base) with this server's TAKweb pages, the server address and the radio's
// TAK user (static/takweb-server.json), the radio's WLAN name (prefs/takweb-ap.txt). Everything else in the base image
// stays. Geometry like ESP32 Arduino / esp_littlefs (4096-byte blocks, 128-byte read/prog). -> Buffer, same size as base
async function radioImage(base, { site, server = '', invite = '', ap = null, setup = null } = {}) {
  const { openLittlefsImage, buildLittlefsImage } = require('@wasm-os/mklfs');
  const geometry = { blockSize: 4096, readSize: 128, progSize: 128 };
  let kept = [];
  try {
    const old = await openLittlefsImage(new Uint8Array(base), geometry);
    kept = old.list().filter(e => e.type === 'file' && !/^\/?static\//.test(e.path))
      .map(e => ({ name: e.path.replace(/^\/+/, ''), data: old.readFile(e.path) }));
  } catch (e) { /* not readable: a fresh file system */ }
  const files = [...kept.filter(f => !/^prefs\/takweb-ap\.txt$/.test(f.name))];
  for (const f of site.files) files.push({ name: 'static/' + f.name + '.gz', data: new Uint8Array(f.gz) });
  // setup: what the admin chose (channel, GPS, MQTT, gateway WLAN) – the radio's page puts it onto the radio
  if (server || setup) files.push({ name: 'static/takweb-server.json', data: Buffer.from(JSON.stringify({ server, ...(invite ? { invite } : {}), ...(setup ? { setup } : {}) })) });
  // empty name: the firmware takes TAKweb-<last 4 of the MAC>
  if (ap) files.push({ name: 'prefs/takweb-ap.txt', data: Buffer.from(`${ap.ssid || ''}\n${ap.psk || ''}\n`) });
  const total = files.reduce((n, f) => n + f.data.length, 0);
  if (total > base.length * 0.9) throw new Error(`TAKweb does not fit the radio's file system (${Math.round(total / 1024)} of ${Math.round(base.length / 1024)} KB)`);
  return Buffer.from(await buildLittlefsImage(files, base.length, geometry));
}

module.exports = { build, radioIndex, radioImage };
