import { stream, validateToolCall, type Tool } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { exec as execCb } from "child_process";
import { promisify } from "util";

const exec = promisify(execCb as any);
const LOCAL_PROMPT = path.join(__dirname, "commit-message-generator.prompt.md");
const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "data", "generate-commit-message", "settings.json");
const DIFF_TRUNCATE_LIMIT = 400000;
const DEFAULT_READ_LINES = 220;
const DEFAULT_FIND_LIMIT = 200;
const DEFAULT_GREP_LIMIT = 80;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const SKIP_DIRS = new Set([
	".git",
	"Library",
	"Temp",
	"Logs",
	"obj",
	"Builds",
	"ProfilerCaptures",
	"UserSettings",
	".idea",
	".vscode",
]);

type PreviewMode = "streaming" | "clarify" | "done" | "error";
type ThinkingLevelSetting = (typeof THINKING_LEVELS)[number];
type ReasoningEffortSetting = Exclude<ThinkingLevelSetting, "off">;

type CommitMessageSettings = {
	model: string | null;
	thinkingLevel: ThinkingLevelSetting;
	useRepoTools: boolean;
	showThinking: boolean;
	showToolActivity: boolean;
	showThinkingSummary: boolean;
};

const DEFAULT_SETTINGS: CommitMessageSettings = {
	model: null,
	thinkingLevel: "high",
	useRepoTools: true,
	showThinking: true,
	showToolActivity: true,
	showThinkingSummary: true,
};

