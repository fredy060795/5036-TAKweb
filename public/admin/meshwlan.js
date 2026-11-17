// Admin → Meshtastic: update the TAKweb page on a radio over its WLAN, without USB – for radios that do not have the
// update button in their settings yet. The page is loaded from this server first (the PC still has internet), then the
// PC joins the radio's WLAN and writes the files with the firmware's own file upload (POST /upload → /static/<name>),
// index.html last. Checked afterwards with /json/fs/browse/static (CORS *). From an https admin page Chrome needs the
// local-network permission (targetAddressSpace) to reach the radio's http address.
const LOCAL = { targetAddressSpace: 'local' };
let pack = null; // { kind, version, files: [{ name, gz, data }] }

const say = (t, cls) => { const m = $('wuMsg'); m.textContent = t; m.className = 'msg' + (cls ? ' ' + cls : ''); };
const fill = p => { $('wuBar').classList.remove('hidden'); $('wuFill').style.width = Math.round(p) + '%'; };
const base = () => {
  let a = $('wuAddr').value.trim().replace(/\/+$/, '') || '192.168.4.1';
  if (!/^https?:\/\//i.test(a)) a = 'http://' + a;
  return a;
};
const query = kind => kind === 'lite' ? '?lite=1' : kind === 'full' ? '?map=full' : '';
async function radioFetch(path, opt = {}) {
  try { return await fetch(base() + path, { ...LOCAL, ...opt }); } catch (e) {
    // older browsers do not know the option – try plainly (works from an http admin page)
    return fetch(base() + path, opt);
  }
}
async function radioFiles() {
  const r = await radioFetch('/json/fs/browse/static', { cache: 'no-store' });
  return ((await r.json()).data || {}).files || [];
}
// which page fits the radio: one-file page (weak radio) when it has no other TAKweb files, the detailed map when it has it
function kindOf(files) {
  const names = files.map(f => (f.name || '').replace(/^.*\//, ''));
  const wm = files.find(f => /worldmap\.json\.gz$/.test(f.name || ''));
  if (!names.includes('index.html.gz')) return null;
  if (!names.some(n => /^(eud|mesh|meshproto)\.js\.gz$/.test(n))) return 'lite';
  return wm && wm.size > 150000 ? 'full' : 'small';
}

fetch('/api/eud/meshsite', { cache: 'no-store' }).then(r => r.json()).then(b => { $('wuVer').textContent = b.version; }).catch(() => {});

$('wuCheck').addEventListener('click', async () => {
  say('Asking the radio at ' + base() + ' …');
  try {
    const files = await radioFiles();
    const k = kindOf(files);
    if (!k) return say('The radio answers but has no TAKweb page yet – set it up over USB first.', 'err');
    if ($('wuKind').value === 'auto') $('wuKind').dataset.found = k;
    say(`Radio found: ${files.length} files, TAKweb page for ${k === 'lite' ? 'a weak radio (one file)' : k === 'full' ? 'an ESP32-S3 radio' : 'a normal radio'}.`
      + (pack ? '' : ' Load the page first (needs internet), then connect to the radio again.'), 'ok');
  } catch (e) {
    say('The radio does not answer at ' + base() + ' – is this PC in the radio\'s WLAN? From an https admin page allow "local network" in Chrome/Edge, or open the admin over http://.', 'err');
  }
});

$('wuLoad').addEventListener('click', async () => {
  let kind = $('wuKind').value;
  if (kind === 'auto') kind = $('wuKind').dataset.found || '';
  if (!kind) {
    // nothing known about the radio yet: load the full set (fits normal and S3 radios) and the one-file page
    say('Radio not checked yet – loading the pages for all radio kinds …');
  }
  const kinds = kind ? [kind] : ['lite', 'small', 'full'];
  try {
    const out = {};
    for (const k of kinds) {
      const b = await (await fetch('/api/eud/meshsite' + query(k), { cache: 'no-store' })).json();
      const files = [];
      for (const f of b.files) {
        const r = await fetch('/api/eud/meshsite/' + encodeURIComponent(f.name) + query(k), { cache: 'no-store' });
        if (!r.ok) throw new Error(f.name + ': ' + r.status);
        const data = await r.arrayBuffer();
        if (data.byteLength !== f.gz) throw new Error(f.name + ': incomplete');
        files.push({ name: f.name, gz: f.gz, data });
      }
      out[k] = { version: b.version, files };
    }
    pack = out;
    $('wuGo').disabled = false;
    const v = Object.values(out)[0].version;
    say(`TAKweb v${v} loaded (${Object.keys(out).join(', ')}). Now connect this PC's WLAN to the radio (TAKweb-xxxx) and press 3.`, 'ok');
  } catch (e) { say('Could not load the page from this server: ' + e.message, 'err'); }
});

$('wuGo').addEventListener('click', async () => {
  if (!pack) return;
  $('wuGo').disabled = true;
  try {
    say('Asking the radio at ' + base() + ' …');
    let before;
    try { before = await radioFiles(); } catch (e) { throw new Error('the radio does not answer at ' + base() + ' – is this PC in the radio\'s WLAN?'); }
    let kind = $('wuKind').value;
    if (kind === 'auto') kind = kindOf(before);
    if (!kind) throw new Error('the radio has no TAKweb page – set it up over USB first');
    const p = pack[kind];
    if (!p) throw new Error('the page for this radio kind was not loaded – press 1 again (with internet)');
    const list = p.files.slice().sort((a, b) => (a.name === 'index.html') - (b.name === 'index.html'));
    const total = list.reduce((n, f) => n + f.gz, 0);
    let done = 0;
    fill(0);
    for (const f of list) {
      say(`Writing ${f.name} (${Math.round(f.gz / 1024)} KB) …`);
      const fd = new FormData();
      fd.append('file', new Blob([f.data], { type: 'application/octet-stream' }), f.name + '.gz');
      // the firmware sends no CORS header for /upload – the answer stays opaque, the file list below shows the result
      await radioFetch('/upload', { method: 'POST', body: fd, mode: 'no-cors' });
      done += f.gz;
      fill(done * 100 / total);
    }
    const after = await radioFiles();
    const bad = list.filter(f => !after.some(x => (x.name || '').replace(/^.*\//, '') === f.name + '.gz' && x.size === f.gz));
    if (bad.length) throw new Error('not complete on the radio: ' + bad.map(f => f.name).join(', ') + ' (flash full?) – press 3 again');
    say(`Done – the radio has TAKweb v${p.version}. Reload the page on the phone.`, 'ok');
  } catch (e) { say('Update stopped: ' + e.message, 'err'); }
  $('wuGo').disabled = false;
});
