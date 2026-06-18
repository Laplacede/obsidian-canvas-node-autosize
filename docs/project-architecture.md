# 项目代码结构与架构详解

这份文档解释 `Canvas Current Node Auto Size` 的项目架构、各文件职责、核心类型、参数含义、数据流、构建流程和 Obsidian 运行时交互。目标是让之后继续维护这个项目时，不需要重新从头摸代码。

## 项目文件结构

当前项目主要文件如下：

```text
node resizer/
├── docs/
│   ├── canvas-development-notes.md
│   └── project-architecture.md
├── src/
│   └── main.ts
├── esbuild.config.mjs
├── manifest.json
├── package.json
├── package-lock.json
├── tsconfig.json
├── main.js
└── LICENSE
```

### `src/main.ts`

插件源码核心文件。包含：

- 插件设置类型。
- Canvas 节点运行时类型。
- 编辑会话状态。
- 默认参数。
- 设置页定义。
- CodeMirror 更新监听。
- 宽度测量逻辑。
- 高度估算逻辑。
- 节点 resize / moveTo / requestSave。
- debug 命令。

大部分业务逻辑都在这里。

### `main.js`

构建产物。Obsidian 实际加载的是这个文件，不是 `src/main.ts`。

每次改完 TypeScript 后要运行：

```bash
npm run build
```

然后把生成的 `main.js` 同步到 vault 的插件目录。

### `manifest.json`

Obsidian 插件清单。关键字段：

```json
{
  "id": "canvas-current-node-auto-size",
  "name": "Canvas Current Node Auto Size",
  "version": "0.1.0",
  "minAppVersion": "1.12.7",
  "description": "Auto-size only the currently edited Canvas text node, with CJK-friendly width padding and configurable height.",
  "isDesktopOnly": false
}
```

Obsidian 通过 `id` 识别插件。插件目录名可以不同，但正式发布时通常目录名和 id 保持一致更清楚。

### `package.json`

Node 项目配置。核心脚本：

```json
{
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "tsc -noEmit -skipLibCheck && node esbuild.config.mjs production"
  }
}
```

`build` 会先做 TypeScript 类型检查，再用 esbuild 打包。

### `esbuild.config.mjs`

负责把 `src/main.ts` 打包成 `main.js`。

Obsidian 插件通常需要把 `obsidian`、`electron`、`@codemirror/*` 等依赖设为 external，因为它们由 Obsidian 运行时提供。

### `tsconfig.json`

TypeScript 编译配置。`npm run build` 中的 `tsc -noEmit` 会读取它做类型检查。

### `styles.css`

当前已经删除。早期它用于隐藏测量元素，但后来的实现不再使用隐藏 DOM 测量，所以保留会造成误导。

## 运行时整体流程

插件的核心流程可以概括为：

```text
Obsidian 加载插件
    ↓
onload()
    ↓
读取设置 loadSettings()
    ↓
注册设置页
    ↓
注册 CodeMirror update listener
    ↓
用户编辑 Canvas 文本节点
    ↓
EditorView.updateListener 收到更新
    ↓
通过 editorInfoField 找到当前 Canvas node
    ↓
建立或复用 EditSession
    ↓
测量文本宽度、高度、行数
    ↓
计算目标 width / height
    ↓
node.resize()
    ↓
必要时 node.moveTo()
    ↓
canvas.requestSave()
```

## 核心类型说明

### `ExpansionMode`

```ts
type ExpansionMode = "right" | "center" | "left";
```

控制节点宽度变化时，节点从哪个方向扩展。

- `right`：默认模式，只增加右边界，`x` 不动。
- `center`：中心扩展，宽度增加时 `x` 左移一半。
- `left`：向左扩展，宽度增加时 `x` 左移全部宽度差。

这个参数只影响当前节点，不会移动其它节点。

### `CanvasAutoSizeSettings`

```ts
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
```

这是插件持久化设置。Obsidian 会把它保存到插件数据文件中。

每个字段的意义如下。

#### `expansionMode`

节点扩展方向。传递路径：

```text
设置页 dropdown
    ↓
plugin.settings.expansionMode
    ↓
resizeNode()
    ↓
决定是否调用 node.moveTo()
```

在 `resizeNode()` 中，如果模式为 `center` 或 `left`，会根据宽度差调整节点 `x` 坐标。

#### `maxWidth`

自动调整后的最大宽度。默认 `520`。

传递路径：