type ToolExecutionResult = {
	toolName: string;
	output: string;
	isError: boolean;
	summary: string;
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("commit-msg", {
		description: "Generate a commit message using the configured model and copy it to clipboard",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) ctx.ui.notify("Preparing commit message generation...", "info");

			const settings = await loadSettings();
			const model = resolveConfiguredModel(ctx, settings);
			if (!model) {
				if (ctx.hasUI) {
					ctx.ui.notify("No model configured. Run /commit-msg:settings and choose a model.", "warning");
				}
				return;
			}
			const reasoningEffort = getReasoningEffortForModel(model, settings.thinkingLevel);

			const promptText = await loadPrompt(ctx);
			if (!promptText) return;

			const submodules = await getSubmodules();
			let workdir = process.cwd();
			let chosenSubmodule: string | null = null;
			if (submodules.length > 0 && ctx.hasUI) {
				const choice = await ctx.ui.select("Generate commit message for:", ["(current repo)", ...submodules]);
				if (!choice) return;
				if (choice !== "(current repo)") {
					chosenSubmodule = choice;
					workdir = path.join(process.cwd(), choice);
				}
			}

			if (!(await isGitRepo(workdir))) {
				if (ctx.hasUI) ctx.ui.notify("Not a git repository: " + workdir, "warning");
				return;
			}

			const stagedNames = await getStagedNames(workdir);
			if (!stagedNames) {
				if (ctx.hasUI) ctx.ui.notify("No staged changes. Stage changes first.", "warning");
				return;
			}
			const changedReadableFiles = settings.useRepoTools ? await getChangedReadableFiles(workdir) : [];

			let initialClarification = "";
			if (ctx.hasUI) {
				const clar = await ctx.ui.input("Optional: provide a brief reason/why for this change (press Enter to skip):");
				if (clar && typeof clar === "string") initialClarification = clar.trim();
			}

			const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-commit-"));
			const tmpDiffPath = path.join(tmpdir, "staged-diff.txt");
			try {
				await exec(`git -C "${workdir}" diff --cached --unified=0 > "${tmpDiffPath}" || true`);
			} catch (_) {
				await fs.writeFile(tmpDiffPath, "", { encoding: "utf8" });
			}

			let diffContent = "";
			try {
				diffContent = String(await fs.readFile(tmpDiffPath, { encoding: "utf8" }));
			} catch (_) {
				diffContent = "";
			}

			let truncated = false;
			if (diffContent.length > DIFF_TRUNCATE_LIMIT) {
				diffContent = diffContent.slice(0, DIFF_TRUNCATE_LIMIT) + `\n\n[TRUNCATED: diff exceeded ${DIFF_TRUNCATE_LIMIT} characters]`;
				truncated = true;
			}

			const promptHeader = `${promptText}\n\n---\nSTAGED FILES:\n${stagedNames}\n\n---\n(Attached file: staged diff)\n`;
			let promptFinal = promptHeader;
			promptFinal += buildRunSpecificInstructions(settings.useRepoTools, changedReadableFiles);
			if (initialClarification) promptFinal += `\nUSER CLARIFICATION:\n${initialClarification}\n\n`;

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth?.ok || !auth.apiKey) {
				if (ctx.hasUI) ctx.ui.notify(String(auth?.error || "No model auth"), "warning");
				await safeRm(tmpdir);
				return;
			}

			const tools = settings.useRepoTools ? createReadOnlyTools() : [];
			const baseMessages = [
				{ role: "user" as const, content: [{ type: "text" as const, text: promptFinal }], timestamp: Date.now() },
				{ role: "user" as const, content: [{ type: "text" as const, text: `<diff>\n${diffContent}\n</diff>` }], timestamp: Date.now() },
			];
			if (truncated) {
				baseMessages.push({ role: "user" as const, content: [{ type: "text" as const, text: `NOTE: The diff was truncated to ${DIFF_TRUNCATE_LIMIT} characters due to context limits.` }], timestamp: Date.now() });
			}

			if (ctx.hasUI) {
				await ctx.ui.custom((tui, theme, _kb, done) => {
					const { Container, Markdown, Text, matchesKey } = require("@mariozechner/pi-tui");
					const { DynamicBorder, getMarkdownTheme } = require("@mariozechner/pi-coding-agent");
					const mdTheme = getMarkdownTheme();

					let mode: PreviewMode = "streaming";
					let thinkingText = "";
					let thinkingSummary = "";
					let outputText = "";
					let errorMsg = "";
					let clarificationQuestion = "";
					let clarificationInput = "";
					let toolActivity: string[] = [];
					let copiedNotice = false;
					let controller: AbortController | null = null;
					let currentMessages = [...baseMessages];
					const targetLabel = chosenSubmodule ? `Submodule: ${chosenSubmodule}` : `Repository: ${path.basename(process.cwd())}`;
					const modelLabel = formatModelRef(model);
					const thinkingLabel = reasoningEffort ?? "off";
					const repoToolsLabel = settings.useRepoTools ? "enabled" : "disabled";
					let spinnerIdx = 0;
					const spinner = ["-", "\\", "|", "/"];

					const resetForRun = () => {
						thinkingText = "";
						thinkingSummary = "";
						outputText = "";
						errorMsg = "";
						clarificationQuestion = "";
						clarificationInput = "";
						copiedNotice = false;
					};

					const runLoop = async () => {
						controller = new AbortController();
						mode = "streaming";
						try {
							const result = await runToolAwareLoop({
								model,
								messages: currentMessages,
								tools,
								apiKey: auth.apiKey,
								headers: auth.headers,
								reasoningEffort,
								signal: controller.signal,
								workdir,
								onEvent: (event) => {
									if (event.type === "thinking_delta") {
										thinkingText += event.delta;
									} else if (event.type === "text_delta") {
										outputText += event.delta;
									} else if (event.type === "tool") {
										toolActivity.push(event.message);
									}
									tui.requestRender?.();
								},
							});

							currentMessages = result.messages;
							outputText = result.finalText || outputText;
							thinkingSummary = summarizeThinking(thinkingText, toolActivity);
							if (isClarificationRequest(outputText)) {
								clarificationQuestion = outputText.trim();
								mode = "clarify";
							} else {
								mode = "done";
							}
						} catch (err: any) {
							if (!controller?.signal.aborted) {
								mode = "error";
								errorMsg = String(err.message || err);
								thinkingSummary = summarizeThinking(thinkingText, toolActivity);
							}
						}
						tui.requestRender?.();
					};

					runLoop();
					const interval = setInterval(() => {
						spinnerIdx = (spinnerIdx + 1) % spinner.length;
						tui.requestRender?.();
					}, 120);

					return {
						render: (width: number) => {
							const container = new Container();
							const addSectionTitle = (title: string) => {
								const line = `── ${title} ${"─".repeat(Math.max(0, width - title.length - 8))}`;
								container.addChild(new Text(theme.fg("borderMuted", line), 1, 0));
							};
							container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
							container.addChild(new Text(theme.fg("accent", theme.bold("Commit message preview")), 1, 0));

							addSectionTitle("Context");
							let headerMd = `**Target:** ${escapeMarkdown(targetLabel)}\n\n**Model:** ${escapeMarkdown(modelLabel)}\n\n**Thinking level:** ${escapeMarkdown(thinkingLabel)}\n\n**Repo tools:** ${escapeMarkdown(repoToolsLabel)}\n\n**Staged files:**\n${escapeMarkdown(stagedNames)}`;
							if (initialClarification) headerMd += `\n\n**Initial clarification:**\n${escapeMarkdown(initialClarification)}`;
							if (truncated) headerMd += `\n\n_Note: diff was truncated for model input._`;
							container.addChild(new Markdown(headerMd, 1, 1, mdTheme));
							container.addChild(new Text("", 1, 0));

							if (settings.showToolActivity && toolActivity.length > 0) {
								addSectionTitle("Tool activity");
								container.addChild(new Markdown(toolActivity.map((x) => `- ${escapeMarkdown(x)}`).join("\n"), 1, 1, mdTheme));
								container.addChild(new Text("", 1, 0));
							}

							if (settings.showThinking && mode === "streaming" && thinkingText) {
								addSectionTitle("Thinking");
								container.addChild(new Text(theme.fg("thinkingHigh", thinkingText), 1, 0));
								container.addChild(new Text("", 1, 0));
							} else if (settings.showThinkingSummary && thinkingSummary) {
								addSectionTitle("Thinking summary");
								container.addChild(new Text(theme.fg("thinkingHigh", thinkingSummary), 1, 0));
								container.addChild(new Text("", 1, 0));
							}

							if (mode === "streaming") {
								addSectionTitle("Current output");
								container.addChild(new Text(theme.fg("muted", `Generating ${spinner[spinnerIdx]}`), 1, 0));
								if (outputText) container.addChild(new Markdown(escapeMarkdown(outputText), 1, 1, mdTheme));
								container.addChild(new Text(theme.fg("dim", "Enter/Esc close"), 1, 0));
							} else if (mode === "clarify") {
								addSectionTitle("Clarification needed");
								container.addChild(new Markdown(escapeMarkdown(clarificationQuestion), 1, 1, mdTheme));
								container.addChild(new Text("", 1, 0));
								container.addChild(new Text(theme.fg("accent", "Your clarification:"), 1, 0));
								container.addChild(new Text(clarificationInput || theme.fg("dim", "Type here..."), 1, 0));
								container.addChild(new Text(theme.fg("dim", "Enter submit • Backspace edit • Esc cancel/close"), 1, 0));
							} else if (mode === "error") {
								addSectionTitle("Error");
								container.addChild(new Text(theme.fg("error", "Model request failed:"), 1, 0));
								container.addChild(new Text(errorMsg || "Unknown error", 1, 0));
								container.addChild(new Text(theme.fg("dim", "Enter/Esc close"), 1, 0));
							} else {
								addSectionTitle("Generated commit message");
								container.addChild(new Markdown(outputText ? escapeMarkdown(outputText) : "(no output)", 1, 1, mdTheme));
								container.addChild(new Text("", 1, 0));
								if (copiedNotice) container.addChild(new Text(theme.fg("success", "Copied to clipboard"), 1, 0));
								container.addChild(new Text(theme.fg("dim", "c copy • Enter/Esc close"), 1, 0));
							}

							container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
							return container.render(width);
						},
						invalidate: () => {},
						handleInput: async (data: string) => {
							try {
								if (mode === "clarify") {
									if (matchesKey(data, "escape") || matchesKey(data, "tui.select.cancel")) {
										clearInterval(interval);
										try { controller?.abort(); } catch (_) {}
										done(undefined);
										return;
									}
									if (matchesKey(data, "backspace") || data === "\x7f") {
										clarificationInput = clarificationInput.slice(0, -1);
										tui.requestRender?.();
										return;
									}
									if (matchesKey(data, "tui.select.confirm") || data === "\n" || data === "\r") {
										if (!clarificationInput.trim()) {
											ctx.ui.notify("Please type a clarification or press Esc to cancel", "warning");
											return;
										}
										currentMessages.push({
											role: "user",
											content: [{ type: "text", text: `USER CLARIFICATION:\n${clarificationInput.trim()}` }],
											timestamp: Date.now(),
										});
										resetForRun();
										await runLoop();
										return;
									}
									if (typeof data === "string" && data.length === 1 && data >= " ") {
										clarificationInput += data;
										tui.requestRender?.();
									}
									return;
								}

								if ((data === "c" || data === "C") && mode === "done") {
									const sanitized = sanitizeReferences(outputText);
									await copyToClipboard(sanitized, ctx, pi);
									copiedNotice = true;
									tui.requestRender?.();
									return;
								}

								if (matchesKey(data, "tui.select.confirm") || matchesKey(data, "tui.select.cancel") || matchesKey(data, "escape") || data === "\n" || data === "\r") {
									clearInterval(interval);
									try { controller?.abort(); } catch (_) {}
									done(undefined);
									return;
								}
							} catch (err: any) {
								clearInterval(interval);
								try { controller?.abort(); } catch (_) {}
								done(undefined);
								if (ctx.hasUI) ctx.ui.notify("Preview error: " + String(err.message || err), "warning");
							}
						},
					};
				});

				await safeRm(tmpdir);
				return;
			}

			try {
				const result = await runToolAwareLoop({
					model,
					messages: [...baseMessages],
					tools,
					apiKey: auth.apiKey,
					headers: auth.headers,
					reasoningEffort,
					workdir,
				});
				const sanitized = sanitizeReferences(result.finalText);
				await copyToClipboard(sanitized, ctx, pi);
				if (ctx.hasUI) ctx.ui.notify("Commit message copied to clipboard", "success");
			} catch (err: any) {
				if (ctx.hasUI) ctx.ui.notify("Model request failed: " + String(err.message || err), "error");
			}
			await safeRm(tmpdir);
		},
	});

	pi.registerCommand("commit-msg:settings", {
		description: "Configure model and preview settings for /commit-msg",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			const settings = await loadSettings();
			while (true) {
				const currentModelLabel = settings.model ?? "(none selected)";
				const choice = await ctx.ui.select("Commit message settings", [
					`Model: ${currentModelLabel}`,
					`Thinking level: ${settings.thinkingLevel}`,
					`Use read/grep/find tools: ${settings.useRepoTools ? "on" : "off"}`,
					`Show thinking: ${settings.showThinking ? "on" : "off"}`,
					`Show tool activity: ${settings.showToolActivity ? "on" : "off"}`,
					`Show thinking summary: ${settings.showThinkingSummary ? "on" : "off"}`,
					"Reset to defaults",
					"Close",
				]);
				if (!choice || choice === "Close") {
					await saveSettings(settings);
					ctx.ui.notify("Commit message settings saved", "success");
					return;
				}

				if (choice.startsWith("Model:")) {
					const availableModels = getSelectableModels(ctx);
					if (!availableModels.length) {
						ctx.ui.notify("No configured models are available in pi. Configure/login to a model first.", "warning");
						continue;
					}
					const labels = ["(none)", ...availableModels.map((m: any) => `${formatModelRef(m)} — ${m.name}`)];
					const selected = await ctx.ui.select("Choose commit message model", labels);
					if (!selected) continue;
					if (selected === "(none)") {
						settings.model = null;
					} else {
						const selectedIndex = labels.indexOf(selected);
						const selectedModel = selectedIndex > 0 ? availableModels[selectedIndex - 1] : undefined;
						if (selectedModel) settings.model = formatModelRef(selectedModel);
					}
					await saveSettings(settings);
					continue;
				}

				if (choice.startsWith("Thinking level:")) {
					const selected = await ctx.ui.select("Choose thinking level", [...THINKING_LEVELS]);
					if (!selected) continue;
					settings.thinkingLevel = selected as ThinkingLevelSetting;
					await saveSettings(settings);
					continue;
				}

				if (choice.startsWith("Use read/grep/find tools:")) {
					settings.useRepoTools = !settings.useRepoTools;
					await saveSettings(settings);
					continue;
				}

				if (choice.startsWith("Show thinking:")) {
					settings.showThinking = !settings.showThinking;
					await saveSettings(settings);
					continue;
				}
				if (choice.startsWith("Show tool activity:")) {
					settings.showToolActivity = !settings.showToolActivity;
					await saveSettings(settings);
					continue;
				}
				if (choice.startsWith("Show thinking summary:")) {
					settings.showThinkingSummary = !settings.showThinkingSummary;
					await saveSettings(settings);
					continue;
				}
				if (choice === "Reset to defaults") {
					settings.model = DEFAULT_SETTINGS.model;
					settings.thinkingLevel = DEFAULT_SETTINGS.thinkingLevel;
					settings.useRepoTools = DEFAULT_SETTINGS.useRepoTools;
					settings.showThinking = DEFAULT_SETTINGS.showThinking;
					settings.showToolActivity = DEFAULT_SETTINGS.showToolActivity;
					settings.showThinkingSummary = DEFAULT_SETTINGS.showThinkingSummary;
					await saveSettings(settings);
					ctx.ui.notify("Commit message settings reset", "info");
				}
			}
		},
	});
}

