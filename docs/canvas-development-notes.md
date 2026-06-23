# Obsidian Canvas 插件开发踩坑与收获记录

这份记录总结了开发 `Canvas Current Node Auto Size` 过程中遇到的 Canvas 相关问题、排查方法和最终取舍。它不是官方 API 文档，而是一次真实调试过程留下的经验库，适合以后继续做 Canvas 插件时参考。

## 目标背景

最初的问题来自 Obsidian Canvas 思维导图场景：

- 现有自动调整节点大小的插件会在扩宽节点时把后面的节点顶走，导致布局被破坏。
- 中文长文本在临界宽度处容易在退出编辑时换行，末尾几个字掉到第二行。
- Canvas 默认文本节点高度偏大，手动拖动高度又不稳定，排版不够紧凑。
- 希望只调整当前正在编辑的节点，不自动移动其它节点。
- 希望支持向右扩展、中心扩展、向左扩展。
- 希望在保留一定安全余量的前提下，让节点大小尽量贴近内容。

最后的核心设计变成：

- 插件只处理当前正在编辑的 Canvas 文本节点。
- 宽度可以增长，默认不在退出时收紧，避免节点突然塌缩。
- 如果用户主动开启退出收紧，则只在确实编辑过内容后收紧一次。
- 不主动推开或重排其它节点。
- 高度采用相对保守的估算方式，避免无限增长和复杂反馈。

## 重要资料来源

### JSON Canvas 规范

JSON Canvas 规范对理解 `.canvas` 文件结构很有帮助。它说明了 Canvas 文件的核心数据模型：

- 顶层是 `nodes` 和 `edges`。
- 节点拥有 `id`、`type`、`x`、`y`、`width`、`height`。
- 文本节点的内容在 `text` 字段里。
- 边通过 `fromNode`、`toNode` 关联节点。

这个规范适合理解 Canvas 文件保存后的数据结构，但插件运行时并不一定应该直接改 `.canvas` JSON。实际开发中，更可靠的是使用 Obsidian Canvas 运行时节点对象的 `resize()`、`moveTo()`、`canvas.requestSave()`。

### Obsidian / CodeMirror 运行时

Canvas 文本节点编辑时内部使用 CodeMirror 编辑器。插件通过 Obsidian 暴露的 `editorInfoField` 取得当前编辑器对应的 Canvas 节点。

本项目依赖的关键入口是：

- `EditorView.updateListener`：监听编辑器更新。
- `editorInfoField`：从编辑器状态中读取 Obsidian 提供的编辑器上下文。
- `editorInfo.node`：实际 Canvas 运行时节点对象。
- `node.resize({ width, height })`：修改当前节点大小。
- `node.moveTo({ x, y })`：在向左或中心扩展时移动节点位置。
- `node.canvas.requestSave()`：请求保存 Canvas 文件。

这部分不是 JSON Canvas 规范的一部分，而是 Obsidian 内部运行时对象。它比直接改文件更适合做即时 UI 修改。

## 关键踩坑

### 1. 不要直接依赖 Canvas JSON 去做即时 UI 调整

一开始容易以为 `.canvas` 文件就是唯一数据源，只要修改 JSON 中节点的 `width`、`height` 就可以。但实际 Canvas 界面里的节点是运行时对象，文件保存只是结果。

如果只改文件，可能出现：

- UI 不立即更新。
- 运行时状态和文件状态短暂分离。
- 选中节点、编辑器节点、文件节点难以准确对应。

最后采用的方式是：通过 `editorInfoField` 找到当前编辑器对应的运行时节点，然后调用 `node.resize()`。

### 2. Canvas 运行时对象没有稳定公开类型

Obsidian 插件 API 没有给 Canvas node 一个完整、稳定、公开的 TypeScript 类型。开发中需要自己定义最小可用接口：

```ts
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
```

然后用运行时检查确保它确实像一个 Canvas 节点：

- 必须有字符串 `id`。
- 必须有数字 `x`、`y`、`width`、`height`。
- 必须有 `resize()` 方法。

这样可以避免插件在非 Canvas 编辑器里误触发。

### 3. 不能移动其它节点

原来的插件痛点之一是自动扩宽会把后面的节点顶飞。这个项目明确不做重排，只改当前节点：

