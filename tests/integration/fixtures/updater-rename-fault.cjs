const fs = require("node:fs");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const originalRename = fs.renameSync;
let injected = false;
fs.renameSync = function patchedRename(source, destination) {
  if (!injected && path.basename(String(source)) === "app" && String(destination).includes(".rollback-")) {
    injected = true;
    const error = new Error("synthetic install rename failure from test preload");
    error.code = "EACCES";
    throw error;
  }
  return originalRename.call(this, source, destination);
};
syncBuiltinESMExports();