async function loadSettings(): Promise<CommitMessageSettings> {
	try {
		const raw = String(await fs.readFile(SETTINGS_PATH, { encoding: "utf8" }));
		const parsed = JSON.parse(raw || "{}") as Partial<CommitMessageSettings>;
		return normalizeSettings(parsed);
	} catch (err: any) {
		if (err?.code === "ENOENT") {
			await saveSettings(DEFAULT_SETTINGS);
			return { ...DEFAULT_SETTINGS };
		}
		return { ...DEFAULT_SETTINGS };
	}
}

async function saveSettings(settings: CommitMessageSettings): Promise<void> {
	const normalized = normalizeSettings(settings);
	await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
	await fs.writeFile(SETTINGS_PATH, JSON.stringify(normalized, null, "\t") + "\n", "utf8");
}

function normalizeSettings(settings: Partial<CommitMessageSettings> | undefined): CommitMessageSettings {
	const thinkingLevel = THINKING_LEVELS.includes(settings?.thinkingLevel as ThinkingLevelSetting)
		? (settings!.thinkingLevel as ThinkingLevelSetting)
		: DEFAULT_SETTINGS.thinkingLevel;
	return {
		model: typeof settings?.model === "string" && settings.model.trim() ? settings.model.trim() : null,
		thinkingLevel,
		useRepoTools: typeof settings?.useRepoTools === "boolean" ? settings.useRepoTools : DEFAULT_SETTINGS.useRepoTools,
		showThinking: typeof settings?.showThinking === "boolean" ? settings.showThinking : DEFAULT_SETTINGS.showThinking,
		showToolActivity: typeof settings?.showToolActivity === "boolean" ? settings.showToolActivity : DEFAULT_SETTINGS.showToolActivity,
		showThinkingSummary: typeof settings?.showThinkingSummary === "boolean" ? settings.showThinkingSummary : DEFAULT_SETTINGS.showThinkingSummary,
	};
}

