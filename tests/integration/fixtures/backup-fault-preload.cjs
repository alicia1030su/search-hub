const fs = require("node:fs");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const promises = fs.promises;
const fault = process.env.SHUB_QA_FAULT || "";
const marker = process.env.SHUB_QA_FAULT_MARKER || "";
const original = { mkdtemp: promises.mkdtemp, open: promises.open, link: promises.link, rename: promises.rename };
let temporaryOpens = 0;

function hit(stage) {
  if (marker) fs.writeFileSync(marker, `${stage}\n`, { mode: 0o600 });
  process.kill(process.pid, "SIGKILL");
}

promises.mkdtemp = async function patchedMkdtemp(prefix, options) {
  if (fault === "snapshot" && String(prefix).includes("shbackup-create-")) hit("snapshot");
  return original.mkdtemp.call(this, prefix, options);
};
promises.open = async function patchedOpen(target, flags, mode) {
  const value = String(target);
  if (fault === "encrypt" && value.endsWith(".shbackup.tmp") && temporaryOpens++ === 0) hit("encrypt");
  if (fault === "verify" && value.endsWith(".shbackup.tmp") && temporaryOpens++ === 1) hit("verify");
  if (fault === "restore-extract" && value.includes("shbackup-verify-") &&
      (path.basename(value) === "manifest.json" || value.endsWith(`${path.sep}data${path.sep}search-hub.db`))) hit("restore-extract");
  return original.open.call(this, target, flags, mode);
};
promises.link = async function patchedLink(source, destination) {
  if (String(destination).endsWith(".shbackup")) {
    if (fault === "enospc") {
      if (marker) fs.writeFileSync(marker, "enospc\n", { mode: 0o600 });
      const error = new Error("synthetic ENOSPC from test preload");
      error.code = "ENOSPC";
      throw error;
    }
    if (fault === "publish") hit("publish");
  }
  return original.link.call(this, source, destination);
};
promises.rename = async function patchedRename(source, destination) {
  if (fault === "restore-publish" && String(source).includes(".shbackup-restore-ready-")) hit("restore-publish");
  return original.rename.call(this, source, destination);
};
syncBuiltinESMExports();
