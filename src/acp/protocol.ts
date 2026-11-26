/** JSON-RPC 2.0 基础消息类型 */
export type JsonRpcId = number | string;

export interface JsonRpcRequest<TParams = unknown> {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
	jsonrpc: "2.0";
	method: string;
	params?: TParams;
}

export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcSuccessResponse<TResult = unknown> {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result: TResult;
}

export interface JsonRpcErrorResponse {
	jsonrpc: "2.0";
	id: JsonRpcId | null;
	error: JsonRpcErrorObject;
}

export type JsonRpcResponse<TResult = unknown> =
	| JsonRpcSuccessResponse<TResult>
	| JsonRpcErrorResponse;

export type JsonRpcMessage =
	| JsonRpcRequest
	| JsonRpcNotification
	| JsonRpcSuccessResponse
	| JsonRpcErrorResponse;

/** ACP 初始化参数与响应 */
export interface AcpInitializeParams {
	protocolVersion: number;
	clientCapabilities: {
		fs?: { readTextFile?: boolean; writeTextFile?: boolean };
		terminal?: boolean;
		elicitation?: { form?: Record<string, never>; url?: Record<string, never> } | boolean;
	};
	clientInfo: {
		name: string;
		version: string;
	};
}

export interface AcpAuthMethod {
	id: string;
	name: string;
	description?: string;
}

export interface AcpInitializeResult {
	protocolVersion: number;
	agentCapabilities?: {
		loadSession?: boolean;
		promptCapabilities?: {
			image?: boolean;
			audio?: boolean;
			embeddedContext?: boolean;
		};
		sessionCapabilities?: {
			resume?: Record<string, unknown>;
			close?: Record<string, unknown>;
			load?: Record<string, unknown>;
			list?: Record<string, unknown>;
			additionalDirectories?: Record<string, unknown>;
		};
		mcpCapabilities?: {
			http?: boolean;
			sse?: boolean;
		};
		auth?: {
			logout?: Record<string, unknown>;
		};
		_meta?: {
			antigravity?: {
				tier?: boolean;
				systemPrompt?: { append?: boolean };
			};
		};
	};
	agentInfo?: {
		name: string;
		version: string;
	};
	authMethods?: AcpAuthMethod[];
}

/** ACP MCP 服务器配置描述 */
export interface AcpHttpHeader {
	name: string;
	value: string;
}

export interface AcpEnvVar {
	name: string;
	value: string;
}

export type AcpMcpServerSpec =
	| {
			type: "http";
			name: string;
			url: string;
			headers?: AcpHttpHeader[];
	  }
	| {
			type?: "stdio";
			name: string;
			command: string;
			args?: string[];
			env?: AcpEnvVar[];
	  };

/** ACP 会话模型与配置选项结构 */
export interface AcpAvailableModel {
	modelId: string;
	name: string;
	description?: string;
}

export interface AcpConfigOptionChoice {
	value: string;
	name: string;
	description?: string;
}

export interface AcpConfigOptionChoiceGroup {
	group: string;
	name?: string;
	options: AcpConfigOptionChoice[];
}

export type AcpConfigOptionEntry = AcpConfigOptionChoice | AcpConfigOptionChoiceGroup;

export interface AcpConfigOption {
	id: string;
	name: string;
	category?: string;
	type: "select" | string;
	currentValue: string;
	options?: AcpConfigOptionEntry[];
}

/** Flattens both flat select choices and grouped select options from ACP configOptions. */
export function flattenConfigOptionChoices(
	option: Pick<AcpConfigOption, "options"> | undefined,
): AcpConfigOptionChoice[] {
	if (!option?.options) return [];
	const choices: AcpConfigOptionChoice[] = [];
	for (const entry of option.options) {
		if ("value" in entry) {
			choices.push(entry);
		} else if (Array.isArray(entry.options)) {
			choices.push(...entry.options);
		}
	}
	return choices;
}

/** Finds an ACP configOption by category or id (preferring category match, then id match). */
export function findConfigOption(
	configOptions: readonly AcpConfigOption[] | undefined,
	key: string,
): AcpConfigOption | undefined {
	if (!configOptions || configOptions.length === 0) return undefined;
	return (
		configOptions.find((opt) => opt.category === key) ??
		configOptions.find((opt) => opt.id === key)
	);
}