function formatModelRef(model: any): string {
	if (!model) return "(none)";
	return `${model.provider}/${model.id}`;
}

function parseModelRef(ref: string | null | undefined): { provider: string; id: string } | null {
	if (!ref) return null;
	const idx = ref.indexOf("/");
	if (idx <= 0 || idx === ref.length - 1) return null;
	return { provider: ref.slice(0, idx), id: ref.slice(idx + 1) };
}

function resolveConfiguredModel(ctx: any, settings: CommitMessageSettings): any | null {
	const parsed = parseModelRef(settings.model);
	if (!parsed) return null;
	return ctx.modelRegistry.find(parsed.provider, parsed.id) || null;
}

function getSelectableModels(ctx: any): any[] {
	return [...ctx.modelRegistry.getAll()]
		.filter((model: any) => ctx.modelRegistry.hasConfiguredAuth(model))
		.sort((a: any, b: any) => formatModelRef(a).localeCompare(formatModelRef(b)));
}

function getReasoningEffortForModel(model: any, thinkingLevel: ThinkingLevelSetting): ReasoningEffortSetting | undefined {
	if (!model?.reasoning) return undefined;
	if (thinkingLevel === "off") return undefined;
	return thinkingLevel;
}

async function loadPrompt(ctx: any): Promise<string | null> {
	try {
		return String(await fs.readFile(LOCAL_PROMPT, { encoding: "utf8" }));
	} catch (_) {}
	if (ctx?.hasUI) ctx.ui.notify("No bundled prompt template found.", "warning");
	return null;
}

