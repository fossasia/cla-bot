"use strict";

const { createHash } = require("crypto");

// Deterministic Git-shaped object IDs for mocked GitHub API responses.
module.exports = (value) =>
  createHash("sha1").update(String(value)).digest("hex");
