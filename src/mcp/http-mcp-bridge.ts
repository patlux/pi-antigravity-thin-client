import * as crypto from "node:crypto";
import * as http from "node:http";
import { StringDecoder } from "node:string_decoder";
import type { ImageContent, JsonObject, TextContent, Tool } from "@earendil-works/pi-ai";
import type { AcpMcpServerSpec } from "../acp/protocol.ts";
import { resolveLocalSchemaRef, validateToolArguments } from "./schema-validator.ts";
import { buildInlineStdioShimCommand } from "./stdio-shim.ts";

export const MCP_SERVER_NAME = "pi_tools";
/** 预留 `mcp_pi_tools_`（13 字符）前缀后，暴露给上游模型函数名的最大安全长度（总长 <= 63 < 64） */
export const MAX_MCP_EXPOSED_TOOL_NAME_LEN = 50;

export interface McpToolResultPayload {
	content: Array<TextContent | ImageContent>;
	isError?: boolean;
}

export interface ParkedToolCall {
	/** Pi 侧使用的工具调用唯一 ID */
	callId: string;
	/** 还原后的 Pi 原始工具名 */
	toolName: string;
	/** 校验后的工具参数对象 */
	arguments: JsonObject;
	/** 所属 AGY 会话 ID（从 _meta 或活跃绑定提取） */
	agySessionId?: string;
	/** 结算 HTTP MCP 响应 */
	settle: (result: McpToolResultPayload) => void;
	/** 是否已因超过 165s 守护阈值而剥离为迟到补发模式 */
	readonly isDetached: boolean;
}

export interface SessionMcpBinding {
	agySessionId?: string;
	tools: Tool[];
	/** 收到合法的 MCP tools/call 且通过门控校验时触发，交由协调器写入 ToolCall 流 */
	onParkedCall: (call: ParkedToolCall) => void;
	/** 达到 mcpHoldLimitMs 仍未收到宿主工具执行结果时触发，先对 AGY 执行预取消 */
	onHoldTimeout: (call: ParkedToolCall) => Promise<void>;
	/** 当工具调用在未知工具、参数预校验或门控阶段提前被拒绝时回调，用于平衡前置宣告计数 */
	onRejectedCall?: (toolName: string) => void;
	/** 当上游 HTTP 客户端在工具结果结算前主动断连时回调，用于及时清理失效挂起句柄 */
	onClientDisconnect?: (callId: string) => void;
}

interface AnnouncedToolEntry {
	agySessionId: string;
	rawTitleOrName: string;
	timestamp: number;
}

interface PendingAnnouncementWaiter {
	toolName: string;
	agySessionId?: string;
	resolve: (matched: boolean) => void;
	timer: ReturnType<typeof setTimeout>;
}

function inferLiteralJsonType(value: unknown): string | undefined {
	if (typeof value === "string") return "string";
	if (typeof value === "boolean") return "boolean";
	if (typeof value === "number" && Number.isFinite(value)) {
		return Number.isInteger(value) ? "integer" : "number";
	}
	if (value === null) return "null";
	return undefined;
}

function isPureLiteralSchemaBranch(
	node: unknown,
): node is Record<string, unknown> & { const: unknown } {
	if (!node || typeof node !== "object" || Array.isArray(node)) return false;
	const rec = node as Record<string, unknown>;
	if (!("const" in rec)) return false;
	for (const key of Object.keys(rec)) {
		if (key !== "const" && key !== "type" && key !== "description" && key !== "title") {
			return false;
		}
	}
	return true;
}

