/* Easy Firmware Updater (rewrite)
   - WebSerial: read ECU version (robust against junk + duplicates)
   - GitHub: find newest firmware bin + matching ini
   - DFU: flash with ALT 0 @ 0x08000000 using dfu.js/dfuse.js
*/

const $ = (id) => document.getElementById(id);
const logEl = $("log");

function log(msg) {
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function sanitizeForLog(s) {
  // Replace non-printable with � for readability
  return String(s).replace(/[^\x20-\x7E\r\n\t]/g, "�");
}

// ---------------- Version parsing ----------------
// Accepts:
//   Speeduino 202501.6
//   Speeduino 2025.01.6
//   Speeduino 202501.6.1 (optional patch)
//   Speeduino 2025.01.6.1
function parseSpeeduinoVersionFromText(text) {
  const s = String(text);

  // Find ALL occurrences, pick the last valid one.
  // Groups: year(4) month(2) minor(1+) patch(optional)
  const re = /Speeduino\s+(\d{4})\.?(\d{2})\.?(\d+)(?:\.(\d+))?/ig;

  let m, last = null;
  while ((m = re.exec(s)) !== null) {
    const year  = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const minor = parseInt(m[3], 10);
    const patch = (m[4] !== undefined) ? parseInt(m[4], 10) : 0;

    if (month >= 1 && month <= 12) {
      last = {
        yyyymm: year * 100 + month, // 2025-01 => 202501
        minor,
        patch,
        raw: m[0].trim()
      };
    }
  }
  return last;
}

function fmtVer(v) {
  return `${v.yyyymm}.${v.minor}` + (v.patch ? `.${v.patch}` : "");
}

function cmpVer(a, b) {
  if (a.yyyymm !== b.yyyymm) return a.yyyymm < b.yyyymm ? -1 : 1;
  if (a.minor  !== b.minor ) return a.minor  < b.minor  ? -1 : 1;
  if (a.patch  !== b.patch ) return a.patch  < b.patch  ? -1 : 1;
  return 0;
}

function parseVersionFromFilename(name) {
  // Works for: 202501.6.bin, 202501.6.1.bin, Speeduino_202501.6.ini, etc.
  const m = String(name).match(/(\d{6})\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return { yyyymm: +m[1], minor: +m[2], patch: m[3] ? +m[3] : 0 };
}

// ---------------- GitHub helpers ----------------
async function listRepoFiles(owner, repo, branch = "main") {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: { "Accept": "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub API failed: ${res.status}`);
  return await res.json();
}

async function getLatestFirmwareAndIni({ want1mb = false } = {}) {
  const owner = "NickZ1969";

  const fwFiles = (await listRepoFiles(owner, "firmware"))
    .filter(x => x.type === "file" && x.name.toLowerCase().endsWith(".bin"));

  const iniFiles = (await listRepoFiles(owner, "Speeduino_ini_files"))
    .filter(x => x.type === "file" && x.name.toLowerCase().endsWith(".ini"));

  const fwCandidates = fwFiles
    .filter(x => want1mb ? x.name.includes("-1mb") : !x.name.includes("-1mb"))
    .map(x => ({ ...x, ver: parseVersionFromFilename(x.name) }))
    .filter(x => x.ver);

  if (!fwCandidates.length) {
    throw new Error("No firmware .bin files found (check repo root filenames).");
  }

  fwCandidates.sort((a, b) => cmpVer(a.ver, b.ver));
  const latestFw = fwCandidates.at(-1);

  const iniCandidates = iniFiles
    .map(x => ({ ...x, ver: parseVersionFromFilename(x.name) }))
    .filter(x => x.ver)
    .sort((a, b) => cmpVer(a.ver, b.ver));

  // Best INI = exact match, else closest <= firmware version, else latest available
  let bestIni = iniCandidates.find(x => cmpVer(x.ver, latestFw.ver) === 0);
  if (!bestIni) bestIni = iniCandidates.filter(x => cmpVer(x.ver, latestFw.ver) <= 0).at(-1);
  if (!bestIni) bestIni = iniCandidates.at(-1) || null;

  return { latestFw, bestIni };
}

async function downloadBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function triggerDownload(bytes, filename) {
  const blob = new Blob([bytes]);
  if (typeof saveAs === "function") return saveAs(blob, filename);

  // fallback
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- WebSerial ----------------
let port = null;
let reader = null;
let writer = null;

let ecuVer = null;
let latest = null; // { latestFw, bestIni, fwBytes, iniBytes, newer }

async function connectSerial() {
  if (!("serial" in navigator)) throw new Error("WebSerial not supported (use Chrome/Edge).");

  port = await navigator.serial.requestPort();
  await port.open({ baudRate: 115200 });

  writer = port.writable.getWriter();
  reader = port.readable.getReader();

  log("Serial connected.");

  // Small flush window to discard boot noise (helps the “press twice” issue)
  await flushSerial(180);
}

async function flushSerial(ms = 180) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    const { done } = await reader.read().catch(() => ({ done: true }));
    if (done) break;
  }
}

async function writeLine(s) {
  const enc = new TextEncoder();
  await writer.write(enc.encode(s));
}

async function closeSerial() {
  try { if (reader) { await reader.cancel(); reader.releaseLock(); } } catch {}
  try { if (writer) { writer.releaseLock(); } } catch {}
  try { if (port)   { await port.close(); } } catch {}
  reader = writer = port = null;
}

async function readChunkWithTimeout(ms) {
  // reader.read() can block forever, so race it against a timer.
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), ms));

  const result = await Promise.race([
    reader.read().then(r => ({ ...r, timeout: false })),
    timeout
  ]);

  if (result.timeout) {
    // Cancel the pending read and re-acquire the reader so future reads work.
    try { await reader.cancel(); } catch {}
    try { reader.releaseLock(); } catch {}
    reader = port.readable.getReader();
    return null; // no data
  }

  return result; // {value, done, timeout:false}
}