```text
NUMERIC_SETTING_DEFINITIONS
    ↓
设置页输入
    ↓
settings.maxWidth
    ↓
measureWidths() / resizeNode()
```

它有两个作用：

- `measureWidths()` 中 clamp 计算出的宽度。
- `resizeNode()` 中 clamp 最终节点宽度。

#### `minSingleLineHeight`

单行文本节点的最小高度。默认 `44`。

只在 `lineCount === 1` 时作为兜底：

```ts
const textHeight = lineCount === 1 ? Math.max(contentHeight, this.settings.minSingleLineHeight) : contentHeight;
```

它的目标是避免单行节点退出编辑后被压得太矮，出现文字被裁切或滚动条。

#### `verticalPadding`

节点文本周围额外总高度。默认 `10`。

高度公式：

```ts
height = textHeight + verticalPadding + SCROLLBAR_SAFETY_HEIGHT
```

如果出现竖向滚动条，可以适当增大它。

#### `horizontalPadding`

基础横向留白。默认 `20`。

宽度公式中始终会加：

```ts
liveWidth = measuredLineWidth + horizontalPadding + wrapSafetyPadding + unwrapPadding
tightWidth = measuredLineWidth + horizontalPadding + tightenExtraPadding
```

它是所有文本都共享的基础宽度余量。

#### `cjkSafetyPadding`

中文、日文、韩文额外宽度。默认 `18`。

在 `measureLine()` 中，如果当前行包含 CJK 字符，就额外加这个值：

```ts
const cjkPadding = containsCjk(text) ? this.settings.cjkSafetyPadding : 0;
```

它用于解决中文末尾临界换行问题。

#### `wrapSafetyPadding`

编辑中的防换行宽度。默认 `28`。

只用于 live width，不用于退出收紧宽度。

目的：

- 编辑时多给一点右侧空间。
- 避免输入过程中刚好到边界就换行。
- 避免中间编辑长文本时节点突然塌缩。

#### `tightenExtraPadding`

退出收紧时保留的可见宽度。默认 `40`。

只在 `tightenWidthOnExit === true` 且本次编辑确实改过内容时生效。

如果关闭 `Tighten width on exit`，设置页会隐藏这个参数。

#### `debounceMs`

输入后延迟 resize 的时间。默认 `40ms`。

在 `onload()` 中创建 debounce 函数：

```ts
this.liveResizeDebounced = debounce((update) => this.handleEditorUpdate(update, true), this.settings.debounceMs, false);
```

注意：当前实现中修改这个值后需要重启 Obsidian 或重新加载插件。

#### `tightenWidthOnExit`

是否在退出编辑时收紧宽度。默认关闭。

关闭时：

```ts
nextWidth = Math.max(session.node.width, session.liveWidth, session.originalWidth)
```

开启时，并且 `session.changed === true`：

```ts
nextWidth = session.tightWidth
```

它是高风险功能，所以默认关闭。

#### `debugNotices`

是否每次测量时弹出 debug Notice。默认关闭。

即使关闭，插件仍会更新 `lastDebug` 并写入 console。

## 默认参数表

```ts
const DEFAULT_SETTINGS: CanvasAutoSizeSettings = {
	expansionMode: "right",
	maxWidth: 520,
	minSingleLineHeight: 44,
	verticalPadding: 10,
	horizontalPadding: 20,
	cjkSafetyPadding: 18,
	wrapSafetyPadding: 28,
	tightenExtraPadding: 40,
	debounceMs: 40,
	tightenWidthOnExit: false,
	debugNotices: false,
};
```

这些默认值只影响新设置。如果本地已经保存过插件设置，默认值变更不会覆盖旧值。

## 数值设置定义

所有数字输入集中在：

```ts
const NUMERIC_SETTING_DEFINITIONS: NumericSettingDefinition[] = [...]
```

每个定义包含：

- `key`：对应 `CanvasAutoSizeSettings` 的字段。
- `name`：设置页显示名。
- `desc`：设置页说明。
- `min`：允许的最小值。
- `max`：允许的最大值。

这个设计的好处：

- 设置页不用重复写默认说明和范围。
- `loadSettings()` 可以统一 clamp。
- 输入框保存时也可以统一 clamp。
- 后面新增数字参数时，只需要改一张表。

## 设置加载流程

入口：

```ts
async loadSettings()
```

流程：