function normalizeJsonSchemaNode(node: unknown, depth = 0): unknown {
	if (depth > 16 || !node || typeof node !== "object") {
		return node;
	}
	if (Array.isArray(node)) {
		return node.map((item) => normalizeJsonSchemaNode(item, depth + 1));
	}

	const rec = { ...(node as Record<string, unknown>) };
	delete rec.$schema;

	// 将 TypeBox Type.Union([Type.Literal(...), ...]) 生成的 anyOf/oneOf 常量联合折叠为标准 type + enum，
	// 避免 Gemini / AGY MCP 协议转换器丢弃 anyOf 导致枚举参数退化为空对象 {}（如 context_recall 的 part/imageVersion/view）
	for (const unionKey of ["anyOf", "oneOf"] as const) {
		const branches = rec[unionKey];
		if (Array.isArray(branches) && branches.length > 0 && branches.every(isPureLiteralSchemaBranch)) {
			const values = branches.map((b) => b.const);
			const inferredTypes = new Set(
				values
					.map((v) => inferLiteralJsonType(v))
					.filter((t): t is string => t !== undefined),
			);
			delete rec[unionKey];
			rec.enum = values;
			if (!rec.type && inferredTypes.size === 1) {
				rec.type = Array.from(inferredTypes)[0];
			} else if (
				!rec.type &&
				inferredTypes.size === 2 &&
				inferredTypes.has("integer") &&
				inferredTypes.has("number")
			) {
				rec.type = "number";
			}
			break;
		}
	}

	if ("const" in rec && !Array.isArray(rec.enum)) {
		const val = rec.const;
		delete rec.const;
		rec.enum = [val];
		if (!rec.type) {
			const inferred = inferLiteralJsonType(val);
			if (inferred) rec.type = inferred;
		}
	}

	if (!rec.type && rec.properties && typeof rec.properties === "object") {
		rec.type = "object";
	}

	if (rec.properties && typeof rec.properties === "object" && !Array.isArray(rec.properties)) {
		const nextProps: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(rec.properties as Record<string, unknown>)) {
			nextProps[k] = normalizeJsonSchemaNode(v, depth + 1);
		}
		rec.properties = nextProps;
	}
	if (rec.items && typeof rec.items === "object") {
		rec.items = normalizeJsonSchemaNode(rec.items, depth + 1);
	}
	if (rec.additionalProperties && typeof rec.additionalProperties === "object") {
		rec.additionalProperties = normalizeJsonSchemaNode(rec.additionalProperties, depth + 1);
	}
	for (const compositeKey of ["anyOf", "oneOf", "allOf"] as const) {
		if (Array.isArray(rec[compositeKey])) {
			rec[compositeKey] = (rec[compositeKey] as unknown[]).map((b) =>
				normalizeJsonSchemaNode(b, depth + 1),
			);
		}
	}
	for (const defsKey of ["$defs", "definitions"] as const) {
		if (rec[defsKey] && typeof rec[defsKey] === "object" && !Array.isArray(rec[defsKey])) {
			const nextDefs: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(rec[defsKey] as Record<string, unknown>)) {
				nextDefs[k] = normalizeJsonSchemaNode(v, depth + 1);
			}
			rec[defsKey] = nextDefs;
		}
	}
	return rec;
}

/** JSON Schema 清洗：剥离 TypeBox Symbol、非标准顶层元字段并将字面量 anyOf/oneOf 规整为标准 enum */
export function sanitizeJsonSchemaForMcp(rawSchema: unknown): Record<string, unknown> {
	try {
		const cloned = JSON.parse(JSON.stringify(rawSchema ?? { type: "object", properties: {} }));
		const normalized = normalizeJsonSchemaNode(cloned);
		if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
			return normalized as Record<string, unknown>;
		}
		return { type: "object", properties: {} };
	} catch {
		return { type: "object", properties: {} };
	}
}

/**
 * 为超长宿主工具名（如长命名空间的直通 MCP 工具）生成满足上游 64 字符上限的确定性短别名；
 * 常规长度工具名（`<= 50` 字符）保持原名零改动。
 */
export function toExposedMcpToolName(originalName: string): string {
	if (originalName.length <= MAX_MCP_EXPOSED_TOOL_NAME_LEN) {
		return originalName;
	}
	const sanitized = originalName.replace(/[^a-zA-Z0-9_-]/g, "_");
	const hash8 = crypto.createHash("sha256").update(originalName).digest("hex").slice(0, 8);
	const head = sanitized.slice(0, 22).replace(/_+$/, "");
	const tail = sanitized.slice(-17).replace(/^_+/, "");
	return `${head}_${tail}_${hash8}`.slice(0, MAX_MCP_EXPOSED_TOOL_NAME_LEN);
}

