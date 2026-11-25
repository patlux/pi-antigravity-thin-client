import * as path from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import {
	generateDiffString,
	getLanguageFromPath,
	highlightCode,
	renderDiff,
	type AgentToolResult,
	type Theme,
	type ToolRendererResolver,
	type ToolRenderers,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";

export const AGY_MIRROR_TOOL_NAMES = [
	"agy_read",
	"agy_edit",
	"agy_write",
	"agy_bash",
	"agy_search",
	"agy_subagent",
	"agy_tool",
] as const;

export type AgyMirrorToolName = (typeof AGY_MIRROR_TOOL_NAMES)[number];

export interface AgyDiffPayload {
	path: string;
	oldText: string;
	newText: string;
}

export interface AgyMirrorToolDetails {
	kind?: string;
	title?: string;
	path?: string;
	line?: number;
	limit?: number;
	command?: string;
	query?: string;
	agentRole?: string;
	diffs?: AgyDiffPayload[];
	status?: string;
}

const COLLAPSED_PREVIEW_LINES = 10;
const BASH_STREAMING_TAIL_LINES = 8;

function formatDisplayPath(rawPath: string | undefined, cwd: string): string {
	if (!rawPath) return "";
	try {
		if (!path.isAbsolute(rawPath)) return rawPath;
		const rel = path.relative(cwd, rawPath);
		if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
			return rel || ".";
		}
		return rawPath;
	} catch {
		return rawPath;
	}
}

function extractResultText(result: AgentToolResult<AgyMirrorToolDetails>): string {
	return result.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trimEnd();
}

function formatDurationSuffix(durationMs: number | undefined, theme: Theme): string {
	if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 100) {
		return "";
	}
	const secs = (durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1);
	return theme.fg("dim", ` (${secs}s)`);
}

