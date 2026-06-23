import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	debounce,
	editorInfoField,
} from "obsidian";
import { EditorView, ViewUpdate } from "@codemirror/view";

type ExpansionMode = "right" | "center" | "left";

interface CanvasAutoSizeSettings {
	expansionMode: ExpansionMode;
	maxWidth: number;
	minSingleLineHeight: number;
	verticalPadding: number;
	horizontalPadding: number;
	cjkSafetyPadding: number;
	wrapSafetyPadding: number;
	tightenExtraPadding: number;
	debounceMs: number;
	tightenWidthOnExit: boolean;
	debugNotices: boolean;
}

interface RuntimeCanvasNode {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	resize: (size: { width: number; height: number }) => void;
	moveTo?: (position: { x: number; y: number }) => void;
	canvas?: {
		requestSave?: () => void;
	};
	[key: string]: unknown;
}

interface EditSession {
	node: RuntimeCanvasNode;
	view: EditorView;
	nodeEl: HTMLElement | null;
	originalWidth: number;
	liveWidth: number;
	tightWidth: number;
	docLength: number;
	lineCount: number;
	hasTrailingWhitespace: boolean;
	widthSource: "editor" | "rendered-markdown" | "rendered-unavailable";
	renderedWidth: RenderedWidthMeasurement | null;
	heightSource: "editor" | "rendered-markdown" | "rendered-unavailable";
	renderedHeight: RenderedHeightMeasurement | null;
	finalized: boolean;
	changed: boolean;
}

interface WidthMeasurement {
	liveWidth: number;
	tightWidth: number;
}

interface RenderedWidthMeasurement {
	width: number;
	contentWidth: number;
	outerInsets: number;
	selector: string;
}

interface RenderedHeightMeasurement {
	height: number;
	contentHeight: number;
	outerInsets: number;
	selector: string;
}

type NumericSettingKey = keyof Pick<
	CanvasAutoSizeSettings,
	| "maxWidth"
	| "horizontalPadding"
	| "cjkSafetyPadding"
	| "wrapSafetyPadding"
	| "tightenExtraPadding"
	| "minSingleLineHeight"
	| "verticalPadding"
	| "debounceMs"
>;

interface NumericSettingDefinition {
	key: NumericSettingKey;
	name: string;
	desc: string;
	min: number;
	max?: number;
}

const INTERNAL_MIN_WIDTH = 60;
const SCROLLBAR_SAFETY_HEIGHT = 4;

const DEFAULT_SETTINGS: CanvasAutoSizeSettings = {
	expansionMode: "right",
	maxWidth: 520,
	minSingleLineHeight: 44,
	verticalPadding: 10,
	horizontalPadding: 20,
	cjkSafetyPadding: 18,
	wrapSafetyPadding: 28,
	tightenExtraPadding: 20,
	debounceMs: 40,
	tightenWidthOnExit: true,
	debugNotices: false,
};

const NUMERIC_SETTING_DEFINITIONS: NumericSettingDefinition[] = [
	{
		key: "maxWidth",
		name: "Maximum width",
		desc: "Largest width the plugin can assign. Minimum allowed: 60 px. Default: 520 px.",
		min: INTERNAL_MIN_WIDTH,
		max: 4000,
	},
	{
		key: "horizontalPadding",
		name: "Base width padding",
		desc: "Extra width used with editor text measurement while editing and as a fallback. Default: 20 px.",
		min: 0,
		max: 400,
	},
	{
		key: "cjkSafetyPadding",
		name: "CJK extra width",
		desc: "Extra editor-measurement width for lines containing Chinese, Japanese, or Korean text. Default: 18 px.",
		min: 0,
		max: 240,
	},
	{
		key: "wrapSafetyPadding",
		name: "Editing anti-wrap width",
		desc: "Add this only while editing, so text is less likely to wrap at the edge. Default: 28 px.",
		min: 0,
		max: 400,
	},
	{
		key: "tightenExtraPadding",
		name: "Exit tighten padding",
		desc: "Extra space added to rendered Markdown width when tightening after editing. Default: 20 px.",
		min: 0,
		max: 400,
	},
	{
		key: "minSingleLineHeight",
		name: "Minimum line height",
		desc: "Minimum per-line height while editing and when rendered Markdown height is unavailable. Default: 44 px.",
		min: 20,
		max: 160,
	},
	{
		key: "verticalPadding",
		name: "Vertical padding",
		desc: "Extra total height added to editor and rendered Markdown measurements. Default: 10 px.",
		min: 0,
		max: 200,
	},
	{
		key: "debounceMs",
		name: "Resize delay",
		desc: "Delay after typing before resizing. Restart Obsidian after changing this. Default: 40 ms.",
		min: 0,
		max: 1000,
	},
];

