// 全局夜间模式：localStorage bus-theme 优先，否则跟系统 prefers-color-scheme。
// 主题存在 document.documentElement.dataset.theme 上，Base.astro 的 <head> 内联
// 脚本在首屏前就设好，避免闪白；这里负责后续切换与按钮图标同步。
const KEY = "bus-theme";

export function getTheme() {
  try {
    const t = localStorage.getItem(KEY);
    if (t === "dark" || t === "light") return t;
  } catch {
    /* ignore */
  }
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function isDark() {
  return getTheme() === "dark";
}

/** 应用主题：改 data-theme、theme-color meta、所有 .theme-btn 的图标 */
export function applyTheme() {
  const theme = getTheme();
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#101216" : "#f5f6f8");
  document.querySelectorAll(".theme-btn").forEach((b) => {
    b.textContent = theme === "dark" ? "☀️" : "🌙";
    b.setAttribute("aria-label", theme === "dark" ? "切换到浅色模式" : "切换到深色模式");
  });
  return theme;
}

export function toggleTheme() {
  const next = getTheme() === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* ignore */
  }
  applyTheme();
  // 地图实例在各页手里，听到这个事件自己调 map.setMapStyle 跟着变
  window.dispatchEvent(new CustomEvent("bus-theme-change", { detail: { theme: next } }));
}
