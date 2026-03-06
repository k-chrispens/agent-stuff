/**
 * Desktop Notification Extension
 *
 * Sends a native desktop notification when the agent finishes and is waiting for input.
 * Uses terminal-native notifications first, then optional webhook fallback for
 * remote/headless scenarios.
 *
 * Terminal protocols:
 * - Windows toast notifications (Windows Terminal/WSL)
 * - OSC 99 (Kitty)
 * - OSC 777 (Ghostty, iTerm2, WezTerm, rxvt-unicode)
 *
 * Optional webhook fallback env vars:
 * - PI_NOTIFY_WEBHOOK_URL=https://...
 * - PI_NOTIFY_WEBHOOK_KIND=auto|generic|slack|ntfy|pushover
 * - PI_NOTIFY_WEBHOOK_BEARER_TOKEN=...        (optional)
 * - PI_NOTIFY_WEBHOOK_TIMEOUT_MS=5000         (optional, default 5000)
 * - PI_NOTIFY_WEBHOOK_ALWAYS=1                (optional, send webhook even when terminal notify succeeded)
 *
 * Optional service-specific env vars:
 * - PI_NOTIFY_PUSHOVER_TOKEN=...              (required for pushover)
 * - PI_NOTIFY_PUSHOVER_USER=...               (required for pushover)
 * - PI_NOTIFY_PUSHOVER_PRIORITY=0             (optional for pushover)
 * - PI_NOTIFY_SLACK_USERNAME=Pi               (optional for slack)
 * - PI_NOTIFY_SLACK_ICON_EMOJI=:robot_face:  (optional for slack)
 *
 * Skips notifications when the agent has pending follow-up messages (e.g., during
 * /loop iterations) to avoid notification spam during automated multi-turn flows.
 */

import { execFile } from "node:child_process";
import { hostname } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@mariozechner/pi-tui";

type NotificationChannel = "windows-toast" | "osc99" | "osc777" | "none";
type WebhookKind = "auto" | "generic" | "slack" | "ntfy" | "pushover";
type ResolvedWebhookKind = Exclude<WebhookKind, "auto">;

type WebhookConfig = {
	url: string;
	kind: WebhookKind;
	bearerToken?: string;
	timeoutMs: number;
	always: boolean;
	slackUsername?: string;
	slackIconEmoji?: string;
	pushoverToken?: string;
	pushoverUser?: string;
	pushoverPriority?: number;
};

const DEFAULT_WEBHOOK_TIMEOUT_MS = 5000;

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
	Boolean(part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part);

const parseBoolean = (value: string | undefined): boolean => {
	if (!value) return false;
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		default:
			return false;
	}
};

const parseTimeoutMs = (value: string | undefined): number => {
	if (!value) return DEFAULT_WEBHOOK_TIMEOUT_MS;
	const timeout = Number.parseInt(value, 10);
	if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_WEBHOOK_TIMEOUT_MS;
	return timeout;
};

const parseOptionalInteger = (value: string | undefined): number | undefined => {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) return undefined;
	return parsed;
};

const parseWebhookKind = (value: string | undefined): WebhookKind => {
	switch ((value ?? "auto").trim().toLowerCase()) {
		case "generic":
			return "generic";
		case "slack":
			return "slack";
		case "ntfy":
			return "ntfy";
		case "pushover":
			return "pushover";
		default:
			return "auto";
	}
};

const sanitizeForOsc = (value: string): string =>
	value
		.replace(/\u001b/g, "")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/;/g, ",")
		.replace(/\s+/g, " ")
		.trim();

const sanitizeForPowerShell = (value: string): string => value.replace(/\r?\n/g, " ").replace(/'/g, "''");

const sanitizeForHeader = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();

const notifyOSC777 = (title: string, body: string): void => {
	const safeTitle = sanitizeForOsc(title);
	const safeBody = sanitizeForOsc(body);
	process.stdout.write(`\x1b]777;notify;${safeTitle};${safeBody}\x07`);
};

const notifyOSC99 = (title: string, body: string): void => {
	const safeTitle = sanitizeForOsc(title);
	const safeBody = sanitizeForOsc(body);
	// Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part
	process.stdout.write(`\x1b]99;i=1:d=0;${safeTitle}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${safeBody}\x1b\\`);
};

const windowsToastScript = (title: string, body: string): string => {
	const safeTitle = sanitizeForPowerShell(title);
	const safeBody = sanitizeForPowerShell(body || "Ready for input");
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText02`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$textNodes = $xml.GetElementsByTagName('text')`,
		`$textNodes[0].AppendChild($xml.CreateTextNode('${safeTitle}')) > $null`,
		`$textNodes[1].AppendChild($xml.CreateTextNode('${safeBody}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('Pi').Show(${toast})`,
	].join("; ");
};