export default class CanvasCurrentNodeAutoSizePlugin extends Plugin {
	settings: CanvasAutoSizeSettings;
	private activeSession: EditSession | null = null;
	private measureCanvas: HTMLCanvasElement | null = null;
	private liveResizeDebounced: (update: ViewUpdate) => void;
	private saveCanvasDebounced: (node: RuntimeCanvasNode) => void;
	private lastDebug = "No Canvas editor update captured yet.";
	private stabilizeFrame: number | null = null;
	private heightFrame: number | null = null;
	private finalizeFrame: number | null = null;
	private finalizeTimer: number | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new CanvasAutoSizeSettingTab(this.app, this));

		this.liveResizeDebounced = debounce((update) => this.handleEditorUpdate(update, true), this.settings.debounceMs, false);
		this.saveCanvasDebounced = debounce((node) => node.canvas?.requestSave?.(), 200);

		this.registerEditorExtension([
			EditorView.updateListener.of((update) => {
				if (update.docChanged) this.liveResizeDebounced(update);
				else this.handleEditorUpdate(update, false);
			}),
		]);

		this.registerDomEvent(activeDocument, "focusout", () => this.scheduleFinalize(), true);
		this.registerDomEvent(activeDocument, "pointerdown", () => this.scheduleFinalize(), true);
		this.registerDomEvent(activeDocument, "keydown", (event) => {
			if (event.key === "Escape") this.scheduleFinalize();
		}, true);
		this.registerDomEvent(activeDocument, "keyup", (event) => {
			if (event.key === "Escape") this.scheduleFinalize();
		}, true);
		this.registerDomEvent(activeWindow, "blur", () => this.scheduleFinalize(), true);

		this.addCommand({
			id: "show-last-canvas-auto-size-debug",
			name: "Show last Canvas auto-size debug",
			callback: () => {
				new Notice(this.lastDebug, 15000);
				console.log("[Canvas Current Node Auto Size]", this.lastDebug);
			},
		});

	}

	async loadSettings() {
		const loaded = ((await this.loadData()) ?? {}) as Partial<CanvasAutoSizeSettings> & {
			normalHeightPadding?: number;
			compactHeightPadding?: number;
			normalVerticalPadding?: number;
			compactVerticalPadding?: number;
		};
		const legacyPadding =
			typeof loaded.compactVerticalPadding === "number"
				? loaded.compactVerticalPadding
				: typeof loaded.normalVerticalPadding === "number"
					? loaded.normalVerticalPadding
					: typeof loaded.compactHeightPadding === "number"
						? loaded.compactHeightPadding
						: typeof loaded.normalHeightPadding === "number"
							? loaded.normalHeightPadding
							: undefined;
		this.settings = {
			expansionMode: isExpansionMode(loaded.expansionMode) ? loaded.expansionMode : DEFAULT_SETTINGS.expansionMode,
			maxWidth: numberSettingOrDefault("maxWidth", loaded.maxWidth),
			minSingleLineHeight: numberSettingOrDefault("minSingleLineHeight", loaded.minSingleLineHeight),
			verticalPadding: numberSettingOrDefault("verticalPadding", legacyPadding ?? loaded.verticalPadding),
			horizontalPadding: numberSettingOrDefault("horizontalPadding", loaded.horizontalPadding),
			cjkSafetyPadding: numberSettingOrDefault("cjkSafetyPadding", loaded.cjkSafetyPadding),
			wrapSafetyPadding: numberSettingOrDefault("wrapSafetyPadding", loaded.wrapSafetyPadding),
			tightenExtraPadding: numberSettingOrDefault("tightenExtraPadding", loaded.tightenExtraPadding),
			debounceMs: numberSettingOrDefault("debounceMs", loaded.debounceMs),
			tightenWidthOnExit: booleanOrDefault(loaded.tightenWidthOnExit, DEFAULT_SETTINGS.tightenWidthOnExit),
			debugNotices: booleanOrDefault(loaded.debugNotices, DEFAULT_SETTINGS.debugNotices),
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private handleEditorUpdate(update: ViewUpdate, docChanged: boolean) {
		const node = this.getRuntimeNode(update);
		if (!node) return;

		const session = this.getSession(node, update.view);
		this.updateSessionMeasurement(session, update.view, docChanged);
		this.resizeSession(session, "Live resized Canvas node.");

		if (!docChanged) this.scheduleStabilize(session);
	}

	private getRuntimeNode(update: ViewUpdate) {
		const editorInfo = this.readEditorInfo(update);
		const node = getUnknownProperty(editorInfo, "node") as RuntimeCanvasNode | undefined;
		return isResizableCanvasNode(node) ? node : null;
	}

	private getSession(node: RuntimeCanvasNode, view: EditorView) {
		if (this.activeSession?.node.id === node.id && !this.activeSession.finalized) {
			this.activeSession.nodeEl ??= view.dom.closest<HTMLElement>(".canvas-node");
			return this.activeSession;
		}

		this.activeSession = {
			node,
			view,
			nodeEl: view.dom.closest<HTMLElement>(".canvas-node"),
			originalWidth: node.width,
			liveWidth: Math.max(node.width, INTERNAL_MIN_WIDTH),
			tightWidth: INTERNAL_MIN_WIDTH,
			docLength: -1,
			lineCount: this.measureLineCount(view),
			hasTrailingWhitespace: this.hasTrailingWhitespace(view),
			widthSource: "editor",
			renderedWidth: null,
			heightSource: "editor",
			renderedHeight: null,
			finalized: false,
			changed: false,
		};
		return this.activeSession;
	}

	private acceptTightWidth(session: EditSession, width: number, docLength: number) {
		const hasPreviousTextMeasurement = session.docLength >= 0;
		const suspiciousShrink = hasPreviousTextMeasurement && docLength >= session.docLength && width < session.tightWidth * 0.75;
		if (!suspiciousShrink) {
			session.tightWidth = width;
			session.docLength = docLength;
		}
		return session.tightWidth;
	}

	private updateSessionMeasurement(session: EditSession, view: EditorView, docChanged: boolean) {
		const measurement = this.measureWidths(view);
		session.view = view;
		session.lineCount = this.measureLineCount(view);
		session.hasTrailingWhitespace = this.hasTrailingWhitespace(view);
		session.liveWidth = Math.max(session.liveWidth, measurement.liveWidth);

		if (docChanged) {
			session.changed = true;
			session.tightWidth = this.acceptTightWidth(session, measurement.tightWidth, view.state.doc.length);
		}
	}

	private resizeSession(session: EditSession, message: string) {
		const nextWidth = Math.max(session.node.width, session.originalWidth, session.liveWidth);
		const nextHeight = this.measureHeight(session);
		this.resizeNode(session.node, nextWidth, nextHeight);
		this.scheduleHeightCorrection(session, nextWidth);
		this.saveCanvasDebounced(session.node);
		this.debug(message, session, nextWidth, nextHeight);
	}

	private scheduleStabilize(session: EditSession) {
		if (this.stabilizeFrame !== null) window.cancelAnimationFrame(this.stabilizeFrame);

		this.stabilizeFrame = window.requestAnimationFrame(() => {
			this.stabilizeFrame = window.requestAnimationFrame(() => {
				this.stabilizeFrame = null;
				if (session.finalized || !isResizableCanvasNode(session.node)) return;

				this.updateSessionMeasurement(session, session.view, false);
				this.resizeSession(session, "Stabilized Canvas node after entering edit mode.");
			});
		});
	}

	private scheduleHeightCorrection(session: EditSession, width: number) {
		if (this.heightFrame !== null) window.cancelAnimationFrame(this.heightFrame);

		this.heightFrame = window.requestAnimationFrame(() => {
			this.heightFrame = window.requestAnimationFrame(() => {
				this.heightFrame = null;
				if (session.finalized || !isResizableCanvasNode(session.node)) return;

				session.lineCount = this.measureLineCount(session.view);
				session.hasTrailingWhitespace = this.hasTrailingWhitespace(session.view);
				const correctedHeight = this.measureHeight(session);
				if (Math.abs(correctedHeight - session.node.height) < 1) return;

				this.resizeNode(session.node, width, correctedHeight);
				this.saveCanvasDebounced(session.node);
				this.debug("Corrected Canvas node height after reflow.", session, width, correctedHeight);
			});
		});
	}

	private scheduleFinalize() {
		const session = this.activeSession;
		if (!session || session.finalized) return;

		if (this.finalizeTimer !== null) window.clearTimeout(this.finalizeTimer);
		this.finalizeTimer = window.setTimeout(() => {
			this.finalizeTimer = null;
			this.finalizeSession(session);
		}, 120);
	}

	private finalizeSession(session: EditSession) {
		if (session.finalized || !isResizableCanvasNode(session.node)) return;
		session.finalized = true;

		const shouldTighten = this.settings.tightenWidthOnExit && session.changed;
		const nextWidth = shouldTighten ? session.tightWidth : Math.max(session.node.width, session.liveWidth, session.originalWidth);
		const nextHeight = this.measureHeight(session);
		this.resizeNode(session.node, nextWidth, nextHeight);
		this.saveCanvasDebounced(session.node);
		this.debug("Finalized Canvas node after editing.", session, nextWidth, nextHeight);

		if (this.activeSession === session) this.activeSession = null;
		this.scheduleFinalizeCorrection(session, nextWidth, shouldTighten);
	}

	private scheduleFinalizeCorrection(session: EditSession, width: number, shouldTighten: boolean) {
		if (this.finalizeFrame !== null) window.cancelAnimationFrame(this.finalizeFrame);

		this.finalizeFrame = window.requestAnimationFrame(() => {
			this.finalizeFrame = window.requestAnimationFrame(() => {
				this.finalizeFrame = null;
				if (!isResizableCanvasNode(session.node)) return;

				if (session.view.dom.isConnected) {
					session.lineCount = this.measureLineCount(session.view);
					session.hasTrailingWhitespace = this.hasTrailingWhitespace(session.view);
				}

				const renderedWidth = shouldTighten ? this.measureRenderedMarkdownWidth(session) : null;
				session.renderedWidth = renderedWidth;
				session.widthSource = renderedWidth
					? "rendered-markdown"
					: shouldTighten
						? "rendered-unavailable"
						: "editor";
				const correctedWidth = renderedWidth?.width ?? width;
				const renderedHeight = this.measureRenderedMarkdownHeight(session, correctedWidth);
				session.renderedHeight = renderedHeight;
				session.heightSource = renderedHeight ? "rendered-markdown" : "rendered-unavailable";
				const correctedHeight = renderedHeight?.height ?? this.measureHeight(session);
				this.resizeNode(session.node, correctedWidth, correctedHeight);
				this.saveCanvasDebounced(session.node);
				this.debug("Corrected Canvas node from rendered Markdown.", session, correctedWidth, correctedHeight);
			});
		});
	}

	private measureRenderedMarkdownWidth(session: EditSession) {
		const nodeEl = this.resolveCurrentNodeElement(session);
		if (!nodeEl?.parentElement) return null;
		session.nodeEl = nodeEl;

		const renderedEl = this.findRenderedMarkdown(nodeEl, true);
		if (!renderedEl) return null;

		const clone = nodeEl.cloneNode(true) as HTMLElement;
		clone.setAttribute("aria-hidden", "true");
		clone.removeAttribute("id");
		clone.removeAttribute("data-node-id");
		clone.classList.add("canvas-node-autosize-measure", "is-width-measure");
		clone.querySelectorAll<HTMLElement>("[id]").forEach((element) => element.removeAttribute("id"));

		const cloneRenderedEl = this.findRenderedMarkdown(clone);
		if (!cloneRenderedEl) return null;

		nodeEl.parentElement.appendChild(clone);
		try {
			const renderedWidth = Math.max(cloneRenderedEl.offsetWidth, cloneRenderedEl.scrollWidth);
			const outerInsets = Math.max(0, nodeEl.offsetWidth - renderedEl.offsetWidth);
			if (!Number.isFinite(renderedWidth) || renderedWidth <= 0) return null;
			return {
				width: Math.ceil(renderedWidth + outerInsets + this.settings.tightenExtraPadding),
				contentWidth: renderedWidth,
				outerInsets,
				selector: renderedEl.classList.contains("markdown-rendered") ? ".markdown-rendered" : ".markdown-preview-view",
			};
		} finally {
			clone.remove();
		}
	}

	private findRenderedMarkdown(root: HTMLElement, preferVisible = false) {
		const elements = Array.from(root.querySelectorAll<HTMLElement>(".markdown-rendered, .markdown-preview-view"));
		return (preferVisible ? elements.find((element) => element.offsetWidth > 0) : null) ?? elements[0] ?? null;
	}

	private measureRenderedMarkdownHeight(session: EditSession, width: number) {
		const nodeEl = this.resolveCurrentNodeElement(session);
		if (!nodeEl?.parentElement) return null;
		session.nodeEl = nodeEl;

		const renderedEl = this.findRenderedMarkdown(nodeEl, true);
		const contentEl = nodeEl.querySelector<HTMLElement>(".canvas-node-content");
		if (!renderedEl || !contentEl) return null;

		const clone = nodeEl.cloneNode(true) as HTMLElement;
		clone.setAttribute("aria-hidden", "true");
		clone.removeAttribute("id");
		clone.removeAttribute("data-node-id");
		clone.classList.add("canvas-node-autosize-measure", "is-height-measure");
		clone.querySelectorAll<HTMLElement>("[id]").forEach((element) => element.removeAttribute("id"));
		clone.setCssProps({
			"--canvas-node-autosize-measure-width": `${clamp(Math.round(width), INTERNAL_MIN_WIDTH, this.settings.maxWidth)}px`,
		});

		const cloneContentEl = clone.querySelector<HTMLElement>(".canvas-node-content");
		const cloneRenderedEl = this.findRenderedMarkdown(clone);
		if (!cloneContentEl || !cloneRenderedEl) return null;

		nodeEl.parentElement.appendChild(clone);
		try {
			const contentHeight = Math.max(
				cloneContentEl.offsetHeight,
				cloneContentEl.scrollHeight,
				cloneRenderedEl.offsetHeight,
				cloneRenderedEl.scrollHeight
			);
			const outerInsets = Math.max(0, nodeEl.offsetHeight - contentEl.offsetHeight);
			if (!Number.isFinite(contentHeight) || contentHeight <= 0) return null;
			return {
				height: Math.ceil(contentHeight + outerInsets + this.settings.verticalPadding + SCROLLBAR_SAFETY_HEIGHT),
				contentHeight,
				outerInsets,
				selector: renderedEl.classList.contains("markdown-rendered") ? ".markdown-rendered" : ".markdown-preview-view",
			};
		} finally {
			clone.remove();
		}
	}

	private resolveCurrentNodeElement(session: EditSession) {
		for (const key of ["nodeEl", "containerEl", "contentEl"] as const) {
			const candidate = getUnknownProperty(session.node, key);
			if (!isHtmlElement(candidate)) continue;
			const nodeEl = candidate.matches(".canvas-node") ? candidate : candidate.closest<HTMLElement>(".canvas-node");
			if (nodeEl?.isConnected) return nodeEl;
		}

		const escapedId = escapeCssValue(session.node.id);
		const byId = activeDocument.querySelector<HTMLElement>(`.canvas-node[data-node-id="${escapedId}"]`);
		if (byId?.isConnected) return byId;

		return session.nodeEl?.isConnected ? session.nodeEl : null;
	}

	private resizeNode(node: RuntimeCanvasNode, nextWidth: number, nextHeight: number) {
		const width = clamp(Math.round(nextWidth), INTERNAL_MIN_WIDTH, this.settings.maxWidth);
		const height = Math.round(nextHeight);
		const widthDelta = width - node.width;

		if (Math.abs(widthDelta) < 1 && Math.abs(height - node.height) < 1) return;

		if (this.settings.expansionMode === "center" && typeof node.moveTo === "function") {
			node.moveTo({ x: Math.round(node.x - widthDelta / 2), y: node.y });
		} else if (this.settings.expansionMode === "left" && typeof node.moveTo === "function") {
			node.moveTo({ x: Math.round(node.x - widthDelta), y: node.y });
		}

		node.resize({ width, height });
	}

	private measureWidths(view: EditorView): WidthMeasurement {
		let liveWidth = 0;
		let tightWidth = 0;
		let hasSoftWrap = false;
		const measuredLineCount = this.getMeasuredDocumentLineCount(view);

		for (let lineNumber = 1; lineNumber <= measuredLineCount; lineNumber += 1) {
			const line = view.state.doc.line(lineNumber);
			const measured = this.measureLine(view, lineNumber, line.text);
			liveWidth = Math.max(liveWidth, measured.width);
			tightWidth = Math.max(tightWidth, measured.tightWidth);
			hasSoftWrap ||= measured.softWrapped;
		}

		const visualLineCount = this.measureLineCount(view);
		const unwrapPadding = hasSoftWrap ? this.settings.wrapSafetyPadding * visualLineCount : 0;

		return {
			liveWidth: clamp(
				Math.ceil(liveWidth + this.settings.horizontalPadding + this.settings.wrapSafetyPadding + unwrapPadding),
				INTERNAL_MIN_WIDTH,
				this.settings.maxWidth
			),
			tightWidth: clamp(
				Math.ceil(tightWidth + this.settings.horizontalPadding + this.settings.tightenExtraPadding),
				INTERNAL_MIN_WIDTH,
				this.settings.maxWidth
			),
		};
	}

	private measureLineCount(view: EditorView) {
		const lineHeight = Math.max(1, view.defaultLineHeight);
		let visualLineCount = 0;
		const measuredLineCount = this.getMeasuredDocumentLineCount(view);

		for (let lineNumber = 1; lineNumber <= measuredLineCount; lineNumber += 1) {
			const line = view.state.doc.line(lineNumber);
			const start = view.coordsAtPos(line.from);
			const end = view.coordsAtPos(this.getMeasuredLineEnd(line.from, line.to, line.text));
			const wrappedLines = start && end ? Math.round(Math.max(0, end.top - start.top) / lineHeight) + 1 : 1;
			visualLineCount += Math.max(1, wrappedLines);
		}

		return Math.max(1, visualLineCount);
	}

	private measureLine(view: EditorView, lineNumber: number, line: string) {
		const text = trimTrailingWhitespace(line) || " ";
		const textWidth = this.measureTextWidth(view, text);
		const coordinate = this.measureLineByCoordinates(view, lineNumber);
		const cjkPadding = containsCjk(text) ? this.settings.cjkSafetyPadding : 0;

		if (coordinate && !coordinate.softWrapped) {
			const width = Math.max(coordinate.width, textWidth) + cjkPadding;
			return { width, tightWidth: width, softWrapped: false };
		}

		const fallback = textWidth + cjkPadding;
		return { width: fallback, tightWidth: fallback, softWrapped: Boolean(coordinate?.softWrapped) };
	}

	private measureLineByCoordinates(view: EditorView, lineNumber: number) {
		const line = view.state.doc.line(lineNumber);
		const start = view.coordsAtPos(line.from);
		const end = view.coordsAtPos(this.getMeasuredLineEnd(line.from, line.to, line.text));
		if (!start || !end) return null;

		const softWrapped = Math.abs(start.top - end.top) > 2;
		return {
			softWrapped,
			width: softWrapped ? 0 : Math.max(0, end.right - start.left),
		};
	}

	private getMeasuredLineEnd(from: number, to: number, text: string) {
		return Math.max(from, to - (text.length - trimTrailingWhitespace(text).length));
	}

	private hasTrailingWhitespace(view: EditorView) {
		const text = view.state.doc.toString();
		return trimDocumentTrailingWhitespace(text).length !== text.length;
	}

	private getMeasuredDocumentLineCount(view: EditorView) {
		let lineNumber = view.state.doc.lines;
		while (lineNumber > 1 && trimTrailingWhitespace(view.state.doc.line(lineNumber).text).length === 0) {
			lineNumber -= 1;
		}
		return lineNumber;
	}

	private measureTextWidth(view: EditorView, line: string) {
		const context = this.getMeasureContext(view);
		const fallbackWidth = this.measureFallbackWidth(view, line);
		const measuredWidth = Math.max(context?.measureText(line).width ?? 0, fallbackWidth);
		const letterSpacing = this.getLetterSpacing(view);
		return measuredWidth + Math.max(0, Array.from(line).length - 1) * letterSpacing;
	}

	private measureFallbackWidth(view: EditorView, line: string) {
		let width = 0;
		for (const char of Array.from(line || " ")) {
			width += isCjkCharacter(char) ? view.defaultCharacterWidth * 1.8 : view.defaultCharacterWidth;
		}
		return width;
	}

	private measureHeight(session: EditSession) {
		const lineCount = Math.max(1, session.lineCount);
		const lineHeight = Math.max(session.view.defaultLineHeight, this.settings.minSingleLineHeight);
		return Math.ceil(lineHeight * lineCount + this.settings.verticalPadding + SCROLLBAR_SAFETY_HEIGHT);
	}

	private getMeasureContext(view: EditorView) {
		const canvas = this.measureCanvas ?? (this.measureCanvas = activeDocument.createElement("canvas"));
		const context = canvas.getContext("2d");
		if (!context) return null;

		const contentEl = view.dom.querySelector<HTMLElement>(".cm-content") ?? view.dom;
		context.font = window.getComputedStyle(contentEl).font;
		return context;
	}

	private getLetterSpacing(view: EditorView) {
		const contentEl = view.dom.querySelector<HTMLElement>(".cm-content") ?? view.dom;
		const parsed = Number.parseFloat(window.getComputedStyle(contentEl).letterSpacing);
		return Number.isFinite(parsed) ? parsed : 0;
	}

	private readEditorInfo(update: ViewUpdate) {
		try {
			return update.state.field(editorInfoField) as unknown;
		} catch (error) {
			console.warn("[Canvas Current Node Auto Size] editorInfoField unavailable", error);
			return null;
		}
	}

	private debug(message: string, session: EditSession, width: number, height: number) {
		this.lastDebug = [
			message,
			`node id: ${session.node.id}`,
			`doc length: ${session.docLength}`,
			`line count: ${session.lineCount}`,
			`trailing whitespace: ${session.hasTrailingWhitespace}`,
			`width source: ${session.widthSource}`,
			`rendered selector: ${session.renderedWidth?.selector ?? "none"}`,
			`rendered content width: ${formatNumber(session.renderedWidth?.contentWidth)}`,
			`rendered outer insets: ${formatNumber(session.renderedWidth?.outerInsets)}`,
			`height source: ${session.heightSource}`,
			`rendered height selector: ${session.renderedHeight?.selector ?? "none"}`,
			`rendered content height: ${formatNumber(session.renderedHeight?.contentHeight)}`,
			`rendered vertical insets: ${formatNumber(session.renderedHeight?.outerInsets)}`,
			`changed: ${session.changed}`,
			`original width: ${session.originalWidth}`,
			`live width: ${session.liveWidth}`,
			`tight width: ${session.tightWidth}`,
			`node width/height: ${formatNumber(session.node.width)} / ${formatNumber(session.node.height)}`,
			`next width/height: ${Math.round(width)} / ${Math.round(height)}`,
		].join("\n");

		console.log("[Canvas Current Node Auto Size]", this.lastDebug);
		if (this.settings.debugNotices) new Notice(this.lastDebug, 6000);
	}
}

class CanvasAutoSizeSettingTab extends PluginSettingTab {
	plugin: CanvasCurrentNodeAutoSizePlugin;

	constructor(app: App, plugin: CanvasCurrentNodeAutoSizePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName("Basics").setHeading();

		new Setting(containerEl)
			.setName("Expansion direction")
			.setDesc("Controls how the current node expands when its width changes.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("right", "Grow right")
					.addOption("center", "Grow from center")
					.addOption("left", "Grow left")
					.setValue(this.plugin.settings.expansionMode)
					.onChange(async (value) => {
						this.plugin.settings.expansionMode = value as ExpansionMode;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Tighten width on exit")
			.setDesc("Measure rendered Markdown and tighten the node width after edited content changes. Enabled by default.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.tightenWidthOnExit).onChange(async (value) => {
					this.plugin.settings.tightenWidthOnExit = value;
					await this.plugin.saveSettings();
					this.display();
				})
			);

		new Setting(containerEl)
			.setName("Reset settings")
			.setDesc("Restore all plugin settings to their defaults.")
			.addButton((button) =>
				button
					.setButtonText("Restore defaults")
					.onClick(async () => {
						this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
						await this.plugin.saveSettings();
						this.display();
					})
			);

		this.addNumberSetting("maxWidth");

		new Setting(containerEl).setName("Width").setHeading();
		this.addNumberSetting("horizontalPadding");
		this.addNumberSetting("cjkSafetyPadding");
		this.addNumberSetting("wrapSafetyPadding");
		if (this.plugin.settings.tightenWidthOnExit) this.addNumberSetting("tightenExtraPadding");

		new Setting(containerEl).setName("Height").setHeading();
		this.addNumberSetting("minSingleLineHeight");
		this.addNumberSetting("verticalPadding");

		new Setting(containerEl).setName("Advanced").setHeading();
		this.addNumberSetting("debounceMs");

		new Setting(containerEl)
			.setName("Debug notices")
			.setDesc("Show a temporary debug notice each time the plugin evaluates a Canvas node.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debugNotices).onChange(async (value) => {
					this.plugin.settings.debugNotices = value;
					await this.plugin.saveSettings();
				})
			);
	}

	private addNumberSetting(key: NumericSettingKey) {
		const definition = getNumberSettingDefinition(key);
		new Setting(this.containerEl)
			.setName(definition.name)
			.setDesc(definition.desc)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = String(definition.min);
				if (typeof definition.max === "number") text.inputEl.max = String(definition.max);
				text.setValue(String(this.plugin.settings[key])).onChange(async (value) => {
					const parsed = Number(value);
					if (!Number.isFinite(parsed)) return;
					this.plugin.settings[key] = clampNumberSetting(key, parsed);
					await this.plugin.saveSettings();
				});
			});
	}
}

