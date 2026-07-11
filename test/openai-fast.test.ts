import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import openAIFastExtension, { SUPPORTED_MODELS } from "../index.js";

type Handler = (event: any, ctx: any) => any;

type HarnessOptions = {
	agentDir?: string;
	api?: string;
	cwd?: string;
	modelId?: string;
	oauth?: boolean;
	projectTrusted?: boolean;
	provider?: string;
};

const temporaryDirectories: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

after(() => {
	if (originalAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	}

	for (const path of temporaryDirectories) {
		rmSync(path, { recursive: true, force: true });
	}
});

function makeTemporaryDirectory(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(path);
	return path;
}

function createModel(
	id: string,
	provider = "openai-codex",
	api = "openai-codex-responses",
): Record<string, unknown> {
	return {
		id,
		name: id,
		provider,
		api,
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 372_000,
		maxTokens: 128_000,
	};
}

function createHarness(options: HarnessOptions = {}) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, any>();
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<string | undefined> = [];
	let oauth = options.oauth ?? true;

	const agentDir = options.agentDir ?? makeTemporaryDirectory("pi-openai-fast-agent-");
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const ctx: any = {
		cwd: options.cwd ?? makeTemporaryDirectory("pi-openai-fast-project-"),
		hasUI: true,
		isProjectTrusted: () => options.projectTrusted ?? false,
		model: createModel(
			options.modelId ?? "gpt-5.6-sol",
			options.provider,
			options.api,
		),
		modelRegistry: {
			isUsingOAuth: () => oauth,
		},
		sessionManager: {},
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
		},
	};

	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: (name: string, definition: any) => commands.set(name, definition),
	};

	openAIFastExtension(pi as any);

	function getHandler(name: string): Handler {
		const handler = handlers.get(name);
		assert.ok(handler, `${name} handler should be registered`);
		return handler;
	}

	getHandler("session_start")({}, ctx);

	return {
		ctx,
		handlers,
		notifications,
		statuses,
		async command(args: string) {
			const command = commands.get("fast");
			assert.ok(command, "/fast command should be registered");
			await command.handler(args, ctx);
		},
		getStatus: () => statuses.at(-1),
		runProviderRequest: async (payload: unknown) =>
			await getHandler("before_provider_request")({ payload }, ctx),
		setModel(id: string, provider = "openai-codex", api = "openai-codex-responses") {
			ctx.model = createModel(id, provider, api);
		},
		setOAuth(value: boolean) {
			oauth = value;
		},
	};
}

test("tracks every model currently advertising Codex Fast mode", () => {
	assert.deepEqual(SUPPORTED_MODELS, [
		"gpt-5.4",
		"gpt-5.5",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
	]);
});

test("defaults to off", async () => {
	const harness = createHarness();
	const payload = { model: "gpt-5.6-sol", input: [] };

	assert.equal(await harness.runProviderRequest(payload), undefined);
	assert.equal(harness.getStatus(), undefined);
});

test("injects the priority tier for every supported OAuth model", async () => {
	const harness = createHarness();
	await harness.command("on");

	for (const modelId of SUPPORTED_MODELS) {
		harness.setModel(modelId);
		const payload = { model: modelId, input: [{ role: "user" }] };

		assert.deepEqual(await harness.runProviderRequest(payload), {
			...payload,
			service_tier: "priority",
		});
	}

	assert.equal(harness.getStatus(), "fast");
});

test("leaves models without advertised Fast support unchanged", async () => {
	const harness = createHarness();
	await harness.command("on");

	for (const modelId of ["gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-6"]) {
		harness.setModel(modelId);
		assert.equal(
			await harness.runProviderRequest({ model: modelId, input: [] }),
			undefined,
		);
	}

	assert.equal(harness.getStatus(), undefined);
});