function normalizeMatchToken(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function extractAnnouncedBareToolToken(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const prefixedMatch = /\bmcp_pi_tools_([a-zA-Z0-9_.-]+)\b/i.exec(trimmed);
	if (prefixedMatch?.[1]) {
		return normalizeMatchToken(prefixedMatch[1]);
	}
	const stripped = trimmed
		.replace(/^mcp_pi_tools_/i, "")
		.replace(/^pi_tools[:/]/i, "");
	if (/\s/.test(stripped)) {
		return "";
	}
	return normalizeMatchToken(stripped);
}

export function doesAnnouncementMatchTool(announced: string, toolName: string): boolean {
	const trimmed = announced.trim();
	if (!trimmed) return true;
	const a = extractAnnouncedBareToolToken(trimmed);
	if (!a) return false;
	const origNorm = normalizeMatchToken(toolName);
	if (a === origNorm) return true;
	const exposedNorm = normalizeMatchToken(toExposedMcpToolName(toolName));
	return a === exposedNorm;
}

function isSingleEditReplacement(value: unknown): value is { oldText: string; newText: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const rec = value as Record<string, unknown>;
	return typeof rec.oldText === "string" && typeof rec.newText === "string";
}

function schemaAllowsType(
	propSchema: Record<string, unknown>,
	targetType: "null" | "string" | "array" | "object",
	rootSchema: Record<string, unknown>,
	depth = 0,
): boolean {
	if (depth > 8) return false;
	if (typeof propSchema.$ref === "string") {
		const resolved = resolveLocalSchemaRef(propSchema.$ref, rootSchema);
		if (resolved && schemaAllowsType(resolved, targetType, rootSchema, depth + 1)) {
			return true;
		}
	}
	if (targetType === "null" && propSchema.const === null) return true;
	if (Array.isArray(propSchema.enum)) {
		if (targetType === "null" && propSchema.enum.includes(null)) return true;
		if (targetType === "string" && propSchema.enum.some((v) => typeof v === "string")) return true;
	}
	const t = propSchema.type;
	if (t === targetType) return true;
	if (Array.isArray(t) && t.includes(targetType)) return true;
	if (targetType === "object" && !t && propSchema.properties && typeof propSchema.properties === "object") {
		return true;
	}
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		const branches = propSchema[key];
		if (Array.isArray(branches)) {
			for (const b of branches) {
				if (
					b &&
					typeof b === "object" &&
					!Array.isArray(b) &&
					schemaAllowsType(b as Record<string, unknown>, targetType, rootSchema, depth + 1)
				) {
					return true;
				}
			}
		}
	}
	return false;
}

function normalizeArgsAgainstSchema(
	node: unknown,
	schema: Record<string, unknown>,
	rootSchema: Record<string, unknown>,
	depth = 0,
): unknown {
	if (depth > 8 || !node || typeof node !== "object" || Array.isArray(node)) {
		return node;
	}
	const targetSchema =
		typeof schema.$ref === "string"
			? (resolveLocalSchemaRef(schema.$ref, rootSchema) ?? schema)
			: schema;
	const props =
		targetSchema.properties &&
		typeof targetSchema.properties === "object" &&
		!Array.isArray(targetSchema.properties)
			? (targetSchema.properties as Record<string, unknown>)
			: undefined;
	if (!props) return node;

	const requiredSet = new Set(
		Array.isArray(targetSchema.required)
			? targetSchema.required.filter((k): k is string => typeof k === "string")
			: [],
	);

	const out: Record<string, unknown> = { ...(node as Record<string, unknown>) };
	for (const [key, val] of Object.entries(out)) {
		const propSchemaRaw = props[key];
		if (!propSchemaRaw || typeof propSchemaRaw !== "object" || Array.isArray(propSchemaRaw)) {
			continue;
		}
		const propSchema = propSchemaRaw as Record<string, unknown>;

		// 剥离模型在非必填且非 nullable 字段上误传的显式 null
		if (
			val === null &&
			!requiredSet.has(key) &&
			!schemaAllowsType(propSchema, "null", rootSchema)
		) {
			delete out[key];
			continue;
		}

		// 将模型误传为 JSON 字符串的数组或对象参数自动反序列化
		if (
			typeof val === "string" &&
			!schemaAllowsType(propSchema, "string", rootSchema)
		) {
			const trimmed = val.trim();
			const expectsArray = schemaAllowsType(propSchema, "array", rootSchema);
			const expectsObject = schemaAllowsType(propSchema, "object", rootSchema);
			if ((expectsArray && trimmed.startsWith("[")) || (expectsObject && trimmed.startsWith("{"))) {
				try {
					const parsed: unknown = JSON.parse(trimmed);
					if (expectsArray && Array.isArray(parsed)) {
						out[key] = parsed;
						continue;
					}
					if (expectsObject && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
						out[key] = normalizeArgsAgainstSchema(parsed, propSchema, rootSchema, depth + 1);
						continue;
					}
				} catch {
					// 保留原字符串交由后续校验生成错误反馈
				}
			}
		}

		if (val && typeof val === "object" && !Array.isArray(val)) {
			out[key] = normalizeArgsAgainstSchema(val, propSchema, rootSchema, depth + 1);
		}
	}
	return out;
}