async function readVersionResponse(totalTimeoutMs = 2500) {
  const dec = new TextDecoder();
  let buf = "";
  const start = performance.now();

  while (performance.now() - start < totalTimeoutMs) {
    const r = await readChunkWithTimeout(250); // poll in small slices
    if (!r) continue;                          // timed out slice, keep waiting
    if (r.done) break;

    buf += dec.decode(r.value, { stream: true });

    const v = parseSpeeduinoVersionFromText(buf);
    if (v) return { raw: buf, ver: v };
  }

  return { raw: buf, ver: parseSpeeduinoVersionFromText(buf) };
}

// ---------------- WebUSB DFU Flash (ALT 0 + 0x08000000) ----------------
async function flashWithDFU(fwBytes) {
  if (!("usb" in navigator)) throw new Error("WebUSB not supported (use Chrome/Edge).");

  // User selects the STM32 Bootloader DFU device
  const device = await navigator.usb.requestDevice({ filters: [] });
  await device.open();

  const ifaces = dfu.findDeviceDfuInterfaces(device);
  if (!ifaces.length) throw new Error("Selected device has no DFU interfaces.");

  const intf = ifaces[0];
  const dfuDev = new dfu.Device(device, intf);

  await dfuDev.open();
  await dfuDev.claimInterface();

  // LOCK to your known-good settings
  await dfuDev.setInterfaceAltSetting(0);
  const startAddr = 0x08000000;

  // Transfer size (ROM usually reports it; fallback if not)
  dfuDev.transferSize = dfuDev.transferSize || 2048;

  log(`DFU connected. ALT=0, start=0x${startAddr.toString(16)}`);
  log(`Flashing ${fwBytes.length} bytes...`);

  const dfuseDev = new dfuse.Device(dfuDev);
  await dfuseDev.do_download(dfuDev.transferSize, fwBytes, startAddr);

  log("Flash complete. Device may disconnect/re-enumerate.");
  await dfuDev.waitDisconnected(6000).catch(() => {});
  log("Done. Power-cycle after your normal wait time.");
}