function isResizableCanvasNode(value: RuntimeCanvasNode | undefined): value is RuntimeCanvasNode {
	return (
		Boolean(value) &&
		typeof value?.id === "string" &&
		typeof value?.x === "number" &&
		typeof value?.y === "number" &&
		typeof value?.width === "number" &&
		typeof value?.height === "number" &&
		typeof value?.resize === "function"
	);
}

function getUnknownProperty(value: unknown, key: string) {
	return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function isHtmlElement(value: unknown): value is HTMLElement {
	return Boolean(
		value &&
			typeof value === "object" &&
			typeof (value as HTMLElement).matches === "function" &&
			typeof (value as HTMLElement).closest === "function"
	);
}

function escapeCssValue(value: string) {
	return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character.codePointAt(0)?.toString(16)} `);
}

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
}

function getNumberSettingDefinition(key: NumericSettingKey) {
	const definition = NUMERIC_SETTING_DEFINITIONS.find((item) => item.key === key);
	if (!definition) throw new Error(`Unknown numeric setting: ${key}`);
	return definition;
}

function clampNumberSetting(key: NumericSettingKey, value: number) {
	const definition = getNumberSettingDefinition(key);
	return clamp(value, definition.min, definition.max ?? Number.MAX_SAFE_INTEGER);
}

function numberSettingOrDefault(key: NumericSettingKey, value: unknown) {
	const defaultValue = DEFAULT_SETTINGS[key];
	return clampNumberSetting(key, typeof value === "number" && Number.isFinite(value) ? value : defaultValue);
}

function booleanOrDefault(value: unknown, defaultValue: boolean) {
	return typeof value === "boolean" ? value : defaultValue;
}

function isExpansionMode(value: unknown): value is ExpansionMode {
	return value === "right" || value === "center" || value === "left";
}

function isCjkCharacter(char: string) {
	const code = char.charCodeAt(0);
	return (
		(code >= 0x2e80 && code <= 0x2eff) ||
		(code >= 0x3000 && code <= 0x303f) ||
		(code >= 0x3040 && code <= 0x30ff) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0xac00 && code <= 0xd7af) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xff00 && code <= 0xffef)
	);
}

function containsCjk(value: string) {
	return Array.from(value).some(isCjkCharacter);
}

function trimTrailingWhitespace(value: string) {
	return value.replace(/[^\S\r\n]+$/u, "");
}

function trimDocumentTrailingWhitespace(value: string) {
	return value.replace(/\s+$/u, "");
}

function formatNumber(value: number | undefined) {
	return typeof value === "number" ? String(Math.round(value)) : "none";
}
