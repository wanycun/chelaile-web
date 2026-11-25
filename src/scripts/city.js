// 城市切换：所选城市存本机，默认广州；列表走 /api/cities（Worker 缓存一天）。
import { esc, getJSON } from "./util.js";

const KEY = "bus-city";
export const DEFAULT_CITY = { id: "040", name: "广州" };

export function getCity() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (raw && typeof raw.id === "string" && raw.id && typeof raw.name === "string" && raw.name) {
      return { id: raw.id, name: raw.name };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_CITY };
}

export function setCity(id, name) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ id, name }));
  } catch {
    /* ignore */
  }
}

let citiesCache = null;

/** 热门城市市中心（WGS-84）：未拿到定位时按它查附近，非热门城市返回 null */
const CITY_CENTERS = {
  "027": { lat: 39.9042, lng: 116.4074 }, // 北京
  "034": { lat: 31.2304, lng: 121.4737 }, // 上海
  "040": { lat: 23.1291, lng: 113.2644 }, // 广州
  "014": { lat: 22.5431, lng: 114.0577 }, // 深圳
  "006": { lat: 39.0842, lng: 117.2010 }, // 天津
  "007": { lat: 30.5728, lng: 104.0668 }, // 成都
  "003": { lat: 29.5630, lng: 106.5516 }, // 重庆
  "019": { lat: 23.0215, lng: 113.1214 }, // 佛山
  "009": { lat: 36.0671, lng: 120.3826 }, // 青岛
  "035": { lat: 41.7968, lng: 123.4315 }, // 沈阳
  "018": { lat: 32.0603, lng: 118.7969 }, // 南京
  "076": { lat: 34.3416, lng: 108.9398 }, // 西安
};

export function cityCenter(id) {
  return CITY_CENTERS[id] || null;
}

/** 城市列表（内存缓存，本页只拉一次） */
export async function fetchCities() {
  if (citiesCache) return citiesCache;
  const data = await getJSON("/api/cities");
  citiesCache = Array.isArray(data.cities) ? data.cities : [];
  return citiesCache;
}

/** 城市选择浮层：底部弹出，搜索框按中文名/拼音筛，热门置顶。
 * onSelect({id, name})：点选后回调，调用方决定是就地重拉还是跳回首页。 */
export async function openCityPicker(onSelect) {
  document.querySelector(".city-sheet")?.remove();
  const sheet = document.createElement("div");
  sheet.className = "city-sheet";
  sheet.innerHTML = `
    <div class="city-sheet-card">
      <div class="city-sheet-head">
        <span class="city-sheet-title">选择城市</span>
        <button class="city-sheet-close" type="button" aria-label="关闭">✕</button>
      </div>
      <input class="city-filter" type="search" placeholder="搜城市名或拼音，如 上海 / shanghai" autocomplete="off" />
      <div class="city-hot-label">热门城市</div>
      <div class="city-hot" id="city-hot"></div>
      <div class="city-hot-label">全部城市</div>
      <div class="city-list" id="city-list"></div>
      <p class="msg" id="city-err" hidden></p>
    </div>`;
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  sheet.addEventListener("click", (ev) => {
    if (ev.target === sheet) close();
  });
  sheet.querySelector(".city-sheet-close").addEventListener("click", close);
  document.addEventListener("keydown", function onKey(ev) {
    if (ev.key === "Escape") {
      close();
      document.removeEventListener("keydown", onKey);
    }
  });
  const hotEl = sheet.querySelector("#city-hot");
  const listEl = sheet.querySelector("#city-list");
  const errEl = sheet.querySelector("#city-err");
  const filterEl = sheet.querySelector(".city-filter");
  const current = getCity();

  let cities = [];
  try {
    cities = await fetchCities();
  } catch (err) {
    errEl.textContent = `城市列表加载失败：${err.message}`;
    errEl.hidden = false;
    return;
  }

  function pick(c) {
    setCity(c.cityId, c.name);
    close();
    onSelect({ id: c.cityId, name: c.name });
  }

  function renderList(q) {
    const query = (q || "").trim().toLowerCase();
    const match = (c) =>
      !query ||
      c.name.includes(query) ||
      (c.pinyin || "").toLowerCase().includes(query);
    const hot = cities.filter((c) => c.hot && match(c));
    const rest = cities.filter((c) => !c.hot && match(c));
    hotEl.innerHTML = hot
      .map(
        (c) => `<button class="city-chip${c.cityId === current.id ? " sel" : ""}" type="button" data-id="${esc(c.cityId)}" data-name="${esc(c.name)}">${esc(c.name)}</button>`,
      )
      .join("");
    listEl.innerHTML = rest
      .map(
        (c) => `<button class="city-row${c.cityId === current.id ? " sel" : ""}" type="button" data-id="${esc(c.cityId)}" data-name="${esc(c.name)}">
          <span>${esc(c.name)}</span><span class="city-row-py">${esc(c.pinyin || "")}</span>
        </button>`,
      )
      .join("");
    if (!hot.length && !rest.length) {
      listEl.innerHTML = `<p class="msg">没有匹配的城市</p>`;
    }
    sheet.querySelectorAll("[data-id]").forEach((btn) => {
      btn.addEventListener("click", () => pick({ cityId: btn.dataset.id, name: btn.dataset.name }));
    });
  }

  filterEl.addEventListener("input", () => renderList(filterEl.value));
  renderList("");
  filterEl.focus();
}