async function getSubmodules(): Promise<string[]> {
	try {
		const res = await exec("git config -f .gitmodules --get-regexp path || true");
		const out: string[] = [];
		for (const line of String(res.stdout).split(/\r?\n/)) {
			if (!line.trim()) continue;
			const parts = line.split(/\s+/);
			if (parts.length >= 2) out.push(parts[1]);
		}
		return out;
	} catch (_) {
		return [];
	}
}

async function isGitRepo(workdir: string): Promise<boolean> {
	try {
		await exec(`git -C "${workdir}" rev-parse --is-inside-work-tree`);
		return true;
	} catch (_) {
		return false;
	}
}

async function getStagedNames(workdir: string): Promise<string> {
	const names = await exec(`git -C "${workdir}" diff --cached --name-status || true`);
	return String(names.stdout).trim();
}

async function getChangedReadableFiles(workdir: string): Promise<string[]> {
	try {
		const result = await exec(`git -C "${workdir}" diff --cached --name-only --diff-filter=ACMR || true`);
		const files = String(result.stdout)
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean);
		const readable: string[] = [];
		for (const rel of files) {
			try {
				const abs = safeResolveFile(workdir, rel);
				const stat = await fs.stat(abs);
				if (!stat.isFile()) continue;
				readable.push(rel);
			} catch (_) {}
		}
		return readable;
	} catch (_) {
		return [];
	}
}