/**
 * 在 JSON Schema 预校验前对齐原生 Pi 工具的参数容错归一化
 *（含可选字段显式 `null` 剥离、字符串化对象/数组解析，以及 `edit` 工具对单对象 `edits` 或顶层 `oldText/newText` 的兼容转换）。
 */
export function normalizeHostToolArguments(
	toolName: string,
	rawArgs: JsonObject,
	toolDef: Tool,
	sanitizedSchema?: Record<string, unknown>,
): JsonObject {
	let current: unknown = { ...rawArgs };
	const maybeWithPrepare = toolDef as Tool & {
		prepareArguments?: (input: unknown) => unknown;
	};
	if (typeof maybeWithPrepare.prepareArguments === "function") {
		try {
			current = maybeWithPrepare.prepareArguments(current);
		} catch {
			// 交由后续 JSON Schema 校验生成明确自愈反馈
		}
	}

	if (toolName === "edit" && current && typeof current === "object" && !Array.isArray(current)) {
		const args = { ...(current as Record<string, unknown>) };
		if (typeof args.edits === "string") {
			try {
				const parsed: unknown = JSON.parse(args.edits);
				if (Array.isArray(parsed)) {
					args.edits = parsed;
				} else if (isSingleEditReplacement(parsed)) {
					args.edits = [parsed];
				}
			} catch {
				// 保留原值交由校验器提示
			}
		} else if (isSingleEditReplacement(args.edits)) {
			args.edits = [args.edits];
		}

		if (typeof args.oldText === "string" && typeof args.newText === "string") {
			const mergedEdits = Array.isArray(args.edits) ? [...args.edits] : [];
			mergedEdits.push({ oldText: args.oldText, newText: args.newText });
			delete args.oldText;
			delete args.newText;
			args.edits = mergedEdits;
		}
		current = args;
	}

	if (current && typeof current === "object" && !Array.isArray(current)) {
		const schema = sanitizedSchema ?? sanitizeJsonSchemaForMcp(toolDef.parameters);
		current = normalizeArgsAgainstSchema(current, schema, schema, 0);
	}

	if (current && typeof current === "object" && !Array.isArray(current)) {
		return current as JsonObject;
	}
	return rawArgs;
}

/**
 * 本地回环 Streamable HTTP MCP 服务端。
 * 支持多会话独立 Bearer Token 路由、JSON Schema 参数自愈校验、ACP 公告门控校验及 165s 超时预剥离。
 */
export class LocalHttpMcpBridge {
	private server?: http.Server;
	private port = 0;
	private readonly bindingsByToken = new Map<string, SessionMcpBinding>();
	private readonly sseClientsByToken = new Map<string, Set<http.ServerResponse>>();
	private readonly recentAnnouncements: AnnouncedToolEntry[] = [];
	private readonly announcementWaiters = new Set<PendingAnnouncementWaiter>();
	private readonly cancelledSessions = new Set<string>();
	private holdLimitMs: number;