```text
this.loadData()
    ↓
读取旧数据 loaded
    ↓
兼容旧字段 normalHeightPadding / compactHeightPadding 等
    ↓
逐项读取当前设置
    ↓
对数字设置执行 numberSettingOrDefault()
    ↓
对布尔设置执行 booleanOrDefault()
    ↓
写入 this.settings
```

### 旧高度字段迁移

早期版本有过 compact / normal 高度参数。现在已经删除，但为了不让旧数据完全失效，加载时仍读取：

- `normalHeightPadding`
- `compactHeightPadding`
- `normalVerticalPadding`
- `compactVerticalPadding`

这些字段只会迁移到当前的 `verticalPadding`。

## 设置保存流程

设置页中每个输入变更时：

```text
用户改设置
    ↓
写入 this.plugin.settings
    ↓
await this.plugin.saveSettings()
    ↓
this.saveData(this.settings)
```

Obsidian 会把数据保存到插件的数据文件。

## CodeMirror 更新监听

在 `onload()` 中注册：

```ts
this.registerEditorExtension([
	EditorView.updateListener.of((update) => {
		if (update.docChanged) this.liveResizeDebounced(update);
		else this.handleEditorUpdate(update, false);
	}),
]);
```

含义：

- 如果文档内容改变，走 debounce，避免每个按键都立即 resize。
- 如果文档内容没变，也会调用 `handleEditorUpdate()`，用于处理进入编辑状态、选中节点等情况。

## 当前 Canvas 节点定位

核心方法：

```ts
private getRuntimeNode(update: ViewUpdate)
```

流程：

```text
readEditorInfo(update)
    ↓
update.state.field(editorInfoField)
    ↓
editorInfo.node
    ↓
isResizableCanvasNode()
    ↓
RuntimeCanvasNode
```

如果当前编辑器不是 Canvas 节点编辑器，或者拿不到有效 `node.resize()`，插件直接返回，不做任何事。

## 编辑会话 `EditSession`

```ts
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
```

它记录一次节点编辑过程中的状态。

### `node`

当前 Canvas 节点运行时对象。

### `view`

当前 CodeMirror `EditorView`。用于读取文本、行数、坐标、默认行高等。

### `originalWidth`

进入本次编辑会话时节点的宽度。用于避免节点在编辑中低于原始宽度。

### `liveWidth`

编辑中使用的宽度。它只增不减：

```ts
session.liveWidth = Math.max(session.liveWidth, measurement.liveWidth);
```

这样可以避免编辑过程中节点突然缩窄。

### `tightWidth`

退出收紧时使用的宽度。它更接近文本实际需要的宽度，不包含编辑中额外防换行的 `wrapSafetyPadding`。

### `maxHeight`

本次编辑中见过的最大高度。退出时如果是多行，会避免高度突然低于编辑中使用过的高度：

```ts
const nextHeight = session.lineCount > 1 ? Math.max(measuredHeight, session.maxHeight) : measuredHeight;
```

### `docLength`

上一次接受 tight width 时的文档长度。用于判断宽度测量是否出现可疑缩小。

### `lineCount`

当前可视行数估算。用于高度计算。

### `finalized`

标记这个会话是否已经退出编辑并完成最终 resize。防止 finalize 多次执行。

### `changed`

本次会话是否真的改过文本。退出收紧只在 `changed === true` 时允许。

## 核心处理流程

### `handleEditorUpdate(update, docChanged)`

这是编辑器更新的主入口。

流程：

```text
getRuntimeNode(update)
    ↓
getSession(node, update.view)
    ↓
updateSessionMeasurement(session, update.view, docChanged)
    ↓
resizeSession(session, "Live resized Canvas node.")
    ↓
如果不是文档变化，scheduleStabilize(session)
```

### `getSession(node, view)`

如果当前 active session 仍是同一个节点，并且没有 finalized，就复用。

否则创建新 session：

```ts
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
```

### `updateSessionMeasurement(session, view, docChanged)`

负责刷新测量状态：

```text
measureWidths(view)
    ↓
更新 session.view
    ↓
更新 session.lineCount
    ↓
liveWidth 只增不减
    ↓
如果 docChanged，标记 changed，并更新 tightWidth
```

### `resizeSession(session, message)`

统一执行 live resize：

```text
nextWidth = max(node.width, originalWidth, liveWidth)
nextHeight = measureHeight(session)
session.maxHeight = max(session.maxHeight, nextHeight)
resizeNode(node, nextWidth, nextHeight)
scheduleHeightCorrection(session, nextWidth)
saveCanvasDebounced(node)
debug(...)
```