function buildRunSpecificInstructions(useRepoTools: boolean, changedReadableFiles: string[]): string {
	if (!useRepoTools) {
		return "\nRUN SETTINGS:\n- Read-only repository tools are DISABLED for this run.\n- Do not assume tools are available.\n- Infer the commit message only from the staged diff, the optional user clarification, and any later user clarification in this session.\n\n";
	}
	let text = "\nRUN SETTINGS:\n- Read-only repository tools are ENABLED for this run.\n- Before producing a final commit message or asking the user for clarification, you MUST inspect the changed source files with read_file.\n";
	if (changedReadableFiles.length > 0) {
		text += `- Mandatory read_file targets for this run:\n${changedReadableFiles.map((file) => `  - ${file}`).join("\n")}\n`;
		text += "- Use read_file at least once for each listed file before your first final answer or clarification question.\n\n";
	} else {
		text += "- No readable changed files were detected, so use tools only if you still need more context from the repository.\n\n";
	}
	return text;
}

function createReadOnlyTools(): Tool[] {
	return [
		{
			name: "find_files",
			description: "Find files in the repository by filename or path substring. Use this to locate relevant source files before reading them.",
			parameters: Type.Object({
				query: Type.String({ description: "Substring to match in a repository-relative path or filename." }),
				limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
				under: Type.Optional(Type.String({ description: "Optional repo-relative subdirectory to search under." })),
			}),
		},
		{
			name: "grep_files",
			description: "Search for a literal string across repository files and return matching lines with file paths and line numbers.",
			parameters: Type.Object({
				query: Type.String({ description: "Literal string to search for." }),
				limit: Type.Optional(Type.Number({ minimum: 1, maximum: 300 })),
				under: Type.Optional(Type.String({ description: "Optional repo-relative subdirectory to search under." })),
				ignoreCase: Type.Optional(Type.Boolean({ default: false })),
			}),
		},
		{
			name: "read_file",
			description: "Read a repository file or excerpt by line range. Paths must be repo-relative.",
			parameters: Type.Object({
				path: Type.String({ description: "Repository-relative file path." }),
				startLine: Type.Optional(Type.Number({ minimum: 1 })),
				maxLines: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
			}),
		},
	];
}

async function runToolAwareLoop(args: {
	model: any;
	messages: any[];
	tools: Tool[];
	apiKey: string;
	headers: Record<string, string> | undefined;
	reasoningEffort?: ReasoningEffortSetting;
	workdir: string;
	signal?: AbortSignal;
	onEvent?: (event:
		| { type: "thinking_delta"; delta: string }
		| { type: "text_delta"; delta: string }
		| { type: "tool"; message: string }) => void;
}): Promise<{ messages: any[]; finalText: string }> {
	const { model, tools, apiKey, headers, reasoningEffort, workdir, signal, onEvent } = args;
	const messages = args.messages;

	while (true) {
		const s = stream(model, { messages, tools }, { apiKey, headers, reasoningEffort, signal });
		for await (const event of s) {
			if (event.type === "thinking_delta") {
				onEvent?.({ type: "thinking_delta", delta: (event as any).delta || "" });
			} else if (event.type === "text_delta") {
				onEvent?.({ type: "text_delta", delta: (event as any).delta || "" });
			} else if (event.type === "toolcall_end") {
				const tc: any = (event as any).toolCall;
				onEvent?.({ type: "tool", message: `Model requested ${tc?.name || "tool"}` });
			}
		}

		const final = await s.result();
		messages.push(final);
		const toolCalls = final.content.filter((b: any) => b.type === "toolCall");
		if (!toolCalls.length) {
			const finalText = final.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
			return { messages, finalText };
		}

		for (const toolCall of toolCalls) {
			const result = await executeReadOnlyTool(toolCall, tools, workdir);
			onEvent?.({ type: "tool", message: result.summary });
			messages.push({
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: result.output }],
				isError: result.isError,
				timestamp: Date.now(),
			});
		}
	}
}

