// 前端共用工具：转义、时间格式化、线路行渲染
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function fmtEta(sec) {
  if (typeof sec !== "number" || sec < 0) return { text: "—", cls: "none", unit: "" };
  if (sec < 60) return { text: "即将", cls: "soon", unit: "到站" };
  const m = Math.round(sec / 60);
  return { text: String(m), cls: m <= 2 ? "soon" : "", unit: "分钟" };
}

export function fmtDist(m) {
  if (typeof m !== "number" || m < 0) return "";
  return m < 1000 ? `${m}m` : `${(m / 1000).toFixed(1)}km`;
}

export function hhmm(ts) {
  const t = new Date(ts || Date.now());
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}

/** 线路页地址 */
export function lineHref(line, station, cityId = "040") {
  const q = new URLSearchParams({
    lineId: line.lineId,
    dir: String(line.dir),
    cityId,
    stationId: station?.sId || "",
    st: station?.name || "",
    n: line.no || "",
  });
  return `/line/?${q}`;
}

/** 站点页地址 */
export function stationHref(station, cityId = "040") {
  const q = new URLSearchParams({
    physicalStId: station.physicalStId || "",
    sId: station.sId || "",
    namesakeStId: station.namesakeStId || "",
    firstLineId: station.firstLineId || "",
    cityId,
    n: station.name || "",
  });
  return `/station/?${q}`;
}

/**
 * 一行线路：可点进线路详情，右侧 ETA，末尾一个收藏按钮。
 * 收藏按钮的数据通过 data-* 带出，由页面统一绑定。
 */
export function lineRow(line, { station, cityId = "040", favId = "", favOn = false, rich = false } = {}) {
  const first = line.buses?.[0];
  const second = line.buses?.[1];
  const eta = fmtEta(first?.eta);
  const meta = [];
  if (first && first.left > 0) meta.push(`还有 ${first.left} 站`);
  else if (first && first.dist > 0) meta.push(fmtDist(first.dist));
  if (line.first && line.last) meta.push(`${line.first}–${line.last}`);
  // 最近三班里的后两班，压成一行小字
  const follow = (line.buses || [])
    .slice(1, 3)
    .filter((b) => b.eta >= 0)
    .map((b) => `${Math.round(b.eta / 60)} 分`)
    .join(" / ");

  const noBus = !first && line.pre;
  const main = noBus
    ? `<span class="num none">${esc(line.pre)}</span><span class="unit">发车</span>`
    : `<span class="num ${eta.cls}">${eta.text}</span>${eta.unit ? `<span class="unit">${eta.unit}</span>` : ""}`;

  const tag = line.tags?.length ? `<span class="tag">${esc(line.tags[0])}</span>` : "";
  const href = line.lineId ? lineHref(line, station, cityId) : "#";
  const favAttrs = favId
    ? `data-fav-line="${esc(favId)}" data-line-name="${esc(line.no)}" data-line-to="${esc(line.to)}" data-line-dir="${line.dir}" data-line-city="${esc(cityId)}" data-line-station="${esc(station?.sId || "")}"`
    : "";

  return `
    <div class="line-wrap">
      <a class="line" href="${href}">
        <span class="badge${line.subway ? " metro" : ""}">${esc(line.no)}</span>
        <span class="dir">
          <span class="to">开往 ${esc(line.to || "—")}${tag}</span>
          <span class="meta">${esc(meta.join(" · "))}</span>
        </span>
        <span class="eta">
          <span class="eta-main">${main}</span>
          ${follow ? `<span class="second">后续 ${follow}</span>` : ""}
        </span>
      </a>
      ${
        favId
          ? `<button class="fav${favOn ? " on" : ""}" type="button" ${favAttrs} aria-label="收藏线路">${favOn ? "★" : "☆"}</button>`
          : ""
      }
    </div>`;
}

export async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
  return data;
}