const notifyWindows = async (title: string, body: string): Promise<void> => {
	await new Promise<void>((resolve, reject) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-Command", windowsToastScript(title, body)],
			{ timeout: 4000 },
			(error) => {
				if (error) reject(error);
				else resolve();
			},
		);
	});
};

const isKnownUnsupportedTerminal = (): boolean => {
	const termProgram = (process.env.TERM_PROGRAM ?? "").toLowerCase();
	const term = (process.env.TERM ?? "").toLowerCase();

	if (termProgram === "apple_terminal") return true;
	if (termProgram === "alacritty") return true;
	if (term.includes("alacritty")) return true;

	return false;
};

const tryTerminalNotification = async (title: string, body: string): Promise<NotificationChannel> => {
	if (!process.stdout.isTTY) {
		return "none";
	}

	if (process.env.WT_SESSION) {
		try {
			await notifyWindows(title, body);
			return "windows-toast";
		} catch {
			return "none";
		}
	}

	if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(title, body);
		return "osc99";
	}

	if (isKnownUnsupportedTerminal()) {
		return "none";
	}

	notifyOSC777(title, body);
	return "osc777";
};

const detectWebhookKind = (url: string): ResolvedWebhookKind => {
	try {
		const host = new URL(url).hostname.toLowerCase();
		if (host.includes("slack.com")) return "slack";
		if (host === "ntfy.sh" || host.includes("ntfy")) return "ntfy";
		if (host.includes("pushover.net")) return "pushover";
	} catch {
		// Ignore invalid URL parsing here; fetch will fail later with a clearer error.
	}
	return "generic";
};

const resolveWebhookKind = (config: WebhookConfig): ResolvedWebhookKind => {
	if (config.kind !== "auto") return config.kind;
	return detectWebhookKind(config.url);
};

const getWebhookConfig = (): WebhookConfig | null => {
	const url = process.env.PI_NOTIFY_WEBHOOK_URL?.trim();
	if (!url) return null;

	return {
		url,
		kind: parseWebhookKind(process.env.PI_NOTIFY_WEBHOOK_KIND),
		bearerToken: process.env.PI_NOTIFY_WEBHOOK_BEARER_TOKEN?.trim() || undefined,
		timeoutMs: parseTimeoutMs(process.env.PI_NOTIFY_WEBHOOK_TIMEOUT_MS),
		always: parseBoolean(process.env.PI_NOTIFY_WEBHOOK_ALWAYS),
		slackUsername: process.env.PI_NOTIFY_SLACK_USERNAME?.trim() || undefined,
		slackIconEmoji: process.env.PI_NOTIFY_SLACK_ICON_EMOJI?.trim() || undefined,
		pushoverToken: process.env.PI_NOTIFY_PUSHOVER_TOKEN?.trim() || undefined,
		pushoverUser: process.env.PI_NOTIFY_PUSHOVER_USER?.trim() || undefined,
		pushoverPriority: parseOptionalInteger(process.env.PI_NOTIFY_PUSHOVER_PRIORITY),
	};
};

const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeoutId);
	}
};

const throwIfNotOk = async (service: string, response: Response): Promise<void> => {
	if (response.ok) return;
	let responseText = "";
	try {
		responseText = (await response.text()).trim();
	} catch {
		responseText = "";
	}
	const detail = responseText ? `: ${responseText.slice(0, 200)}` : "";
	throw new Error(`${service} returned ${response.status} ${response.statusText}${detail}`);
};

const sendGenericWebhook = async (
	config: WebhookConfig,
	title: string,
	body: string,
	channel: NotificationChannel,
): Promise<void> => {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (config.bearerToken) {
		headers.authorization = `Bearer ${config.bearerToken}`;
	}

	const response = await fetchWithTimeout(
		config.url,
		{
			method: "POST",
			headers,
			body: JSON.stringify({
				title,
				body,
				channel,
				timestamp: new Date().toISOString(),
				host: hostname(),
				cwd: process.cwd(),
				source: "pi-notify-extension",
			}),
		},
		config.timeoutMs,
	);

	await throwIfNotOk("Webhook", response);
};

const sendSlackWebhook = async (
	config: WebhookConfig,
	title: string,
	body: string,
	channel: NotificationChannel,
): Promise<void> => {
	const context = `${hostname()} · ${process.cwd()} · ${channel}`;
	const text = [
		`*${title}*`,
		body || "Ready for input",
		`_${context}_`,
	].join("\n");

	const payload: Record<string, string> = { text };
	if (config.slackUsername) payload.username = config.slackUsername;
	if (config.slackIconEmoji) payload.icon_emoji = config.slackIconEmoji;

	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (config.bearerToken) {
		headers.authorization = `Bearer ${config.bearerToken}`;
	}

	const response = await fetchWithTimeout(
		config.url,
		{
			method: "POST",
			headers,
			body: JSON.stringify(payload),
		},
		config.timeoutMs,
	);

	await throwIfNotOk("Slack webhook", response);
};

