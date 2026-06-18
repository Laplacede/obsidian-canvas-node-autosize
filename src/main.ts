import { App, Notice, Plugin, PluginSettingTab, Setting, debounce, editorInfoField } from "obsidian";
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
	originalWidth: number;
	liveWidth: number;
	tightWidth: number;
	maxHeight: number;
	docLength: number;
	lineCount: number;
	finalized: boolean;
	changed: boolean;
}

interface WidthMeasurement {
	liveWidth: number;
	tightWidth: number;
}

const INTERNAL_MIN_WIDTH = 96;
const SCROLLBAR_SAFETY_HEIGHT = 4;

const DEFAULT_SETTINGS: CanvasAutoSizeSettings = {
	expansionMode: "right",
	maxWidth: 520,
	minSingleLineHeight: 44,
	verticalPadding: 10,
	horizontalPadding: 40,
	cjkSafetyPadding: 18,
	wrapSafetyPadding: 28,
	tightenExtraPadding: 40,
	debounceMs: 40,
	tightenWidthOnExit: false,
	debugNotices: false,
};

export default class CanvasCurrentNodeAutoSizePlugin extends Plugin {
	settings: CanvasAutoSizeSettings;
	private activeSession: EditSession | null = null;
	private measureCanvas: HTMLCanvasElement | null = null;
	private liveResizeDebounced: (update: ViewUpdate) => void;
	private saveCanvasDebounced: (node: RuntimeCanvasNode) => void;
	private lastDebug = "No Canvas editor update captured yet.";
	private stabilizeFrame: number | null = null;
	private heightFrame: number | null = null;
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

		this.registerDomEvent(document, "focusout", () => this.scheduleFinalize(), true);
		this.registerDomEvent(document, "pointerdown", () => this.scheduleFinalize(), true);
		this.registerDomEvent(document, "keydown", (event) => {
			if (event.key === "Escape") this.scheduleFinalize();
		}, true);
		this.registerDomEvent(document, "keyup", (event) => {
			if (event.key === "Escape") this.scheduleFinalize();
		}, true);
		this.registerDomEvent(window, "blur", () => this.scheduleFinalize(), true);

		this.addCommand({
			id: "show-last-canvas-auto-size-debug",
			name: "Show last Canvas auto-size debug",
			callback: () => {
				new Notice(this.lastDebug, 15000);
				console.log("[Canvas Current Node Auto Size]", this.lastDebug);
			},
		});

