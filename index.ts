import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const EXTENSION_ID = "openai-fast";
const PROVIDER_ID = "openai-codex";
const API_ID = "openai-codex-responses";
const FAST_SERVICE_TIER = "priority";

// Keep this allowlist aligned with Codex's advertised `service_tiers` metadata:
// https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json
export const SUPPORTED_MODELS = [
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
] as const;

const SUPPORTED_MODEL_SET = new Set<string>(SUPPORTED_MODELS);
const COMMAND_ACTIONS = ["on", "off", "status"] as const;

const DEFAULT_CONFIG: OpenAIFastConfig = {
	enabled: false,
	showStatus: true,
};

type FastOverride = "auto" | "on" | "off";

type OpenAIFastConfig = {
	/** Default Fast mode state when there is no session override. */
	enabled: boolean;
	/** Show `fast` in the status area while Fast mode is active. */
	showStatus: boolean;
};

type SessionState = {
	config: OpenAIFastConfig;
	override: FastOverride;
};

type PayloadRecord = Record<string, unknown>;

type Eligibility = {
	eligible: boolean;
	modelKey: string;
	reason?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfigFile(path: string): Partial<OpenAIFastConfig> {
	if (!existsSync(path)) return {};

	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed)) return {};

		return {
			...(typeof parsed.enabled === "boolean" ? { enabled: parsed.enabled } : {}),
			...(typeof parsed.showStatus === "boolean" ? { showStatus: parsed.showStatus } : {}),
		};
	} catch (error) {
		console.error(`Warning: Could not parse ${path}: ${error}`);
		return {};
	}
}

function mergeConfig(
	base: OpenAIFastConfig,
	overrides: Partial<OpenAIFastConfig>,
): OpenAIFastConfig {
	return {
		enabled: overrides.enabled ?? base.enabled,
		showStatus: overrides.showStatus ?? base.showStatus,
	};
}

function loadConfig(ctx: ExtensionContext): OpenAIFastConfig {
	const globalConfig = readConfigFile(join(getAgentDir(), "extensions", "openai-fast.json"));
	const projectConfig = ctx.isProjectTrusted()
		? readConfigFile(join(ctx.cwd, CONFIG_DIR_NAME, "openai-fast.json"))
		: {};

	return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function modelKey(ctx: ExtensionContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model";
}

function isFastEnabled(state: SessionState): boolean {
	if (state.override === "on") return true;
	if (state.override === "off") return false;
	return state.config.enabled;
}

function describeMode(state: SessionState): string {
	if (state.override === "on") return "on (session override)";
	if (state.override === "off") return "off (session override)";
	return state.config.enabled ? "on (config default)" : "off (config default)";
}

function getEligibility(ctx: ExtensionContext): Eligibility {
	const model = ctx.model;
	if (!model) {
		return { eligible: false, modelKey: "no-model", reason: "no model is selected" };
	}

	const key = modelKey(ctx);
	if (model.provider !== PROVIDER_ID) {
		return {
			eligible: false,
			modelKey: key,
			reason: `provider is ${model.provider}, not ${PROVIDER_ID}`,
		};
	}

	if (model.api !== API_ID) {
		return {
			eligible: false,
			modelKey: key,
			reason: `API is ${model.api}, not ${API_ID}`,
		};
	}

	if (!SUPPORTED_MODEL_SET.has(model.id)) {
		return {
			eligible: false,
			modelKey: key,
			reason: `${model.id} does not advertise Codex Fast mode`,
		};
	}

	if (!ctx.modelRegistry.isUsingOAuth(model)) {
		return {
			eligible: false,
			modelKey: key,
			reason: "ChatGPT OAuth authentication is required",
		};
	}

	return { eligible: true, modelKey: key };
}

function updateStatus(ctx: ExtensionContext, state: SessionState): void {
	if (!ctx.hasUI) return;

	const eligibility = getEligibility(ctx);
	const visible =
		state.config.showStatus && isFastEnabled(state) && eligibility.eligible ? "fast" : undefined;
	ctx.ui.setStatus(EXTENSION_ID, visible);
}

function getStatusMessage(ctx: ExtensionContext, state: SessionState): string {
	const eligibility = getEligibility(ctx);

	if (!isFastEnabled(state)) {
		return `OpenAI Fast mode is ${describeMode(state)}. Current model: ${eligibility.modelKey}.`;
	}

	if (!eligibility.eligible) {
		return `OpenAI Fast mode is ${describeMode(state)}, but inactive for ${eligibility.modelKey}: ${eligibility.reason}.`;
	}

	return `OpenAI Fast mode is ${describeMode(state)} and active for ${eligibility.modelKey}; requests without an existing service tier use service_tier=${FAST_SERVICE_TIER}.`;
}

function injectFastServiceTier(
	payload: unknown,
	ctx: ExtensionContext,
	state: SessionState,
): PayloadRecord | undefined {
	if (!isFastEnabled(state) || !getEligibility(ctx).eligible || !isRecord(payload)) {
		return undefined;
	}
	if (payload.model !== ctx.model?.id || Object.hasOwn(payload, "service_tier")) {
		return undefined;
	}

	return {
		...payload,
		service_tier: FAST_SERVICE_TIER,
	};
}

export default function openAIFastExtension(pi: ExtensionAPI) {
	let state: SessionState | undefined;

	function getState(ctx: ExtensionContext): SessionState {
		state ??= {
			config: loadConfig(ctx),
			override: "auto",
		};
		return state;
	}

	pi.on("session_start", (_event, ctx) => {
		state = {
			config: loadConfig(ctx),
			override: "auto",
		};
		updateStatus(ctx, state);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_ID, undefined);
		state = undefined;
	});

	pi.on("model_select", (_event, ctx) => {
		updateStatus(ctx, getState(ctx));
	});

	pi.on("before_provider_request", (event, ctx) => {
		const currentState = getState(ctx);
		const nextPayload = injectFastServiceTier(event.payload, ctx, currentState);
		updateStatus(ctx, currentState);
		return nextPayload;
	});

	pi.registerCommand("fast", {
		description: "Toggle or inspect OpenAI Codex Fast mode",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			const matches = COMMAND_ACTIONS.filter((action) => action.startsWith(normalized));
			return matches.length > 0
				? matches.map((action) => ({ value: action, label: action }))
				: null;
		},
		handler: async (args, ctx) => {
			const currentState = getState(ctx);
			const action = args.trim().toLowerCase();

			switch (action) {
				case "":
					currentState.override = isFastEnabled(currentState) ? "off" : "on";
					break;
				case "on":
					currentState.override = "on";
					break;
				case "off":
					currentState.override = "off";
					break;
				case "status":
					break;
				default:
					ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
					return;
			}

			updateStatus(ctx, currentState);
			ctx.ui.notify(getStatusMessage(ctx, currentState), "info");
		},
	});
}