async function executeReadOnlyTool(toolCall: any, tools: Tool[], workdir: string): Promise<ToolExecutionResult> {
	try {
		const args = validateToolCall(tools, toolCall as any) as any;
		if (toolCall.name === "find_files") {
			const under = args.under ? safeResolveUnder(workdir, args.under) : workdir;
			const limit = clamp(args.limit ?? DEFAULT_FIND_LIMIT, 1, 500);
			const files = await findFiles(under, String(args.query || ""), limit, workdir);
			return {
				toolName: toolCall.name,
				output: files.length ? files.join("\n") : "No files found.",
				isError: false,
				summary: `find_files: ${args.query} (${files.length} result${files.length === 1 ? "" : "s"})`,
			};
		}
		if (toolCall.name === "grep_files") {
			const under = args.under ? safeResolveUnder(workdir, args.under) : workdir;
			const limit = clamp(args.limit ?? DEFAULT_GREP_LIMIT, 1, 300);
			const hits = await grepFiles(under, String(args.query || ""), limit, workdir, Boolean(args.ignoreCase));
			return {
				toolName: toolCall.name,
				output: hits.length ? hits.join("\n") : "No matches found.",
				isError: false,
				summary: `grep_files: ${args.query} (${hits.length} match${hits.length === 1 ? "" : "es"})`,
			};
		}
		if (toolCall.name === "read_file") {
			const requestedPath = String(args.path);
			const resolved = safeResolveFile(workdir, requestedPath);
			const startLine = clamp(args.startLine ?? 1, 1, 1_000_000);
			const maxLines = clamp(args.maxLines ?? DEFAULT_READ_LINES, 1, 500);
			const content = await readFileExcerpt(resolved, startLine, maxLines, workdir);
			return {
				toolName: toolCall.name,
				output: content,
				isError: false,
				summary: `read_file: ${path.relative(workdir, resolved)}:${startLine}+${maxLines}`,
			};
		}
		return {
			toolName: toolCall.name,
			output: `Unsupported tool: ${toolCall.name}`,
			isError: true,
			summary: `Unsupported tool: ${toolCall.name}`,
		};
	} catch (err: any) {
		const message = String(err?.message || err || "Unknown tool error");
		return {
			toolName: toolCall?.name || "unknown",
			output: `Tool error: ${message}`,
			isError: true,
			summary: `${toolCall?.name || "tool"}: error`,
		};
	}
}

function clamp(n: number, min: number, max: number) {
	return Math.max(min, Math.min(max, n));
}

function safeResolveFile(workdir: string, relPath: string): string {
	const resolved = path.resolve(workdir, relPath);
	const root = path.resolve(workdir);
	if (!resolved.startsWith(root + path.sep) && resolved !== root) {
		throw new Error(`Path escapes repository root: ${relPath}`);
	}
	return resolved;
}

function safeResolveUnder(workdir: string, relPath: string): string {
	return safeResolveFile(workdir, relPath);
}

async function findFiles(root: string, query: string, limit: number, workdir: string): Promise<string[]> {
	const out: string[] = [];
	const q = query.toLowerCase();
	await walkFiles(root, async (abs, rel) => {
		if (out.length >= limit) return false;
		if (!q || rel.toLowerCase().includes(q)) out.push(rel);
		return true;
	}, workdir);
	return out;
}

async function grepFiles(root: string, query: string, limit: number, workdir: string, ignoreCase: boolean): Promise<string[]> {
	const out: string[] = [];
	const needle = ignoreCase ? query.toLowerCase() : query;
	await walkFiles(root, async (abs, rel) => {
		if (out.length >= limit) return false;
		let text = "";
		try {
			text = await fs.readFile(abs, "utf8");
		} catch {
			return true;
		}
		const lines = text.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			if (out.length >= limit) return false;
			const hay = ignoreCase ? lines[i]!.toLowerCase() : lines[i]!;
			if (hay.includes(needle)) out.push(`${rel}:${i + 1}: ${lines[i]}`);
		}
		return true;
	}, workdir);
	return out;
}

async function readFileExcerpt(absPath: string, startLine: number, maxLines: number, workdir: string): Promise<string> {
	const text = await fs.readFile(absPath, "utf8");
	const lines = text.split(/\r?\n/);
	const startIdx = Math.max(0, startLine - 1);
	const endIdx = Math.min(lines.length, startIdx + maxLines);
	const excerpt = lines.slice(startIdx, endIdx).map((line, idx) => `${startIdx + idx + 1}: ${line}`).join("\n");
	return `# ${path.relative(workdir, absPath)}\n${excerpt}`;
}

