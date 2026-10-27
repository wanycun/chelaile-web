// 收藏：全部存 localStorage，不上传、不需要账号
const KEY = "cl-favs-v1";
const EVENT = "cl-favs-change";

function empty() {
  return { stations: [], lines: [] };
}

export function getFavs() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!raw || typeof raw !== "object") return empty();
    return {
      stations: Array.isArray(raw.stations) ? raw.stations : [],
      lines: Array.isArray(raw.lines) ? raw.lines : [],
    };
  } catch {
    return empty();
  }
}

function commit(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* 隐私模式下写不进去就算了 */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
  return data;
}

export function isFavStation(sId) {
  return !!sId && getFavs().stations.some((s) => s.id === sId);
}

export function isFavLine(id) {
  return !!id && getFavs().lines.some((l) => l.id === id);
}

/** 站点收藏：id 用 sId */
export function toggleStation(st) {
  const data = getFavs();
  const i = data.stations.findIndex((s) => s.id === st.id);
  if (i >= 0) data.stations.splice(i, 1);
  else data.stations.unshift(st);
  return commit(data);
}

/** 线路收藏：id 用 lineId#dir（同一条线两个方向分别收藏） */
export function toggleLine(ln) {
  const data = getFavs();
  const i = data.lines.findIndex((l) => l.id === ln.id);
  if (i >= 0) data.lines.splice(i, 1);
  else data.lines.unshift(ln);
  return commit(data);
}

export function onFavChange(cb) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
}
