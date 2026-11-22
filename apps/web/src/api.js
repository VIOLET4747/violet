/**
 * 所有请求统一走这里：
 * - 后端没起来时 fetch 会抛 TypeError("Failed to fetch")，翻译成可操作的提示
 * - 500 时把后端返回的 error 字段透出来，而不是只显示状态码
 */

const json = async (response) => {
	const text = await response.text();
	let data = {};
	if (text) {
		try {
			data = JSON.parse(text);
		} catch {
			data = {};
		}
	}
	if (!response.ok) {
		throw new Error(data.error ?? `${response.status} ${response.statusText}`);
	}
	return data;
};

const request = async (path, options) => {
	try {
		const response = await fetch(path, options);
		return await json(response);
	} catch (error) {
		if (error instanceof TypeError) {
			throw new Error("无法连接后端服务（127.0.0.1:8787 未运行或已退出）。请重启：npm run dev");
		}
		throw error;
	}
};

const jsonBody = (body) => ({
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body ?? {}),
});

export const api = {
	get: (path) => request(path),
	post: (path, body) => request(path, { method: "POST", ...jsonBody(body) }),
	put: (path, body) => request(path, { method: "PUT", ...jsonBody(body) }),
};