	constructor(holdLimitMs = 165_000) {
		this.holdLimitMs = holdLimitMs;
	}

	setHoldLimitMs(ms: number): void {
		this.holdLimitMs = Math.max(5_000, Math.min(175_000, Math.floor(ms)));
	}

	async ensureListening(): Promise<number> {
		if (this.server && this.port > 0) {
			return this.port;
		}

		const srv = http.createServer((req, res) => {
			void this.handleHttpRequest(req, res);
		});

		await new Promise<void>((resolve, reject) => {
			srv.once("error", reject);
			srv.listen(0, "127.0.0.1", () => {
				srv.removeListener("error", reject);
				const addr = srv.address();
				if (addr && typeof addr === "object") {
					this.port = addr.port;
					this.server = srv;
					resolve();
				} else {
					reject(new Error("Could not get the port of the local HTTP MCP server"));
				}
			});
		});

		return this.port;
	}

	/** 注册一个新的会话级 MCP 绑定并返回一次性鉴权 Token */
	registerSessionBinding(binding: SessionMcpBinding): string {
		const token = crypto.randomBytes(24).toString("hex");
		this.bindingsByToken.set(token, binding);
		return token;
	}

	updateBindingSessionId(token: string, agySessionId: string): void {
		const binding = this.bindingsByToken.get(token);
		if (binding) {
			binding.agySessionId = agySessionId;
			this.cancelledSessions.delete(agySessionId);
		}
	}

	/** 更新会话绑定的工具表，并返回是否已通过活跃 SSE 连接向客户端实时推送 `tools/list_changed` */
	updateBindingTools(token: string, tools: Tool[]): boolean {
		const binding = this.bindingsByToken.get(token);
		if (!binding) return false;
		binding.tools = tools;
		return this.broadcastToolsListChanged(token);
	}

	unregisterSessionBinding(token: string): void {
		this.bindingsByToken.delete(token);
		const clients = this.sseClientsByToken.get(token);
		if (clients) {
			for (const res of clients) {
				try {
					res.end();
				} catch {
					// 忽略关闭异常
				}
			}
			this.sseClientsByToken.delete(token);
		}
	}

	/** 记录来自 ACP `session/update` 的 `tool_call` 宣告，供门控配对校验 */
	recordAcpToolAnnouncement(agySessionId: string, rawTitleOrName: string): void {
		if (this.cancelledSessions.has(agySessionId)) {
			return;
		}

		for (const waiter of Array.from(this.announcementWaiters)) {
			if (
				(!waiter.agySessionId || waiter.agySessionId === agySessionId) &&
				doesAnnouncementMatchTool(rawTitleOrName, waiter.toolName)
			) {
				clearTimeout(waiter.timer);
				this.announcementWaiters.delete(waiter);
				waiter.resolve(true);
				return;
			}
		}

		const now = Date.now();
		this.pruneExpiredAnnouncements(now);
		this.recentAnnouncements.push({
			agySessionId,
			rawTitleOrName,
			timestamp: now,
		});
	}

	/** 标记某会话当前轮次已取消，拦截迟到的残留 MCP `tools/call` */
	markSessionTurnCancelled(agySessionId: string): void {
		this.cancelledSessions.add(agySessionId);
		for (let i = this.recentAnnouncements.length - 1; i >= 0; i--) {
			if (this.recentAnnouncements[i].agySessionId === agySessionId) {
				this.recentAnnouncements.splice(i, 1);
			}
		}
		for (const waiter of Array.from(this.announcementWaiters)) {
			if (waiter.agySessionId === agySessionId) {
				clearTimeout(waiter.timer);
				this.announcementWaiters.delete(waiter);
				waiter.resolve(false);
			}
		}
	}

	clearSessionCancelled(agySessionId: string): void {
		this.cancelledSessions.delete(agySessionId);
	}