- 向右扩展：只改 `width`。
- 中心扩展：改 `width`，同时把 `x` 左移宽度变化的一半。
- 向左扩展：改 `width`，同时把 `x` 左移整个宽度变化。

无论哪种模式，都不扫描其它节点，也不修改其它节点位置。

### 4. 中文宽度不能只靠默认字符宽度

英文和数字的宽度可以比较稳定地由 canvas `measureText()` 估算。中文、日文、韩文在 Obsidian / Electron / 字体渲染中会更敏感，临界宽度处容易出现“测量够了但实际换行”的情况。

最终采用组合测量：

- 优先通过 CodeMirror 坐标 `coordsAtPos()` 获取行首和行尾坐标差。
- 同时用 canvas `measureText()` 得到文字宽度。
- 再用字符宽度 fallback 兜底。
- 对包含 CJK 字符的行额外加 `cjkSafetyPadding`。

这样比单纯 `line.length * averageCharWidth` 稳定。

### 5. 退出编辑时收紧宽度很危险

收紧功能看似自然，但实际很容易出错：

- 如果测量到的是空白位置，宽度会被算得很小。
- 如果只是点击进入编辑但没有输入，退出时不应该收紧。
- 如果用户从中间编辑长文本，Obsidian 初始可能短暂给出很窄的编辑区，导致测量宽度异常小。

最终收紧逻辑做了几层保护：

- 默认开启 `tightenWidthOnExit`，可由用户关闭以保留编辑期间的最大宽度。
- 只有 `session.changed === true` 时才允许退出收紧。
- 编辑中维护 `tightWidth`，但通过 `acceptTightWidth()` 拒绝可疑的突然缩小。
- 正常编辑时 `liveWidth` 只增不减，避免输入过程中节点塌缩。
- 开启退出收紧时，等待 Markdown DOM 出现后克隆节点，以 `max-content` 离屏测量最终宽度，并加回真实的节点横向占用。

### 6. 刚进入编辑时容易短暂塌缩

Canvas 节点进入编辑模式后，CodeMirror 和 Canvas 节点布局不是同步完成的。刚拿到编辑器时，测量结果可能短暂偏小。

项目中用双层 `requestAnimationFrame()` 做稳定修正：

```ts
requestAnimationFrame(() => {
	requestAnimationFrame(() => {
		// 重新测量并 resize
	});
});
```

这样等浏览器完成两轮布局，再重新测量一次。它解决了“选中后闪一下缩短，然后恢复”的大部分问题。

### 7. 高度测量比宽度更容易出反馈回路

高度是本次开发最容易踩坑的部分。

尝试过几种方案：

- 用 `scrollDOM.scrollHeight`。
- 用 `contentDOM.scrollHeight`。
- 统计 `.cm-line` 元素高度。
- 用行首/行尾坐标上下差。
- 用可视行数和稳定的每行高度估算。

其中 `scrollHeight` 方案最危险。因为节点外框一旦变高，滚动容器自己的 `scrollHeight` 也可能随之变高；插件下一轮又把这个高度当成内容需求，于是节点会随时间快速变高。

最终使用不依赖历史最大高度的确定性估算：

```ts
const lineHeight = Math.max(session.view.defaultLineHeight, this.settings.minSingleLineHeight);
return Math.ceil(lineHeight * lineCount + this.settings.verticalPadding + SCROLLBAR_SAFETY_HEIGHT);
```

这不是最精确的视觉高度，但没有反馈回路，行为更稳定。

退出编辑后会优先使用更准确的 Markdown DOM 高度：先固定最终节点宽度，再离屏克隆渲染内容，解除克隆的高度限制并读取自然高度。因为测量对象是独立克隆，它不会受到当前节点外框高度影响，也不会形成 `scrollHeight` 反馈回路。Callout、表格、列表和代码块都会走这条路径；拿不到渲染 DOM 时才回退到行数公式。

### 8. 设置参数不要过多，也不要名字太像

早期设置页出现过很多类似 `padding`、`extra height`、`compact height` 的参数。它们会让用户不知道该调哪个，也会让维护者忘记哪些真的参与计算。

后面做了几件事：

- 删除 compact height 模式。
- 删除旧样式测量用的 `styles.css`。
- 数值参数集中到 `NUMERIC_SETTING_DEFINITIONS`。
- 设置页分成 `Basics`、`Width`、`Height`、`Advanced`。
- 参数名称改为体现生效时机，例如：
  - `Base width padding`
  - `CJK extra width`
  - `Editing anti-wrap width`
  - `Exit tighten padding`

