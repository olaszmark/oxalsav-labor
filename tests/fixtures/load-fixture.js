// Reads a tab-separated measurement file (decimal commas, header line) into
// raw table rows [{v: "8,50", i: "16,99"}, …] exactly as a student would type them.
const fs = require("node:fs");
const path = require("node:path");

function loadTsv(name) {
  const text = fs.readFileSync(path.join(__dirname, name), "utf8").replace(/^﻿/, "");
  return text.split(/\r?\n/).slice(1).filter((l) => l.trim()).map((l) => {
    const [v, i] = l.split("\t");
    return { v: v.trim(), i: i.trim() };
  });
}

module.exports = { loadTsv };