	/** 生成注入 `session/new` 或 `session/resume` 的 ACP `mcpServers` 配置项 */
	async buildAcpMcpServerSpec(
		token: string,
		useHttpTransport: boolean,
	): Promise<AcpMcpServerSpec> {
		const port = await this.ensureListening();
		const url = `http://127.0.0.1:${port}/mcp`;

		if (useHttpTransport) {
			return {
				type: "http",
				name: MCP_SERVER_NAME,
				url,
				headers: [{ name: "Authorization", value: `Bearer ${token}` }],
			};
		}

		const shim = buildInlineStdioShimCommand(url, token);
		return {
			type: "stdio",
			name: MCP_SERVER_NAME,
			command: shim.command,
			args: shim.args,
			env: shim.env,
		};
	}

	async dispose(): Promise<void> {
		for (const token of Array.from(this.bindingsByToken.keys())) {
			this.unregisterSessionBinding(token);
		}
		for (const waiter of this.announcementWaiters) {
			clearTimeout(waiter.timer);
			waiter.resolve(false);
		}
		this.announcementWaiters.clear();

		if (this.server) {
			const srv = this.server;
			this.server = undefined;
			this.port = 0;
			srv.closeIdleConnections?.();
			srv.closeAllConnections?.();
			await new Promise<void>((resolve) => srv.close(() => resolve()));
		}
	}

	private broadcastToolsListChanged(token: string): boolean {
		const clients = this.sseClientsByToken.get(token);
		if (!clients || clients.size === 0) return false;
		const payload = JSON.stringify({
			jsonrpc: "2.0",
			method: "notifications/tools/list_changed",
			params: {},
		});
		let delivered = false;
		for (const res of Array.from(clients)) {
			if (res.writableEnded || res.destroyed) {
				clients.delete(res);
				continue;
			}
			try {
				res.write(`event: message\ndata: ${payload}\n\n`);
				delivered = true;
			} catch {
				clients.delete(res);
			}
		}
		return delivered;
	}

	private pruneExpiredAnnouncements(now: number): void {
		while (
			this.recentAnnouncements.length > 0 &&
			now - this.recentAnnouncements[0].timestamp > 10_000
		) {
			this.recentAnnouncements.shift();
		}
	}

	private consumeMatchingAnnouncement(toolName: string, agySessionId: string | undefined): boolean {
		const now = Date.now();
		this.pruneExpiredAnnouncements(now);
		const existingIdx = this.recentAnnouncements.findIndex(
			(entry) =>
				(!agySessionId || entry.agySessionId === agySessionId) &&
				doesAnnouncementMatchTool(entry.rawTitleOrName, toolName),
		);
		if (existingIdx !== -1) {
			this.recentAnnouncements.splice(existingIdx, 1);
			return true;
		}
		return false;
	}

	private waitForAnnouncementPairing(
		toolName: string,
		agySessionId: string | undefined,
		windowMs = 2_000,
	): Promise<boolean> {
		if (agySessionId && this.cancelledSessions.has(agySessionId)) {
			return Promise.resolve(false);
		}

		if (this.consumeMatchingAnnouncement(toolName, agySessionId)) {
			return Promise.resolve(true);
		}

		return new Promise<boolean>((resolve) => {
			const waiter: PendingAnnouncementWaiter = {
				toolName,
				agySessionId,
				resolve,
				timer: setTimeout(() => {
					this.announcementWaiters.delete(waiter);
					// 若窗口期满后会话已被取消则拦截；若会话仍正常活跃则放行，兼容不发送前置宣告的模型分支
					const cancelled = Boolean(agySessionId && this.cancelledSessions.has(agySessionId));
					resolve(!cancelled);
				}, windowMs),
			};
			this.announcementWaiters.add(waiter);
		});
	}

	private extractBearerToken(req: http.IncomingMessage): string | undefined {
		const header = req.headers.authorization;
		if (!header || typeof header !== "string") return undefined;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		return match?.[1]?.trim();
	}