它被两个地方复用：

- 正常编辑更新。
- 进入编辑后稳定帧修正。

## 宽度测量流程

### `measureWidths(view)`

返回：

```ts
interface WidthMeasurement {
	liveWidth: number;
	tightWidth: number;
}
```

流程：

```text
遍历每一行
    ↓
measureLine()
    ↓
取最大 liveWidth / tightWidth
    ↓
如果检测到软换行，增加 unwrapPadding
    ↓
返回 liveWidth 和 tightWidth
```

### `measureLine(view, lineNumber, line)`

单行测量方法。

使用三个信息源：

1. CodeMirror 坐标：

```ts
view.coordsAtPos(line.from)
view.coordsAtPos(line.to)
```

2. Canvas 2D `measureText()`。

3. fallback 字符宽度估算。

如果坐标有效且没有软换行：

```ts
width = Math.max(coordinate.width, textWidth) + cjkPadding
```

如果软换行或坐标无效：

```ts
fallback = textWidth + cjkPadding
```

### `measureLineByCoordinates(view, lineNumber)`

通过行首行尾坐标判断：

- `softWrapped`：行首和行尾 `top` 差异大于 2px。
- `width`：`end.right - start.left`。

这适合检测当前行是否已经发生视觉换行。

### `measureTextWidth(view, line)`

通过隐藏的 canvas context 测量文本宽度：

```ts
context.font = window.getComputedStyle(contentEl).font;
context.measureText(line).width;
```

同时考虑 `letterSpacing`。

### `measureFallbackWidth(view, line)`

兜底估算：

- CJK 字符按 `defaultCharacterWidth * 1.8`。
- 其它字符按 `defaultCharacterWidth`。

这是为了当 canvas 或坐标测量不可靠时仍能有一个保守值。

## 高度估算流程

### `measureLineCount(view)`

遍历每一行，用行首行尾坐标估算视觉行数：

```ts
const wrappedLines = start && end ? Math.round(Math.max(0, end.top - start.top) / lineHeight) + 1 : 1;
```

最后返回所有视觉行数之和。

### `measureHeight(session)`

当前高度公式：

```ts
const lineCount = Math.max(1, session.lineCount);
const contentHeight = Math.max(session.view.contentHeight, session.view.defaultLineHeight * lineCount);
const textHeight = lineCount === 1 ? Math.max(contentHeight, this.settings.minSingleLineHeight) : contentHeight;
return Math.ceil(textHeight + this.settings.verticalPadding + SCROLLBAR_SAFETY_HEIGHT);
```

含义：

- 多行主要依赖 `contentHeight` 和行数估算。
- 单行额外用 `minSingleLineHeight` 防止被压太扁。
- 最后加 `verticalPadding` 和内部固定 `SCROLLBAR_SAFETY_HEIGHT`。

当前 `SCROLLBAR_SAFETY_HEIGHT = 4`。

## 节点 resize 与位置调整

### `resizeNode(node, nextWidth, nextHeight)`

最终修改节点尺寸。

流程：

```text
width = clamp(round(nextWidth), INTERNAL_MIN_WIDTH, maxWidth)
height = round(nextHeight)
widthDelta = width - node.width
如果尺寸没有变化，直接返回
根据 expansionMode 决定是否 moveTo()
node.resize({ width, height })
```

扩展模式：

- `right`：不移动 `x`。
- `center`：`x = x - widthDelta / 2`。
- `left`：`x = x - widthDelta`。

## 退出编辑流程

退出触发注册在 `onload()`：

```ts
this.registerDomEvent(document, "focusout", () => this.scheduleFinalize(), true);
this.registerDomEvent(document, "pointerdown", () => this.scheduleFinalize(), true);
this.registerDomEvent(document, "keydown", ... Escape ...);
this.registerDomEvent(document, "keyup", ... Escape ...);
this.registerDomEvent(window, "blur", () => this.scheduleFinalize(), true);
```

### `scheduleFinalize()`

延迟 120ms 执行：

```ts
this.finalizeTimer = window.setTimeout(() => {
	this.finalizeTimer = null;
	this.finalizeSession(session);
}, 120);
```

这个延迟给 Obsidian / CodeMirror 一点时间完成退出编辑的内部状态更新。

### `finalizeSession(session)`

流程：

```text
如果已 finalized，返回
标记 finalized
判断是否 shouldTighten
计算 nextWidth
计算 measuredHeight
多行时避免低于 maxHeight
resizeNode()
requestSave()
debug()
清空 activeSession
```

