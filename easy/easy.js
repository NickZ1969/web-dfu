// ---------------- UI helpers ----------------
const $ = (id) => document.getElementById(id);
const logEl = $("log");
function log(msg) { logEl.textContent += msg + "\n"; logEl.scrollTop = logEl.scrollHeight; }

const btnSerial   = $("btnSerial");
const btnReadVer  = $("btnReadVer");
const btnCheck    = $("btnCheck");
const btnDownload = $("btnDownload");
const btnBoot     = $("btnBoot");
const btnFlash    = $("btnFlash");
const chk1mb      = $("chk1mb");

const ecuVerEl    = $("ecuVer");
const latestVerEl = $("latestVer");

// ---------------- Version parsing ----------------
// Accept: "Speeduino 202501.6" OR "Speeduino 202501.6.1"
function parseSpeeduinoVersion(line) {
  const m = String(line).match(/Speeduino\s+(\d{6})(?:\.(\d+))?(?:\.(\d+))?/i);
  if (!m) return null;
  return { yyyymm:+m[1], minor: m[2]?+m[2]:0, patch: m[3]?+m[3]:0, raw:m[0] };
}
function fmtVer(v){ return `${v.yyyymm}.${v.minor}` + (v.patch ? `.${v.patch}` : ""); }
function cmpVer(a,b){
  if (a.yyyymm !== b.yyyymm) return a.yyyymm < b.yyyymm ? -1 : 1;
  if (a.minor  !== b.minor ) return a.minor  < b.minor  ? -1 : 1;
  if (a.patch  !== b.patch ) return a.patch  < b.patch  ? -1 : 1;
  return 0;
}
function parseVersionFromFilename(name){
  const m = name.match(/(\d{6})\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return { yyyymm:+m[1], minor:+m[2], patch:m[3]?+m[3]:0 };
}

// ---------------- GitHub lookup ----------------
async function listRepoFiles(owner, repo, branch="main"){
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers:{ "Accept":"application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub API failed: ${res.status}`);
  return await res.json();
}

async function getLatestFirmwareAndIni({ want1mb=false } = {}){
  const owner = "NickZ1969";

  const fwFiles  = (await listRepoFiles(owner, "firmware")).filter(x => x.name.endsWith(".bin"));
  const iniFiles = (await listRepoFiles(owner, "Speeduino_ini_files")).filter(x => x.name.toLowerCase().endsWith(".ini"));

  const fwCandidates = fwFiles
    .filter(x => want1mb ? x.name.includes("-1mb") : !x.name.includes("-1mb"))
    .map(x => ({...x, ver: parseVersionFromFilename(x.name)}))
    .filter(x => x.ver);

  if (!fwCandidates.length) throw new Error("No firmware .bin candidates found");
  fwCandidates.sort((a,b)=>cmpVer(a.ver,b.ver));
  const latestFw = fwCandidates.at(-1);

  const iniCandidates = iniFiles
    .map(x => ({...x, ver: parseVersionFromFilename(x.name)}))
    .filter(x => x.ver)
    .sort((a,b)=>cmpVer(a.ver,b.ver));

  let bestIni = iniCandidates.find(x => cmpVer(x.ver, latestFw.ver) === 0);
  if (!bestIni) bestIni = iniCandidates.filter(x => cmpVer(x.ver, latestFw.ver) <= 0).at(-1) || iniCandidates.at(-1);

  return { latestFw, bestIni };
}

async function downloadBytes(url){
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function triggerDownload(bytes, filename){
  const blob = new Blob([bytes]);
  // FileSaver.js provides saveAs()
  if (typeof saveAs === "function") return saveAs(blob, filename);

  // fallback
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- WebSerial (ECU normal mode) ----------------
let port=null, reader=null, writer=null;
let ecuVer=null;
let latest=null; // { latestFw, bestIni, fwBytes, iniBytes, newer }

async function connectSerial(){
  if (!("serial" in navigator)) throw new Error("WebSerial not supported (use Chrome/Edge).");
  port = await navigator.serial.requestPort();
  await port.open({ baudRate: 115200 });
  writer = port.writable.getWriter();
  reader = port.readable.getReader();
  log("Serial connected.");
}

async function writeLine(s){
  const enc = new TextEncoder();
  await writer.write(enc.encode(s));
}

async function readLine(timeoutMs=2000){
  const dec = new TextDecoder();
  let buf = "";
  const start = performance.now();
  while (performance.now() - start < timeoutMs){
    const {value, done} = await reader.read();
    if (done) break;
    buf += dec.decode(value, {stream:true});
    const idx = buf.indexOf("\n");
    if (idx >= 0) return buf.slice(0, idx).trim();
  }
  return buf.trim();
}

// ---------------- WebUSB DFU Flash ----------------
// Uses dfu.js + dfuse.js from your repo (same as webdfu).
// This targets STM32 DfuSe internal flash at 0x08000000 by default.
async function flashWithDFU(fwBytes){
  if (!("usb" in navigator)) throw new Error("WebUSB not supported (use Chrome/Edge).");

  // Ask user to pick DFU device
  const device = await navigator.usb.requestDevice({ filters: [] });
  await device.open();

  // Find DFU interface
  const interfaces = dfu.findDeviceDfuInterfaces(device);
  if (!interfaces.length) throw new Error("Selected device has no DFU interfaces.");

  // Pick first interface (or you could present a chooser)
  const intf = interfaces[0];
  const dfuDevice = new dfu.Device(device, intf);

  await dfuDevice.open();
  await dfuDevice.claimInterface();

  // DfuSe wrapper for STM32 ROM DFU
  const dfuseDevice = new dfuse.Device(dfuDevice);

  // Typical STM32: alt settings include “Internal Flash”
  // Most users already select the correct alt in your existing page.
  // We’ll try alt=0 first; if you need another, we can add a radio list.
  await dfuDevice.setInterfaceAltSetting(0);

  // A sane transfer size (STM32 ROM commonly reports 2048)
  // If your dfu-util.js already sets this, you can remove.
  dfuDevice.transferSize = dfuDevice.transferSize || 2048;

  const startAddr = 0x08000000;
  log(`Flashing ${fwBytes.length} bytes to 0x${startAddr.toString(16)} ...`);

  // DfuSe “download” expects a contiguous binary and start address
  await dfuseDevice.do_download(dfuDevice.transferSize, fwBytes, startAddr);

  log("Download finished. Waiting for manifestation...");
  await dfuDevice.waitDisconnected(5000).catch(()=>{});
  log("Done. Power-cycle ECU after ~20s (same as your current instructions).");
}

// ---------------- Wire up buttons ----------------
btnSerial.onclick = async () => {
  try { await connectSerial(); btnReadVer.disabled = false; }
  catch(e){ log("ERROR: " + e.message); }
};

btnReadVer.onclick = async () => {
  try{
    log("Sending 'S' to read ECU version...");
    await writeLine("S\n");
    const line = await readLine(2500);
    log("ECU: " + line);
    ecuVer = parseSpeeduinoVersion(line);
    if (!ecuVer) throw new Error("Could not parse version. Expected 'Speeduino YYYYMM.x[.y]'");
    ecuVerEl.textContent = fmtVer(ecuVer);
    btnCheck.disabled = false;
    btnBoot.disabled = false;
  }catch(e){ log("ERROR: " + e.message); }
};

btnCheck.onclick = async () => {
  try{
    log("Checking GitHub for latest firmware + INI...");
    const { latestFw, bestIni } = await getLatestFirmwareAndIni({ want1mb: chk1mb.checked });
    latestVerEl.textContent = fmtVer(latestFw.ver);
    log(`Latest BIN: ${latestFw.name}`);
    log(`INI match:  ${bestIni?.name || "(none)"}`);

    const fwBytes  = await downloadBytes(latestFw.download_url);
    const iniBytes = bestIni?.download_url ? await downloadBytes(bestIni.download_url) : null;

    const newer = (ecuVer && (cmpVer(ecuVer, latestFw.ver) < 0));
    log(newer ? "Update available ✅" : "Already up-to-date ✅");

    latest = { latestFw, bestIni, fwBytes, iniBytes, newer };
    btnDownload.disabled = false;
    btnFlash.disabled = !newer; // change if you want “force flash”
  }catch(e){ log("ERROR: " + e.message); }
};

btnDownload.onclick = async () => {
  try{
    if (!latest) throw new Error("Run Check GitHub first.");
    triggerDownload(latest.fwBytes, latest.latestFw.name);
    if (latest.iniBytes && latest.bestIni) triggerDownload(latest.iniBytes, latest.bestIni.name);
    log("Downloads triggered.");
  }catch(e){ log("ERROR: " + e.message); }
};

btnBoot.onclick = async () => {
  try{
    // RECOMMENDED: implement "BOOT" ASCII in your ECU firmware for easiest browser support
    log("Sending BOOT command...");
    await writeLine("BOOT\n");
    log("ECU should reboot and enumerate as STM32 Bootloader (DFU).");
  }catch(e){ log("ERROR: " + e.message); }
};

btnFlash.onclick = async () => {
  try{
    if (!latest) throw new Error("Run Check GitHub first.");
    if (!confirm(`Flash ${latest.latestFw.name} now?`)) return;
    await flashWithDFU(latest.fwBytes);
  }catch(e){ log("ERROR: " + e.message); }
};