// ---------------- UI wiring ----------------
const btnSerial   = $("btnSerial");
const btnReadVer  = $("btnReadVer");
const btnCheck    = $("btnCheck");
const btnDownload = $("btnDownload");
const btnBoot     = $("btnBoot");
const btnFlash    = $("btnFlash");
const chk1mb      = $("chk1mb");

const ecuVerEl    = $("ecuVer");
const latestVerEl = $("latestVer");

function setEnabled(el, on) { el.disabled = !on; }

btnSerial.onclick = async () => {
  try {
    await connectSerial();
    btnReadVer.disabled = false;   // <-- THIS enables the button
    log("Serial connected (Read Version enabled).");
  } catch (e) {
    log("ERROR: " + e.message);
  }
};

btnReadVer.onclick = async () => {
  try {
    log("Sending 'S' to read ECU version...");
    await writeLine("S\r\n");
    await new Promise(r => setTimeout(r, 60));

    const { raw, ver } = await readVersionResponse(3000);
    log("ECU raw: " + sanitizeForLog(raw));

    if (!ver) throw new Error("Could not parse version from ECU reply.");

    ecuVer = ver;
    ecuVerEl.textContent = fmtVer(ecuVer);
    log(`Parsed: ${ver.raw} => ${fmtVer(ecuVer)}`);

    btnCheck.disabled = false;
    btnBoot.disabled = false;
  } catch (e) {
    log("ERROR: " + e.message);
  }
};


btnCheck.onclick = async () => {
  try {
    if (!ecuVer) throw new Error("Read ECU version first.");

    log("Checking GitHub for latest firmware + INI...");
    const { latestFw, bestIni } = await getLatestFirmwareAndIni({ want1mb: chk1mb.checked });

    latestVerEl.textContent = fmtVer(latestFw.ver);
    log(`Latest BIN: ${latestFw.name}`);
    log(`INI match:  ${bestIni ? bestIni.name : "(none found)"}`);

    log("Downloading firmware (for fast flashing)...");
    const fwBytes = await downloadBytes(latestFw.download_url);

    let iniBytes = null;
    if (bestIni?.download_url) {
      log("Downloading INI...");
      iniBytes = await downloadBytes(bestIni.download_url);
    }

    const newer = cmpVer(ecuVer, latestFw.ver) < 0;
    log(newer ? "Update available ✅" : "Already up-to-date ✅");

    latest = { latestFw, bestIni, fwBytes, iniBytes, newer };

    setEnabled(btnDownload, true);
    setEnabled(btnFlash, newer); // only enable flash if newer (change if you want “force flash”)
  } catch (e) {
    log("ERROR: " + e.message);
  }
};

btnDownload.onclick = async () => {
  try {
    if (!latest) throw new Error("Run Check GitHub first.");

    triggerDownload(latest.fwBytes, latest.latestFw.name);
    if (latest.iniBytes && latest.bestIni) triggerDownload(latest.iniBytes, latest.bestIni.name);

    log("Downloads triggered.");
  } catch (e) {
    log("ERROR: " + e.message);
  }
};

btnBoot.onclick = async () => {
  try {
    log("Sending BOOT command...");
    // Recommended: implement ASCII "BOOT" on ECU to call jumpToBootloader()
    await writeLine("BOOT\n");

    // Release Serial cleanly so DFU can enumerate without the port being held
    await closeSerial();

    log("Serial closed. ECU should now appear as STM32 Bootloader (DFU).");
    log("Click 'Flash via DFU' next and select the DFU device.");
  } catch (e) {
    log("ERROR: " + e.message);
  }
};

btnFlash.onclick = async () => {
  try {
    if (!latest) throw new Error("Run Check GitHub first.");
    if (!latest.newer) throw new Error("No newer firmware detected (enable force-flash if desired).");

    const ok = confirm(`Flash ${latest.latestFw.name} now?\n\nALT 0 @ 0x08000000`);
    if (!ok) return;

    await flashWithDFU(latest.fwBytes);
  } catch (e) {
    log("ERROR: " + e.message);
  }
};