const sendNtfyWebhook = async (
	config: WebhookConfig,
	title: string,
	body: string,
	channel: NotificationChannel,
): Promise<void> => {
	const lines = [
		body || "Ready for input",
		"",
		`host: ${hostname()}`,
		`cwd: ${process.cwd()}`,
		`channel: ${channel}`,
	];

	const headers: Record<string, string> = {
		"content-type": "text/plain; charset=utf-8",
		Title: sanitizeForHeader(title),
	};
	if (config.bearerToken) {
		headers.authorization = `Bearer ${config.bearerToken}`;
	}

	const response = await fetchWithTimeout(
		config.url,
		{
			method: "POST",
			headers,
			body: lines.join("\n"),
		},
		config.timeoutMs,
	);

	await throwIfNotOk("ntfy", response);
};

const sendPushoverWebhook = async (
	config: WebhookConfig,
	title: string,
	body: string,
	channel: NotificationChannel,
): Promise<void> => {
	if (!config.pushoverToken || !config.pushoverUser) {
		throw new Error("Pushover requires PI_NOTIFY_PUSHOVER_TOKEN and PI_NOTIFY_PUSHOVER_USER");
	}

	const message = [body || "Ready for input", "", `${hostname()} · ${process.cwd()} · ${channel}`].join("\n");
	const params = new URLSearchParams({
		token: config.pushoverToken,
		user: config.pushoverUser,
		title,
		message,
	});
	if (typeof config.pushoverPriority === "number") {
		params.set("priority", String(config.pushoverPriority));
	}

	const headers: Record<string, string> = {
		"content-type": "application/x-www-form-urlencoded",
	};

	const response = await fetchWithTimeout(
		config.url,
		{
			method: "POST",
			headers,
			body: params.toString(),
		},
		config.timeoutMs,
	);

	await throwIfNotOk("Pushover", response);
};

const sendWebhookNotification = async (
	config: WebhookConfig,
	title: string,
	body: string,
	channel: NotificationChannel,
): Promise<boolean> => {
	const kind = resolveWebhookKind(config);

	try {
		switch (kind) {
			case "slack":
				await sendSlackWebhook(config, title, body, channel);
				break;
			case "ntfy":
				await sendNtfyWebhook(config, title, body, channel);
				break;
			case "pushover":
				await sendPushoverWebhook(config, title, body, channel);
				break;
			case "generic":
				await sendGenericWebhook(config, title, body, channel);
				break;
		}
		return true;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`[notify] webhook fallback failed (${kind}): ${message}\n`);
		return false;
	}
};

const extractLastAssistantText = (messages: Array<{ role?: string; content?: unknown }>): string | null => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") {
			continue;
		}

		const content = message.content;
		if (typeof content === "string") {
			return content.trim() || null;
		}

		if (Array.isArray(content)) {
			const text = content
				.filter(isTextPart)
				.map((part) => part.text)
				.join("\n")
				.trim();
			return text || null;
		}

		return null;
	}

	return null;
};

const plainMarkdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: () => "",
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: () => "",
	quote: (text) => text,
	quoteBorder: () => "",
	hr: () => "",
	listBullet: () => "",
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

const simpleMarkdown = (text: string, width = 80): string => {
	const markdown = new Markdown(text, 0, 0, plainMarkdownTheme);
	return markdown.render(width).join("\n");
};

const formatNotification = (text: string | null): { title: string; body: string } => {
	const simplified = text ? simpleMarkdown(text) : "";
	const normalized = simplified.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return { title: "Ready for input", body: "" };
	}

	const maxBody = 200;
	const body = normalized.length > maxBody ? `${normalized.slice(0, maxBody - 1)}…` : normalized;
	return { title: "π", body };
};

const sendNotification = async (title: string, body: string): Promise<void> => {
	const terminalChannel = await tryTerminalNotification(title, body);
	const webhookConfig = getWebhookConfig();
	if (!webhookConfig) return;

	if (webhookConfig.always || terminalChannel === "none") {
		await sendWebhookNotification(webhookConfig, title, body, terminalChannel);
	}
};

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (event, ctx) => {
		// Skip notification if there are pending messages (e.g., /loop iterations,
		// follow-up steering messages). Only notify when the agent is truly idle.
		if (ctx.hasPendingMessages()) return;

		const lastText = extractLastAssistantText(event.messages ?? []);
		const { title, body } = formatNotification(lastText);
		await sendNotification(title, body);
	});
}
