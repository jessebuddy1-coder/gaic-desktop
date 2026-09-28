// Shared loaders: run shipped runtime files in an isolated vm context.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

export const RUNTIME = process.env.GAIC_RUNTIME ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "runtime");

export function read(name) {
  return fs.readFileSync(path.join(RUNTIME, name), "utf8");
}

export function loadScript(name, extra = {}) {
  const ctx = { TextEncoder, console, ...extra };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read(name), ctx, { filename: name });
  return ctx;
}

// detector-worker.js with the browser-only pieces stubbed: top-level function
// declarations become properties of the context for pure-function tests.
export function loadWorker() {
  const ctx = {
    console,
    importScripts() {},
    addEventListener() {},
    postMessage() {},
    location: { href: "file:///detector-worker.js" },
  };
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // model-config.js is unchanged by the engine update, so engine/runtime does
  // not carry it; the worker falls back to its built-in defaults without it.
  if (fs.existsSync(path.join(RUNTIME, "model-config.js"))) {
    vm.runInContext(read("model-config.js"), ctx, { filename: "model-config.js" });
  }
  vm.runInContext(read("detector-worker.js"), ctx, { filename: "detector-worker.js" });
  return ctx;
}

// Slice named top-level sections out of app.js (it is one browser IIFE).
export function appSection(startMarker, endMarker) {
  const app = read("app.js");
  const start = app.indexOf(startMarker);
  const end = app.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("app.js section not found: " + startMarker);
  return app.slice(start, end);
}

// Source text of a function declaration, for "keep synchronized" checks.
export function functionSource(source, name) {
  const start = source.indexOf("function " + name + "(");
  if (start < 0) throw new Error("function not found: " + name);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1).replace(/\s+/g, " ");
    }
  }
  throw new Error("unbalanced function: " + name);
}
