const json = async (response) => {
	const text = await response.text();
	const data = text ? JSON.parse(text) : {};
	if (!response.ok) throw new Error(data.error ?? `${response.status} ${response.statusText}`);
	return data;
};

export const api = {
	get: (path) => fetch(path).then(json),
	post: (path, body) =>
		fetch(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body ?? {}),
		}).then(json),
	put: (path, body) =>
		fetch(path, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body ?? {}),
		}).then(json),
};
