// HTTP server that runs apps-script/Code.gs (in a VM with fake Google services) and
// behaves like a deployed Apps Script web app: POST /exec → 302 → GET /echo returns JSON.
import http from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { loadGas } = require("../gas-harness.js");

export function startFakeAppsScript(port = 8092, opts = {}) {
  const gas = loadGas({ password: opts.password || "titok" });
  const results = new Map();
  // log.requests: one entry per POST {t, mode, contentType, action, rev, state, result}
  // log.delayNext: hold the NEXT request this many ms before doPost runs (simulates a slow network)
  const log = { posts: 0, options: 0, contentTypes: new Set(), failing: false, actions: [], requests: [], delayNext: 0 };
  let seq = 0;
  const cors = { "Access-Control-Allow-Origin": "*" };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === "OPTIONS") { log.options++; res.writeHead(405, cors); res.end(); return; }
    if (req.method === "POST" && url.pathname === "/exec") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        log.posts++;
        log.contentTypes.add(req.headers["content-type"]);
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        const entry = {
          t: Date.now(), mode: req.headers["sec-fetch-mode"] || "", contentType: req.headers["content-type"],
          action: parsed && parsed.action, rev: parsed && parsed.rev, state: parsed && parsed.state, result: null
        };
        log.requests.push(entry);
        if (parsed) log.actions.push(parsed.action);
        const delay = log.delayNext;
        log.delayNext = 0;
        setTimeout(() => {
          if (log.failing) { entry.result = { failed: true }; res.writeHead(500, cors); res.end("error"); return; }
          let out;
          try { out = gas.post(body); } catch (e) { out = { ok: false, error: "server_error", message: String(e) }; }
          entry.result = out;
          entry.done = Date.now();
          const id = String(++seq);
          results.set(id, JSON.stringify(out));
          res.writeHead(302, { ...cors, Location: `http://127.0.0.1:${port}/echo?id=${id}` });
          res.end();
        }, delay);
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/echo") {
      const body = results.get(url.searchParams.get("id")) || '{"ok":false,"error":"gone"}';
      res.writeHead(200, { ...cors, "Content-Type": "application/json; charset=utf-8" });
      res.end(body);
      return;
    }
    if (req.method === "GET" && url.pathname === "/exec") {
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify(gas.get()));
      return;
    }
    res.writeHead(404, cors); res.end();
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ server, gas, log, url: `http://127.0.0.1:${port}/exec` })));
}
