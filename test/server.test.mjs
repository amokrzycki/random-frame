import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	extractImageUrl,
	handleRequest,
	isAllowedImageUrl,
} from "../dist/server.js";

async function request(url) {
	let status;
	let headers;
	let body;
	const response = {
		headersSent: false,
		writeHead(value, values) {
			status = value;
			headers = new Headers(values);
			this.headersSent = true;
		},
		end(value) {
			body = value;
		},
		destroy(error) {
			throw error;
		},
	};

	await handleRequest({ url }, response);
	return {
		status,
		headers,
		json: () => JSON.parse(String(body)),
		text: () => String(body),
	};
}

test("extracts only a trusted screenshot image", () => {
	const html =
		'<meta property="og:image" content="https://image.prntscr.com/image/example.png?x=1&amp;y=2">';
	assert.equal(
		extractImageUrl(html),
		"https://image.prntscr.com/image/example.png?x=1&y=2",
	);
	assert.equal(
		extractImageUrl(
			'<meta property="og:image" content="https://evil.example/image.png">',
		),
		null,
	);
});

test("allows only known HTTPS image hosts", () => {
	assert.equal(isAllowedImageUrl("https://i.imgur.com/example.png"), true);
	assert.equal(
		isAllowedImageUrl("http://image.prntscr.com/example.png"),
		false,
	);
	assert.equal(
		isAllowedImageUrl("https://image.prntscr.com.evil.example/image.png"),
		false,
	);
});

test("serves the compiled client modules", async () => {
	const response = await request("/app.js");
	assert.equal(response.status, 200);
	assert.match(response.text(), /navigation\.js/);
	assert.equal((await request("/toast.js")).status, 200);
});

test("renders the package version in the footer", async () => {
	const { version } = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	);
	assert.match(
		(await request("/")).text(),
		new RegExp(`>v${version.replaceAll(".", "\\.")}<`),
	);
});

test("serves the privacy policy and links it from the footer", async () => {
	const home = await request("/");
	const privacy = await request("/privacy");

	assert.match(home.text(), /href="\/privacy">Privacy<\/a>/);
	assert.equal(privacy.status, 200);
	assert.match(privacy.text(), /<h1>Privacy Policy<\/h1>/);
	assert.match(privacy.text(), /Cloudflare Web Analytics/);
});

test("limits API bursts and does not retry upstream 403 or 429 responses", async (t) => {
	const originalFetch = globalThis.fetch;
	const originalDateNow = Date.now;
	const now = Date.now();
	let pageStatus = 200;
	let imageStatus = 200;
	let upstreamCalls = 0;

	Date.now = () => now;
	globalThis.fetch = async (url) => {
		upstreamCalls += 1;
		if (String(url).startsWith("https://prnt.sc/")) {
			return new Response(
				'<meta property="og:image" content="https://image.prntscr.com/image/example.png">',
				{ status: pageStatus },
			);
		}
		return new Response(imageStatus === 200 ? new Uint8Array([1]) : null, {
			status: imageStatus,
			headers: { "content-type": "image/png", "content-length": "1" },
		});
	};

	t.after(() => {
		Date.now = originalDateNow;
		globalThis.fetch = originalFetch;
	});

	for (let index = 0; index < 8; index += 1) {
		assert.equal((await request("/api/image/invalid")).status, 400);
	}
	assert.equal((await request("/api/random")).status, 200);
	assert.equal((await request("/api/image/abc123")).status, 200);

	for (const [source, status, expectedCalls] of [
		["page", 403, 1],
		["page", 429, 1],
		["image", 403, 2],
		["image", 429, 2],
	]) {
		pageStatus = source === "page" ? status : 200;
		imageStatus = source === "image" ? status : 200;
		const callsBefore = upstreamCalls;
		assert.equal((await request("/api/random")).status, 502);
		assert.equal(upstreamCalls, callsBefore + expectedCalls);
	}

	pageStatus = 200;
	imageStatus = 200;
	for (let index = 0; index < 2; index += 1) {
		assert.equal((await request("/api/image/abc123")).status, 200);
	}

	const callsBeforeLimit = upstreamCalls;
	const limited = await request("/api/image/abc124");
	assert.equal(limited.status, 429);
	assert.equal(limited.headers.get("retry-after"), "1");
	assert.deepEqual(limited.json(), {
		error: "Too many requests. Please try again shortly.",
	});
	assert.equal(upstreamCalls, callsBeforeLimit);
});