收紧条件：

```ts
const shouldTighten = this.settings.tightenWidthOnExit && session.changed;
```

也就是说：

- 用户打开收紧。
- 本次确实改了内容。

两者都满足才收紧。

## 保存流程

插件不会直接写 `.canvas` 文件。它调用：

```ts
node.canvas?.requestSave?.()
```

为了避免频繁保存，保存被 debounce：

```ts
this.saveCanvasDebounced = debounce((node) => node.canvas?.requestSave?.(), 200);
```

## Debug 机制

### `lastDebug`

插件保存最近一次测量结果：

```ts
private lastDebug = "No Canvas editor update captured yet.";
```

每次 `debug()` 都会更新。

### 命令

插件注册两个命令：

- `Show last Canvas auto-size debug`
- `Copy last Canvas auto-size debug`

它们用于在 Obsidian 命令面板中查看或复制最近一次测量结果。

### Debug 内容

包括：

- node id
- doc length
- line count
- changed
- original width
- live width
- tight width
- max height
- node width/height
- next width/height

## 设置页结构

设置页类：

```ts
class CanvasAutoSizeSettingTab extends PluginSettingTab
```

分组：

### Basics

- Expansion direction
- Tighten width on exit
- Reset settings
- Maximum width

### Width

- Base width padding
- CJK extra width
- Editing anti-wrap width
- Exit tighten padding

其中 `Exit tighten padding` 只有打开 `Tighten width on exit` 后才显示。

### Height

- Single-line height
- Vertical padding

### Advanced

- Resize delay
- Debug notices

## 构建流程

### 安装依赖

```bash
npm install
```

### 构建

```bash
npm run build
```

它会执行：

```bash
tsc -noEmit -skipLibCheck
node esbuild.config.mjs production
```

生成或更新 `main.js`。

### 同步到 Obsidian 插件目录

当前测试 vault 的实际插件目录是：

```text
/Users/fengzhe/Library/Mobile Documents/iCloud~md~obsidian/Documents/知识仓库/.obsidian/plugins/node resizer/
```

至少需要同步：

```text
main.js
manifest.json
```

如果以后重新引入 `styles.css`，也需要同步它。

当前项目已经删除 `styles.css`。

### 重新加载插件

同步后需要在 Obsidian 中：

- 关闭再开启插件，或
- 重启 Obsidian，或
- 使用插件重载工具。

否则 Obsidian 可能还在运行旧的 `main.js`。

## Git 工作流

当前远程仓库：

```text
https://github.com/Laplacede/obsidian-canvas-node-autosize.git
```

常用流程：

```bash
npm run build
git status
git add -A
git commit -m "..."
git push
```

注意：修改后最好先在 Obsidian 实际插件目录测试，再 commit。

## 重要维护原则

### 1. 不要随便改高度算法

高度算法历史上踩坑最多。尤其不要直接使用会受节点外框影响的容器高度，例如 `scrollDOM.scrollHeight`。

### 2. 宽度允许保守一点

中文和 Canvas 编辑状态下的临界换行很难完全精确。宽度多留一点通常比节点反复换行更可接受。

### 3. live width 只增不减

这是防止编辑中塌缩的关键设计。不要轻易改成实时缩小。

### 4. 退出收紧必须谨慎

收紧只应该在明确编辑过内容后执行，并且默认关闭。

### 5. 参数要少而清楚

如果一个参数只有开发者知道怎么用，最好先不要暴露在设置页。

### 6. 运行时接口要做防御

Canvas 运行时对象没有完整公开类型，所以每次使用前都应该检查方法是否存在。

## 后续可以改进的方向

### README

项目还缺正式 README。建议内容包括：

- 插件用途。
- 安装方法。
- 设置说明。
- 中文使用建议。
- 已知限制。

### Release 流程

如果要正式发布，可以增加：

- `versions.json`
- release zip 打包脚本
- GitHub Release 说明

### 更稳定的高度测量

如果以后想继续优化高度，建议独立做一个测量模块，不要和当前逻辑混在一起。可以尝试隐藏测量容器，但要确保测量容器不受 Canvas 节点本身尺寸影响。

### 单元测试

Obsidian 插件运行时难测，但纯函数可以测试：

- `isCjkCharacter()`
- `containsCjk()`
- `clampNumberSetting()`
- 设置加载迁移逻辑

