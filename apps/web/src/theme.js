/**
 * 主题：dark（默认）/ light。
 * 只操作 <html data-theme>，具体配色全部由 styles.css 的语义变量决定。
 */
const STORAGE_KEY = "pi-pentest-theme";

export function getTheme() {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		return stored === "light" ? "light" : "dark";
	} catch {
		return "dark";
	}
}

export function applyTheme(theme) {
	const next = theme === "light" ? "light" : "dark";
	document.documentElement.dataset.theme = next;
	try {
		localStorage.setItem(STORAGE_KEY, next);
	} catch {
		/* 隐私模式下忽略 */
	}
	return next;
}

export function initTheme() {
	// 支持 ?theme=light|dark 深链，方便分享/截图/排查
	try {
		const forced = new URLSearchParams(window.location.search).get("theme");
		if (forced === "light" || forced === "dark") return applyTheme(forced);
	} catch {
		/* ignore */
	}
	return applyTheme(getTheme());
}