async function walkFiles(root: string, visit: (abs: string, rel: string) => Promise<boolean>, workdir: string) {
	const entries = await fs.readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		const abs = path.join(root, entry.name);
		const rel = path.relative(workdir, abs);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			const keepGoing = await walkFiles(abs, visit, workdir).then(() => true);
			if (!keepGoing) return false;
		} else if (entry.isFile()) {
			const keepGoing = await visit(abs, rel);
			if (!keepGoing) return false;
		}
	}
	return true;
}

function isClarificationRequest(text: string): boolean {
	const t = text.trim();
	if (!t || t.length > 400) return false;
	const lower = t.toLowerCase();
	if (
		lower.startsWith("please provide") ||
		lower.startsWith("please clarify") ||
		lower.startsWith("please") ||
		lower.startsWith("what") ||
		lower.startsWith("which") ||
		lower.startsWith("why") ||
		lower.startsWith("could you") ||
		lower.includes("clarify")
	) return true;
	return t.endsWith("?") && t.split("\n").length <= 3;
}

async function safeRm(p: string) {
	try {
		await fs.rm(p, { recursive: true, force: true });
	} catch (_) {}
}

async function copyToClipboard(text: string, ctx: any, pi: ExtensionAPI) {
	const cleaned = text.replace(/^```[a-zA-Z0-9_-]*\s*/g, "").replace(/```\s*$/g, "").trim();
	const tmpPath = path.join(os.tmpdir(), `pi-commit-clipboard-${Date.now()}.md`);
	await fs.writeFile(tmpPath, cleaned, { encoding: "utf8" });
	const unixEscape = (p: string) => `'${p.replace(/'/g, `\\'`)}'`;
	try {
		if (process.platform === "darwin") {
			await exec(`pbcopy < ${unixEscape(tmpPath)}`);
		} else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
			try {
				await exec(`wl-copy < ${unixEscape(tmpPath)}`);
			} catch (_) {
				await exec(`xclip -selection clipboard < ${unixEscape(tmpPath)}`);
			}
		} else if (process.platform === "win32") {
			const winCmd = `powershell -NoProfile -Command "Get-Content -Raw -Path ${JSON.stringify(tmpPath)} | Set-Clipboard"`;
			await exec(winCmd);
		} else {
			await exec(`xclip -selection clipboard < ${unixEscape(tmpPath)}`);
		}
		await safeRm(tmpPath);
		return;
	} catch (err: any) {
		await safeRm(tmpPath);
		if (ctx.hasUI) ctx.ui.notify("Failed to copy to clipboard: " + String(err.message || err), "warning");
		pi.appendEntry("generated-commit-message", { text: cleaned });
	}
}

function escapeMarkdown(s: string): string {
	if (!s) return s;
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function summarizeThinking(thinking: string, toolActivity: string[]): string {
	const pieces: string[] = [];
	const normalized = thinking
		.replace(/\r/g, "")
		.split(/\n+/)
		.map((s) => s.trim())
		.filter(Boolean);
	const seen = new Set<string>();
	for (const line of normalized) {
		const compact = line.replace(/\s+/g, " ").trim();
		if (compact.length < 12) continue;
		if (seen.has(compact)) continue;
		seen.add(compact);
		pieces.push(compact);
		if (pieces.length >= 4) break;
	}
	if (!pieces.length && toolActivity.length) {
		pieces.push("Reviewed staged changes and inspected related source files.");
	}
	if (!pieces.length) return "Reviewed staged changes and synthesized the final commit message.";
	return pieces.map((p) => `• ${p}`).join("\n");
}

function sanitizeReferences(input: string): string {
	let out = input;
	out = out.replace(/(?:[A-Za-z]:)?(?:[\\/][^\\s'"<>]+)+[\\/]?([^\\s'"<>\\/]+\.[A-Za-z0-9_\\-]+)\\b/g, (_m, filename) => filename);
	out = out.replace(/(?:[^\\s'"<>]+\\\\)+([^\\\\\\s'"<>]+\.[A-Za-z0-9_\\-]+)\\b/g, (_m, filename) => filename);
	out = out.replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){1,6})\b/g, (m) => {
		if (!m.includes(".")) return m;
		const parts = m.split(".");
		return parts[parts.length - 1];
	});
	out = out.replace(/[ \t]{2,}/g, " ");
	out = out.replace(/(?:\n\s*){3,}/g, "\n\n");
	return out.trim();
}