test("requires the Codex provider, Codex Responses API, OAuth, and a matching payload model", async () => {
	const harness = createHarness();
	await harness.command("on");

	harness.setOAuth(false);
	assert.equal(
		await harness.runProviderRequest({ model: "gpt-5.6-sol", input: [] }),
		undefined,
	);

	harness.setOAuth(true);
	harness.setModel("gpt-5.6-sol", "openai", "openai-responses");
	assert.equal(
		await harness.runProviderRequest({ model: "gpt-5.6-sol", input: [] }),
		undefined,
	);

	harness.setModel("gpt-5.6-sol", "openai-codex", "openai-responses");
	assert.equal(
		await harness.runProviderRequest({ model: "gpt-5.6-sol", input: [] }),
		undefined,
	);

	harness.setModel("gpt-5.6-sol");
	assert.equal(
		await harness.runProviderRequest({ model: "gpt-5.6-terra", input: [] }),
		undefined,
	);
});

test("preserves an existing service tier", async () => {
	const harness = createHarness();
	await harness.command("on");

	assert.equal(
		await harness.runProviderRequest({
			model: "gpt-5.6-sol",
			input: [],
			service_tier: "default",
		}),
		undefined,
	);
});

test("supports explicit, status, toggle, and invalid command forms", async () => {
	const harness = createHarness();

	await harness.command("on");
	assert.equal(harness.getStatus(), "fast");
	assert.match(harness.notifications.at(-1)?.message ?? "", /active.*service_tier=priority/);

	await harness.command("status");
	assert.equal(harness.getStatus(), "fast");

	await harness.command("off");
	assert.equal(harness.getStatus(), undefined);
	assert.match(harness.notifications.at(-1)?.message ?? "", /off \(session override\)/);

	await harness.command("");
	assert.equal(harness.getStatus(), "fast");

	await harness.command("later");
	assert.deepEqual(harness.notifications.at(-1), {
		message: "Usage: /fast [on|off|status]",
		level: "warning",
	});
});

test("updates the status when the model changes", async () => {
	const harness = createHarness();
	await harness.command("on");
	assert.equal(harness.getStatus(), "fast");

	harness.setModel("gpt-5.4-mini");
	harness.handlers.get("model_select")?.({}, harness.ctx);
	assert.equal(harness.getStatus(), undefined);

	harness.setModel("gpt-5.6-luna");
	harness.handlers.get("model_select")?.({}, harness.ctx);
	assert.equal(harness.getStatus(), "fast");
});

test("merges global and trusted project configuration", async () => {
	const agentDir = makeTemporaryDirectory("pi-openai-fast-config-");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(
		join(agentDir, "extensions", "openai-fast.json"),
		JSON.stringify({ enabled: false, showStatus: true }),
	);

	const project = makeTemporaryDirectory("pi-openai-fast-config-project-");
	mkdirSync(join(project, ".pi"), { recursive: true });
	writeFileSync(
		join(project, ".pi", "openai-fast.json"),
		JSON.stringify({ enabled: true, showStatus: false }),
	);

	const harness = createHarness({
		agentDir,
		cwd: project,
		projectTrusted: true,
	});

	assert.deepEqual(
		await harness.runProviderRequest({ model: "gpt-5.6-sol", input: [] }),
		{ model: "gpt-5.6-sol", input: [], service_tier: "priority" },
	);
	assert.equal(harness.getStatus(), undefined);
});

test("does not load project configuration from outside Pi's trusted cwd", async () => {
	const parent = makeTemporaryDirectory("pi-openai-fast-parent-config-");
	const cwd = join(parent, "nested");
	mkdirSync(join(parent, ".pi"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeFileSync(
		join(parent, ".pi", "openai-fast.json"),
		JSON.stringify({ enabled: true }),
	);

	const harness = createHarness({ cwd, projectTrusted: true });
	assert.equal(
		await harness.runProviderRequest({ model: "gpt-5.6-sol", input: [] }),
		undefined,
	);
});

test("ignores project configuration when the project is untrusted", async () => {
	const project = makeTemporaryDirectory("pi-openai-fast-untrusted-");
	mkdirSync(join(project, ".pi"), { recursive: true });
	writeFileSync(
		join(project, ".pi", "openai-fast.json"),
		JSON.stringify({ enabled: true }),
	);

	const harness = createHarness({ cwd: project, projectTrusted: false });
	assert.equal(
		await harness.runProviderRequest({ model: "gpt-5.6-sol", input: [] }),
		undefined,
	);
});