function appendExpandHint(
	renderedLines: string[],
	totalLines: number,
	shownLines: number,
	theme: Theme,
	keyHintFn: (kb: "app.tools.expand", desc: string) => string,
): string {
	let output = renderedLines.join("\n");
	const remaining = totalLines - shownLines;
	if (remaining > 0) {
		output += `${theme.fg("muted", `\n... (${remaining} more lines, `)}${keyHintFn("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}
	return output;
}

export function getMirrorToolRenderers(toolName: AgyMirrorToolName): ToolRenderers {
	return {
		renderShell: "default",
		renderCall(rawArgs: unknown, theme: Theme, context) {
			const args = (
				rawArgs && typeof rawArgs === "object" ? rawArgs : {}
			) as Record<string, unknown>;
			const duration = formatDurationSuffix(context.durationMs, theme);
			const rawPath = typeof args?.path === "string" ? args.path : undefined;
			const displayPath = formatDisplayPath(rawPath, context.cwd);
			const title = typeof args?.title === "string" ? args.title : "";

			switch (toolName) {
				case "agy_read": {
					const label = displayPath || title || "file";
					const lineInfo =
						typeof args?.line === "number" ? theme.fg("muted", `:${args.line}`) : "";
					return new Text(
						`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", label)}${lineInfo}${duration}`,
						0,
						0,
					);
				}
				case "agy_edit": {
					const label = displayPath || title || "file";
					return new Text(
						`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", label)}${duration}`,
						0,
						0,
					);
				}
				case "agy_write": {
					const label = displayPath || title || "file";
					return new Text(
						`${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", label)}${duration}`,
						0,
						0,
					);
				}
				case "agy_bash": {
					const cmd =
						(typeof args?.command === "string" && args.command.trim()) ||
						title ||
						"command";
					return new Text(
						`${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("toolTitle", cmd)}${duration}`,
						0,
						0,
					);
				}
				case "agy_search": {
					const query =
						(typeof args?.query === "string" && args.query.trim()) || title || "workspace";
					return new Text(
						`${theme.fg("toolTitle", theme.bold("search"))} ${theme.fg("accent", query)}${duration}`,
						0,
						0,
					);
				}
				case "agy_subagent": {
					const role =
						(typeof args?.agentRole === "string" && args.agentRole.trim()) ||
						title ||
						"subagent";
					return new Text(
						`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", role)}${duration}`,
						0,
						0,
					);
				}
				default: {
					const internalTool = typeof args?.tool === "string" ? args.tool : undefined;
					if (internalTool === "schedule") {
						return new Text(`${theme.fg("toolTitle", theme.bold("⏰ timer"))}${duration}`, 0, 0);
					}
					if (internalTool === "manage_task") {
						return new Text(`${theme.fg("toolTitle", theme.bold("task"))} ${theme.fg("muted", "Hintergrund-Task abfragen/steuern")}${duration}`, 0, 0);
					}
					if (internalTool) {
						return new Text(`${theme.fg("toolTitle", theme.bold(internalTool))}${duration}`, 0, 0);
					}
					const fallbackName = title || "tool";
					return new Text(
						`${theme.fg("toolTitle", theme.bold(fallbackName))}${duration}`,
						0,
						0,
					);
				}
			}
		},

		renderResult(
			result: AgentToolResult<AgyMirrorToolDetails>,
			options: ToolRenderResultOptions,
			theme: Theme,
			context,
		): Component {
			const details = (result.details ?? {}) as AgyMirrorToolDetails;
			const rawText = extractResultText(result);

			// 1. 编辑工具优先渲染红绿行内对比 Diff
			if (details.diffs && details.diffs.length > 0) {
				const renderedDiffBlocks: string[] = [];
				for (const diffItem of details.diffs) {
					const generated = generateDiffString(diffItem.oldText ?? "", diffItem.newText ?? "");
					if (generated.diff.trim().length > 0) {
						renderedDiffBlocks.push(renderDiff(generated.diff, { filePath: diffItem.path }));
					}
				}
				if (renderedDiffBlocks.length > 0) {
					const combined = renderedDiffBlocks.join("\n\n");
					const allLines = combined.split("\n");
					const limit = options.expanded ? allLines.length : Math.min(allLines.length, 24);
					const text = appendExpandHint(
						allLines.slice(0, limit),
						allLines.length,
						limit,
						theme,
						context.keyHint.bind(context),
					);
					return new Text(text, 0, 0);
				}
			}

			if (!rawText) {
				if (options.isPartial) {
					return new Text(theme.fg("muted", "Running..."), 0, 0);
				}
				return new Text("", 0, 0);
			}

			// 2. 终端执行工具：流式阶段滚动展示尾部输出，报错时高亮
			if (toolName === "agy_bash") {
				const lines = rawText.split("\n");
				if (!options.expanded && options.isPartial && lines.length > BASH_STREAMING_TAIL_LINES) {
					const tail = lines.slice(-BASH_STREAMING_TAIL_LINES);
					const skipped = lines.length - tail.length;
					const body = tail
						.map((l) => theme.fg(context.isError ? "error" : "toolOutput", l))
						.join("\n");
					return new Text(
						`${theme.fg("muted", `... (${skipped} earlier lines)\n`)}${body}`,
						0,
						0,
					);
				}

				const shownCount = options.expanded
					? lines.length
					: Math.min(lines.length, COLLAPSED_PREVIEW_LINES);
				const colored = lines
					.slice(0, shownCount)
					.map((l) => theme.fg(context.isError ? "error" : "toolOutput", l));
				return new Text(
					appendExpandHint(
						colored,
						lines.length,
						shownCount,
						theme,
						context.keyHint.bind(context),
					),
					0,
					0,
				);
			}

			// 3. 文件读取与写入：按文件后缀启用原生语法高亮
			if (toolName === "agy_read" || toolName === "agy_write") {
				const ctxArgs = (
					context.args && typeof context.args === "object" ? context.args : {}
				) as Record<string, unknown>;
				const targetPath =
					details.path ||
					(typeof ctxArgs.path === "string" ? ctxArgs.path : undefined);
				const lang = targetPath ? getLanguageFromPath(targetPath) : undefined;
				const highlighted = lang ? highlightCode(rawText, lang) : rawText.split("\n").map((l) => theme.fg("toolOutput", l));
				const shownCount = options.expanded
					? highlighted.length
					: Math.min(highlighted.length, COLLAPSED_PREVIEW_LINES);
				return new Text(
					appendExpandHint(
						highlighted.slice(0, shownCount),
						highlighted.length,
						shownCount,
						theme,
						context.keyHint.bind(context),
					),
					0,
					0,
				);
			}

			// 4. 通用工具 / 搜索 / 子代理输出
			const lines = rawText.split("\n");
			const shownCount = options.expanded
				? lines.length
				: Math.min(lines.length, COLLAPSED_PREVIEW_LINES);
			const styled = lines
				.slice(0, shownCount)
				.map((l) => theme.fg(context.isError ? "error" : "toolOutput", l));
			return new Text(
				appendExpandHint(
					styled,
					lines.length,
					shownCount,
					theme,
					context.keyHint.bind(context),
				),
				0,
				0,
			);
		},
	};
}

/**
 * 全局工具渲染解析器：即使当前处于 `pi-tools` 模式或回放 `/resume` 历史记录，
 * 也能拦截所有 `agy_*` 镜像工具调用并提供与内置工具一致的主题渲染。
 */
export function createAgyToolRendererResolver(): ToolRendererResolver {
	const nameSet = new Set<string>(AGY_MIRROR_TOOL_NAMES);
	return (toolName, next) => {
		if (nameSet.has(toolName)) {
			return getMirrorToolRenderers(toolName as AgyMirrorToolName);
		}
		return next();
	};
}