这比一堆 `padding` 更容易理解。

### 9. 已保存设置不会因为默认值改变而自动改变

Obsidian 插件设置会保存在插件的 `data.json` 中。`DEFAULT_SETTINGS` 只影响：

- 第一次安装。
- 设置中缺少某个字段。
- 点击恢复默认。

如果用户已经保存过 `horizontalPadding: 40`，后来把默认值改成 `20`，用户本地仍会继续用 `40`，除非手动改或恢复默认。这一点在调试时要特别注意，否则会误以为代码没有生效。

### 10. `debounceMs` 变更后需要重启或重新加载插件

`liveResizeDebounced` 在 `onload()` 中创建：

```ts
this.liveResizeDebounced = debounce((update) => this.handleEditorUpdate(update, true), this.settings.debounceMs, false);
```

因此设置页里改 `debounceMs` 后，已经创建出来的 debounce 函数不会自动换延迟。当前设置说明里明确写了“Restart Obsidian after changing this”。

以后如果想让它实时生效，需要在保存 debounce 设置时重新创建 `liveResizeDebounced`，并注意旧 listener 闭包引用的问题。

## 当前比较可靠的调试方法

### 使用插件命令查看 debug

项目提供一个命令：

- `Show last Canvas auto-size debug`

调试信息包括：

- 当前 node id。
- 文档长度。
- 行数。
- 是否发生编辑。
- 原始宽度。
- live width。
- tight width。
- max height。
- 当前节点宽高。
- 下一次目标宽高。

这比只看视觉表现可靠很多。

### 用最小 Canvas 文件复现

调试 Canvas 插件时，最好使用只有一两个节点的测试 canvas。原因是：

- 视觉反馈更明确。
- 不容易误判是其它节点、连线、插件影响。
- 可以快速观察节点是否只调整自己。

### 每次大改后同步实际插件目录

项目源码目录和 Obsidian 实际加载目录不是同一个地方。构建后需要把 `main.js` 同步到：

```text
知识仓库/.obsidian/plugins/node resizer/main.js
```

否则你看到的可能还是旧插件。

## 当前取舍

### 保留

- 只调整当前节点。
- 宽度实时自动增长。
- 中文额外宽度保护。
- 编辑中防换行宽度保护。
- 可选退出收紧。
- 向右、向左、中心扩展模式。
- 保守高度估算。

### 不做

- 不移动其它节点。
- 不自动重排布局。
- 不直接改 Canvas JSON 文件。
- 不默认退出收紧。
- 不使用 `scrollHeight` 做高度来源。
- 不保留 compact height 模式。

## 以后继续开发的建议

### 如果要继续解决高度问题

不要再直接使用外层容器的 `scrollHeight`。更安全的方向可能是：

- 在独立隐藏测量容器中模拟 Canvas 文本样式。
- 固定测量宽度后计算文本排版高度。
- 只把测量容器当成纯内容测量，不让它受 Canvas 节点外框影响。

但这会增加 CSS 同步成本，需要精确复制 Obsidian Canvas 文本节点样式。

### 如果要做自动收紧

自动收紧目前默认开启，并通过渲染后测量与最小宽度限制降低意外塌缩风险。若要增强，可以考虑：

- 只在用户按特定命令时收紧当前节点。
- 增加收紧预览。
- 对收紧后行数增加的情况自动撤销本次收紧。

### 如果要支持更多节点类型

当前目标是文本节点编辑。文件节点、链接节点、图片节点、group 节点的内容结构和编辑器状态不同，不建议混在一个逻辑里。

如果以后支持，建议拆出不同策略：

- Text node strategy
- File node strategy
- Link node strategy
- Group node strategy

每种策略各自测量和 resize。

### 如果要写 README

README 应重点说明：

- 插件只调整当前节点，不移动其它节点。
- 默认向右扩展。
- 中文用户如果遇到尾字换行，先调 `CJK extra width` 和 `Editing anti-wrap width`。
- 如果遇到竖向滚动条，调 `Minimum line height` 或 `Vertical padding`。
- `Tighten width on exit` 默认开启；希望保留最大编辑宽度时可以关闭。