export interface AcpTierInfo {
	id: string;
	name: string;
	upgradeUri?: string;
}

export interface AcpSessionMeta {
	antigravity?: {
		tier?: AcpTierInfo;
	};
}

export interface AcpSessionNewParams {
	cwd: string;
	mcpServers: AcpMcpServerSpec[];
	additionalDirectories?: string[];
}

export interface AcpSessionNewResult {
	sessionId: string;
	models?: {
		currentModelId?: string;
		availableModels?: AcpAvailableModel[];
	};
	modes?: {
		currentModeId?: string;
		availableModes?: Array<{ id: string; name: string; description?: string }>;
	};
	configOptions?: AcpConfigOption[];
	_meta?: AcpSessionMeta;
}

export interface AcpSessionResumeParams {
	sessionId: string;
	cwd: string;
	mcpServers: AcpMcpServerSpec[];
	additionalDirectories?: string[];
}

export type AcpSessionResumeResult = AcpSessionNewResult;

export interface AcpSessionLoadParams {
	sessionId: string;
	cwd: string;
	mcpServers: AcpMcpServerSpec[];
	additionalDirectories?: string[];
}

export type AcpSessionLoadResult = AcpSessionNewResult;

export interface AcpSessionSummary {
	sessionId: string;
	cwd: string;
	title?: string;
	updatedAt?: string;
}

export interface AcpSessionListResult {
	sessions?: AcpSessionSummary[];
	nextCursor?: string;
}

export interface AcpSetConfigOptionParams {
	sessionId: string;
	configId: string;
	value: string;
}

export interface AcpSetConfigOptionResult {
	configOptions?: AcpConfigOption[];
}

/** ACP Prompt 内容块 */
export type AcpPromptBlock =
	| {
			type: "text";
			text: string;
	  }
	| {
			type: "image";
			data: string;
			mimeType: string;
	  }
	| {
			type: "resource_link";
			uri: string;
			name?: string;
			mimeType?: string;
	  }
	| {
			type: "resource";
			resource: {
				uri: string;
				mimeType?: string;
				text?: string;
				blob?: string;
			};
	  };

export interface AcpSessionPromptParams {
	sessionId: string;
	prompt: AcpPromptBlock[];
}

export interface AcpPromptUsage {
	inputTokens?: number;
	outputTokens?: number;
	cachedReadTokens?: number;
	cachedWriteTokens?: number;
	thoughtTokens?: number;
	totalTokens?: number;
}

export type AcpPromptStopReason =
	| "end_turn"
	| "max_tokens"
	| "max_turn_requests"
	| "refusal"
	| "cancelled"
	| string;

export interface AcpPromptResponse {
	stopReason: AcpPromptStopReason;
	usage?: AcpPromptUsage;
}

/** ACP 流式工具与会话更新通知 */
export type AcpToolKind =
	| "read"
	| "edit"
	| "delete"
	| "move"
	| "search"
	| "execute"
	| "think"
	| "fetch"
	| "switch_mode"
	| "other"
	| string;

export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed" | string;

export interface AcpToolCallLocation {
	path: string;
	line?: number;
}

export type AcpToolCallContentItem =
	| {
			type: "content";
			content:
				| { type: "text"; text: string }
				| { type: "image"; data: string; mimeType: string };
	  }
	| {
			type: "diff";
			path: string;
			oldText?: string | null;
			newText: string;
	  }
	| {
			type: "terminal";
			terminalId: string;
	  };

export type AcpSessionUpdatePayload =
	| {
			sessionUpdate: "agent_thought_chunk" | "agent_message_chunk" | "user_message_chunk";
			content:
				| { type: "text"; text: string }
				| { type: "image"; data: string; mimeType: string };
	  }
	| {
			sessionUpdate: "tool_call";
			toolCallId: string;
			name?: string;
			args?: unknown;
			title?: string;
			kind?: AcpToolKind;
			status?: AcpToolStatus;
			rawInput?: unknown;
			rawOutput?: unknown;
			content?: AcpToolCallContentItem[];
			locations?: AcpToolCallLocation[];
			_meta?: Record<string, unknown>;
	  }
	| {
			sessionUpdate: "tool_call_update";
			toolCallId: string;
			name?: string;
			args?: unknown;
			title?: string;
			kind?: AcpToolKind;
			status?: AcpToolStatus;
			rawInput?: unknown;
			rawOutput?: unknown;
			content?: AcpToolCallContentItem[];
			locations?: AcpToolCallLocation[];
			_meta?: Record<string, unknown>;
	  }
	| {
			sessionUpdate: "usage_update";
			used?: number;
			size?: number;
	  }
	| {
			sessionUpdate: "session_info_update";
			title?: string | null;
			updatedAt?: string;
	  }
	| {
			sessionUpdate: "config_option_update";
			configOptions?: AcpConfigOption[];
	  }
	| {
			sessionUpdate: "current_mode_update";
			currentModeId: string;
	  }
	| {
			sessionUpdate: "available_commands_update";
			availableCommands?: Array<{ name: string; description?: string }>;
	  }
	| {
			sessionUpdate: "plan";
			entries?: Array<{ content: string; priority?: string; status?: string }>;
	  };

