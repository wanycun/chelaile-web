// 临时：用 CDP 点一次「换向」，验证方向翻转、目标站校验与提示
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9334;
const URL = "https://bus.wanyc.xyz/line/?lineId=020-01300-1&dir=1&cityId=040&stationId=020-1103&n=130";
const OUT = "D:/开发/chelaile-web/_dir.png";

const proc = spawn(EDGE, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + process.env.TEMP + "\\cdp-dir",
  "--window-size=500,1000",
  "--hide-scrollbars",
  URL,
], { stdio: "ignore" });

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const p = list.find((t) => t.type === "page" && t.url.includes("bus.wanyc.xyz"));
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(300);
  }
  throw new Error("no target");
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((r) => pending.set(mid, r));
};
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
await sleep(4500);

const read = `JSON.stringify({
  dirText: document.getElementById('dir-txt')?.textContent,
  switchTo: document.getElementById('switch-to')?.textContent,
  arrivalsHidden: document.getElementById('arrivals')?.hidden,
  arrivalsHead: document.getElementById('arrivals')?.textContent.trim().slice(0,40),
  stops: document.querySelectorAll('.stop').length,
  buses: document.querySelectorAll('.bus-row').length,
  msg: document.getElementById('msg')?.textContent.slice(0,60),
  url: location.search
})`;

console.log("换向前:", await evaluate(read));
await evaluate("document.getElementById('switch-dir').click(); 'clicked'");
await sleep(4000);
console.log("换向后:", await evaluate(read));

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(OUT, Buffer.from(shot.result.data, "base64"));
console.log("截图:", OUT);

ws.close();
proc.kill();