		this.addCommand({
			id: "copy-last-canvas-auto-size-debug",
			name: "Copy last Canvas auto-size debug",
			callback: async () => {
				await navigator.clipboard.writeText(this.lastDebug);
				new Notice("Canvas auto-size debug copied.");
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
			maxWidth: numberOrDefault(loaded.maxWidth, DEFAULT_SETTINGS.maxWidth),
			minSingleLineHeight: numberOrDefault(loaded.minSingleLineHeight, DEFAULT_SETTINGS.minSingleLineHeight),
			verticalPadding: numberOrDefault(legacyPadding ?? loaded.verticalPadding, DEFAULT_SETTINGS.verticalPadding),
			horizontalPadding: numberOrDefault(loaded.horizontalPadding, DEFAULT_SETTINGS.horizontalPadding),
			cjkSafetyPadding: numberOrDefault(loaded.cjkSafetyPadding, DEFAULT_SETTINGS.cjkSafetyPadding),
			wrapSafetyPadding: numberOrDefault(loaded.wrapSafetyPadding, DEFAULT_SETTINGS.wrapSafetyPadding),
			tightenExtraPadding: numberOrDefault(loaded.tightenExtraPadding, DEFAULT_SETTINGS.tightenExtraPadding),
			debounceMs: numberOrDefault(loaded.debounceMs, DEFAULT_SETTINGS.debounceMs),
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
		const measurement = this.measureWidths(update.view);
		session.view = update.view;
		session.lineCount = this.measureLineCount(update.view);
		session.liveWidth = Math.max(session.liveWidth, measurement.liveWidth);

		if (docChanged) {
			session.changed = true;
			session.tightWidth = this.acceptTightWidth(session, measurement.tightWidth, update.view.state.doc.length);
		}

		const nextWidth = Math.max(node.width, session.originalWidth, session.liveWidth);
		const nextHeight = this.measureHeight(session);
		session.maxHeight = Math.max(session.maxHeight, nextHeight);
		this.resizeNode(node, nextWidth, nextHeight);
		this.scheduleHeightCorrection(session, nextWidth);
		this.saveCanvasDebounced(node);
		this.debug("Live resized Canvas node.", session, nextWidth, nextHeight);

		if (!docChanged) this.scheduleStabilize(session);
	}

	private getRuntimeNode(update: ViewUpdate) {
		const editorInfo = this.readEditorInfo(update);
		const node = getUnknownProperty(editorInfo, "node") as RuntimeCanvasNode | undefined;
		return isResizableCanvasNode(node) ? node : null;
	}

	private getSession(node: RuntimeCanvasNode, view: EditorView) {
		if (this.activeSession?.node.id === node.id && !this.activeSession.finalized) {
			return this.activeSession;
		}

		this.activeSession = {
			node,
			view,
			originalWidth: node.width,
			liveWidth: Math.max(node.width, INTERNAL_MIN_WIDTH),
			tightWidth: INTERNAL_MIN_WIDTH,
			maxHeight: node.height,
			docLength: -1,
			lineCount: this.measureLineCount(view),
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

	private scheduleStabilize(session: EditSession) {
		if (this.stabilizeFrame !== null) window.cancelAnimationFrame(this.stabilizeFrame);

		this.stabilizeFrame = window.requestAnimationFrame(() => {
			this.stabilizeFrame = window.requestAnimationFrame(() => {
				this.stabilizeFrame = null;
				if (session.finalized || !isResizableCanvasNode(session.node)) return;

				const measurement = this.measureWidths(session.view);
				session.lineCount = this.measureLineCount(session.view);
				session.liveWidth = Math.max(session.liveWidth, measurement.liveWidth);
				const nextWidth = Math.max(session.node.width, session.originalWidth, session.liveWidth);
				const nextHeight = this.measureHeight(session);
				session.maxHeight = Math.max(session.maxHeight, nextHeight);
				this.resizeNode(session.node, nextWidth, nextHeight);
				this.scheduleHeightCorrection(session, nextWidth);
				this.saveCanvasDebounced(session.node);
				this.debug("Stabilized Canvas node after entering edit mode.", session, nextWidth, nextHeight);
			});
		});
	}

	private scheduleHeightCorrection(session: EditSession, width: number) {
		if (this.heightFrame !== null) window.cancelAnimationFrame(this.heightFrame);

		this.heightFrame = window.requestAnimationFrame(() => {
			this.heightFrame = window.requestAnimationFrame(() => {
				this.heightFrame = null;
				if (session.finalized || !isResizableCanvasNode(session.node)) return;

				const correctedHeight = this.measureHeight(session);
				if (Math.abs(correctedHeight - session.node.height) < 1) return;

				session.maxHeight = Math.max(session.maxHeight, correctedHeight);
				session.node.resize({ width, height: correctedHeight });
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
		const measuredHeight = this.measureHeight(session);
		const nextHeight = session.lineCount > 1 ? Math.max(measuredHeight, session.maxHeight) : measuredHeight;
		this.resizeNode(session.node, nextWidth, nextHeight);
		this.saveCanvasDebounced(session.node);
		this.debug("Finalized Canvas node after editing.", session, nextWidth, nextHeight);

		if (this.activeSession === session) this.activeSession = null;
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

		for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
			const line = view.state.doc.line(lineNumber);
			const measured = this.measureLine(view, lineNumber, line.text);
			liveWidth = Math.max(liveWidth, measured.width);
			tightWidth = Math.max(tightWidth, measured.tightWidth);
			hasSoftWrap ||= measured.softWrapped;
		}

		const visualLineCount = Math.max(1, Math.round(view.contentHeight / Math.max(1, view.defaultLineHeight)));
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

		for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
			const line = view.state.doc.line(lineNumber);
			const start = view.coordsAtPos(line.from);
			const end = view.coordsAtPos(line.to);
			const wrappedLines = start && end ? Math.round(Math.max(0, end.top - start.top) / lineHeight) + 1 : 1;
			visualLineCount += Math.max(1, wrappedLines);
		}

		return Math.max(1, visualLineCount);
	}

	private measureLine(view: EditorView, lineNumber: number, line: string) {
		const text = line || " ";
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
		const end = view.coordsAtPos(line.to);
		if (!start || !end) return null;

		const softWrapped = Math.abs(start.top - end.top) > 2;
		return {
			softWrapped,
			width: softWrapped ? 0 : Math.max(0, end.right - start.left),
		};
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
		const contentHeight = Math.max(session.view.contentHeight, session.view.defaultLineHeight * lineCount);
		const textHeight = lineCount === 1 ? Math.max(contentHeight, this.settings.minSingleLineHeight) : contentHeight;
		return Math.ceil(textHeight + this.settings.verticalPadding + SCROLLBAR_SAFETY_HEIGHT);
	}

	private getMeasureContext(view: EditorView) {
		if (!this.measureCanvas) this.measureCanvas = document.createElement("canvas");

		const context = this.measureCanvas.getContext("2d");
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
			`changed: ${session.changed}`,
			`original width: ${session.originalWidth}`,
			`live width: ${session.liveWidth}`,
			`tight width: ${session.tightWidth}`,
			`max height: ${session.maxHeight}`,
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
		containerEl.createEl("h2", { text: "Canvas Current Node Auto Size" });

		new Setting(containerEl)
			.setName("Expansion direction")
			.setDesc("Controls how the current node expands. Other nodes are never moved.")
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
			.setDesc("Shrink width once after leaving edit mode.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.tightenWidthOnExit).onChange(async (value) => {
					this.plugin.settings.tightenWidthOnExit = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Debug notices")
			.setDesc("Show a temporary debug notice each time the plugin evaluates a Canvas node.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debugNotices).onChange(async (value) => {
					this.plugin.settings.debugNotices = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Reset settings")
			.setDesc("Restore all plugin settings to their defaults.")
			.addButton((button) =>
				button
					.setButtonText("Restore defaults")
					.setWarning()
					.onClick(async () => {
						const keepTightenWidthOnExit = this.plugin.settings.tightenWidthOnExit;
						this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS, {
							tightenWidthOnExit: keepTightenWidthOnExit,
						});
						await this.plugin.saveSettings();
						this.display();
					})
			);

		this.addNumberSetting("Maximum width", "Largest auto-sized node width in pixels.", "maxWidth");
		this.addNumberSetting("Horizontal padding", "Extra width around measured text.", "horizontalPadding");
		this.addNumberSetting("CJK safety padding", "Extra width for Chinese/Japanese/Korean text.", "cjkSafetyPadding");
		this.addNumberSetting("Wrap safety padding", "Extra width used while editing to prevent wrapping.", "wrapSafetyPadding");
		this.addNumberSetting("Tighten extra padding", "Extra visible space kept after tightening width on exit.", "tightenExtraPadding");
		this.addNumberSetting("Minimum line height", "Minimum height reserved for each visible text line.", "minSingleLineHeight");
		this.addNumberSetting("Vertical padding", "Extra total height kept around node text.", "verticalPadding");
		this.addNumberSetting("Debounce", "Delay after typing before resizing, in milliseconds. Restart Obsidian after changing this.", "debounceMs");
	}

	private addNumberSetting(
		name: string,
		desc: string,
		key: keyof Pick<
			CanvasAutoSizeSettings,
			| "maxWidth"
			| "horizontalPadding"
			| "cjkSafetyPadding"
			| "wrapSafetyPadding"
			| "tightenExtraPadding"
			| "minSingleLineHeight"
			| "verticalPadding"
			| "debounceMs"
		>
	) {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings[key]))
					.onChange(async (value) => {
						const parsed = Number(value);
						if (!Number.isFinite(parsed)) return;
						this.plugin.settings[key] = parsed;
						await this.plugin.saveSettings();
					})
			);
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

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
}

function numberOrDefault(value: unknown, defaultValue: number) {
	return typeof value === "number" && Number.isFinite(value) ? value : defaultValue;
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

function formatNumber(value: number | undefined) {
	return typeof value === "number" ? String(Math.round(value)) : "none";
}