	private async handleHttpRequest(
		req: http.IncomingMessage,
		res: http.ServerResponse,
	): Promise<void> {
		const urlPath = (req.url || "/").split("?")[0];

		// AGY MCP 客户端会探测 OAuth 元数据路径且不携带静态 Authorization 头，返回 404 表明无需 OAuth 握手
		if (urlPath.startsWith("/.well-known/")) {
			res.writeHead(404);
			res.end();
			return;
		}

		if (urlPath !== "/mcp") {
			res.writeHead(404);
			res.end();
			return;
		}

		const token = this.extractBearerToken(req);
		const binding = token ? this.bindingsByToken.get(token) : undefined;
		if (!token || !binding) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Unauthorized" }));
			return;
		}

		// 处理会话关闭时的空体 DELETE 请求
		if (req.method === "DELETE") {
			res.writeHead(200);
			res.end();
			return;
		}

		// 处理 Streamable HTTP SSE 通知订阅请求
		if (req.method === "GET") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			let set = this.sseClientsByToken.get(token);
			if (!set) {
				set = new Set();
				this.sseClientsByToken.set(token, set);
			}
			set.add(res);
			req.on("close", () => {
				set?.delete(res);
			});
			return;
		}

		if (req.method !== "POST") {
			res.writeHead(405);
			res.end();
			return;
		}

		let rawBody = "";
		try {
			const bodyDecoder = new StringDecoder("utf8");
			for await (const chunk of req) {
				rawBody += typeof chunk === "string" ? chunk : bodyDecoder.write(chunk as Buffer);
			}
			rawBody += bodyDecoder.end();
		} catch {
			res.writeHead(400);
			res.end();
			return;
		}

		if (!rawBody.trim()) {
			res.writeHead(202);
			res.end();
			return;
		}

		let rpc: Record<string, unknown>;
		try {
			rpc = JSON.parse(rawBody) as Record<string, unknown>;
		} catch {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: null,
					error: { code: -32700, message: "Parse error" },
				}),
			);
			return;
		}

		const id = rpc.id;
		const method = typeof rpc.method === "string" ? rpc.method : "";
		const params =
			rpc.params && typeof rpc.params === "object"
				? (rpc.params as Record<string, unknown>)
				: {};

		// 单向通知直接返回 202
		if (id === undefined) {
			res.writeHead(202);
			res.end();
			return;
		}

		res.setHeader("Content-Type", "application/json");
		res.setHeader("Mcp-Session-Id", token.slice(0, 16));

		if (method === "initialize") {
			const clientProto =
				typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-11-25";
			res.writeHead(200);
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id,
					result: {
						protocolVersion: clientProto,
						capabilities: {
							tools: { listChanged: true },
						},
						serverInfo: {
							name: MCP_SERVER_NAME,
							version: "0.1.0",
						},
					},
				}),
			);
			return;
		}

		if (method === "ping") {
			res.writeHead(200);
			res.end(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
			return;
		}

		if (method === "tools/list") {
			const toolsList = binding.tools.map((tool) => {
				const exposedName = toExposedMcpToolName(tool.name);
				const baseDesc = tool.description || tool.name;
				return {
					name: exposedName,
					description:
						exposedName !== tool.name ? `[Original tool: ${tool.name}] ${baseDesc}` : baseDesc,
					inputSchema: sanitizeJsonSchemaForMcp(tool.parameters),
				};
			});
			res.writeHead(200);
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id,
					result: { tools: toolsList },
				}),
			);
			return;
		}

		if (method === "tools/call") {
			await this.handleToolCallRpc(id, params, binding, res);
			return;
		}

		// 对 server/discover 等非标准探测方法返回标准 -32601，引导客户端回退标准 initialize
		res.writeHead(200);
		res.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: `Method not found: ${method}` },
			}),
		);
	}

	private async handleToolCallRpc(
		rpcId: unknown,
		params: Record<string, unknown>,
		binding: SessionMcpBinding,
		res: http.ServerResponse,
	): Promise<void> {
		const incomingName = typeof params.name === "string" ? params.name : "";
		const rawArgs =
			params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
				? (params.arguments as JsonObject)
				: {};

		const meta =
			params._meta && typeof params._meta === "object"
				? (params._meta as Record<string, unknown>)
				: undefined;
		const rootConvId =
			(typeof meta?.["antigravity.google/root_conversation_id"] === "string"
				? (meta["antigravity.google/root_conversation_id"] as string)
				: undefined) ??
			(typeof meta?.["antigravity.google/conversation_id"] === "string"
				? (meta["antigravity.google/conversation_id"] as string)
				: undefined) ??
			binding.agySessionId;

		const toolDef = binding.tools.find(
			(t) => t.name === incomingName || toExposedMcpToolName(t.name) === incomingName,
		);
		if (!toolDef) {
			this.consumeMatchingAnnouncement(incomingName, rootConvId);
			binding.onRejectedCall?.(incomingName);
			res.writeHead(200);
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: rpcId,
					result: {
						isError: true,
						content: [
							{
								type: "text",
								text: `Unknown tool "${incomingName}". Available tools: ${binding.tools.map((t) => toExposedMcpToolName(t.name)).join(", ")}`,
							},
						],
					},
				}),
			);
			return;
		}

		const toolName = toolDef.name;
		const sanitizedSchema = sanitizeJsonSchemaForMcp(toolDef.parameters);

		// 1. 对齐宿主工具的参数预处理与 JSON Schema 参数预校验（与 tools/list 暴露的规整 Schema 保持一致）
		const normalizedArgs = normalizeHostToolArguments(toolName, rawArgs, toolDef, sanitizedSchema);
		const validation = validateToolArguments(toolName, normalizedArgs, sanitizedSchema);
		if (!validation.valid) {
			this.consumeMatchingAnnouncement(toolName, rootConvId);
			binding.onRejectedCall?.(toolName);
			res.writeHead(200);
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: rpcId,
					result: {
						isError: true,
						content: [{ type: "text", text: validation.formattedError ?? "Invalid tool arguments" }],
					},
				}),
			);
			return;
		}

		// 2. ACP 公告门控校验，防止已取消旧轮次迟到调用串扰
		const allowed = await this.waitForAnnouncementPairing(toolName, rootConvId, 450);
		if (!allowed) {
			binding.onRejectedCall?.(toolName);
			res.writeHead(200);
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: rpcId,
					result: {
						isError: true,
						content: [{ type: "text", text: "Tool call cancelled." }],
					},
				}),
			);
			return;
		}

		// 3. Park-and-Yield 挂起 HTTP 响应，交由 Pi Agent Loop 执行真实工具
		const callId = `agy_mcp_${crypto.randomUUID().slice(0, 12)}`;
		let settled = false;
		let detached = false;

		const sendMcpResult = (payload: McpToolResultPayload) => {
			if (settled) return;
			settled = true;
			clearTimeout(holdTimer);
			const mcpContent = payload.content.map((block) => {
				if (block.type === "image") {
					return {
						type: "image",
						data: block.data,
						mimeType: block.mimeType,
					};
				}
				return {
					type: "text",
					text: block.text,
				};
			});
			if (mcpContent.length === 0) {
				mcpContent.push({ type: "text", text: "(empty output)" });
			}
			try {
				if (!res.writableEnded) {
					res.writeHead(200);
					res.end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: rpcId,
							result: {
								isError: Boolean(payload.isError),
								content: mcpContent,
							},
						}),
					);
				}
			} catch {
				// 忽略客户端提前断连异常
			}
		};

		const parkedCall: ParkedToolCall = {
			callId,
			toolName,
			arguments: normalizedArgs,
			agySessionId: rootConvId,
			get isDetached() {
				return detached;
			},
			settle: (result) => {
				sendMcpResult(result);
			},
		};

		const holdTimer = setTimeout(() => {
			if (settled) return;
			detached = true;
			void binding
				.onHoldTimeout(parkedCall)
				.catch(() => {})
				.finally(() => {
					sendMcpResult({
						isError: true,
						content: [
							{
								type: "text",
								text: "Tool execution detached due to hold timeout; result will be delivered in the next prompt.",
							},
						],
					});
				});
		}, this.holdLimitMs);

		res.on("close", () => {
			if (!settled) {
				settled = true;
				clearTimeout(holdTimer);
				binding.onClientDisconnect?.(callId);
			}
		});

		binding.onParkedCall(parkedCall);
	}
}