export interface AcpSessionUpdateNotification {
	sessionId: string;
	update: AcpSessionUpdatePayload;
}

/** ACP 权限请求与响应 */
export interface AcpPermissionOption {
	optionId: string;
	name: string;
	kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
	_meta?: Record<string, unknown>;
}

export interface AcpRequestPermissionParams {
	sessionId: string;
	toolCall?: {
		toolCallId: string;
		title?: string;
		kind?: AcpToolKind;
		rawInput?: unknown;
		locations?: AcpToolCallLocation[];
		content?: AcpToolCallContentItem[];
	};
	options: AcpPermissionOption[];
}

/** Antigravity sends native interactive questions through `session/request_permission` with `interaction_*` toolCallIds. */
export function isAntigravityUserInputRequest(params: AcpRequestPermissionParams): boolean {
	return Boolean(params.toolCall?.toolCallId?.startsWith("interaction_"));
}

export type AcpRequestPermissionResult =
	| {
			outcome: {
				outcome: "selected";
				optionId: string;
			};
	  }
	| {
			outcome: {
				outcome: "cancelled";
			};
	  };

/** ACP Elicitation 结构化提问请求与响应 */
export interface AcpElicitationTitledOption {
	const: string;
	title?: string;
	description?: string;
}

export interface AcpElicitationArrayItemsSchema {
	type?: string;
	enum?: string[];
	anyOf?: AcpElicitationTitledOption[];
}

export interface AcpElicitationPropertySchema {
	type?: string;
	title?: string;
	description?: string;
	enum?: string[];
	enumNames?: string[];
	oneOf?: AcpElicitationTitledOption[];
	items?: AcpElicitationArrayItemsSchema;
	minItems?: number;
	maxItems?: number;
	default?: unknown;
}

export interface AcpElicitationCreateParams {
	sessionId?: string;
	mode?: "form" | "url" | string;
	message: string;
	url?: string;
	requestedSchema?: {
		type?: "object";
		properties?: Record<string, AcpElicitationPropertySchema>;
		required?: string[];
	};
}

export interface AcpElicitationCreateResult {
	action: "accept" | "decline" | "cancel";
	content?: Record<string, unknown>;
}

/** NDJSON 流式按行解析器（兼容 UTF-8 多字节跨块分片与 CRLF/LF） */
export class NdjsonLineParser {
	private buffer = "";
	private readonly onMessage: (msg: JsonRpcMessage) => void;
	private readonly onParseError?: (rawLine: string, error: unknown) => void;

	constructor(
		onMessage: (msg: JsonRpcMessage) => void,
		onParseError?: (rawLine: string, error: unknown) => void,
	) {
		this.onMessage = onMessage;
		this.onParseError = onParseError;
	}

	push(chunk: string): void {
		this.buffer += chunk;
		let newlineIndex = this.buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const rawLine = this.buffer.slice(0, newlineIndex).trim();
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (rawLine.length > 0) {
				this.parseLine(rawLine);
			}
			newlineIndex = this.buffer.indexOf("\n");
		}
	}

	flush(): void {
		const tail = this.buffer.trim();
		this.buffer = "";
		if (tail.length > 0) {
			this.parseLine(tail);
		}
	}

	private parseLine(line: string): void {
		try {
			const parsed = JSON.parse(line) as JsonRpcMessage;
			if (parsed && typeof parsed === "object" && parsed.jsonrpc === "2.0") {
				this.onMessage(parsed);
			}
		} catch (error) {
			this.onParseError?.(line, error);
		}
	}
}
