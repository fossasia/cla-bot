"use strict";

// Generate a disposable localhost certificate at test runtime so the repo
// does not contain a PEM private key that secret scanners can mistake for a
// production credential. CI runs on Ubuntu, where OpenSSL is available.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cla-bot-local-tls-"));
const keyPath = path.join(directory, "key.pem");
const certPath = path.join(directory, "cert.pem");

try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "2",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  fs.chmodSync(keyPath, 0o600);
} catch (error) {
  fs.rmSync(directory, { recursive: true, force: true });
  throw new Error("OpenSSL is required to create the local HTTPS test server certificate", {
    cause: error,
  });
}

process.on("exit", () => {
  fs.rmSync(directory, { recursive: true, force: true });
});

module.exports = {
  key: fs.readFileSync(keyPath),
  cert: fs.readFileSync(certPath),
  certPath,
};
